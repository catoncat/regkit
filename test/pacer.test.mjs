// AIMD pacer properties: the submit step must serialize globally and back off
// exponentially on rate walls while converging down on success.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignupPacer, nullPacer } from '../src/pacer.mjs';

test('repeated ok converges the gap toward minGap', () => {
  const p = createSignupPacer({ minGapMs: 1000, startGapMs: 8000, maxGapMs: 60000 });
  for (let i = 0; i < 20; i++) p.report('ok');
  assert.equal(p.gapMs, 1000);
});

test('rate_fast doubles and caps at maxGap; next slot waits the full gap', async () => {
  const p = createSignupPacer({ minGapMs: 500, startGapMs: 1000, maxGapMs: 4000 });
  await p.slot();
  p.report('rate_fast');
  p.report('rate_fast');
  p.report('rate_fast');
  assert.ok(p.gapMs <= 4000, 'gap must cap');
  assert.ok(p.gapMs > 1000, 'gap must have grown');
  const waitStart = Date.now();
  await p.slot();
  const waited = Date.now() - waitStart;
  assert.ok(waited >= p.gapMs - 60, `slot waited ${waited}ms, expected >= ~${p.gapMs}ms`);
});

test('submit moments stay gap-separated across workers', async () => {
  const gap = 40;
  const p = createSignupPacer({ minGapMs: gap, startGapMs: gap, maxGapMs: gap });
  const moments = [];
  await Promise.all(Array.from({ length: 5 }, () => p.slot().then(() => moments.push(Date.now()))));
  moments.sort((a, b) => a - b);
  for (let i = 1; i < moments.length; i++) {
    assert.ok(moments[i] - moments[i - 1] >= gap - 12, `two submits ${moments[i] - moments[i - 1]}ms apart (gap ${gap}ms)`);
  }
});

test('with a submit-shaped body (< gap) there is never overlap', async () => {
  const p = createSignupPacer({ minGapMs: 30, startGapMs: 30, maxGapMs: 30 });
  let inside = 0;
  let maxConcurrent = 0;
  const submit = async () => {
    inside++;
    maxConcurrent = Math.max(maxConcurrent, inside);
    await new Promise((r) => setTimeout(r, 2));
    inside--;
  };
  await Promise.all(Array.from({ length: 8 }, () => p.slot().then(submit)));
  assert.equal(maxConcurrent, 1);
});

test('nullPacer is a no-op that never waits', async () => {
  const p = nullPacer();
  const t0 = Date.now();
  await p.slot();
  assert.ok(Date.now() - t0 < 30);
  p.report('ok');
  assert.equal(p.gapMs, 0);
});
