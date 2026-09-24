// JSONL append/read/latest-wins contracts — the persistence backbone shared
// by accounts.jsonl, events.jsonl, usage.jsonl.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonl, readJsonl, latestWins, seenKeys, appendMergeLatest, readTail, fileSig,
} from '../src/jsonl.mjs';

test('append + read round-trips, torn tail lines are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-jsonl-'));
  const file = join(dir, 'x.jsonl');
  appendJsonl(file, { a: 1 });
  appendJsonl(file, { a: 2 });
  // simulate a torn tail write
  appendFileSync(file, '{"a": 3, \n');
  const rows = readJsonl(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: 1 });
  assert.deepEqual(rows[1], { a: 2 });
});

test('latestWins returns the newest record per key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-jsonl-'));
  const file = join(dir, 'accts.jsonl');
  appendJsonl(file, { email: 'a@x', status: 'pending', created_at: '2026-01-01' });
  appendJsonl(file, { email: 'a@x', status: 'verified', created_at: '2026-01-02' });
  appendJsonl(file, { email: 'b@x', status: 'verified' });
  const latest = latestWins(file, 'email');
  assert.equal(latest.length, 2);
  assert.equal(latest.find((r) => r.email === 'a@x').status, 'verified');
  assert.deepEqual(seenKeys(file, 'email'), new Set(['a@x', 'b@x']));
});

test('appendMergeLatest carries identity forward on partial updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-jsonl-'));
  const file = join(dir, 'accts.jsonl');
  appendMergeLatest(file, { email: 'a@x', api_key: 'sk-x', balance_usd: 5 });
  appendMergeLatest(file, { email: 'a@x', balance_usd: 5.5, checked_at: 'now' });
  const [rec] = latestWins(file, 'email');
  assert.equal(rec.api_key, 'sk-x');      // identity survived the partial update
  assert.equal(rec.balance_usd, 5.5);
  assert.equal(rec.checked_at, 'now');
});

test('readTail returns parsed events, clipping from the end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-jsonl-'));
  const file = join(dir, 'events.jsonl');
  for (let i = 0; i < 10; i++) appendJsonl(file, { ts: 't' + i, event: 'e' + i });
  const tail = readTail(file, 4096);
  assert.equal(tail.length, 10);
  assert.equal(tail[9].event, 'e9');
  assert.ok(fileSig(file) === fileSig(file));
  assert.ok(fileSig(join(dir, 'missing.jsonl')) === '');
});
