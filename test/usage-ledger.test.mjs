// usage.mjs ledger contracts (review P1): a failed write is never silent (spool +
// { ok:false }), an unreadable ledger is never "no spend", the hot-path reader
// tails instead of re-parsing, and compaction is exact (only rows no anchor can
// ever need).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordUsage, readUsageRows, readUsageState, createUsageReader, compactUsage,
  drainUsageSpool, displayedBalance, usageSpoolPath,
} from '../src/usage.mjs';
import { createKeyPool } from '../src/pool.mjs';
import { createLogger } from '../src/logger.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-ledger-'));
const row = (ts, email, cost) => JSON.stringify({ ts, email, cost_usd: cost, kind: 'gateway' });
const RATES = { in: 0, out: 0 };

test('recordUsage: appends and reports ok (old callers could ignore the result)', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  assert.deepEqual(recordUsage(path, { email: 'a@x', cost_usd: 0.5, model: 'm' }), { ok: true, spooled: false, error: null });
  const rows = readUsageRows(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'a@x');
  assert.equal(rows[0].cost_usd, 0.5);
  assert.equal(existsSync(usageSpoolPath(path)), false);
});

test('recordUsage: a failed append spools the row instead of losing the spend', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  mkdirSync(path);                                   // a directory cannot be appended to
  const r = recordUsage(path, { email: 'a@x', cost_usd: 1.25 });
  assert.equal(r.ok, false);
  assert.equal(r.spooled, true);
  assert.ok(r.error);
  const spooled = readFileSync(usageSpoolPath(path), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(spooled.length, 1);
  assert.equal(spooled[0].cost_usd, 1.25);
});

test('recordUsage: when even the spool fails the caller is told (ok:false, spooled:false)', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  chmodSync(dir, 0o500);                             // read-only dir: everything fails
  try {
    const r = recordUsage(path, { email: 'a@x', cost_usd: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.spooled, false);
    assert.ok(r.error);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('drainUsageSpool: spooled rows are replayed into the ledger, spool removed', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  writeFileSync(usageSpoolPath(path), row('2026-09-17T10:00:00Z', 'a@x', 3) + '\n');
  assert.deepEqual(drainUsageSpool(path), { drained: 1 });
  assert.equal(readUsageRows(path)[0].cost_usd, 3);
  assert.equal(existsSync(usageSpoolPath(path)), false);
  assert.deepEqual(drainUsageSpool(path), { drained: 0 });   // idempotent
});

test('readUsageState: missing vs ok vs unreadable, tolerating only a torn tail', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  assert.equal(readUsageState(path).state, 'missing');

  writeFileSync(path, row('2026-09-17T10:00:00Z', 'a@x', 1) + '\n');
  assert.equal(readUsageState(path).state, 'ok');

  appendFileSync(path, '{"ts":"2026-09-17T10:01:00Z","email":"b@x","cost_usd":2');  // crash mid-append
  const torn = readUsageState(path);
  assert.equal(torn.state, 'ok');
  assert.equal(torn.rows.length, 1);

  appendFileSync(path, '}\n');                       // writer finishes the line
  const repaired = readUsageState(path);
  assert.equal(repaired.state, 'ok');
  assert.equal(repaired.rows.length, 2);

  // corruption that is NOT a torn tail (a garbage line the writer did terminate)
  appendFileSync(path, 'GARBAGE\n');
  writeFileSync(path, row('2026-09-17T10:00:00Z', 'a@x', 1) + '\nGARBAGE\n' + row('2026-09-17T10:02:00Z', 'b@x', 1) + '\n');
  const bad = readUsageState(path);
  assert.equal(bad.state, 'unreadable', 'corruption mid-file must not read as healthy');
  assert.equal(bad.bad_lines, 1);
});

test('createUsageReader: tails appended bytes, reloads after a shrink, drains a spool', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  const reader = createUsageReader(path);
  assert.equal(reader.read().state, 'missing');

  writeFileSync(path, row('2026-09-17T10:00:00Z', 'a@x', 1) + '\n');
  let r = reader.read();
  assert.equal(r.rows.length, 1);
  assert.equal(reader.count, 1);

  // appended increments are picked up without re-reading what we already parsed
  appendFileSync(path, row('2026-09-17T10:01:00Z', 'b@x', 2) + '\n');
  const beforeOffset = reader.offset;
  r = reader.read();
  assert.equal(r.rows.length, 2);
  assert.ok(reader.offset > beforeOffset);

  // a partial line (writer mid-append) is not consumed yet
  appendFileSync(path, '{"ts":"2026-09-17T10:02:00Z","email":"c@x"');
  assert.equal(reader.read().rows.length, 2, 'torn tail must not be parsed');
  appendFileSync(path, ',"cost_usd":3}\n');
  assert.equal(reader.read().rows.length, 3);

  // compaction shrinks the file under us -> full reload
  compactUsage(path, [{ email: 'a@x', balance_usd: 10, checked_at: '2026-09-17T10:00:30Z' }]);
  r = reader.read();
  assert.equal(r.rows.length, 2, 'reload after shrink');
  assert.deepEqual(r.rows.map((x) => x.email), ['b@x', 'c@x']);

  // a spooled row is replayed before this read reports
  writeFileSync(usageSpoolPath(path), row('2026-09-17T10:03:00Z', 'd@x', 4) + '\n');
  assert.equal(reader.read().rows.length, 3);
  assert.equal(reader.read().rows.some((x) => x.email === 'd@x'), true);
});

