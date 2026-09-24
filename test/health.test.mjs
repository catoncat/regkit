// health.mjs tests: every detector rule + state machine transitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, deriveTransition, dueReprobe, step, loadHealth, isGated, ACTIONS, DEFAULT_THRESHOLDS as T } from '../src/health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'health-'));
const now = new Date('2026-09-15T14:00:00Z');

test('ACTIONS: exactly the four linkage actions — no fifth', () => {
  assert.deepEqual([...ACTIONS], ['stopRegistrar', 'stopSupply', 'removeModels', 'haltProject']);
  assert.equal(ACTIONS.includes('resume'), false, 'recovery is a state, not an executable action');
});

// ── rule 1: register-broken ──
test('register-broken: N dead batches with clustered failure signature halts registrar+supply', () => {
  const events = [
    ...Array.from({ length: 5 }, () => ({ event: 'reg.fail', klass: 'http', detail: 'OTP timeout 408' })),
    { event: 'batch.done', ok: 0, failed: 3 }, { event: 'batch.done', ok: 0, failed: 2 }, { event: 'batch.done', ok: 0, failed: 4 },
  ];
  const f = analyze({ events });
  assert.equal(f.registerBroken, true);
  const next = deriveTransition(null, f, { now });
  assert.equal(next.status, 'halted');
  assert.equal(next.reason, 'register-broken');
  assert.deepEqual(next.actions, ['stopRegistrar', 'stopSupply', 'haltProject']);
});
test('register-broken: does not fire when any batch succeeded or signatures scatter', () => {
  const ok = analyze({ events: [{ event: 'batch.done', ok: 0 }, { event: 'batch.done', ok: 0 }, { event: 'batch.done', ok: 1 }] });
  assert.equal(ok.registerBroken, false);
  const scattered = analyze({
    events: [
      { event: 'reg.fail', detail: 'a 1' }, { event: 'reg.fail', detail: 'b 2' }, { event: 'reg.fail', detail: 'c 3' },
      { event: 'reg.fail', detail: 'd 4' }, { event: 'reg.fail', detail: 'e 5' },
      { event: 'batch.done', ok: 0 }, { event: 'batch.done', ok: 0 }, { event: 'batch.done', ok: 0 },
    ],
  });
  assert.equal(scattered.registerBroken, false);
});

// ── rule 2: no-credit ──
test('no-credit: newest verified accounts all ~zero balance stops registration, pool KEEPS serving', () => {
  const accounts = [
    { email: 'a', status: 'verified', created_at: '2026-09-14', balance_usd: 0 },
    { email: 'b', status: 'verified', created_at: '2026-09-13', balance_usd: 0 },
    { email: 'c', status: 'verified', created_at: '2026-09-12', balance_usd: 0 },
  ];
  const f = analyze({ accounts });
  assert.equal(f.noCredit, true);
  const next = deriveTransition(null, f, { now });
  // degraded, NOT halted: the pool's remaining balance stays in the gateway
  assert.equal(next.status, 'degraded');
  assert.equal(next.reason, 'no-credit');
  assert.deepEqual(next.actions, ['stopRegistrar', 'stopSupply']);
  assert.equal(isGated(next), false); // 网关不摘池子
});
test('no-credit: does not fire while fresh accounts carry balance', () => {
  const accounts = [
    { email: 'a', status: 'verified', created_at: '2026-09-14', balance_usd: 5 },
    { email: 'b', status: 'verified', created_at: '2026-09-13', balance_usd: 0 },
    { email: 'c', status: 'verified', created_at: '2026-09-12', balance_usd: 0 },
  ];
  assert.equal(analyze({ accounts }).noCredit, false);
});

// ── rule 3: pool-broken ──
test('pool-broken: hard failures dominate the ai window -> degraded + removeModels', () => {
  const events = [
    ...Array.from({ length: 16 }, () => ({ event: 'ai.fail', klass: 'balance' })),
    ...Array.from({ length: 2 }, () => ({ event: 'ai.ok' })),
  ];
  const f = analyze({ events });
  assert.equal(f.poolBroken, true);
  const next = deriveTransition(null, f, { now });
  assert.equal(next.status, 'degraded');
  assert.equal(next.reason, 'pool-broken');
  assert.deepEqual(next.actions, ['removeModels']);
});

