// lock.mjs: the cross-process advisory lock used for every coordination-file
// read-modify-write (health.json / fleet.local.json / usage ledger).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock, withFileLock, withFileLockAsync, LOCK_DEFAULTS, UNSTAMPED_GRACE_MS } from '../src/lock.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-lock-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('withFileLockAsync: concurrent sections never interleave (no lost update)', async () => {
  const lockPath = join(tmp(), 'coord.lock');
  const log = [];
  const section = async (tag) => withFileLockAsync(lockPath, async () => {
    log.push(tag + ':start');
    await delay(20);
    log.push(tag + ':end');
  }, { timeoutMs: 2000 });
  await Promise.all([section('a'), section('b'), section('c')]);

  // Acquisition order is not FIFO (that is not promised) — what IS promised is
  // mutual exclusion: a start is always followed by its own end.
  assert.equal(log.length, 6, 'every section ran exactly once: ' + log.join(','));
  let open = null;
  for (const e of log) {
    if (e.endsWith(':start')) {
      assert.equal(open, null, 'overlap: ' + log.join(','));
      open = e;
    } else {
      assert.equal(open, e.replace(':end', ':start'), 'mismatched release: ' + log.join(','));
      open = null;
    }
  }
  assert.equal(open, null);
  assert.deepEqual([...new Set(log.map((x) => x[0]))].sort(), ['a', 'b', 'c']);
  assert.equal(existsSync(lockPath), false, 'lock released');
});

test('withFileLock: serialized read-modify-write keeps every update', () => {
  const dir = tmp();
  const lockPath = join(dir, 'coord.lock');
  const data = join(dir, 'count.json');
  writeFileSync(data, JSON.stringify({ n: 0 }));
  for (let i = 0; i < 25; i++) {
    withFileLock(lockPath, () => {
      const cur = JSON.parse(readFileSync(data, 'utf8'));
      writeFileSync(data, JSON.stringify({ n: cur.n + 1 }));
    });
  }
  assert.equal(JSON.parse(readFileSync(data, 'utf8')).n, 25);
  assert.equal(existsSync(lockPath), false);
});

test('withFileLock: a held lock times out instead of clobbering the holder', () => {
  const lockPath = join(tmp(), 'coord.lock');
  const release = acquireFileLock(lockPath);
  assert.match(readFileSync(lockPath, 'utf8'), new RegExp('^' + process.pid + ' '));
  assert.throws(() => withFileLock(lockPath, () => {}, { timeoutMs: 30 }), /lock timeout after 30ms/);
  release();
  // once released, the next caller gets in
  assert.equal(withFileLock(lockPath, () => 'ok'), 'ok');
  assert.equal(existsSync(lockPath), false);
});

test('reclaim: dead holder pid does not wedge the fleet', () => {
  const lockPath = join(tmp(), 'coord.lock');
  // 4_194_305 is beyond Linux/macOS max pid -> kill() reports ESRCH
  writeFileSync(lockPath, '4194305 ' + Date.now());
  assert.equal(withFileLock(lockPath, () => 'ran'), 'ran');
});

test('reclaim: live holder with a stale mtime is reclaimed after staleMs', () => {
  const lockPath = join(tmp(), 'coord.lock');
  writeFileSync(lockPath, process.pid + ' 1');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockPath, old, old);
  assert.equal(withFileLock(lockPath, () => 'ran', { staleMs: 1000 }), 'ran');
});

test('reclaim: an empty (unstamped) lock is stale only after the grace period', () => {
  const lockPath = join(tmp(), 'coord.lock');
  writeFileSync(lockPath, '');
  // just created: that is a live holder between open() and stamp — do NOT reclaim
  assert.throws(() => withFileLock(lockPath, () => 'ran', { timeoutMs: 100 }), /lock timeout/);
  assert.ok(existsSync(lockPath), 'fresh unstamped lock survives a contender');
  // older than the grace period: nobody stamps this late — reclaim
  const old = (Date.now() - UNSTAMPED_GRACE_MS - 5000) / 1000;
  utimesSync(lockPath, old, old);
  assert.equal(withFileLock(lockPath, () => 'ran'), 'ran');
});

test('reclaim: a lock re-created by another contender is never unlinked out from under it', () => {
  const lockPath = join(tmp(), 'coord.lock');
  // stale lock (dead pid) — but by the time WE act, a fresh holder owns the path.
  // Simulate by taking the lock ourselves right before the contender's attempt:
  writeFileSync(lockPath, '4194305 ' + Date.now());
  const release = acquireFileLock(lockPath);       // reclaims the stale one, stamps ours
  const ours = readFileSync(lockPath, 'utf8');
  assert.match(ours, new RegExp('^' + process.pid + ' '));
  assert.throws(() => withFileLock(lockPath, () => {}, { timeoutMs: 50 }), /lock timeout/);
  assert.equal(readFileSync(lockPath, 'utf8'), ours, 'the live lock is untouched by the loser');
  release();
});

test('release: never unlinks a lock file that is no longer ours', () => {
  const lockPath = join(tmp(), 'coord.lock');
  const release = acquireFileLock(lockPath);
  // simulate a reclaimer having replaced the path with another holder's file
  writeFileSync(lockPath + '.other', '4194305 ' + Date.now());
  const { renameSync } = fsModule;
  renameSync(lockPath + '.other', lockPath);
  release();
  assert.ok(existsSync(lockPath), 'the other holder keeps its lock');
  assert.match(readFileSync(lockPath, 'utf8'), /^4194305 /);
  assert.equal(readdirSync(join(lockPath, '..')).filter((f) => f.includes('.stale-')).length, 0, 'no grave files');
});

test('withFileLock: a throwing body still releases the lock', () => {
  const lockPath = join(tmp(), 'coord.lock');
  assert.throws(() => withFileLock(lockPath, () => { throw new Error('body blew up'); }), /body blew up/);
  assert.equal(existsSync(lockPath), false);
  assert.equal(withFileLock(lockPath, () => 'fine'), 'fine');
});

test('lock file carries holder pid + timestamp, and defaults are bounded', () => {
  const lockPath = join(tmp(), 'coord.lock');
  const release = acquireFileLock(lockPath);
  const [pid, at] = readFileSync(lockPath, 'utf8').split(/\s+/);
  assert.equal(Number(pid), process.pid);
  assert.ok(Math.abs(Date.now() - Number(at)) < 5000);
  release();
  assert.deepEqual(LOCK_DEFAULTS, { timeoutMs: 3000, staleMs: 30_000, pollMs: 5 });
});

test('locks live next to the file they guard (appendJsonl path style)', () => {
  const dir = tmp();
  const data = join(dir, 'usage.jsonl');
  appendFileSync(data, '{}\n');
  withFileLock(data + '.lock', () => {
    assert.ok(existsSync(data + '.lock'));
  });
  assert.ok(existsSync(data), 'guarded file untouched');
});
