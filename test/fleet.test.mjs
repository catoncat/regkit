// fleet.mjs slice-1 tests: declaration, state vocabulary, ports, discovery, status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  validateService, scanServices, loadFleetLocal, allocPort, deriveState,
  probePort, lockPidAlive, lastEventAgeMin, poolSummary, modelsOf,
  findOrphans, status,
} from '../src/fleet.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fleet-'));
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

// ── validateService ──
test('validateService: minimal declaration gets defaults', () => {
  const d = validateService({ id: 'alpha' }, { unitDir: '/p/alpha' });
  assert.equal(d.id, 'alpha');
  assert.equal(d.kind, 'registrar');
  assert.equal(d.lifecycle, 'active');
  assert.equal(d.staleAfterMin, 1440);
  assert.equal(d.events, '/p/alpha/data/events.jsonl');
});
test('validateService: rejects bad id/kind/lifecycle and bad spawn', () => {
  assert.throws(() => validateService({ id: 'Bad_ID' }), /bad id/);
  assert.throws(() => validateService({ id: 'x', kind: 'weird' }), /bad kind/);
  assert.throws(() => validateService({ id: 'x', lifecycle: 'zzz' }), /bad lifecycle/);
  assert.throws(() => validateService({ id: 'x', spawn: {} }), /spawn.pattern/);
  assert.throws(() => validateService(null), /must be an object/);
});
test('validateService: resolves paths against unitDir, passes dialect through', () => {
  const d = validateService({
    id: 'ot', accounts: 'data/accounts.jsonl', usage: 'data/usage.jsonl',
    gateway: { prefix: 'ot', base: 'https://x/v1', aliases: { 'ds-flash': 'deepseek-v4-flash' }, dialect: { rewriteRoles: { developer: 'system' } } },
    spawn: { cmd: 'node src/ot.mjs register', pattern: 'src/ot.mjs register' },
  }, { unitDir: '/p/epsilon' });
  assert.equal(d.accounts, '/p/epsilon/data/accounts.jsonl');
  assert.equal(d.gateway.dialect.rewriteRoles.developer, 'system');
  assert.deepEqual(modelsOf(d), ['ds-flash']);
});

// ── deriveState: the five-value vocabulary, precedence order ──
test('deriveState: full truth table', () => {
  assert.equal(deriveState({ declared: false, enabled: false, alive: true }), 'orphan');
  assert.equal(deriveState({ declared: true, enabled: false, alive: true }), 'off');
  assert.equal(deriveState({ declared: true, enabled: true, alive: false }), 'down');
  assert.equal(deriveState({ declared: true, enabled: true, alive: true, lastEventAgeMin: null }), 'running');
  assert.equal(deriveState({ declared: true, enabled: true, alive: true, lastEventAgeMin: 10, staleAfterMin: 1440 }), 'running');
  assert.equal(deriveState({ declared: true, enabled: true, alive: true, lastEventAgeMin: 2000, staleAfterMin: 1440 }), 'stale');
  assert.equal(deriveState({ declared: true, enabled: true, alive: true, lastEventAgeMin: 2000, staleAfterMin: 3000 }), 'running');
});

// ── allocPort ──
test('allocPort: preferred wins when free, else first free in range', () => {
  assert.equal(allocPort({ table: {}, preferred: 48790 }), 48790);
  assert.equal(allocPort({ table: { a: 48790 }, preferred: 48790 }), 48780);
  assert.equal(allocPort({ table: { a: 48780, b: 48781 }, taken: [48782] }), 48783);
  assert.throws(() => allocPort({ table: { a: 48780, b: 48781 }, taken: [48782, 48783, 48784, 48785, 48786, 48787, 48788, 48789, 48790, 48791, 48792, 48793, 48794, 48795, 48796, 48797, 48798, 48799] }), /no free port/);
});

// ── loadFleetLocal ──
test('loadFleetLocal: missing file = defaults; broken file throws', () => {
  const dir = tmp();
  const dflt = loadFleetLocal(join(dir, 'nope.json'));
  assert.equal(dflt.gatewayPort, 48790);
  const f = join(dir, 'fleet.local.json');
  writeFileSync(f, JSON.stringify({ gatewayPort: 48000, ports: { alpha: 48791 } }));
  const loaded = loadFleetLocal(f);
  assert.equal(loaded.gatewayPort, 48000);
  assert.equal(loaded.ports.alpha, 48791);
  writeFileSync(f, '{broken');
  assert.throws(() => loadFleetLocal(f));
});