// ── rule 4: model-delisted ──
test('model-delisted: repeated model_mismatch for one model removes just that model', () => {
  const events = [
    { event: 'ai.fail', klass: 'model_mismatch', model: 'old-model' },
    { event: 'ai.fail', klass: 'model_mismatch', model: 'old-model' },
    { event: 'ai.fail', klass: 'model_mismatch', model: 'old-model' },
    { event: 'ai.ok', model: 'live-model' },
  ];
  const f = analyze({ events });
  assert.deepEqual(f.delistedModels, ['old-model']);
  const next = deriveTransition(null, f, { now });
  assert.equal(next.status, 'degraded');
  assert.equal(next.reason, 'model-delisted');
});

// ── rule 5: upstream-flaky (flag only, status stays ok) ──
test('flaky: network-dominated fails set the flag without changing status', () => {
  const events = [
    ...Array.from({ length: 6 }, () => ({ event: 'ai.fail', klass: 'network' })),
    ...Array.from({ length: 4 }, () => ({ event: 'ai.ok' })),
  ];
  const f = analyze({ events });
  assert.equal(f.flaky, true);
  assert.equal(f.poolBroken, false);
  const next = deriveTransition(null, f, { now });
  assert.equal(next.status, 'ok');
  assert.equal(next.flaky, true);
});

// ── degraded recovers when findings clear ──
test('degraded recovers to ok once findings clear', () => {
  const prev = { status: 'degraded', reason: 'model-delisted', since: '2026-09-14T00:00:00Z', lastReprobeAt: null };
  const next = deriveTransition(prev, analyze({ events: [{ event: 'ai.ok' }] }), { now });
  assert.equal(next.status, 'ok');
  assert.equal(next.reason, null);
  assert.deepEqual(next.actions, []);   // recovery is not one of the four actions
});

// ── halted + daily reprobe ──
test('halted: reprobe marks recoverable but never auto-resumes', async () => {
  const dir = tmp();
  const healthPath = join(dir, 'health.json');
  const eventsFile = join(dir, 'events.jsonl');
  writeFileSync(healthPath, JSON.stringify({ status: 'halted', reason: 'no-credit', since: '2026-09-13T00:00:00Z', last_reprobe_at: '2026-09-14T00:00:00Z' }));
  writeFileSync(eventsFile, '');

  const still = await step({ healthPath, eventsFile, now, probe: async () => ({ ok: false }) });
  assert.equal(still.next.status, 'halted');
  assert.equal(still.next.last_reprobe_at, now.toISOString());
  assert.equal(still.next.recoverable, false);

  const dayLater = new Date(now.getTime() + 25 * 3600 * 1000);
  const healed = await step({ healthPath, eventsFile, now: dayLater, probe: async () => ({ ok: true }) });
  assert.equal(healed.next.status, 'halted');   // 不自动复开
  assert.equal(healed.next.recoverable, true);   // 只标"可恢复",等用户一键
  assert.equal(readFileSync(eventsFile, 'utf8').trim(), ''); // 状态没变,零转移事件
});

test('dueReprobe: only halted and only after the interval', () => {
  assert.equal(dueReprobe({ status: 'ok' }, now), false);
  assert.equal(dueReprobe({ status: 'halted', last_reprobe_at: '2026-09-15T13:00:00Z' }, now), false);
  assert.equal(dueReprobe({ status: 'halted', last_reprobe_at: '2026-09-13T13:00:00Z' }, now), true);
  assert.equal(dueReprobe({ status: 'halted', last_reprobe_at: null }, now), true);
});

// ── step end-to-end: writes health.json, emits transition, idempotent ──
test('step: register-broken end-to-end persists and is idempotent', async () => {
  const dir = tmp();
  const healthPath = join(dir, 'health.json');
  const eventsFile = join(dir, 'events.jsonl');
  const lines = [
    ...Array.from({ length: 4 }, () => JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'reg.fail', klass: 'http', detail: 'server action 404' })),
    ...Array.from({ length: 3 }, () => JSON.stringify({ ts: '2026-09-15T13:30:00Z', event: 'batch.done', ok: 0 })),
  ];
  writeFileSync(eventsFile, lines.join('\n') + '\n');

  const r1 = await step({ healthPath, eventsFile, now });
  assert.equal(r1.next.status, 'halted');
  assert.equal(r1.next.reason, 'register-broken');
  assert.equal(r1.changed, true);
  assert.equal(loadHealth(healthPath).reason, 'register-broken');

  const r2 = await step({ healthPath, eventsFile, now });
  assert.equal(r2.changed, false); // same state, same reason -> nothing rewritten

  const transitions = readFileSync(eventsFile, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'health.transition');
  assert.equal(transitions.length, 1); // exactly one transition recorded
});
