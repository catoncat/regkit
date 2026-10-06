// Multi-upstream watcher contracts: one process, N account pools, one hub
// gateway. Legacy single-upstream callers must keep working unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl } from '../src/jsonl.mjs';
import { runWatch, spendByUpstream, defaultRenderMulti, defaultRender, poolBalance } from '../src/watch.mjs';
import { createSupplyController } from '../src/supply.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rk-watch-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  const a = join(dir, 'alpha.jsonl');
  const b = join(dir, 'free.jsonl');
  appendJsonl(a, { email: 'g1@x', status: 'verified', api_key: 'k1', balance_usd: 20, checked_at: new Date().toISOString() });
  appendJsonl(b, { email: 'f1@x', status: 'verified', api_key: 'k2', balance_usd: 7, checked_at: new Date().toISOString() });
  appendJsonl(b, { email: 'f2@x', status: 'pending', api_key: 'k3' });
  const eventsFile = join(dir, 'events.jsonl');
  const iso = new Date().toISOString();
  appendJsonl(eventsFile, { ts: iso, event: 'ai.ok', upstream: 'alpha', email: 'g1@x', model: 'deepseek', cost_usd: 0.002, ms: 900 });
  appendJsonl(eventsFile, { ts: iso, event: 'ai.ok', upstream: 'free', email: 'f1@x', model: 'qwen7b', cost_usd: 0.0, ms: 400 });
  appendJsonl(eventsFile, { ts: iso, event: 'ai.fail', upstream: 'free', email: 'f1@x', status: 429, klass: 'concurrency' });
  return { dir, a, b, eventsFile };
}

test('spendByUpstream groups ai events per upstream inside the window', () => {
  const { eventsFile } = fixture();
  const rows = [];
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  const spend = spendByUpstream(rows, Date.now(), 30);
  assert.equal(spend.get('alpha').calls, 1);
  assert.equal(spend.get('alpha').cost, 0.002);
  assert.equal(spend.get('free').calls, 1);
  assert.equal(spend.get('free').fails, 1);
});

test('defaultRenderMulti shows one block per upstream and a single hub gateway', () => {
  const { dir, a, b } = fixture();
  const ctx = {
    upstreams: [
      { id: 'alpha', accts: readJsonlLocal(a), balance: 20, targetUsd: 20, supplyEnabled: true, supply: { childPid: 4242, cooldownSec: 0 }, prevBalance: 19 },
      { id: 'free', accts: readJsonlLocal(b), balance: 7, targetUsd: 10, supplyEnabled: false, supply: { childPid: null, cooldownSec: 0 }, prevBalance: 7 },
    ],
    evts: [], stats: { aiCalls: 0, aiCost: 0 }, flight: { workers: [] }, now: Date.now(),
    cols: 100, rows: 30, tty: false, gatewayState: 'up',
  };
  const out = defaultRenderMulti(ctx, { windowMin: 30, gatewayPort: 48800 });
  assert.match(out, /alpha/);
  assert.match(out, /free/);
  assert.match(out, /\$27\.00/);            // total displayed balance 20 + 7
  assert.match(out, /hub \(2 upstreams, one port\)/);
  assert.match(out, /pid 4242/);
  assert.match(out, /off/);                  // free pool supply disabled
});

test('runWatch multi mode folds H.upstreams into per-pool context (and legacy mode still works)', async () => {
  const { dir, a, b, eventsFile } = fixture();
  let seen = null;
  await runWatch({
    root: dir, eventsFile, windowMin: 30, once: true,
    upstreams: [
      { id: 'alpha', accountsFile: a, usageFile: join(dir, 'alpha-usage.jsonl'), targetUsd: 20 },
      { id: 'free', accountsFile: b, usageFile: join(dir, 'free-usage.jsonl'), targetUsd: 10, supplyEnabled: false },
    ],
    render: (ctx) => { seen = ctx; return 'FRAME\n'; },
  });
  assert.equal(seen.upstreams.length, 2);
  assert.deepEqual(seen.upstreams.map((u) => u.id), ['alpha', 'free']);
  assert.equal(seen.upstreams[0].balance, 20);
  assert.equal(seen.upstreams[1].balance, 7, 'pending account not counted');
  assert.equal(seen.upstreams[0].supplyEnabled, true);
  assert.equal(seen.upstreams[1].supplyEnabled, false);
  assert.equal(seen.accts.length, 3, 'merged accounts for header stats');

  let single = null;
  await runWatch({
    root: dir, eventsFile, windowMin: 30, once: true,
    accountsFile: a, usageFile: join(dir, 'a-usage.jsonl'), targetUsd: 20,
    render: (ctx) => { single = ctx; return 'FRAME\n'; },
  });
  assert.equal(single.accts.length, 1, 'legacy single-upstream path untouched');
  assert.equal(single.upstreams, undefined);
  assert.equal(single.balance, 20, 'single mode hands the render a computed balance');
});

test('poolBalance keeps working with an explicit usage file (multi path)', () => {
  const { dir, a } = fixture();
  const usage = join(dir, 'alpha-usage.jsonl');
  writeFileSync(usage, '');
  const bal = poolBalance(readJsonlLocal(a), { usageFile: usage });
  assert.equal(bal, 20);
});

