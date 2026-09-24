// Usage ledger contracts: displayed balance = authoritative anchor minus
// locally recorded spend since the anchor (never double-counted).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUsage, readUsageRows, sumSpend, displayedBalance } from '../src/usage.mjs';
import { displayedPoolBalance } from '../src/accounts.mjs';

test('recordUsage persists only numeric cost; non-numeric kept but never summed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-usage-'));
  const file = join(dir, 'usage.jsonl');
  recordUsage(file, { email: 'a@x', kind: 'gateway', cost_usd: 0.01, model: 'm' });
  recordUsage(file, { email: 'a@x', kind: 'probe', cost_usd: 'n/a' });
  const rows = readUsageRows(file);
  assert.equal(rows.length, 2);
  assert.equal(sumSpend(rows), 0.01);
});

test('displayed balance = anchor minus spend after the anchor only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-usage-'));
  const file = join(dir, 'usage.jsonl');
  recordUsage(file, { email: 'a@x', kind: 'gateway', cost_usd: 0.01 });
  const rows = readUsageRows(file);
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const before = { email: 'a@x', balance_usd: 5, checked_at: t0 };
  assert.ok(Math.abs(displayedBalance(before, rows) - 4.99) < 1e-9);
  const after = { email: 'a@x', balance_usd: 5, checked_at: rows[0].ts };
  assert.equal(displayedBalance(after, rows), 5);
  assert.equal(displayedBalance({ email: 'a@x' }, rows), null); // no anchor yet
});

test('displayedPoolBalance aggregates verified accounts only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-usage-'));
  const file = join(dir, 'usage.jsonl');
  recordUsage(file, { email: 'a@x', kind: 'gateway', cost_usd: 1 });
  const rows = readUsageRows(file);
  const accts = [
    { email: 'a@x', status: 'verified', balance_usd: 5, checked_at: new Date(Date.now() - 60_000).toISOString() },
    { email: 'b@x', status: 'verified', balance_usd: 5 },
    { email: 'c@x', status: 'pending', balance_usd: 5 },
  ];
  assert.equal(displayedPoolBalance(accts, rows), 9); // 5-1 + 5, pending excluded
});
