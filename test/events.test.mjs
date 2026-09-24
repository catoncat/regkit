// Event analysis contracts: window stats, in-flight tracking, mood verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { windowStats, throughputSpark, inflight, classifyMood } from '../src/events.mjs';

const t = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();

test('windowStats buckets http outcomes and reg/ai events', () => {
  const evts = [
    { ts: t(0.1), event: 'http', name: 'verification-code', status: 200, klass: 'ok', ms: 50 },
    { ts: t(0.2), event: 'http', name: 'verification-code', status: 429, klass: 'rate_fast', ms: 10 },
    { ts: t(0.3), event: 'http', name: 'register', status: 403, klass: 'forbidden', ms: 10 },
    { ts: t(0.4), event: 'http', name: 'register', status: 500, klass: 'server_error', ms: 10 },
    { ts: t(0.5), event: 'code.timeout' },
    { ts: t(0.6), event: 'reg.ok', balance_usd: 5 },
    { ts: t(0.7), event: 'ai.ok', cost_usd: 0.01, ms: 80 },
    { ts: t(0.8), event: 'ai.fail' },
    { ts: t(50), event: 'http', name: 'old', status: 200 }, // outside window
  ];
  const s = windowStats(evts, Date.now(), { windowMin: 10 });
  assert.equal(s.ok, 1);
  assert.equal(s.ratelimit, 1);
  assert.equal(s.forbidden, 1);
  assert.equal(s.server, 1);
  assert.equal(s.mailTimeout, 1);
  assert.equal(s.regsOk, 1);
  assert.equal(s.fails, 1); // code.timeout counts
  assert.equal(s.aiCalls, 1);
  assert.equal(s.aiFails, 1);
  assert.ok(Math.abs(s.aiCost - 0.01) < 1e-9);
  assert.equal(s.byEndpoint['verification-code'].ok, 1);
  assert.equal(s.byEndpoint['verification-code'].c429, 1);
});

test('inflight tracks a batch through its stages', () => {
  const evts = [
    { ts: t(1), event: 'batch.start', count: 2 },
    { ts: t(1), event: 'reg.start', email: 'a@x' },
    { ts: t(1), event: 'http', name: 'verification-code', klass: 'ok' },
    { ts: t(1), event: 'code.received', email: 'a@x' },
    { ts: t(1), event: 'http', name: 'register', klass: 'ok' },
    { ts: t(1), event: 'http', name: 'billing', klass: 'ok' },
    { ts: t(1), event: 'reg.ok', email: 'a@x', balance_usd: 5 },
    { ts: t(1), event: 'reg.start', email: 'b@x' },
    { ts: t(1), event: 'reg.fail', email: 'b@x', step: 'verification-code' },
  ];
  const f = inflight(evts);
  assert.equal(f.done, 1);
  assert.equal(f.failed, 1);
  const a = f.workers.find((w) => w.email === 'a@x');
  assert.equal(a.stage, 'done');
  const b = f.workers.find((w) => w.email === 'b@x');
  assert.equal(b.stage, 'fail');
});

test('classifyMood: blocked when forbidden dominates', () => {
  const mood = classifyMood({
    accts: [],
    stats: { forbidden: 2, ok: 0, ratelimit: 0, regsOk: 0, fails: 0, mailTimeout: 0 },
    flight: { workers: [] },
    lastEventAgeMin: 0.1,
  });
  assert.equal(mood.word, 'BLOCKED');
});

test('classifyMood: empty pool when no verified accounts', () => {
  const mood = classifyMood({
    accts: [{ email: 'a@x', status: 'pending' }],
    stats: {},
    flight: { workers: [] },
    lastEventAgeMin: null,
  });
  assert.equal(mood.word, 'EMPTY');
});

test('throughputSpark returns a sparkline glyph string', () => {
  const evts = [];
  for (let i = 0; i < 20; i++) {
    evts.push({ ts: new Date(Date.now() - i * 3000).toISOString(), event: 'http', status: 200 });
  }
  const spark = throughputSpark(evts, Date.now(), { binMs: 6000, bins: 10 });
  assert.ok(spark.length > 0);
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(spark));
});
