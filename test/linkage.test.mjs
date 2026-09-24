// linkage.test.mjs — P0 regression: the linkage detectors must key off the event
// vocabulary the registrar template ACTUALLY emits.
//
// Review finding: health rule 1 and patrol filtered `register.failed`, a name no
// emitter produces (skeleton/src/register.mjs emits `reg.fail`), so register-broken
// and the LLM patrol could never fire on real traffic. Every unit test fabricated
// its own event name, so the broken integration stayed green. These cases emit
// through the real Logger at the template's own call sites, then assert the
// fleet-level detector reacts and the keeper honours the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../src/logger.mjs';
import { REG_FAILURE_EVENTS } from '../src/events.mjs';
import { step, loadHealth } from '../src/health.mjs';
import { needsPatrol } from '../src/patrol.mjs';
import { keeperSupplyTick } from '../src/watch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'rk-linkage-'));
const now = new Date('2026-09-17T12:00:00Z');

/**
 * Replay the failure path of skeleton/src/register.mjs + cli.mjs through the real
 * logger: N `reg.fail` (verification-code step) then 3 dead `batch.done`.
 */
function emitSkeletonFailureBatch(eventsFile, { fails = 4 } = {}) {
  mkdirSync(dirname(eventsFile), { recursive: true });
  const log = createLogger({ eventsFile, quiet: true });
  log.event('batch.start', { count: fails, workers: 4, domains: 1, domain: null, probe: false });
  for (let i = 0; i < fails; i++) {
    log.event('reg.fail', {
      email: `worker${i}@example.io`, step: 'verification-code',
      klass: 'http', error: 'turnstile blocked forever 403',
    });
  }
  for (let i = 0; i < 3; i++) log.event('batch.done', { ok: 0, failed: fails, gap_ms: 5000 });
  return eventsFile;
}

// ── the detector reacts to real registrar traffic ──
test('real reg.fail traffic halts the unit via register-broken (was unfireable)', async () => {
  const dir = tmp();
  const eventsFile = emitSkeletonFailureBatch(join(dir, 'data', 'events.jsonl'));
  const healthPath = join(dir, 'data', 'health.json');
  const r = await step({ healthPath, eventsFile, now });
  assert.equal(r.findings.registerBroken, true);
  assert.equal(r.findings.evidence.register.fails, 4);
  assert.equal(r.next.status, 'halted');
  assert.equal(r.next.reason, 'register-broken');
  assert.deepEqual(r.next.actions, ['stopRegistrar', 'stopSupply', 'haltProject']);
  assert.equal(loadHealth(healthPath).status, 'halted');
});

test('real reg.crash traffic counts as a registration failure too', () => {
  const dir = tmp();
  const dirData = join(dir, 'data');
  const eventsFile = emitSkeletonFailureBatch(join(dirData, 'events.jsonl'), { fails: 0 });
  const log = createLogger({ eventsFile, quiet: true });
  for (let i = 0; i < 4; i++) {
    log.event('reg.crash', { email: `c${i}@example.io`, error: 'TypeError: cannot read properties of undefined 6', persisted: true });
  }
  return step({ healthPath: join(dirData, 'health.json'), eventsFile, now }).then((r) => {
    assert.equal(r.next.reason, 'register-broken');
  });
});

test('patrol sees the real failure signature as unseen (was invisible)', () => {
  const dir = tmp();
  const eventsFile = emitSkeletonFailureBatch(join(dir, 'data', 'events.jsonl'), { fails: 1 });
  const r = needsPatrol({ unitDir: dir, eventsFile, now });
  assert.equal(r.need, true);
  assert.equal(r.why, 'unseen-signatures');
  assert.equal(r.fails, 1);
});

// ── the loop closes: what the fleet-level detector writes, the keeper reads ─
test('keeper honours the health.json that tick wrote (halted => no spawn)', async () => {
  const dir = tmp();
  const eventsFile = emitSkeletonFailureBatch(join(dir, 'data', 'events.jsonl'));
  const healthPath = join(dir, 'data', 'health.json');
  await step({ healthPath, eventsFile, now });
  const calls = [];
  await keeperSupplyTick({
    upstreams: [{ id: 'u', healthFile: healthPath, supply: { check: () => calls.push('u') } }],
    healthFor: async (u) => loadHealth(u.healthFile), // the production read path
  });
  assert.deepEqual(calls, []);
});

// ─ guards against the drift coming back ──
test('vocabulary guard: the template still emits every name REG_FAILURE_EVENTS filters on', () => {
  const src = ['register.mjs', 'cli.mjs']
    .map((f) => readFileSync(join(REPO, 'skeleton', 'src', f), 'utf8'))
    .join('\n');
  const emitted = new Set([...src.matchAll(/\blog\?*\.event\('([a-z.]+)'/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 8, 'skeleton event calls not found — scan is stale');
  for (const name of REG_FAILURE_EVENTS) {
    assert.ok(emitted.has(name), `skeleton never emits '${name}' — detectors filter a phantom event`);
  }
});

test('vocabulary guard: detectors import the constant, never re-type a failure name', () => {
  for (const f of ['health.mjs', 'patrol.mjs']) {
    const src = readFileSync(join(REPO, 'src', f), 'utf8');
    assert.equal(/'reg\.(fail|crash)'/.test(src), false, `${f} re-types a failure event name — use REG_FAILURE_EVENTS`);
  }
});