test('poolBalance: an unreadable ledger is UNKNOWN (null), never the untouched anchor', () => {
  const { dir, a } = fixture();
  const usage = join(dir, 'alpha-broken.jsonl');
  // corruption that is not a torn tail: strict readers call this unreadable
  writeFileSync(usage, 'GARBAGE\n' + JSON.stringify({ ts: new Date().toISOString(), email: 'g1@x', cost_usd: 1 }) + '\n');
  assert.equal(poolBalance(readJsonlLocal(a), { usageFile: usage }), null);

  // the panels print unknown as a dash and say why, instead of $20.00
  const accts = readJsonlLocal(a);
  // runWatch computes ctx.balance from poolBalance (render is pure); null = unknown
  const single = defaultRender({
    accts, balance: poolBalance(accts, { usageFile: usage }),
    evts: [], stats: { aiCalls: 0, aiCost: 0, aiFails: 0, fails: 0, mailTimeout: 0, regsOk: 0, byEndpoint: {}, forbidden: 0, ratelimit: 0, ok: 0 },
    flight: { workers: [], done: 0, failed: 0 }, now: Date.now(), cols: 100, rows: 30, tty: false,
    gatewayState: 'off', keeper: { active: false, childPid: null, cooldownSec: 0 },
  }, { targetUsd: 20, windowMin: 30, gatewayPort: 1 });
  assert.match(single, /\$—/);
  assert.match(single, /ledger unreadable/);
  assert.doesNotMatch(single, /\$20\.00/);

  // supply gated by health.json says WHY — an "idle" line hides a halted unit
  const held = defaultRender({
    accts, balance: 4.98, evts: [], stats: { aiCalls: 0, aiCost: 0, byEndpoint: {}, fails: 0 }, flight: { workers: [] },
    now: Date.now(), cols: 100, rows: 30, tty: false, gatewayState: 'fleet',
    keeper: { active: true, childPid: null, cooldownSec: 0, stalled: null },
    supplyHeld: { reason: 'no-credit', upstream: 'alpha' },
  }, { targetUsd: 70, windowMin: 30, gatewayPort: 48799 });
  assert.match(held, /supply\s+held · health\.json no-credit/);

  // supply stalled by the zero-yield breaker says why too (and how to retry)
  const stalled = defaultRender({
    accts, balance: 4.98, evts: [], stats: { aiCalls: 0, aiCost: 0, byEndpoint: {}, fails: 0 }, flight: { workers: [] },
    now: Date.now(), cols: 100, rows: 30, tty: false, gatewayState: 'fleet',
    keeper: { active: true, childPid: null, cooldownSec: 0, stalled: { atUsd: 4.98, batches: 3 } },
  }, { targetUsd: 70, windowMin: 30, gatewayPort: 48799 });
  assert.match(stalled, /STALLED · 3 batches added no credit/);

  const multi = defaultRenderMulti({
    upstreams: [
      { id: 'alpha', accts, balance: null, targetUsd: 20, supplyEnabled: true, supply: { childPid: null, cooldownSec: 0 }, prevBalance: 19 },
      { id: 'free', accts: [], balance: 7, targetUsd: 10, supplyEnabled: false, supply: { childPid: null, cooldownSec: 0 }, prevBalance: 7 },
    ],
    evts: [], stats: { aiCalls: 0, aiCost: 0 }, flight: { workers: [] }, now: Date.now(), cols: 100, rows: 30, tty: false, gatewayState: 'off',
  }, { windowMin: 30, gatewayPort: 1 });
  assert.match(multi, /1 ledger\(s\) unreadable/);
  assert.match(multi, /\$7\.00/, 'known pools still sum');
});

test('supply controller: an unknown balance holds instead of spawning', () => {
  const events = [];
  let spawned = 0;
  const ctl = createSupplyController({
    targetUsd: 20, perAccountUsd: 1, checkIntervalMs: 0, balance: () => null,
    spawnBatch: () => { spawned++; return null; }, emit: (n, f) => events.push([n, f]),
  });
  ctl.check();
  assert.equal(spawned, 0, 'unknown is not "below target"');
  assert.deepEqual(events, [['supply.hold', { reason: 'balance-unknown', target: 20 }]]);
});

/** A batch that never exits cleanly is not what we are testing: run one spawn to
 *  completion by firing the exit handler the controller hooked. */
function runBatch(ctl, exits) {
  ctl.check();
  exits.shift()();
}

