// Gateway pure-function contracts. Cost math must match the official per-M
// rates exactly (a wrong table silently drains keys that still have credit).
// Rotation classes decide whether a key retires (402) or just rotates (404).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateCostUsd, extractUsage, injectIncludeUsage, conversationId, createGateway,
} from '../src/gateway.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl } from '../src/jsonl.mjs';
import { appendMergeLatest as appendAccountLocal } from '../src/jsonl.mjs';
import { latestWins as readAccountsLocal } from '../src/jsonl.mjs';
import { appendJsonl as recordUsageLocal } from '../src/jsonl.mjs';
import { createLogger } from '../src/logger.mjs';

const RATES = { in: 0.15, out: 0.35 };

test('cost math matches official pricing ($0.15/M in, $0.35/M out)', () => {
  assert.equal(estimateCostUsd(RATES, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0.5);
  const tiny = estimateCostUsd(RATES, { prompt_tokens: 100, completion_tokens: 200 });
  assert.ok(tiny > 0 && tiny < 0.001, 'tiny call books something');
  // 回归:单次 < $0.00005 的调用(4dp 会被归零)必须仍记 > 0,本地账本不丢消耗
  const sub = estimateCostUsd(RATES, { prompt_tokens: 89, completion_tokens: 8 });
  assert.ok(sub > 0, 'sub-$0.00005 call must still book spend (got ' + sub + ')');
  assert.equal(estimateCostUsd(RATES, null), 0);
  assert.equal(estimateCostUsd(RATES, {}), 0);
});

test('streaming usage extracted from final SSE chunk', () => {
  const NL = String.fromCharCode(10);
  const raw = [
    'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]',
    '',
  ].join(NL);
  assert.deepEqual(extractUsage(raw, true), { prompt_tokens: 10, completion_tokens: 5 });
  assert.deepEqual(extractUsage(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), false), { prompt_tokens: 7, completion_tokens: 3 });
});

test('include_usage injected once, only for streams', () => {
  const buf = Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [] }));
  const once = JSON.parse(injectIncludeUsage(buf).toString());
  assert.equal(once.stream_options.include_usage, true);
  const twice = JSON.parse(injectIncludeUsage(Buffer.from(JSON.stringify(once))).toString());
  assert.equal(twice.stream_options.include_usage, true); // idempotent
  const plain = injectIncludeUsage(Buffer.from(JSON.stringify({ model: 'm', messages: [] })));
  assert.equal(JSON.parse(plain.toString()).stream_options, undefined);
});

test('conversation pinning: immutable prompt head hashes stable, changes on compaction', () => {
  const a = Buffer.from(JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }] }));
  const b = Buffer.from(JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'x' }] }));
  const c = Buffer.from(JSON.stringify({ messages: [{ role: 'system', content: 'REWRITTEN' }, { role: 'user', content: 'q' }] }));
  assert.equal(conversationId(a), conversationId(b));
  assert.notEqual(conversationId(a), conversationId(c));
});

test('gateway health counts eligible keys and drains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gw-'));
  const accountsFile = join(dir, 'accounts.jsonl');
  const usagePath = join(dir, 'usage.jsonl');
  appendJsonl(accountsFile, { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  appendJsonl(accountsFile, { email: 'b@x', status: 'verified', api_key: 'k2', balance_usd: 5 });
  appendJsonl(accountsFile, { email: 'c@x', status: 'pending', api_key: 'k3' });
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const gw = createGateway({
    cfg: {},
    log,
    accountsFile,
    usagePath,
    upstreamBase: 'http://127.0.0.1:1/v1',
    rates: () => RATES,
    classifyFailure: (s) => s === 402 ? 'balance' : s === 404 ? 'model_mismatch' : s === 429 ? 'concurrency' : s >= 500 ? 'network' : 'client',
    gatewayToken: 'tok',
    poolName: 'test',
  });
  const h = gw.health();
  assert.equal(h.eligible_keys, 2);
  assert.equal(h.drained_keys, 0);
  assert.ok(h.display_balance_usd === 10);
  // drained via a 402-style manual retirement is not exposed here (no upstream),
  // but auth is enforced:
  assert.equal(typeof gw.borrow(null).api_key, 'string');
});


