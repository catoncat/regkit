// P2 money-path contracts: a failed key must actually leave the rotation, a 402
// must survive a restart, a project classifier bug must not fail the request, and
// the panel's pool summary must show what the gateway will really serve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.mjs';
import { AFFINITY_TTL_MS, AFFINITY_MAX, MAX_DRAINS_PER_REQUEST, classifyDefault } from '../src/pool.mjs';
import { createLogger } from '../src/logger.mjs';
import { appendJsonl } from '../src/jsonl.mjs';
import { poolSummary } from '../src/fleet.mjs';

const RATES = { in: 0, out: 0 };
const req = { headers: {} };
const res = () => {
  const st = { code: 0, body: '' };
  return {
    writeHead(code) { st.code = code; },
    write(c) { st.body += Buffer.from(c || '').toString('utf8'); return true; },
    end(b) { if (b) { try { st.body += Buffer.from(b).toString('utf8'); } catch { /* ignore */ } } },
    _state: st,
  };
};
const body = (content = 'hi') => Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }));

function mkPool({ dir, accounts, extra = {} }) {
  const accountsFile = join(dir, 'accounts.jsonl');
  for (const a of accounts) appendJsonl(accountsFile, a);
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  return {
    accountsFile,
    eventsFile: join(dir, 'events.jsonl'),
    gw: createGateway({
      cfg: {}, log, accountsFile, usagePath: join(dir, 'usage.jsonl'),
      upstreamBase: 'http://127.0.0.1:1/v1', rates: () => RATES,
      classifyFailure: classifyDefault, gatewayToken: 'tok', poolName: 'test', ...extra,
    }),
  };
}

/** Stub fetch by API key: replay a per-key script of HTTP statuses. */
function stubFetch(script) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'POST' || !String(url).endsWith('/chat/completions')) return new Response('{}', { status: 200 });
    const auth = String(init?.headers?.get?.('authorization') || init?.headers?.authorization || '');
    const key = auth.replace(/^Bearer\s+/i, '');
    seen.push(key);
    const status = typeof script[key] === 'function' ? script[key]() : (script[key] ?? 200);
    if (status === 200) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'upstream said ' + status } }), { status, headers: { 'content-type': 'application/json' } });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const twoKeys = [
  { email: 'a@x', status: 'verified', api_key: 'k-a', balance_usd: 5, checked_at: '2026-09-17T09:00:00Z' },
  { email: 'b@x', status: 'verified', api_key: 'k-b', balance_usd: 5, checked_at: '2026-09-17T09:00:00Z' },
];
const readEvents = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ── P2-6: affinity must not defeat rotation ──
test('rotation: a pinned key that fails is not borrowed again in the same request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-rot-'));
  const { gw, eventsFile } = mkPool({ dir, accounts: twoKeys });
  let stub = stubFetch({ 'k-a': 200, 'k-b': 200 });
  try {
    // request 1 pins the conversation to whichever key served it
    const r1 = res();
    await gw.handleChat(req, r1, body('same head'));
    assert.equal(r1._state.code, 200);
    assert.equal(stub.seen.at(-1), 'k-a', 'first borrow is registration order');

    // request 2: the pinned key now dies with a failing class (network)
    stub.restore();
    stub = stubFetch({ 'k-a': 500, 'k-b': 200 });
    const r2 = res();
    await gw.handleChat(req, r2, body('same head'));
    assert.equal(r2._state.code, 200, 'client still gets a clean 200 from the other key');
    assert.deepEqual(stub.seen, ['k-a', 'k-b'], 'the dead pinned key must be tried once, then left alone');
  } finally { stub.restore(); }

  const ok = readEvents(eventsFile).filter((e) => e.event === 'ai.ok').at(-1);
  assert.equal(ok.attempts, 2, 'two attempts, not MAX_KEY_ATTEMPTS on one dead key');
});

