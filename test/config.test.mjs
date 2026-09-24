// Config loader contracts: .env.local merge, overrides strip empties.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfigLoader, loadDotEnv, splitList } from '../src/config.mjs';

test('loadDotEnv parses simple KEY=VALUE with quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-cfg-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'A=1\nB="two words"\nC=three words # comment\n');
  const env = loadDotEnv(f);
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two words');
  assert.equal(env.C, 'three words # comment');
});

test('makeConfigLoader: defaults + env-mapped values + overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-cfg-'));
  const root = join(dir, 'proj');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.env.local'), 'OT_COUNT=7\n');
  const load = makeConfigLoader(root, {
    count: (env) => Number(env.OT_COUNT || 1),
    name: 'fixed',
    gap: 1000,
  });
  const cfg = load({ accountsFile: '' }); // empty override must not clobber
  assert.equal(cfg.count, 7);
  assert.equal(cfg.name, 'fixed');
  assert.equal(cfg.gap, 1000);
  assert.equal(cfg.accountsFile, undefined);
  const cfg2 = load({ count: '3' });
  assert.equal(cfg2.count, '3');
});

test('splitList trims, lowercases, strips @, drops empties', () => {
  assert.deepEqual(splitList(' A.com, @B.com ,c.com, , '), ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(splitList(''), []);
});