test('compactUsage: exact — only rows older than every anchor are archived', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  writeFileSync(path, [
    row('2026-09-17T09:00:00Z', 'a@x', 1),   // before both anchors -> archived
    row('2026-09-17T10:00:00Z', 'a@x', 2),   // after the oldest anchor -> kept
    row('2026-09-17T11:00:00Z', 'a@x', 4),
  ].join('\n') + '\n');
  const accounts = [
    { email: 'a@x', balance_usd: 100, checked_at: '2026-09-17T09:30:00Z' },
    { email: 'b@x', balance_usd: 50, checked_at: '2026-09-17T10:30:00Z' },
  ];
  const before = displayedBalance(accounts[0], readUsageRows(path));
  const r = compactUsage(path, accounts);
  assert.equal(r.moved, 1);
  assert.equal(r.kept, 2);
  assert.equal(r.cutoff, '2026-09-17T09:30:00.000Z');

  const after = displayedBalance(accounts[0], readUsageRows(path));
  assert.equal(after, before, 'displayed balance must be identical after compaction');
  assert.equal(after, 100 - 6);

  const archive = readFileSync(path.replace(/\.jsonl$/, '') + '-archive.jsonl', 'utf8').trim().split('\n');
  assert.equal(archive.length, 1);
  assert.equal(JSON.parse(archive[0]).cost_usd, 1);

  // no anchors (never refreshed balances) -> never guess, leave the file alone
  const again = compactUsage(path, []);
  assert.equal(again.moved, 0);
  assert.equal(readUsageRows(path).length, 2);
});

test('compactUsage: a fresh account (balance at signup, never re-checked) anchors at created_at', () => {
  const dir = tmp();
  const path = join(dir, 'usage.jsonl');
  writeFileSync(path, [
    row('2026-09-17T08:00:00Z', 'old@x', 1),   // before every anchor -> archived
    row('2026-09-17T10:05:00Z', 'new@x', 2),   // fresh account's own spend -> MUST stay
    row('2026-09-17T10:06:00Z', 'old@x', 3),
  ].join('\n') + '\n');
  const accounts = [
    { email: 'old@x', balance_usd: 100, checked_at: '2026-09-17T10:00:00Z' },
    // skeleton registerOne writes balance_usd + created_at, no checked_at until the
    // keeper's balance rotation reaches it — its displayed balance sums ALL its rows
    { email: 'new@x', balance_usd: 5, created_at: '2026-09-17T10:04:00Z' },
  ];
  const rows0 = readUsageRows(path);
  const before = accounts.map((a) => displayedBalance(a, rows0));
  const r = compactUsage(path, accounts);
  assert.equal(r.moved, 1);
  assert.equal(r.cutoff, '2026-09-17T10:00:00.000Z');
  const rows1 = readUsageRows(path);
  assert.deepEqual(accounts.map((a) => displayedBalance(a, rows1)), before, 'no displayed balance may move');
  assert.equal(displayedBalance(accounts[1], rows1), 3);

  // a balance-carrying account with NO anchor instant at all -> no safe cutoff -> untouched
  const r2 = compactUsage(path, [...accounts, { email: 'odd@x', balance_usd: 1 }]);
  assert.equal(r2.moved, 0);
  assert.equal(readUsageRows(path).length, 2);
});

test('pool: an unreadable ledger refuses to hand out keys (fail closed)', () => {
  const dir = tmp();
  const accountsFile = join(dir, 'accounts.jsonl');
  const usagePath = join(dir, 'usage.jsonl');
  appendFileSync(accountsFile, JSON.stringify({ email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5, checked_at: '2026-09-17T10:00:00Z' }) + '\n');
  writeFileSync(usagePath, 'GARBAGE LINE\n' + row('2026-09-17T11:00:00Z', 'a@x', 1) + '\n');
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const pool = createKeyPool({
    id: 'test', base: 'http://upstream/v1', accountsFile, usagePath,
    rates: () => RATES, classifyFailure: () => 'network', log,
  });
  assert.equal(pool.borrow(null), null, 'unknown spend must not be spendable');
  assert.equal(pool.health().eligible_keys, 0);
  assert.equal(pool.health().ledger.state, 'unreadable');

  // repairing the ledger restores service without a restart
  writeFileSync(usagePath, row('2026-09-17T11:00:00Z', 'a@x', 1) + '\n');
  assert.equal(pool.borrow(null)?.email, 'a@x');
  assert.equal(pool.health().ledger.state, 'ok');
});