test('rotation: a healthy pin is still honoured (affinity kept for cache/locality)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-rot-pin-'));
  const { gw } = mkPool({ dir, accounts: twoKeys });
  const stub = stubFetch({ 'k-a': 200, 'k-b': 200 });
  try {
    for (let i = 0; i < 3; i++) {
      const r = res();
      await gw.handleChat(req, r, body('stable head'));
      assert.equal(r._state.code, 200);
    }
    assert.deepEqual(stub.seen, ['k-a', 'k-a', 'k-a'], 'one conversation stays on one key while it works');
  } finally { stub.restore(); }
  // the bounds are part of the contract (an unbounded map is a leak)
  assert.equal(AFFINITY_MAX, 2000);
  assert.equal(AFFINITY_TTL_MS, 30 * 60 * 1000);
});

// ── P2-7: classifier isolation + 402 persistence ──
test('rotation: a throwing project classifier falls back to the taxonomy, request survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-rot-cls-'));
  const { gw, eventsFile } = mkPool({
    dir, accounts: twoKeys,
    extra: { classifyFailure: () => { throw new Error('classifier bug'); } },
  });
  const stub = stubFetch({ 'k-a': 503, 'k-b': 200 });
  try {
    const r = res();
    await gw.handleChat(req, r, body());
    assert.equal(r._state.code, 200, 'a classifier bug must not fail the request');
    assert.deepEqual(stub.seen, ['k-a', 'k-b']);
  } finally { stub.restore(); }
  const events = readEvents(eventsFile);
  const classified = events.find((e) => e.event === 'classify.fail');
  assert.equal(classified.fallback, 'network', '503 falls back to the standard taxonomy');
  assert.equal(events.filter((e) => e.event === 'ai.fail')[0].klass, 'network');
});

test('402 without a retire hook is still PERSISTED (a restart cannot resurrect it)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-rot-402-'));
  const { gw, accountsFile } = mkPool({ dir, accounts: twoKeys });   // no retire hook at all
  const stub = stubFetch({ 'k-a': 402, 'k-b': 200 });
  try {
    const r = res();
    await gw.handleChat(req, r, body());
    assert.equal(r._state.code, 200);
  } finally { stub.restore(); }

  const latest = new Map();
  for (const line of readFileSync(accountsFile, 'utf8').trim().split('\n')) {
    const j = JSON.parse(line);
    latest.set(j.email, j);
  }
  assert.equal(latest.get('a@x').status, 'exhausted', 'drained key must be on disk');
  assert.equal(latest.get('a@x').balance_usd, 0);
  assert.match(latest.get('a@x').note, /402/);
  assert.equal(latest.get('a@x').api_key, 'k-a', 'identity fields survive the merge');
  assert.equal(latest.get('b@x').status, 'verified', 'only the drained key is touched');

  // a rebuilt gateway (fresh process state) must not pick the drained key
  const rebuilt = mkPool({ dir, accounts: [] }).gw;
  assert.equal(rebuilt.borrow(null).email, 'b@x');
});

// ── P2-8: the panel must show displayed balance, not the raw anchor ──
test('poolSummary: subtracts local spend, reports it, and fails closed on a bad ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-sum-'));
  const accountsFile = join(dir, 'accounts.jsonl');
  const usageFile = join(dir, 'usage.jsonl');
  writeFileSync(accountsFile, [
    JSON.stringify({ email: 'a@x', status: 'verified', balance_usd: 10, checked_at: '2026-09-17T10:00:00Z' }),
    JSON.stringify({ email: 'b@x', status: 'verified', balance_usd: '2.5', checked_at: '2026-09-17T10:00:00Z' }),
    JSON.stringify({ email: 'c@x', status: 'failed' }),
  ].join('\n') + '\n');
  writeFileSync(usageFile, [
    JSON.stringify({ ts: '2026-09-17T11:00:00Z', email: 'a@x', cost_usd: 3 }),   // after the anchor -> counts
    JSON.stringify({ ts: '2026-09-17T09:00:00Z', email: 'a@x', cost_usd: 99 }),  // before the anchor -> absorbed
    JSON.stringify({ ts: '2026-09-17T11:00:00Z', email: 'b@x', cost_usd: 0.5 }),
  ].join('\n') + '\n');

  const s = poolSummary(accountsFile, usageFile);
  assert.equal(s.verified, 2);
  assert.equal(s.balance_known, 2);
  assert.equal(s.balance, 9);                // (10-3) + (2.5-0.5); anchors alone would claim 12.5
  assert.equal(s.spend_local_usd, 3.5);
  assert.equal(s.ledger, undefined);

  // an unreadable ledger reports the balance as UNKNOWN, never as the raw anchor
  writeFileSync(usageFile, 'GARBAGE\n' + JSON.stringify({ ts: '2026-09-17T11:00:00Z', email: 'a@x', cost_usd: 1 }) + '\n');
  const bad = poolSummary(accountsFile, usageFile);
  assert.equal(bad.balance_known, 0);
  assert.equal(bad.ledger, 'unreadable');

  // no ledger at all still works (anchors only) — the pre-existing contract
  const legacy = poolSummary(accountsFile, join(dir, 'nope.jsonl'));
  assert.equal(legacy.balance, 12.5);
  assert.equal(poolSummary(join(dir, 'missing.jsonl')), null);
});