test('supply controller: batches that add no credit open the breaker instead of spawning forever', () => {
  const events = [];
  const exits = [];
  let spawned = 0;
  let bal = 0;                                   // upstream mints accounts worth $0
  const ctl = createSupplyController({
    targetUsd: 70, perAccountUsd: 7, checkIntervalMs: 0, stallBatches: 3, balance: () => bal,
    spawnBatch: () => { spawned++; return { pid: spawned, once: (ev, fn) => { if (ev === 'exit') exits.push(fn); } }; },
    emit: (n, f) => events.push([n, f]),
  });
  for (let i = 0; i < 3; i++) runBatch(ctl, exits);
  assert.equal(spawned, 3);
  assert.deepEqual(ctl.stalled, { atUsd: 0, batches: 3 });
  ctl.check();
  assert.equal(spawned, 3, 'breaker open: the next check spawns nothing');
  assert.equal(events.filter(([n]) => n === 'supply.stall').length, 1, 'says so once, not per check');

  // credit arrives by another path (manual batch, campaign restored) -> re-arm
  bal = 7;
  ctl.check();
  assert.equal(spawned, 4);
  assert.equal(ctl.stalled, null);
  assert.deepEqual(events.at(-2), ['supply.resume', { balance_usd: 7, was_usd: 0, target: 70 }]);
});

test('supply controller: a batch that pays for itself never counts toward the breaker', () => {
  const exits = [];
  let spawned = 0;
  let bal = 0;
  const ctl = createSupplyController({
    targetUsd: 100, perAccountUsd: 7, checkIntervalMs: 0, stallBatches: 3, balance: () => bal,
    spawnBatch: () => { spawned++; return { pid: spawned, once: (ev, fn) => { if (ev === 'exit') exits.push(fn); } }; },
  });
  for (let i = 0; i < 6; i++) { ctl.check(); bal += 7; exits.shift()(); }
  assert.equal(spawned, 6, 'credit keeps arriving = keep replenishing');
  assert.equal(ctl.stalled, null);
});

// local helper: read JSONL without importing jsonl.mjs twice
function readJsonlLocal(path) {
  const out = [];
  const latest = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    if (j.email) latest.set(j.email, j);
  }
  for (const v of latest.values()) out.push(v);
  return out;
}


test('runWatch: the embedded gateway is OPT-IN — the fleet gateway serves the pool; embedGateway:true still listens (debug)', async () => {
  const { dir, a, eventsFile } = fixture();
  const mkHook = () => {
    const calls = { created: 0, listened: null };
    const createGateway = () => { calls.created++; return { server: { once() {}, listen(port, host, cb) { calls.listened = port; cb(); } } }; };
    return { calls, createGateway };
  };
  const events = [];
  const base = (extra) => ({
    root: dir, eventsFile, windowMin: 30, once: false, gatewayPort: 48799, holdOpen: false,
    accountsFile: a, usageFile: join(dir, 'a-usage.jsonl'), targetUsd: 20, balanceRotateSec: 3600,
    emit: (name, fields) => events.push({ name, ...fields }),
    ...extra,
  });

  // default: hook present, nothing listens, the panel says so
  const h1 = mkHook();
  let state1 = null;
  await runWatch(base({ createGateway: h1.createGateway, render: (ctx) => { state1 = ctx.gatewayState; return ''; } }));
  assert.equal(h1.calls.created, 0, 'gateway not even constructed');
  assert.equal(h1.calls.listened, null);
  assert.equal(state1, 'fleet');
  assert.equal(events.find((e) => e.name === 'gateway.start'), undefined);

  // explicit opt-in: listens on gatewayPort
  const h2 = mkHook();
  let state2 = null;
  await runWatch(base({ createGateway: h2.createGateway, embedGateway: true, render: (ctx) => { state2 = ctx.gatewayState; return ''; } }));
  assert.equal(h2.calls.created, 1);
  assert.equal(h2.calls.listened, 48799);
  assert.equal(state2, 'up');
  assert.ok(events.find((e) => e.name === 'gateway.start' && e.port === 48799 && e.embedded === true));

  // no hook at all: plain off
  let state3 = null;
  await runWatch(base({ render: (ctx) => { state3 = ctx.gatewayState; return ''; } }));
  assert.equal(state3, 'off');

  // the render vocabulary for the new state
  const frame = defaultRender({
    accts: readJsonlLocal(a), balance: 20, evts: [], stats: { aiCalls: 0, aiCost: 0, byEndpoint: {}, fails: 0 }, flight: { workers: [] },
    now: Date.now(), cols: 100, rows: 30, tty: false, gatewayState: 'fleet', keeper: { active: false, childPid: null, cooldownSec: 0 },
  }, { targetUsd: 20, windowMin: 30, gatewayPort: 48799 });
  assert.match(frame, /fleet gateway serves this pool/);
  assert.match(frame, /48799/, 'tells you how to turn the debug gateway on');
  // runtime facts come from ctx, not H (the single panel used to print "gateway off" while listening)
  const live = defaultRender({
    accts: readJsonlLocal(a), balance: 20, evts: [], stats: { aiCalls: 0, aiCost: 0, byEndpoint: {}, fails: 0 }, flight: { workers: [] },
    now: Date.now(), cols: 100, rows: 30, tty: false, gatewayState: 'up', keeper: { active: true, childPid: null, cooldownSec: 12 },
  }, { targetUsd: 20, windowMin: 30, gatewayPort: 48799 });
  assert.match(live, /gateway\s+http:\/\/127\.0\.0\.1:48799\/v1/);
  assert.match(live, /supply\s+idle · target \$20/);
});
