// Management verbs: recover / sunset / retire / projectHealth / refreshCatalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recover, sunset, retire, projectHealth, refreshCatalog, loadFleetLocal } from '../src/fleet.mjs';
import { loadHealth } from '../src/health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-verbs-'));
const mkunit = (root, name, service, health = null) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  if (health) writeFileSync(join(dir, 'data', 'health.json'), JSON.stringify(health));
  return dir;
};

test('recover: halted+recoverable resumes; second call is a no-op; unknown id throws', async () => {
  const root = tmp();
  const dir = mkunit(root, 'p', { id: 'ppp' }, { status: 'halted', reason: 'no-credit', recoverable: true });
  const r1 = await recover({ id: 'ppp', roots: [root] });
  assert.equal(r1.recovered, true);
  assert.equal(r1.forced, false);
  assert.equal(loadHealth(join(dir, 'data', 'health.json')).status, 'ok');
  // 转移事件落在该项目 events.jsonl
  const ev = readFileSync(join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev.at(-1).event, 'health.transition');
  assert.equal(ev.at(-1).to.status, 'ok');
  const r2 = await recover({ id: 'ppp', roots: [root] });
  assert.equal(r2.recovered, false);
  assert.equal(r2.why, 'not-halted');
  await assert.rejects(() => recover({ id: 'ghost', roots: [root] }), /unknown unit/);
});

test('recover: halted but not yet recoverable = forced (user axis wins, we say so)', async () => {
  const root = tmp();
  mkunit(root, 'p', { id: 'ppp' }, { status: 'halted', reason: 'register-broken', recoverable: false });
  const r = await recover({ id: 'ppp', roots: [root] });
  assert.equal(r.recovered, true);
  assert.equal(r.forced, true);
});

test('sunset: writes lifecycle into service.json and flips desired state off', async () => {
  const root = tmp();
  const dir = mkunit(root, 'p', { id: 'ppp', lifecycle: 'active' });
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ units: { ppp: { enabled: true } }, ports: { ppp: 48791 } }));
  const r = await sunset({ id: 'ppp', roots: [root], fleetFile });
  assert.equal(r.lifecycle, 'sunset');
  assert.equal(r.mode.action, 'bootout');
  assert.equal(JSON.parse(readFileSync(join(dir, 'data', 'service.json'), 'utf8')).lifecycle, 'sunset');
  assert.equal(loadFleetLocal(fleetFile).units.ppp.enabled, false);
  const r2 = await retire({ id: 'ppp', roots: [root], fleetFile });
  assert.equal(JSON.parse(readFileSync(join(dir, 'data', 'service.json'), 'utf8')).lifecycle, 'dead');
});

test('projectHealth: unit status + health.json in one object', async () => {
  const root = tmp();
  mkunit(root, 'p', { id: 'ppp' }, { status: 'degraded', reason: 'model-delisted' });
  const out = await projectHealth({ id: 'ppp', roots: [root], fleetFile: join(root, 'missing.json') });
  assert.equal(out.unit.id, 'ppp');
  assert.equal(out.health.reason, 'model-delisted');
  await assert.rejects(() => projectHealth({ id: 'ghost', roots: [root], fleetFile: join(root, 'missing.json') }), /unknown unit/);
});

test('refreshCatalog: hits the gateway refresh endpoint with token and upstream', async () => {
  const root = tmp();
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'tok' }));
  let seen = null;
  const out = await refreshCatalog({
    id: 'alpha', fleetFile,
    fetchFn: async (url, init) => {
      seen = { url, auth: init.headers.authorization };
      return new Response(JSON.stringify({ refreshed: ['alpha'], models: 5 }), { status: 200 });
    },
  });
  assert.match(seen.url, /127\.0\.0\.1:48790\/v1\/models\/refresh\?upstream=alpha/);
  assert.equal(seen.auth, 'Bearer tok');
  assert.equal(out.models, 5);
});