test('classifyDefault: the shared taxonomy (also the fleet-hub default)', () => {
  assert.equal(classifyDefault(401), 'balance');
  assert.equal(classifyDefault(402), 'balance');
  assert.equal(classifyDefault(404), 'model_mismatch');
  assert.equal(classifyDefault(429), 'concurrency');
  assert.equal(classifyDefault(503), 'network');
  assert.equal(classifyDefault(0), 'network');
  assert.equal(classifyDefault(400), 'client');
});

// ── drain-storm breaker: a model-tier 402 must not eat the whole pool ──
test('drain storm: after MAX_DRAINS_PER_REQUEST balance failures in ONE request the upstream error is returned and no more keys are retired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-storm-'));
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ email: k + '@x', status: 'verified', api_key: 'k-' + k, balance_usd: 1, checked_at: '2026-09-17T09:00:00Z' }));
  const { gw, accountsFile, eventsFile } = mkPool({ dir, accounts: six });
  // every key says 402 "requires a paid balance" — the default classifier calls that 'balance'
  const stub = stubFetch(Object.fromEntries(six.map((a) => ['k-' + a.email[0], 402])));
  try {
    const r = res();
    await gw.handleChat(req, r, body('claude please'));
    assert.equal(r._state.code, 402, 'client gets the upstream answer, not a 503 pool_exhausted');
    assert.match(r._state.body, /upstream said 402/);
    assert.equal(stub.seen.length, MAX_DRAINS_PER_REQUEST + 1, 'N drains + the one that trips the breaker');
  } finally { stub.restore(); }
  const events = readEvents(eventsFile);
  assert.equal(events.filter((e) => e.event === 'key.drained').length, MAX_DRAINS_PER_REQUEST);
  const storm = events.find((e) => e.event === 'pool.drain_storm');
  assert.ok(storm, 'the storm is on record');
  assert.equal(storm.drained, MAX_DRAINS_PER_REQUEST);
  assert.equal(storm.status, 402);
  const persisted = readFileSync(accountsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a.status === 'exhausted');
  assert.equal(persisted.length, MAX_DRAINS_PER_REQUEST, 'only the first N were written to disk');
  assert.equal(gw.health().eligible_keys, six.length - MAX_DRAINS_PER_REQUEST, 'the other keys are still in the pool');
});

test('drain storm: genuine one-at-a-time exhaustion is untouched by the breaker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-storm-ok-'));
  const { gw, eventsFile } = mkPool({ dir, accounts: twoKeys });
  const stub = stubFetch({ 'k-a': 402, 'k-b': 200 });
  try {
    const r = res();
    await gw.handleChat(req, r, body('x'));
    assert.equal(r._state.code, 200, 'one empty wallet: rotate and serve');
  } finally { stub.restore(); }
  const events = readEvents(eventsFile);
  assert.equal(events.filter((e) => e.event === 'key.drained').length, 1);
  assert.equal(events.find((e) => e.event === 'pool.drain_storm'), undefined);
});
