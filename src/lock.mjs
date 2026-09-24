// Locks. Two different jobs, deliberately kept apart:
//
//   acquireLock / releaseLock — single-instance guard (pid file): two watch
//   panes must never double-spawn supply batches; a stale pid file is
//   reclaimed automatically.
//
//   withFileLock / withFileLockAsync — cross-process advisory lock for
//   read-modify-write on a shared coordination file (health.json,
//   fleet.local.json, the usage ledger). Atomic writes (tmp + rename) only
//   prevent torn files; they do NOT stop two writers from clobbering each
//   other's decisions. Detectors, patrol, fleet verbs and keepers all take
//   the same lock file, so every read-modify-write is serialized.
//
// Lock file format: "<pid> <epochMs>". A lock is reclaimed when its holder is
// gone or it is older than staleMs, so a crashed writer can never wedge the
// fleet dead. Reclaiming is inode-checked (see reclaim) so two contenders on one
// stale lock cannot end up both holding it.

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, fstatSync, mkdirSync, renameSync, linkSync } from 'node:fs';
import { dirname } from 'node:path';

export function acquireLock(lockPath) {
  try {
    if (existsSync(lockPath)) {
      const other = Number(readFileSync(lockPath, 'utf8').trim());
      if (other && other !== process.pid) {
        try { process.kill(other, 0); return false; } catch { /* stale lock */ }
      }
    }
    writeFileSync(lockPath, String(process.pid));
    return true;
  } catch { return false; }
}

export function releaseLock(lockPath, held = true) {
  try {
    if (held && existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch { /* ignore */ }
}

// Blocking sleep without a dependency (Atomics.wait on a throwaway buffer).
// ONLY ever used by the sync acquire path; the async path must yield instead,
// otherwise waiting for a lock would starve the event loop that the current
// holder needs in order to finish and release.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* no SharedArrayBuffer: a short busy loop beats waiting forever */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export const LOCK_DEFAULTS = Object.freeze({ timeoutMs: 3000, staleMs: 30_000, pollMs: 5 });

/** A lock file that exists but carries no pid yet belongs to a holder between
 *  open(O_EXCL) and its stamp write. Give it this long before calling it dead. */
export const UNSTAMPED_GRACE_MS = 1000;

/** The lock guarding one shared file: <file>.lock, in the same directory. */
export const lockPathFor = (file) => file + '.lock';

const normOpts = ({ timeoutMs, staleMs, pollMs } = {}) => ({
  ...LOCK_DEFAULTS,
  ...(timeoutMs != null ? { timeoutMs } : {}),
  ...(staleMs != null ? { staleMs } : {}),
  ...(pollMs != null ? { pollMs } : {}),
});

/**
 * Inode of the lock file if it is stale (holder gone, or older than staleMs),
 * else null. Two things are deliberately NOT stale: a lock that vanished between
 * EEXIST and stat (just retry), and an EMPTY lock younger than the grace period —
 * that is a live holder between open() and stamp, and reclaiming it hands the
 * same lock to two processes.
 */
function staleInodeOf(lockPath, staleMs) {
  try {
    const st = statSync(lockPath);
    const age = Date.now() - st.mtimeMs;
    if (age > staleMs) return st.ino;
    const pid = Number(String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/)[0]);
    if (!(pid > 0)) return age > UNSTAMPED_GRACE_MS ? st.ino : null;
    return alive(pid) ? null : st.ino;
  } catch { return null; }
}

/**
 * Remove a stale lock without unlinking a fresh one. unlink() by path races: A
 * judges stale, B reclaims and re-creates, A unlinks B's FRESH lock -> two
 * holders. rename() is atomic and only one rename of a given source succeeds, and
 * the inode tells us whether what we moved is the file we actually judged; if it
 * is not, link() it back (no-clobber, unlike rename) so the live holder keeps it.
 */
function reclaim(lockPath, staleIno) {
  const grave = lockPath + '.stale-' + process.pid + '-' + Date.now();
  try { renameSync(lockPath, grave); } catch { return; }     // someone else got there first
  try {
    if (statSync(grave).ino !== staleIno) {
      try { linkSync(grave, lockPath); } catch { /* path re-taken meanwhile; release() below protects the new holder */ }
    }
  } catch { /* stat failed: nothing to put back */ }
  finally { try { unlinkSync(grave); } catch { /* ignore */ } }   // never leave a grave behind
}

/** One O_EXCL attempt. Returns an fd, or null when the caller must retry. */
function openExclusive(lockPath, staleMs) {
  try { return openSync(lockPath, 'wx', 0o600); } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const staleIno = staleInodeOf(lockPath, staleMs);
    if (staleIno !== null) reclaim(lockPath, staleIno);
    return null;
  }
}

/**
 * Stamp the holder into the lock file and return its release(). release() only
 * unlinks the path if it still points at OUR inode: if a reclaimer ever moved our
 * file aside and a newer holder created its own, unlinking by path would take the
 * newer holder's lock away — the last two-holder window closes here.
 */
function stampHolder(fd, lockPath) {
  try { writeFileSync(fd, `${process.pid} ${Date.now()}`); } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    throw err;
  }
  let ino = null;
  try { ino = fstatSync(fd).ino; } catch { /* fall back to unlink-by-path */ }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try { closeSync(fd); } catch { /* ignore */ }
    try {
      if (ino === null || statSync(lockPath).ino === ino) unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
}

const prepare = (lockPath) => {
  try { mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 }); } catch { /* open() below reports it */ }
};

/**
 * Take the advisory lock synchronously (O_EXCL). Throws on timeout.
 * Returns a release() the caller MUST call. Never hold it across an await.
 */
export function acquireFileLock(lockPath, opts) {
  const T = normOpts(opts);
  prepare(lockPath);
  const deadline = Date.now() + T.timeoutMs;
  for (;;) {
    const fd = openExclusive(lockPath, T.staleMs);
    if (fd !== null) return stampHolder(fd, lockPath);
    if (Date.now() >= deadline) throw new Error(`lock timeout after ${T.timeoutMs}ms: ${lockPath}`);
    sleepSync(T.pollMs);
  }
}

/**
 * Async variant: identical contract, but waiting yields to the event loop so a
 * holder that is mid-await can still finish and release.
 */
export async function acquireFileLockAsync(lockPath, opts) {
  const T = normOpts(opts);
  prepare(lockPath);
  const deadline = Date.now() + T.timeoutMs;
  for (;;) {
    const fd = openExclusive(lockPath, T.staleMs);
    if (fd !== null) return stampHolder(fd, lockPath);
    if (Date.now() >= deadline) throw new Error(`lock timeout after ${T.timeoutMs}ms: ${lockPath}`);
    await sleep(T.pollMs);
  }
}

/** Serialized critical section (sync body). */
export function withFileLock(lockPath, fn, opts) {
  const release = acquireFileLock(lockPath, opts);
  try { return fn(); } finally { release(); }
}

/**
 * Serialized critical section that may await. Rule of the house: the body stays
 * short (pure read-modify-write). Anything slow — a network probe, spawning a
 * batch — happens OUTSIDE the lock, or a sync waiter will time out on it.
 */
export async function withFileLockAsync(lockPath, fn, opts) {
  const release = await acquireFileLockAsync(lockPath, opts);
  try { return await fn(); } finally { release(); }
}
