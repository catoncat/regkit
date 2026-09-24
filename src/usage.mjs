// Local consumption ledger (data/usage.jsonl). One JSON line per observed
// spend of a pool key. Displayed balance = authoritative anchor
// (accounts.jsonl checked_at snapshot) minus locally recorded spend since.
//
//   { ts, email, kind, model, cost_usd, prompt_tokens, completion_tokens, note }
//
// Rows without a numeric cost_usd are kept for audit but never summed.
//
// Money rule (review P1): a ledger write that FAILS must never be silent — the
// caller gets { ok:false } and the row is spooled beside the ledger, so the pool
// can stop handing out a key whose spend it could not record. And an UNREADABLE
// ledger must never read as "no spend" (that over-states balance and keeps
// minting keys past exhaustion): readUsageState reports 'unreadable' so gates can
// fail closed.
//
// Hot path: createUsageReader tails only the newly appended bytes instead of
// re-parsing the whole file on every gateway request.

import { appendJsonl, readJsonl, ensureDir, NL } from './jsonl.mjs';
import { withFileLock, lockPathFor } from './lock.mjs';
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';

const errText = (err) => String(err?.message || err).slice(0, 120);

/** The spool that holds rows whose ledger append failed. Lives beside the ledger. */
export const usageSpoolPath = (path) => path + '.spool';

export function recordUsage(path, row) {
  const cost = Number(row.cost_usd);
  const rec = {
    ts: new Date().toISOString(),
    email: row.email,
    kind: row.kind || 'unattributed',
    ...(row.model ? { model: row.model } : {}),
    ...(Number.isFinite(cost) ? { cost_usd: Math.round(cost * 100000000) / 100000000 } : {}),
    ...(row.prompt_tokens != null ? { prompt_tokens: Number(row.prompt_tokens) || 0 } : {}),
    ...(row.completion_tokens != null ? { completion_tokens: Number(row.completion_tokens) || 0 } : {}),
    ...(row.note ? { note: String(row.note).slice(0, 200) } : {}),
  };
  try {
    // The ledger lock is shared with compaction: a rewrite (tmp + rename) running
    // concurrently with an append would silently drop the appended row.
    withFileLock(lockPathFor(path), () => appendJsonl(path, rec), { timeoutMs: 1000 });
    return { ok: true, spooled: false, error: null };
  } catch (err) {
    try {
      appendJsonl(usageSpoolPath(path), rec);
      return { ok: false, spooled: true, error: errText(err) };
    } catch (err2) {
      return { ok: false, spooled: false, error: errText(err) + ' | spool failed: ' + errText(err2) };
    }
  }
}

/**
 * Replay spooled rows into the ledger. Idempotent in the normal case (the spool
 * is removed after a successful append); if removal fails the rows would land
 * twice, which over-states spend — the conservative direction: it never hands a
 * key out for budget we may already have burned.
 */
export function drainUsageSpool(path) {
  const spool = usageSpoolPath(path);
  if (!existsSync(spool)) return { drained: 0 };
  let text;
  try { text = readFileSync(spool, 'utf8'); } catch { return { drained: 0, error: 'spool unreadable' }; }
  const lines = text.split(NL).filter((l) => l.trim());
  if (!lines.length) { try { unlinkSync(spool); } catch { /* ignore */ } return { drained: 0 }; }
  try {
    withFileLock(lockPathFor(path), () => appendFileSync(path, lines.join(NL) + NL, { mode: 0o600 }), { timeoutMs: 1000 });
  } catch (err) {
    return { drained: 0, error: errText(err) };
  }
  try { unlinkSync(spool); } catch { /* next drain may duplicate — conservative */ }
  return { drained: lines.length };
}

export function readUsageRows(path) {
  return readJsonl(path);
}

/**
 * Strict read: 'missing' (nothing recorded yet), 'ok', or 'unreadable'.
 * One torn tail line is tolerated (a crash mid-append); anything else means the
 * ledger cannot be trusted as a record of what was spent.
 */
export function readUsageState(path) {
  if (!path || !existsSync(path)) return { state: 'missing', rows: [], bad_lines: 0, error: null };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    return { state: 'unreadable', rows: [], bad_lines: 0, error: errText(err) };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split(NL)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  const tornTail = bad === 1 && !text.endsWith(NL);
  if (bad > 0 && !tornTail) return { state: 'unreadable', rows, bad_lines: bad, error: bad + ' unparsable line(s)' };
  return { state: 'ok', rows, bad_lines: 0, error: null };
}

/**
 * Incremental reader for the hot path (one borrow per gateway request): parse
 * only the bytes appended since the last call, keep the rows in memory. A shrink
 * (compaction/rotation) triggers a full reload. A spool drops in first, so
 * recovered spend is counted before anything is handed out.
 */