// ── 需求 2:无余额账号双写持久化 ─────────────────────────────
function stubFetchStatus(status, body) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Response(new Uint8Array(buf), { status, headers: { 'content-type': 'application/json' } });
  };
  return { restore: () => { globalThis.fetch = real; }, calls };
}
const req = { headers: {} };
const res = () => { const st = { code: 0, body: '' }; return {
  writeHead(code, h) { st.code = code; },
  write(c) { st.body += Buffer.from(c || '').toString('utf8'); return true; },
  end(b) { if (b) { try { st.body += Buffer.from(b).toString('utf8'); } catch { /* ignore */ } } },
  _state: st,
}; };

function classifyLike(s) {
  return s === 402 || s === 401 ? 'balance' : s === 404 ? 'model_mismatch' : s === 429 ? 'concurrency' : s >= 500 ? 'network' : 'client';
}

test('402 → retire hook 落盘 exhausted + 同进程不挑 + 重建后仍池外', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-drain-'));
  const accountsFile = join(dir, 'accounts.jsonl');
  const usagePath = join(dir, 'usage.jsonl');
  appendJsonl(accountsFile, { email: 'dead@x', status: 'verified', api_key: 'k-dead', balance_usd: 1 });
  appendJsonl(accountsFile, { email: 'alive@x', status: 'verified', api_key: 'k-alive', balance_usd: 1 });
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const retired = [];
  const gw = createGateway({
    cfg: {}, log, accountsFile, usagePath,
    upstreamBase: 'http://127.0.0.1:1/v1',
    rates: () => RATES,
    classifyFailure: classifyLike,
    gatewayToken: 'tok', poolName: 'test',
    retire: (account, reason, status) => {
      retired.push({ email: account.email, reason, status });
      appendAccountLocal(accountsFile, { email: account.email, status: 'exhausted', balance_usd: 0, checked_at: new Date().toISOString(), note: 'drained via gateway HTTP ' + status + ' (no-balance account)' });
    },
  });
  // 按 key 区分: dead@x → 402, alive@x → 200(真实 402 只打坏号)
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.get?.('authorization') || init?.headers?.authorization || '');
    const key = auth.replace(/^Bearer\s+/i, '');
    if (init?.method === 'POST' && String(url).endsWith('/chat/completions')) {
      seen.push(key);
      if (key === 'k-dead') return new Response(JSON.stringify({ error: { detail: 'insufficient wallet balance' } }), { status: 402, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const r = res();
    await gw.handleChat(req, r, Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(r._state.code, 200);                       // alive 兜底成功, 客户端拿到干净 200
  } finally { globalThis.fetch = real; }
  assert.deepEqual(retired, [{ email: 'dead@x', reason: 'balance', status: 402 }]);   // 只有坏号被 retire, alive 不落盘
  assert.deepEqual(seen, ['k-dead', 'k-alive']);            // dead 先打(402) → 换 alive 成功

  // 落盘: latest-wins 后 dead@x = exhausted, alive@x 原样 verified
  const rows = readAccountsLocal(accountsFile);
  const dead = rows.find((a) => a.email === 'dead@x');
  const alive = rows.find((a) => a.email === 'alive@x');
  assert.equal(dead.status, 'exhausted');
  assert.equal(dead.balance_usd, 0);
  assert.match(dead.note, /402/);
  assert.equal(dead.api_key, 'k-dead');   // 其他字段(明文 key)不受影响,仅状态变更
  assert.equal(alive.status, 'verified'); // 没被打过 402 的号保持原样

  // 同进程: dead 已内存拉黑 + 落盘 exhausted, 不再被挑
  assert.equal(gw.borrow(null)?.email, 'alive@x');
  assert.equal(gw.health().drained_keys, 1);

  // 重建网关(模拟重启, readAccounts 重读): dead 仍在池外, alive 还能用
  const gw2 = createGateway({
    cfg: {}, log, accountsFile, usagePath,
    upstreamBase: 'http://127.0.0.1:1/v1',
    rates: () => RATES, classifyFailure: classifyLike,
    gatewayToken: 'tok', poolName: 'test',
  });
  assert.equal(gw2.borrow(null)?.email, 'alive@x', '重建后 dead 仍在池外, 只挑 alive');
  assert.equal(gw2.health().eligible_keys, 1);
});

test('余额预检: displayedBalance <= 0 (非 undefined) 不可选, 其余不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-bal-'));
  const accountsFile = join(dir, 'accounts.jsonl');
  const usagePath = join(dir, 'usage.jsonl');
  appendJsonl(accountsFile, { email: 'empty@x', status: 'verified', api_key: 'k-e', balance_usd: 0 });
  appendJsonl(accountsFile, { email: 'neg@x', status: 'verified', api_key: 'k-n', balance_usd: -0.5 });
  appendJsonl(accountsFile, { email: 'ok@x', status: 'verified', api_key: 'k-o', balance_usd: 2 });
  appendJsonl(accountsFile, { email: 'unknown@x', status: 'verified', api_key: 'k-u' });   // 无锚点 → 显示 null, 仍可选
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const gw = createGateway({
    cfg: {}, log, accountsFile, usagePath,
    upstreamBase: 'http://127.0.0.1:1/v1',
    rates: () => RATES, classifyFailure: classifyLike,
    gatewayToken: 'tok', poolName: 'test',
  });
  const pool = gw.health().eligible_keys;
  assert.equal(pool, 2, '只留 ok@x + unknown@x (2 个), empty/neg 被本地余额预检拦下');
  const picked = [gw.borrow(null)?.email, gw.borrow(null)?.email].filter(Boolean);
  assert.deepEqual(picked.sort(), ['ok@x', 'unknown@x']);
  // 已用账本把 ok@x 打到 0 → 也不再可选
  recordUsageLocal(usagePath, { email: 'ok@x', cost_usd: 2, ts: new Date(Date.now() + 10000).toISOString() });
  const gw2 = createGateway({ cfg: {}, log, accountsFile, usagePath, upstreamBase: 'http://127.0.0.1:1/v1', rates: () => RATES, classifyFailure: classifyLike, gatewayToken: 'tok', poolName: 'test' });
  const b = gw2.borrow(null);
  assert.ok(b && b.email === 'unknown@x', 'ok@x 被本地消耗打穿到 0 后也不再可选');
});

test('429/5xx/model_mismatch: 只轮转不弃号, 不触发 retire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-noret-'));
  const accountsFile = join(dir, 'accounts.jsonl');
  const usagePath = join(dir, 'usage.jsonl');
  appendJsonl(accountsFile, { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const retired = [];
  for (const [code, body] of [[429, { error: { detail: 'rate limited' } }], [500, {}], [404, { error: { message: 'model not found' } }]]) {
    const gw = createGateway({
      cfg: {}, log, accountsFile, usagePath,
      upstreamBase: 'http://127.0.0.1:1/v1',
      rates: () => RATES, classifyFailure: classifyLike,
      gatewayToken: 'tok', poolName: 'test',
      retire: (acct) => retired.push(acct.email),
    });
    const s = stubFetchStatus(code, body);
    try {
      const r = res();
      await gw.handleChat(req, r, Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })));
    } finally { s.restore(); }
    assert.equal(gw.health().drained_keys, 0, 'HTTP ' + code + ' 不弃号');
    assert.ok(gw.borrow(null)?.email === 'a@x', 'HTTP ' + code + ' 后 a@x 仍在池内');
  }
  assert.deepEqual(retired, [], '429/5xx/model_mismatch 永不打 retire 落盘');
});