// ── scanServices ──
test('scanServices: finds declarations, reports broken, skips absent', () => {
  const root = tmp();
  write(join(root, 'good-proj', 'data', 'service.json'), JSON.stringify({ id: 'good' }));
  write(join(root, 'bad-proj', 'data', 'service.json'), '{nope');
  mkdirSync(join(root, 'none-proj', 'data'), { recursive: true });
  const found = scanServices({ roots: [root] });
  assert.equal(found.length, 2);
  assert.equal(found.find((f) => f.decl)?.decl.id, 'good');
  assert.ok(found.find((f) => !f.decl)?.error.length > 0);
});

// ── poolSummary / lastEventAgeMin / lockPidAlive ──
test('poolSummary: latest-wins, verified-only balance, as-of', () => {
  const dir = tmp();
  const f = join(dir, 'accounts.jsonl');
  writeFileSync(f, [
    JSON.stringify({ email: 'a@x', status: 'verified', balance_usd: 5 }),
    JSON.stringify({ email: 'a@x', status: 'verified', balance_usd: 4.5 }),
    JSON.stringify({ email: 'b@x', status: 'failed' }),
  ].join('\n') + '\n');
  const s = poolSummary(f);
  assert.equal(s.total, 2);
  assert.equal(s.verified, 1);
  assert.equal(s.balance, 4.5);
  assert.ok(s.as_of);
  assert.equal(poolSummary(join(dir, 'missing.jsonl')), null);
});
test('lastEventAgeMin: minutes since last event ts', () => {
  const dir = tmp();
  const f = join(dir, 'events.jsonl');
  const now = new Date('2026-09-15T14:00:00Z');
  writeFileSync(f, [
    JSON.stringify({ ts: '2026-09-15T12:00:00Z', event: 'balance.ok' }),
    JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'balance.ok' }),
  ].join('\n') + '\n');
  assert.equal(lastEventAgeMin(f, now), 60);
  assert.equal(lastEventAgeMin(join(dir, 'nope'), now), null);
});
test('lockPidAlive: own pid alive, bogus pid dead', () => {
  const dir = tmp();
  const f = join(dir, '.watch-keeper.lock');
  writeFileSync(f, String(process.pid));
  assert.equal(lockPidAlive(f), true);
  writeFileSync(f, '99999999');
  assert.equal(lockPidAlive(f), false);
  assert.equal(lockPidAlive(join(dir, 'nope')), false);
});

// ── probePort (real loopback) ──
test('probePort: true for listening, false for closed', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal(await probePort(port), true);
  srv.close();
  assert.equal(await probePort(1, { timeoutMs: 200 }), false);
});

// ── findOrphans ──
test('findOrphans: register processes with no declared pattern', () => {
  const processes = [
    { pid: 1, etime: '01:00', cmd: 'node src/cli.mjs register --count 1 --probe' },
    { pid: 2, etime: '02:00', cmd: 'node src/ot.mjs register --count 5' },
    { pid: 3, etime: '03:00', cmd: 'node unrelated.mjs serve' },
  ];
  const declared = [{ decl: { spawn: { pattern: 'src/ot.mjs register' } } }];
  const orphans = findOrphans({ processes, declared });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 1);
});

// ── status: end-to-end with injected I/O ──
test('status: aggregates units, states, orphans, totals', async () => {
  const root = tmp();
  const now = new Date('2026-09-15T14:00:00Z');
  // unitA: running (port open via injected probe, recent event, 1 alias)
  write(join(root, 'a-proj', 'data', 'service.json'), JSON.stringify({
    id: 'aaa', gateway: { port: 40001, aliases: { cheap: 'vendor/model' } }, accounts: 'data/accounts.jsonl',
  }));
  write(join(root, 'a-proj', 'data', 'events.jsonl'), JSON.stringify({ ts: '2026-09-15T13:50:00Z', event: 'balance.ok' }) + '\n');
  write(join(root, 'a-proj', 'data', 'accounts.jsonl'), JSON.stringify({ email: 'a@x', status: 'verified', balance_usd: 5 }) + '\n');
  // unitB: down (port closed)
  write(join(root, 'b-proj', 'data', 'service.json'), JSON.stringify({ id: 'bbb', gateway: { port: 40002 } }));
  // unitC: off (lifecycle dead)
  write(join(root, 'c-proj', 'data', 'service.json'), JSON.stringify({ id: 'ccc', lifecycle: 'dead' }));
  // unitD: broken declaration -> errors list, not a unit
  write(join(root, 'd-proj', 'data', 'service.json'), '{broken');

  const probe = async (port) => port === 40001;
  const listProcesses = async () => [{ pid: 42, etime: '18:00', cmd: 'node src/cli.mjs register --count 1' }];
  const out = await status({ roots: [root], fleetFile: join(root, 'missing-fleet.json'), now, probe, listProcesses });

  const byId = Object.fromEntries(out.units.map((u) => [u.id, u]));
  assert.equal(byId.aaa.state, 'running');
  assert.equal(byId.aaa.pool.balance, 5);
  assert.deepEqual(byId.aaa.models, ['cheap']);
  assert.equal(byId.bbb.state, 'down');
  assert.equal(byId.ccc.state, 'off');
  assert.equal(out.errors.length, 1);
  assert.equal(out.orphans.length, 1);
  assert.equal(out.orphans[0].pid, 42);
  assert.equal(out.totals.projects, 3);
  assert.equal(out.totals.models, 1);
  assert.equal(out.totals.running, 1);
  assert.equal(out.totals.down, 1);
  assert.equal(out.totals.off, 1);
});

