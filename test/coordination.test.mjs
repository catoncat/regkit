// Coordination-state safety (review P1): health.json and fleet.local.json are
// read-modify-written by several processes (tick, patrol, fleet verbs, keepers).
// These cases prove (a) writers serialize across PROCESSES, (b) a writer merges
// into the current state instead of clobbering a concurrent decision, and (c) an
// unreadable coordination file fails CLOSED while a merely missing one does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readHealthState, gateDecision, updateHealth, step, loadHealth, isGated } from '../src/health.mjs';
import { buildFleetProviders, createHealthGate } from '../src/fleet-hub.mjs';
import { adopt } from '../src/fleet.mjs';
import { buildKeeperHealthFor } from '../src/watch.mjs';

const execFileP = promisify(execFile);
const REPO = join(fileURLToPath(new URL('./', import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'rk-coord-'));
const now = new Date('2026-09-17T12:00:00Z');
// ── strict read + one gate decision ──
test('readHealthState: missing vs ok vs unreadable are distinguishable', () => {
  const dir = tmp();
  const p = join(dir, 'health.json');
  assert.deepEqual(readHealthState(p), { state: 'missing', health: null, error: null });

  writeFileSync(p, JSON.stringify({ status: 'halted', reason: 'no-credit' }));
  assert.equal(readHealthState(p).state, 'ok');
  assert.equal(readHealthState(p).health.reason, 'no-credit');

  writeFileSync(p, '{"status": "halted"'); // torn/partial write
  const bad = readHealthState(p);
  assert.equal(bad.state, 'unreadable');
  assert.equal(bad.health, null);
  assert.ok(bad.error);

  writeFileSync(p, '[1,2,3]'); // valid JSON, wrong shape
  assert.equal(readHealthState(p).state, 'unreadable');

  assert.equal(loadHealth(p), null, 'lenient loader (display paths) stays lenient');
});

test('gateDecision: unreadable fails closed, missing stays open, ok defers to isGated', () => {
  assert.deepEqual(gateDecision({ state: 'missing', health: null }), { gated: false, health: null, reason: null });

  const delisted = { status: 'ok', reason: null, evidence: { delisted_models: ['m'] } };
  assert.equal(gateDecision({ state: 'ok', health: delisted }).gated, false); // a delisted model is not a gate
  assert.equal(isGated(delisted), false);

  const halted = { status: 'halted', reason: 'register-broken' };
  assert.equal(gateDecision({ state: 'ok', health: halted }).gated, true);
  assert.equal(gateDecision({ state: 'ok', health: halted }).reason, 'register-broken');

  assert.equal(gateDecision({ state: 'ok', health: { status: 'degraded', reason: 'pool-broken' } }).gated, true);

  const unreadable = gateDecision({ state: 'unreadable', health: null, error: 'torn' });
  assert.equal(unreadable.gated, true);
  assert.equal(unreadable.reason, 'health-unreadable');
  assert.equal(gateDecision().gated, false, 'no state at all == nothing detected yet');
});

// ── cross-process serialization ─
test('updateHealth: 8 concurrent PROCESSES each increment without losing one', async () => {
  const dir = tmp();
  const healthPath = join(dir, 'health.json');
  const mod = join(REPO, 'src', 'health.mjs');
  const script = `import { updateHealth } from ${JSON.stringify(mod)};`
    + `updateHealth(process.argv[1], (cur) => ({ ...(cur || {}), n: ((cur && cur.n) || 0) + 1 }));`;
  await Promise.all(Array.from({ length: 8 }, () =>
    execFileP(process.execPath, ['--input-type=module', '-e', script, healthPath])));
  assert.equal(loadHealth(healthPath).n, 8, 'an update was lost across processes');
  assert.equal(existsSync(healthPath + '.lock'), false, 'lock must be released');
});


test('step: derives from the CURRENT file — a concurrent patrol verdict survives', async () => {
  const dir = tmp();
  const healthPath = join(dir, 'health.json');
  const eventsFile = join(dir, 'events.jsonl');
  // unit was already halted by the patrol judge; the patrol field is its evidence
  writeFileSync(healthPath, JSON.stringify({
    status: 'halted', reason: 'patrol: mechanism-changed', since: '2026-09-16T00:00:00Z',
    actions: ['stopRegistrar', 'stopSupply', 'haltProject'],
    patrol: { at: '2026-09-16T00:00:00Z', provider: 'fleet-gateway', verdict: 'mechanism-changed', reason: 'new wall' },
    last_reprobe_at: '2026-09-16T00:00:00Z',
  }));
  // a fresh register-broken window arrives mid-flight
  const lines = [
    ...Array.from({ length: 4 }, () => JSON.stringify({ ts: '2026-09-17T11:00:00Z', event: 'reg.fail', klass: 'http', detail: 'server action 404' })),
    ...Array.from({ length: 3 }, () => JSON.stringify({ ts: '2026-09-17T11:30:00Z', event: 'batch.done', ok: 0 })),
  ];
  writeFileSync(eventsFile, lines.join('\n') + '\n');

  const r = await step({ healthPath, eventsFile, now });
  assert.equal(r.next.status, 'halted');
  assert.equal(r.next.reason, 'register-broken');
  assert.equal(r.next.patrol.verdict, 'mechanism-changed', 'patrol verdict was clobbered');
  assert.equal(loadHealth(healthPath).patrol.provider, 'fleet-gateway');
});

// ── fail-closed gates ──
test('fleet-hub: corrupt health.json closes the LIVE gate, missing health.json serves', async () => {
  const root = tmp();
  const mk = (name, health) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify({
      id: name, kind: 'registrar', gateway: { prefix: name, base: 'https://api.' + name + '.example.com/v1' },
      accounts: 'data/accounts.jsonl',
    }));
    if (health !== undefined) writeFileSync(join(dir, 'data', 'health.json'), health);
    return dir;
  };
  mk('bad', '{"status": "ok"');                       // corrupt
  mk('fresh');                                       // never detected
  mk('gone', JSON.stringify({ status: 'halted', reason: 'register-broken' }));

  const { providers, entries } = await buildFleetProviders({ roots: [root] });
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  // health never bakes a `disabled` into the provider: every unit gets a live pool
  // and the per-request gate decides — so a repaired/recovered file re-admits it
  // without a gateway restart.
  for (const id of ['bad', 'fresh', 'gone']) assert.equal(byId[id].disabled, undefined, id + ' must be a live provider');

  const gate = createHealthGate(entries, { ttlMs: 0 });
  assert.equal(await gate(byId.bad), false, 'unreadable health closes the gate');
  assert.equal(await gate(byId.fresh), true, 'a project with no health.json must still serve');
  assert.equal(await gate(byId.gone), false);
  // repair the corrupt file: admitted on the next decision, no rebuild
  writeFileSync(join(root, 'bad', 'data', 'health.json'), JSON.stringify({ status: 'ok', reason: null }));
  assert.equal(await gate(byId.bad), true);
});

