// Liveness sources (panel must not call a running project "down").
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { status } from '../src/fleet.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-live-'));
const now = new Date('2026-09-16T09:00:00Z');
const mkunit = (root, name, service, events = null) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  if (events) writeFileSync(join(dir, 'data', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
};
const run = (root, processes = []) => status({
  roots: [root],
  fleetFile: join(root, 'missing.json'),
  now,
  probe: async () => false,
  listProcesses: async () => processes,
});

test('liveness: recent events keep a project running even with no port/lock', async () => {
  const root = tmp();
  mkunit(root, 'ph', { id: 'beta' }, [{ ts: '2026-09-16T08:30:00Z', event: 'reg.ok' }]); // 30m ago
  const out = await run(root);
  assert.equal(out.units[0].state, 'running');
});

test('liveness: stale events + no other evidence = down (activity window is ~3h)', async () => {
  const root = tmp();
  mkunit(root, 'amp', { id: 'amp' }, [{ ts: '2026-09-15T20:00:00Z', event: 'token.ok' }]); // 13h ago
  const out = await run(root);
  assert.equal(out.units[0].state, 'down');
});

test('liveness: declared resident.pattern matches a foreign process owner', async () => {
  const root = tmp();
  mkunit(root, 'pp', { id: 'beta', resident: { cmd: 'x', pattern: 'scripts/supply-loop.mjs' } });
  const out = await run(root, [{ pid: 42, etime: '10:00', cmd: 'node /p/beta/scripts/supply-loop.mjs' }]);
  assert.equal(out.units[0].state, 'running');
});

test('liveness: declared spawn.pattern (a registration in flight) also counts', async () => {
  const root = tmp();
  mkunit(root, 'gg', { id: 'alpha', spawn: { cmd: 'x', pattern: 'src/cli.mjs register' } });
  const out = await run(root, [{ pid: 7, etime: '00:30', cmd: 'node src/cli.mjs register --count 1' }]);
  assert.equal(out.units[0].state, 'running');
});

test('liveness: activityAliveMin override tightens the window', async () => {
  const root = tmp();
  mkunit(root, 'tt', { id: 'tight', activityAliveMin: 5 }, [{ ts: '2026-09-16T08:30:00Z', event: 'reg.ok' }]); // 30m > 5m
  const out = await run(root);
  assert.equal(out.units[0].state, 'down');
});