export function createUsageReader(path) {
  let offset = 0;
  let rows = [];
  let state = 'missing';
  let corrupt = false;
  return {
    read({ drainSpool = true } = {}) {
      if (!path) return { state: 'missing', rows: [] };
      if (drainSpool && existsSync(usageSpoolPath(path))) {
        drainUsageSpool(path);
        offset = 0; rows = []; corrupt = false;   // the ledger grew behind our back
      }
      let st;
      try { st = statSync(path); } catch (err) {
        if (err?.code === 'ENOENT') { offset = 0; rows = []; corrupt = false; state = 'missing'; return { state, rows: [] }; }
        state = 'unreadable';
        return { state, rows };
      }
      if (st.size < offset) { offset = 0; rows = []; corrupt = false; }   // compacted under us
      if (st.size > offset) {
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        let fd;
        try {
          fd = openSync(path, 'r');
          const n = readSync(fd, buf, 0, len, offset);
          const text = buf.subarray(0, n).toString('utf8');
          const cut = text.lastIndexOf(NL);
          if (cut >= 0) {
            for (const line of text.slice(0, cut).split(NL)) {
              if (!line.trim()) continue;
              try { rows.push(JSON.parse(line)); } catch { corrupt = true; }
            }
            offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
          }
        } catch (err) {
          state = 'unreadable';
          return { state, rows };
        } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
      }
      state = corrupt ? 'unreadable' : 'ok';
      return { state, rows };
    },
    get offset() { return offset; },
    get count() { return rows.length; },
  };
}

/**
 * The instant before which no ledger row can affect this account's displayed
 * balance: its balance anchor (checked_at), or — for a freshly registered account
 * whose balance was read at signup and never re-checked — its created_at (no row
 * can carry its email before it existed). null = no safe instant is known.
 */
export function anchorTimeOf(account) {
  for (const f of ['checked_at', 'created_at']) {
    const t = Date.parse(account?.[f] || '');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

const hasBalanceAnchor = (a) => Number.isFinite(Number(a?.balance_usd ?? a?.available_usd));

/**
 * Exact compaction: archive the rows no displayed balance can ever need — those
 * at or before the OLDEST anchor instant across every account that carries a
 * balance. A row older than every anchor is already absorbed by that anchor, so
 * spend-after-anchor is unchanged; rows newer than an anchor are never touched.
 * If any balance-carrying account has NO known anchor instant, nothing is
 * archived: its displayed balance sums every row it has, so no cutoff is safe.
 * Archives rather than deletes, so the audit trail survives.
 * Returns { moved, kept, cutoff }.
 */
export function compactUsage(path, accounts, { archivePath = path.replace(/\.jsonl$/, '') + '-archive.jsonl' } = {}) {
  const anchored = (accounts || []).filter(hasBalanceAnchor);
  const anchors = anchored.map(anchorTimeOf);
  if (!anchors.length || anchors.some((t) => t === null) || !existsSync(path)) return { moved: 0, kept: 0, cutoff: null };
  const cutoff = Math.min(...anchors);
  const keep = [];
  const move = [];
  // Same lock as every ledger append (and as drainUsageSpool): the read-plan-
  // rewrite step must not interleave with a row being appended.
  const result = withFileLock(lockPathFor(path), () => {
    for (const line of readFileSync(path, 'utf8').split(NL)) {
      if (!line.trim()) continue;
      let t = NaN;
      try { t = Date.parse(JSON.parse(line)?.ts || ''); } catch { keep.push(line); continue; }  // let strict reads complain
      if (Number.isFinite(t) && t <= cutoff) move.push(line); else keep.push(line);
    }
    if (!move.length) return { moved: 0, kept: keep.length, cutoff: new Date(cutoff).toISOString() };
    ensureDir(archivePath);
    appendFileSync(archivePath, move.join(NL) + NL, { mode: 0o600 });
    ensureDir(path);
    const tmpFile = path + '.tmp-' + process.pid;
    writeFileSync(tmpFile, keep.length ? keep.join(NL) + NL : '', { mode: 0o600 });
    renameSync(tmpFile, path);
    return { moved: move.length, kept: keep.length, cutoff: new Date(cutoff).toISOString() };
  });
  return result;
}

/** Sum of recorded dollars, optionally only rows after an ISO cutoff. */
export function sumSpend(rows, sinceIso = null) {
  const cut = sinceIso ? Date.parse(sinceIso) || 0 : 0;
  let total = 0;
  for (const r of rows) {
    if (typeof r.cost_usd !== 'number') continue;
    if (cut && (Date.parse(r.ts) || 0) <= cut) continue;
    total += r.cost_usd;
  }
  return total;
}

/** Displayed balance for one account: anchor minus local spend after it.
 *  No authoritative anchor yet -> null so callers can render a dash. */
export function displayedBalance(account, usageRows, { balanceField = 'balance_usd', checkedAtField = 'checked_at', emailField = 'email' } = {}) {
  if (typeof account?.[balanceField] !== 'number') return null;
  const mine = usageRows.filter((r) => r[emailField] === account[emailField]);
  return account[balanceField] - sumSpend(mine, account[checkedAtField] || null);
}