test('keeper health reader: unreadable blocks supply and is announced; missing stays open', async () => {
  const dir = tmp();
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ status: 'halted', reason: 'no-credit', actions: ['stopSupply'] }));
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, 'not json at all');

  const goodUp = { id: 'u', healthFile: good };
  const read = buildKeeperHealthFor({}, [goodUp]);
  assert.equal((await read(goodUp)).reason, 'no-credit');

  const brokenUp = { id: 'u2', healthFile: broken };
  const readBroken = buildKeeperHealthFor({}, [brokenUp]);
  const gated = await readBroken(brokenUp);
  assert.equal(gated.reason, 'health-unreadable');
  assert.deepEqual(gated.actions, ['stopSupply']);

  const events = [];
  const brokenUp3 = { id: 'u3', healthFile: broken };
  const withEmit = buildKeeperHealthFor({}, [brokenUp3], (name, fields) => events.push([name, fields]));
  await withEmit(brokenUp3);
  assert.deepEqual(events, [['health.unreadable', { upstream: 'u3', health: broken }]]);

  assert.equal(await buildKeeperHealthFor({}, [{ id: 'x' }])({ id: 'x' }), null, 'no health configured at all = ungated');
});

// ── desired-state concurrency ──
test('adopt: concurrent PROCESSES never collide on a port, gateway port is reserved', async () => {
  const root = tmp();
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48780, gatewayToken: 't', ports: {}, units: {} }));
  const units = ['aaa', 'bbb', 'ccc'].map((id) => {
    const dir = join(root, id);
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify({ id, kind: 'registrar' }));
    return dir;
  });
  const mod = join(REPO, 'src', 'fleet.mjs');
  const script = `import { adopt } from ${JSON.stringify(mod)};`
    + `adopt({ unitDir: process.argv[1], fleetFile: process.argv[2], writePlist: false })`
    + `.then((p) => process.stdout.write(String(p.port)));`;
  const out = await Promise.all(units.map((dir) =>
    execFileP(process.execPath, ['--input-type=module', '-e', script, dir, fleetFile])));
  const ports = out.map((r) => Number(r.stdout.trim()));
  assert.equal(new Set(ports).size, 3, 'ports collided: ' + ports.join(','));
  assert.equal(ports.includes(48780), false, 'the resident gateway port was handed to a unit');
  for (const p of ports) assert.ok(p >= 48781 && p <= 48799, 'port out of range: ' + p);

  const saved = JSON.parse(readFileSync(fleetFile, 'utf8'));
  assert.deepEqual(Object.keys(saved.units).sort(), ['aaa', 'bbb', 'ccc']);
  assert.equal(Object.values(saved.units).every((u) => u.enabled), true);
  assert.equal(new Set(Object.values(saved.ports)).size, 3);
});