test('status: gateway block is the hub\'s own gate decision; unreadable health is visible, not silent', async () => {
  const root = tmp();
  const now = new Date('2026-09-15T14:00:00Z');
  // sunset unit, registrar off, healthy-enough pool: registrar axis off, serving axis on
  write(join(root, 'ot', 'data', 'service.json'), JSON.stringify({ id: 'ot', lifecycle: 'sunset', gateway: { port: 40011, aliases: { 'ds-flash': 'x' } }, accounts: 'data/accounts.jsonl' }));
  write(join(root, 'ot', 'data', 'accounts.jsonl'), JSON.stringify({ email: 'a@x', status: 'verified', balance_usd: 5 }) + '\n');
  write(join(root, 'ot', 'data', 'health.json'), JSON.stringify({ status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar', 'stopSupply'] }));
  // halted unit: gated with the halt reason
  write(join(root, 'h', 'data', 'service.json'), JSON.stringify({ id: 'hh', gateway: { port: 40012, aliases: { m: 'x' } } }));
  write(join(root, 'h', 'data', 'health.json'), JSON.stringify({ status: 'halted', reason: 'register-broken', actions: ['stopRegistrar', 'stopSupply', 'haltProject'] }));
  // unreadable health.json: gated (unknown ≠ fine) and reported as such
  write(join(root, 'u', 'data', 'service.json'), JSON.stringify({ id: 'uu', gateway: { port: 40013, aliases: { m: 'x' } } }));
  write(join(root, 'u', 'data', 'health.json'), '{not json');
  // no gateway section at all (harvest)
  write(join(root, 'a', 'data', 'service.json'), JSON.stringify({ id: 'amp', kind: 'harvest' }));
  const fleetFile = join(root, 'fleet.json');
  writeFileSync(fleetFile, JSON.stringify({ units: { ot: { enabled: false } } }));
  const out = await status({ roots: [root], fleetFile, now, probe: async () => false, listProcesses: async () => [] });
  const byId = Object.fromEntries(out.units.map((u) => [u.id, u]));
  assert.deepEqual(byId.ot.gateway, { gated: false, gate_reason: null, models: 1 });
  assert.equal(byId.ot.enabled, false);
  assert.deepEqual(byId.ot.health.actions, ['stopRegistrar', 'stopSupply']);
  assert.deepEqual(byId.hh.gateway, { gated: true, gate_reason: 'register-broken', models: 0 });
  assert.deepEqual(byId.hh.models_available, []);
  assert.deepEqual(byId.uu.gateway, { gated: true, gate_reason: 'health-unreadable', models: 0 });
  assert.equal(byId.uu.health.status, 'unreadable');
  assert.deepEqual(byId.uu.models_available, [], 'panel must not promise models the hub refuses');
  assert.equal(byId.amp.gateway, null);
  assert.equal(out.totals.models, 1);
});

test('status: stale when alive but events older than threshold', async () => {
  const root = tmp();
  const now = new Date('2026-09-15T14:00:00Z');
  write(join(root, 'g-proj', 'data', 'service.json'), JSON.stringify({ id: 'ggg', gateway: { port: 40003 } }));
  write(join(root, 'g-proj', 'data', 'events.jsonl'), JSON.stringify({ ts: '2026-09-11T13:00:00Z', event: 'batch.done' }) + '\n');
  const out = await status({
    roots: [root], fleetFile: join(root, 'missing.json'), now,
    probe: async () => true, listProcesses: async () => [],
  });
  assert.equal(out.units[0].state, 'stale');
  assert.ok(out.units[0].last_event_age_min > 4000);
});
