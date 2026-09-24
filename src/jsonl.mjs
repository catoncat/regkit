// Generic JSONL helpers. Append-only lines of JSON objects; the read contract
// is "latest record per key wins" (key = email or any string field).
// All writes are 0600 and never let a logging/disk hiccup kill the caller.

import { appendFileSync, mkdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname } from 'node:path';

const NL = String.fromCharCode(10);

export function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}

/** Append one JSON object as a line. Best-effort safe. */
export function appendJsonl(file, record) {
  ensureDir(file);
  appendFileSync(file, JSON.stringify(record) + NL, { mode: 0o600 });
}

/** Read all lines, skipping torn/bad ones. Never throws. */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split(NL)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  } catch { /* ignore */ }
  return out;
}

/** Latest record per key field — the append-only file's read contract. */
export function latestWins(file, key = 'email') {
  const m = new Map();
  for (const r of readJsonl(file)) if (r && r[key]) m.set(r[key], r);
  return [...m.values()];
}

/** Keys already present (for batch dedup). */
export function seenKeys(file, key = 'email') {
  const s = new Set();
  for (const r of readJsonl(file)) if (r && r[key]) s.add(r[key]);
  return s;
}

/** Merge-over-previous append: a partial update must never silently erase
 *  identity fields the previous line carried. Explicit null still clears. */
export function appendMergeLatest(file, record, key = 'email') {
  let out = record;
  try {
    if (record[key] && existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(NL);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const prev = JSON.parse(lines[i]);
        if (prev && prev[key] === record[key]) {
          out = { ...prev, ...record };
          for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
          break;
        }
      }
    }
  } catch { /* unreadable history -> write as-is */ }
  appendJsonl(file, out);
  return out;
}

/** Signature (size:mtimeMs) of a file for cheap change detection. */
export function fileSig(file) {
  try {
    const st = statSync(file);
    return st.size + ':' + Math.floor(st.mtimeMs);
  } catch { return ''; }
}

/** Read the tail (last maxBytes) of a file, parsed as JSONL. */
export function readTail(file, maxBytes = 256 * 1024) {
  if (!existsSync(file)) return [];
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const out = [];
    for (const line of buf.toString('utf8').split(NL)) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j && j.event) out.push(j); } catch { /* clipped */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

export { NL };
