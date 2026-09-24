// probeFleet: end-to-end viability verdicts (machine-judgeable half of state).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeFleet } from '../src/fleet.mjs';
import { loadHealth } from '../src/health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-probe-'));
const mkunit = (root, name, service, accounts) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  if (accounts) writeFileSync(join(dir, 'data', 'accounts.jsonl'), JSON.stringify(accounts) + '\n');
  return dir;
};
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('probeFleet: 200 = viable, recorded next to health.json', async () => {
  const root = tmp();
  const dir = mkunit(root, 'a-proj', { id: 'aaa', gateway: { prefix: 'a', aliases: { cheap: 'm1' } }, accounts: 'data/accounts.jsonl' },
    { email: 'a@x', status: 'verified', api_key: 'k', balance_usd: 5 });
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'tok' }));
  const out = await probeFleet({
    roots: [root], fleetFile,
    fetchFn: async (url, init) => {
      assert.ok(url.includes(':48790/v1/chat/completions'));
      assert.equal(JSON.parse(init.body).model, 'cheap');
      return jsonResp({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].http, 200);
  assert.equal(loadHealth(join(dir, 'data', 'health.json')).probe.ok, true);
});

test('probeFleet: non-200 and thrown fetch are verdicts, not crashes; no-models skipped', async () => {
  const root = tmp();
  mkunit(root, 'a-proj', { id: 'aaa', gateway: { aliases: { m: 'm1' } }, accounts: 'data/accounts.jsonl' },
    { email: 'a@x', status: 'verified', api_key: 'k', balance_usd: 5 });
  mkunit(root, 'b-proj', { id: 'bbb', gateway: { aliases: { m: 'm1' } }, accounts: 'data/accounts.jsonl' },
    { email: 'b@x', status: 'verified', api_key: 'k', balance_usd: 5 });
  mkunit(root, 'c-proj', { id: 'ccc', kind: 'external', remoteHealth: 'http://127.0.0.1:1/healthz' });
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'tok' }));
  let n = 0;
  const out = await probeFleet({
    roots: [root], fleetFile,
    fetchFn: async () => {
      n += 1;
      if (n === 1) return jsonResp({ error: { type: 'pool_exhausted' } }, 503);
      throw new Error('ECONNREFUSED');
    },
  });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.aaa.ok, false);
  assert.equal(byId.aaa.http, 503);
  assert.equal(byId.bbb.ok, false);
  assert.equal(byId.bbb.http, 0);
  assert.equal(byId.ccc.ok, null);
  assert.equal(byId.ccc.why, 'no-models');
});
