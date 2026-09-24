// fleet tick + doctor: detection lives at fleet level, not in
// project watchers. tick merges project events.jsonl with the gateway's
// fleet-events.jsonl (filtered by upstream) and runs health.step per unit —
// sunset units included (they have no watcher; tick is their only detector).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick, doctor, probeUnitDirect, fleetEventsFileFor } from '../src/fleet.mjs';
import { loadHealth } from '../src/health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-tick-'));
const mkunit = (root, name, service, { events = [], accounts = [] } = {}) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  if (events.length) writeFileSync(join(dir, 'data', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (accounts.length) writeFileSync(join(dir, 'data', 'accounts.jsonl'), accounts.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
};
const svc = (id, extra = {}) => ({
  id, kind: 'registrar', lifecycle: 'active',
  gateway: { prefix: id, base: 'https://api.example.com/v1', port: 48791, aliases: { m: 'real-model' } },
  accounts: 'data/accounts.jsonl',
  ...extra,
});
const now = new Date('2026-09-16T12:00:00Z');
const ts = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();

test('tick: register-broken from PROJECT events halts the unit (stopRegistrar chain)', async () => {
  const root = tmp();
  const events = [];
  for (let i = 0; i < 3; i++) events.push({ ts: ts(10 - i), event: 'batch.done', ok: 0 });
  for (let i = 0; i < 4; i++) events.push({ ts: ts(8), event: 'reg.fail', klass: 'http', detail: 'turnstile blocked forever' });
  const dir = mkunit(root, 'p', svc('ppp'), { events });
  const fleetFile = join(root, 'fleet.local.json');
  const r = await tick({ roots: [root], fleetFile, now });
  assert.equal(r.results[0].to, 'halted');
  assert.equal(r.results[0].reason, 'register-broken');
  const h = loadHealth(join(dir, 'data', 'health.json'));
  assert.equal(h.status, 'halted');
  assert.deepEqual(h.actions, ['stopRegistrar', 'stopSupply', 'haltProject']);
  // transition event lands in the PROJECT's events.jsonl (first one ever)
  const tail = readFileSync(join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(tail.at(-1).event, 'health.transition');
});

test('tick: pool-broken from FLEET gateway events (upstream-tagged ai.fail)', async () => {
  const root = tmp();
  const dir = mkunit(root, 'p', svc('ppp'));
  const fleetFile = join(root, 'fleet.local.json');
  const fleetEvents = fleetEventsFileFor(fleetFile);
  mkdirSync(join(root, 'data'), { recursive: true });
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push({ ts: ts(5), event: 'ai.fail', upstream: 'ppp', klass: 'balance', detail: '402 payment required' });
  lines.push({ ts: ts(5), event: 'ai.ok', upstream: 'ppp' });
  // another unit's failures must NOT leak into ppp's window
  for (let i = 0; i < 8; i++) lines.push({ ts: ts(4), event: 'ai.fail', upstream: 'other', klass: 'network', detail: 'boom' });
  writeFileSync(fleetEvents, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = await tick({ roots: [root], fleetFile, now });
  assert.equal(r.results[0].to, 'degraded');
  assert.equal(r.results[0].reason, 'pool-broken');
  const h = loadHealth(join(dir, 'data', 'health.json'));
  assert.equal(h.status, 'degraded');
  assert.deepEqual(h.actions, ['removeModels']);
});

test('tick: sunset units are ticked (no watcher exists for them); dead and drained are skipped', async () => {
  const root = tmp();
  // sunset with balance: ticked
  mkunit(root, 'sun', svc('sunsetp', { lifecycle: 'sunset' }), {
    accounts: [{ email: 'a@x.io', status: 'verified', balance_usd: 5 }],
  });
  // sunset drained to zero: effective dead, skipped
  mkunit(root, 'dry', svc('dryp', { lifecycle: 'sunset' }), {
    accounts: [{ email: 'b@x.io', status: 'verified', balance_usd: 0 }],
  });
  // dead: skipped
  mkunit(root, 'dead', svc('deadp', { lifecycle: 'dead' }));
  const r = await tick({ roots: [root], fleetFile: join(root, 'fleet.local.json'), now });
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId.sunsetp.to, 'ok');         // ticked, nothing firing
  assert.equal(byId.dryp.skipped, 'effective-dead');
  assert.equal(byId.deadp.skipped, 'dead');
});

test('tick: halted unit reprobe pass marks recoverable but does NOT auto-resume', async () => {
  const root = tmp();
  const dir = mkunit(root, 'p', svc('ppp'));
  const healthPath = join(dir, 'data', 'health.json');
  writeFileSync(healthPath, JSON.stringify({
    status: 'halted', reason: 'no-credit', since: ts(60 * 30),
    last_reprobe_at: ts(60 * 25), // due (> 24h)
  }));
  const r = await tick({
    roots: [root], fleetFile: join(root, 'fleet.local.json'), now,
    probeForUnit: async () => ({ ok: true, note: 'http 200' }),
  });
  assert.equal(r.results[0].to, 'halted');           // still halted
  assert.equal(r.results[0].recoverable, true);      // but flagged
  const h = loadHealth(healthPath);
  assert.equal(h.status, 'halted');
  assert.equal(h.recoverable, true);
  assert.equal(h.probe_note, 'http 200');
});

test('probeUnitDirect: one verified key against the upstream models endpoint', async () => {
  const root = tmp();
  const decl = {
    gateway: { base: 'https://api.example.com/v1/' },
    accounts: join(root, 'accounts.jsonl'),
  };
  appendFileSync(decl.accounts, JSON.stringify({ email: 'a@x.io', status: 'verified', api_key: 'sk-test' }) + '\n');
  let seen = null;
  const r = await probeUnitDirect({
    decl,
    fetchFn: async (url, init) => { seen = { url, auth: init.headers.authorization }; return new Response('{}', { status: 200 }); },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.example.com/v1/models');
  assert.equal(seen.auth, 'Bearer sk-test');
  const noKey = await probeUnitDirect({ decl: { gateway: { base: 'https://x' }, accounts: join(root, 'missing.jsonl') } });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.note, 'no-verified-key');
});

test('doctor: reports drift, never mutates — sunset-but-enabled, enabled-but-not-loaded, off-but-alive', async () => {
  const root = tmp();
  const res = { cmd: 'node src/cli.mjs watch', pattern: 'src/cli.mjs watch' };
  mkunit(root, 'sun', svc('sunsetp', { lifecycle: 'sunset', resident: res }));
  mkunit(root, 'fine', svc('finep', { resident: res }));
  mkunit(root, 'ghost', svc('ghostp', { resident: res }));
  mkunit(root, 'zombie', svc('zombiep', { lifecycle: 'sunset', resident: res }));   // declared off, yet its port answers
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({
    gatewayPort: 48790,
    ports: { sunsetp: 48781, finep: 48782, ghostp: 48783, zombiep: 48784 },
    units: { sunsetp: { enabled: true }, finep: { enabled: true }, ghostp: { enabled: true }, zombiep: { enabled: false } },
  }));
  const plistDir = join(root, 'LaunchAgents');
  mkdirSync(plistDir, { recursive: true });
  for (const id of ['sunsetp', 'finep', 'ghostp']) writeFileSync(join(plistDir, 'com.regkit.fleet.' + id + '.plist'), '<plist/>');
  const r = await doctor({
    roots: [root], fleetFile, now, plistDir,
    probe: async (port) => port === 48790 || port === 48782 || port === 48784, // gateway + finep + the zombie listen; ghostp doesn't
    listProcesses: async () => [{ pid: 1, etime: '01:00', cmd: 'node src/cli.mjs watch' }], // everyone pattern-matches alive
    listLaunchd: async () => new Set(['com.regkit.fleet.gateway', 'com.regkit.fleet.finep']),
  });
  const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.ok(byId.sunsetp.drifts.some((d) => d.includes('期望态还开着')));
  assert.ok(byId.ghostp.drifts.some((d) => d.includes('launchd 没加载')));
  assert.ok(!byId.ghostp.drifts.some((d) => d.includes('没在听')), 'a silent project port is the norm (embedded gateway is debug-only; the fleet gateway serves)');
  assert.equal(byId.finep.drifts.length, 0);
  assert.ok(byId.zombiep.drifts.some((d) => d.includes('已关但还有进程在跑它') && d.includes('48784')), 'off-but-alive is a drift, with the port that gave it away');
  // every fixture declares alias 'm': the hub will refuse the bare name, so doctor must say who collides
  assert.ok(r.gateway.drifts.some((d) => d.includes('别名 m') && d.includes('sunsetp') && d.includes('zombiep')), 'alias claimed by several declarations is a gateway drift');
  assert.equal(r.ok, false);
});

test('doctor: clean fleet reports ok (gateway + one healthy unit)', async () => {
  const root = tmp();
  mkunit(root, 'fine', svc('finep', { resident: { cmd: 'node src/cli.mjs watch', pattern: 'src/cli.mjs watch' } }));
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({
    gatewayPort: 48790, ports: { finep: 48782 }, units: { finep: { enabled: true } },
  }));
  const plistDir = join(root, 'LaunchAgents');
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(join(plistDir, 'com.regkit.fleet.finep.plist'), '<plist/>');
  const r = await doctor({
    roots: [root], fleetFile, now, plistDir,
    probe: async () => true,
    listProcesses: async () => [{ pid: 1, etime: '01:00', cmd: 'node src/cli.mjs watch' }],
    listLaunchd: async () => new Set(['com.regkit.fleet.gateway', 'com.regkit.fleet.finep']),
  });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].drifts.length, 0);
});
