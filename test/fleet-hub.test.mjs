// fleet-hub: declarations -> providers, classify dynamic loading, health gating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { appendJsonl } from '../src/jsonl.mjs';
import { createLogger } from '../src/logger.mjs';
import { loadClassify, buildFleetProviders, createHealthGate, buildFleetHub } from '../src/fleet-hub.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-fh-'));
const quietLog = (dir) => createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
const writeService = (root, name, service) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  return dir;
};

test('loadClassify: loads exported classifyFailure, isolates missing module', async () => {
  const dir = tmp();
  const proto = join(dir, 'protocol.mjs');
  writeFileSync(proto, 'export function classifyFailure(s) { return s === 402 ? "balance" : "client"; }');
  const ok = await loadClassify(proto);
  assert.equal(ok.classifyFailure(402), 'balance');
  const missing = await loadClassify(join(dir, 'nope.mjs'));
  assert.match(missing.error, /nope/);
  const noExport = join(dir, 'empty.mjs');
  writeFileSync(noExport, 'export const x = 1;');
  assert.match((await loadClassify(noExport)).error, /no classifyFailure/);
});

test('buildFleetProviders: classify ok / classify fail isolated / halted stays a LIVE pool / flags mapped', async () => {
  const root = tmp();
  // unit a: protocol loads fine
  const aDir = writeService(root, 'a-proj', {
    id: 'aaa', protocol: 'src/protocol.mjs',
    gateway: { prefix: 'a', base: 'https://a/v1', aliases: { cheap: 'a/model' }, dialect: { injectFields: { x: 1 } } },
    accounts: 'data/accounts.jsonl', usage: 'data/usage.jsonl', rates: { in: 1, out: 2 },
  });
  mkdirSync(join(aDir, 'src'), { recursive: true });
  writeFileSync(join(aDir, 'src', 'protocol.mjs'), 'export const classifyFailure = (s) => s === 402 ? "balance" : "client";');
  appendJsonl(join(aDir, 'data', 'accounts.jsonl'), { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  // unit b: protocol missing -> isolated, others unaffected
  writeService(root, 'b-proj', { id: 'bbb', protocol: 'src/protocol.mjs', gateway: { base: 'https://b/v1' } });
  // unit c: health halted at BUILD time -> still a live provider (the gate excludes
  // it per request); baking the verdict in as `disabled` would make recover need a
  // gateway restart.
  const cDir = writeService(root, 'c-proj', { id: 'ccc', gateway: { base: 'https://c/v1', balanceEligible: 'always' } });
  writeFileSync(join(cDir, 'data', 'health.json'), JSON.stringify({ status: 'halted', reason: 'no-credit' }));

  const { providers, entries } = await buildFleetProviders({ roots: [root], log: quietLog(root) });
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  assert.equal(byId.aaa.classifyFailure(402), 'balance');
  assert.deepEqual(byId.aaa.rates(), { in: 1, out: 2 });
  assert.equal(byId.aaa.dialect.injectFields.x, 1);
  assert.match(byId.bbb.disabled, /classify-load-failed/);
  assert.equal(byId.ccc.disabled, undefined, 'health never disables at build time');
  assert.equal(typeof byId.ccc.balanceEligible, 'function', 'halted pool keeps its pool hooks');
  const gate = createHealthGate(entries, { ttlMs: 0 });
  assert.equal(await gate({ id: 'ccc' }), false, 'the live gate is what excludes it');
  writeFileSync(join(cDir, 'data', 'health.json'), JSON.stringify({ status: 'ok', reason: null }));
  assert.equal(await gate({ id: 'ccc' }), true, 'recover flips it back without a rebuild');
});

test('createHealthGate: live flip to halted excludes without rebuild', async () => {
  const root = tmp();
  const dir = writeService(root, 'p', { id: 'ppp', gateway: { base: 'https://p/v1' } });
  const { entries } = await buildFleetProviders({ roots: [root], log: quietLog(root) });
  const gate = createHealthGate(entries, { ttlMs: 0 });
  assert.equal(await gate({ id: 'ppp' }), true);
  writeFileSync(join(dir, 'data', 'health.json'), JSON.stringify({ status: 'halted', reason: 'register-broken' }));
  assert.equal(await gate({ id: 'ppp' }), false);
  writeFileSync(join(dir, 'data', 'health.json'), JSON.stringify({ status: 'degraded', reason: 'pool-broken' }));
  assert.equal(await gate({ id: 'ppp' }), false);
  writeFileSync(join(dir, 'data', 'health.json'), JSON.stringify({ status: 'degraded', reason: 'model-delisted' }));
  assert.equal(await gate({ id: 'ppp' }), true); // delisted alone does not gate the pool
});

test('buildFleetHub end-to-end: gated pool out of catalog, alias routes, blocklist filters', async () => {
  const root = tmp();
  // real fake upstream for the active pool
  const up = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'live-model' }, { id: 'old-model' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const port = up.address().port;

  const aDir = writeService(root, 'a-proj', {
    id: 'aaa', gateway: { prefix: 'a', base: 'http://127.0.0.1:' + port + '/v1', aliases: { fast: 'live-model' } },
    accounts: 'data/accounts.jsonl', usage: 'data/usage.jsonl',
  });
  appendJsonl(join(aDir, 'data', 'accounts.jsonl'), { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  // delist old-model via health evidence
  writeFileSync(join(aDir, 'data', 'health.json'), JSON.stringify({ status: 'degraded', reason: 'model-delisted', evidence: { delisted_models: ['old-model'] } }));
  const gDir = writeService(root, 'g-proj', { id: 'ggg', gateway: { base: 'https://g/v1', models: ['gated-model'] } });
  writeFileSync(join(gDir, 'data', 'health.json'), JSON.stringify({ status: 'halted', reason: 'no-credit' }));

  const hub = await buildFleetHub({ log: quietLog(root), roots: [root], fleetFile: join(root, 'missing-fleet.json'), token: 'tok', gateTtlMs: 0 });
  const merged = await hub.mergedModels();
  const ids = merged.data.map((m) => m.id);
  assert.ok(ids.includes('live-model'));
  assert.ok(!ids.includes('old-model'), 'blocklisted model filtered from catalog');
  assert.ok(!ids.includes('gated-model'), 'halted pool excluded from catalog');

  const route = await hub.route('fast');
  assert.equal(route.provider.id, 'aaa');
  assert.equal(route.model, 'live-model');
  assert.equal(await hub.route('gated-model'), null, 'gated pool not routable');

  // the per-upstream listing follows the same gate as the merged catalog
  await new Promise((r) => hub.server.listen(0, '127.0.0.1', r));
  const gp = hub.server.address().port;
  const H = { authorization: 'Bearer tok', connection: 'close' };
  const gated = await fetch('http://127.0.0.1:' + gp + '/v1/models?upstream=ggg', { headers: H });
  assert.equal(gated.status, 404);
  assert.equal((await gated.json()).error.type, 'upstream_gated');
  const live = await fetch('http://127.0.0.1:' + gp + '/v1/models?upstream=aaa', { headers: H });
  assert.equal(live.status, 200);
  assert.deepEqual((await live.json()).data.map((m) => m.id), ['live-model']);
  const health = await (await fetch('http://127.0.0.1:' + gp + '/health', { headers: H })).json();
  assert.ok(health.upstreams.ggg, 'gated pool stays visible in /health');
  assert.equal(health.upstreams.ggg.gated, true, '/health says WHY it is not serving');
  assert.equal(health.upstreams.aaa.gated, false);
  assert.equal(health.totals.gated, 1);
  assert.equal(health.totals.eligible_keys, 1, 'gated pool keys are not counted as serving capacity');
  hub.server.closeAllConnections?.(); hub.server.close();
  up.close();
});

test('POST /v1/models/refresh re-pulls dynamic catalogs, skips static', async () => {
  const { createHub } = await import('../src/hub.mjs');
  let modelCalls = 0;
  const up = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      modelCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'dyn-model' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const dir = tmp();
  const accountsFile = join(dir, 'accounts.jsonl');
  appendJsonl(accountsFile, { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  const hub = createHub({
    log: quietLog(dir), token: 't',
    providers: [
      { id: 'dyn', base: 'http://127.0.0.1:' + up.address().port + '/v1', accountsFile, usagePath: join(dir, 'u.jsonl'), rates: () => ({ in: 1, out: 1 }), classifyFailure: (s) => (s >= 500 ? 'network' : 'client') },
      { id: 'stat', base: 'http://127.0.0.1:1/v1', accountsFile, usagePath: join(dir, 'u.jsonl'), rates: () => ({ in: 1, out: 1 }), classifyFailure: () => 'client', models: ['static-model'] },
    ],
  });
  const server = hub.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const H = { authorization: 'Bearer t', connection: 'close' }; // no keep-alive: let the runner exit
  const get = () => fetch('http://127.0.0.1:' + port + '/v1/models', { headers: H }).then((r) => r.json());
  const post = (q) => fetch('http://127.0.0.1:' + port + '/v1/models/refresh' + q, { method: 'POST', headers: H }).then((r) => r.json());

  await get();
  assert.equal(modelCalls, 1);
  await get();
  assert.equal(modelCalls, 1);           // cached
  const r1 = await post('');
  assert.deepEqual(r1.refreshed, ['dyn']); // static pool untouched
  assert.equal(modelCalls, 2);           // re-pulled during mergedModels
  const r2 = await post('?upstream=stat');
  assert.deepEqual(r2.refreshed, []);      // static never re-pulled
  assert.equal(modelCalls, 2);
  server.closeAllConnections?.(); server.close();
  up.closeAllConnections?.(); up.close();
});

