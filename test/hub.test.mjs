// Hub contracts: one port, many upstreams, routed by requested model.
// Every assertion drives the REAL hub + REAL key pools against fake upstream
// HTTP servers (no fetch stubbing), so rotation/affinity/ledger behaviour is
// exercised end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl } from '../src/jsonl.mjs';
import { readUsageRows } from '../src/usage.mjs';
import { createLogger } from '../src/logger.mjs';
import { createHub } from '../src/hub.mjs';

const RATES = { in: 1, out: 2 };

/** Fake OpenAI-ish upstream: /models + /chat/completions. Records calls. */
function fakeUpstream({ models, reply = 'pong', failOnce = null }) {
  const calls = [];
  let failed = false;
  const server = createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({ key: auth, model: body.model });
      if (failOnce && !failed && failOnce.key === auth) {
        failed = true;
        res.writeHead(failOnce.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { detail: failOnce.detail || 'nope' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'x', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  return {
    server, calls,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

const classify = (s) => (s === 402 || s === 401 ? 'balance' : s === 404 ? 'model_mismatch' : s === 429 ? 'concurrency' : s >= 500 ? 'network' : 'client');

function providerFixture(dir, { id, base, keys, aliases = {}, models }) {
  const accountsFile = join(dir, `${id}-accounts.jsonl`);
  for (const k of keys) appendJsonl(accountsFile, { email: `${k}@${id}`, status: 'verified', api_key: k, balance_usd: 5 });
  return {
    id, base, accountsFile, usagePath: join(dir, `${id}-usage.jsonl`),
    rates: () => RATES, classifyFailure: classify, aliases, models,
    poolName: id,
  };
}

async function withHub(ctx, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-'));
  const a = fakeUpstream({ models: ['alpha-model'], reply: 'from-A' });
  const b = fakeUpstream({ models: ['beta-model', 'shared-model'], reply: 'from-B' });
  const portA = await a.listen();
  const portB = await b.listen();
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const hub = createHub({
    log,
    providers: [
      // 'shared-model' is declared by BOTH pools: the merged catalog must mirror it with prefixes
      providerFixture(dir, { id: 'aaa', base: `http://127.0.0.1:${portA}/v1`, keys: ['ka1'], models: ['alpha-model', 'shared-model'] }),
      providerFixture(dir, { id: 'bbb', base: `http://127.0.0.1:${portB}/v1`, keys: ['kb1', 'kb2'], aliases: { deepseek: 'beta-model' }, models: ['beta-model', 'shared-model'] }),
    ],
    defaultUpstream: ctx.defaultUpstream ?? null,
  });
  try {
    await fn({ hub, a, b, dir });
  } finally {
    a.close();
    b.close();
  }
}

function fakeReq(headers = {}) { return { headers }; }
function fakeRes() {
  const st = { code: 0, body: '' };
  return {
    writeHead(code) { st.code = code; },
    write(c) { st.body += Buffer.from(c || '').toString('utf8'); return true; },
    end(x) { if (x) st.body += Buffer.from(x).toString('utf8'); },
    _state: st,
  };
}

test('hub routes by catalog: each model lands in its own upstream pool', async () => {
  await withHub({}, async ({ hub, a, b }) => {
    const r1 = fakeRes();
    await hub.handleChat(fakeReq(), r1, Buffer.from(JSON.stringify({ model: 'beta-model', messages: [{ role: 'user', content: 'hi' }] })));
    assert.equal(r1._state.code, 200);
    assert.match(r1._state.body, /from-B/);
    assert.deepEqual(b.calls.map((c) => c.key), ['kb1']);
    assert.equal(a.calls.length, 0, 'alpha pool untouched');
  });
});

test('hub: a model two pools both serve is never silently routed (目录唯一)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-amb-'));
  const a = fakeUpstream({ models: ['dup', 'only-a'], reply: 'from-A' });
  const b = fakeUpstream({ models: ['dup', 'only-b'], reply: 'from-B' });
  const portA = await a.listen();
  const portB = await b.listen();
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  try {
    const hub = createHub({
      log,
      providers: [
        providerFixture(dir, { id: 'aaa', base: `http://127.0.0.1:${portA}/v1`, keys: ['ka1'], models: ['dup', 'only-a'] }),
        providerFixture(dir, { id: 'bbb', base: `http://127.0.0.1:${portB}/v1`, keys: ['kb1'], models: ['dup', 'only-b'] }),
      ],
    });
    // no default pool -> an ambiguous id is a 404, not a coin flip
    const r1 = fakeRes();
    await hub.handleChat(fakeReq(), r1, Buffer.from(JSON.stringify({ model: 'dup', messages: [] })));
    assert.equal(r1._state.code, 404);
    assert.equal(a.calls.length + b.calls.length, 0, 'no pool may be touched on an ambiguous id');

    // the prefix mirror clients are pointed at does resolve it
    const r2 = fakeRes();
    await hub.handleChat(fakeReq(), r2, Buffer.from(JSON.stringify({ model: 'bbb/dup', messages: [] })));
    assert.equal(r2._state.code, 200);
    assert.equal(b.calls.at(-1).model, 'dup', 'prefix forces the bbb pool');

    // and the ambiguity is visible in the event stream
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((e) => e.event === 'hub.ambiguous_model');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].upstreams.slice().sort(), ['aaa', 'bbb']);
    assert.equal(events[0].model, 'dup');
  } finally {
    a.close();
    b.close();
  }
});

test('hub routes by alias and by explicit prefix', async () => {
  await withHub({}, async ({ hub, a, b }) => {
    const r1 = fakeRes();
    await hub.handleChat(fakeReq(), r1, Buffer.from(JSON.stringify({ model: 'deepseek', messages: [] })));
    assert.equal(r1._state.code, 200);
    assert.equal(b.calls.at(-1).model, 'beta-model', 'alias rewrites to the concrete upstream model');

    const r2 = fakeRes();
    await hub.handleChat(fakeReq(), r2, Buffer.from(JSON.stringify({ model: 'aaa/alpha-model', messages: [] })));
    assert.equal(r2._state.code, 200);
    assert.equal(a.calls.at(-1).model, 'alpha-model', 'prefix forces the aaa pool and strips the prefix');

    // prefix + that pool's alias: forcing a pool must not lose the alias (bbb/deepseek → beta-model)
    const r3 = fakeRes();
    await hub.handleChat(fakeReq(), r3, Buffer.from(JSON.stringify({ model: 'bbb/deepseek', messages: [] })));
    assert.equal(r3._state.code, 200);
    assert.equal(b.calls.at(-1).model, 'beta-model', 'prefix/alias resolves through the pool alias table');
  });
});

test('hub 404s an unroutable model and names the available upstreams', async () => {
  await withHub({}, async ({ hub }) => {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'nope-model', messages: [] })));
    assert.equal(r._state.code, 404);
    assert.match(r._state.body, /model_not_found/);
    assert.match(r._state.body, /aaa/);
    assert.match(r._state.body, /bbb/);
  });
});

test('hub falls back to defaultUpstream only when nothing else matches', async () => {
  await withHub({ defaultUpstream: 'bbb' }, async ({ hub, a }) => {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'unlisted-model', messages: [] })));
    assert.equal(r._state.code, 200, 'default pool serves it');
    assert.equal(a.calls.length, 0);
  });
});

test('hub /v1/models merges catalogs and mirrors colliding ids with a prefix', async () => {
  await withHub({}, async ({ hub }) => {
    const merged = await hub.mergedModels();
    const ids = merged.data.map((m) => m.id);
    assert.ok(ids.includes('alpha-model'));
    assert.ok(ids.includes('beta-model'));
    assert.equal(merged.data.find((m) => m.id === 'beta-model').owned_by, 'bbb');
    // the collision: bare id listed once per owner, plus one forced-prefix mirror each
    assert.deepEqual(merged.data.filter((m) => m.id === 'shared-model').map((m) => m.owned_by).sort(), ['aaa', 'bbb']);
    assert.ok(ids.includes('aaa/shared-model'));
    assert.ok(ids.includes('bbb/shared-model'));
    assert.ok(!ids.includes('aaa/alpha-model'), 'unique ids get no mirror');
  });
});

test('hub health reports every pool separately plus totals', async () => {
  await withHub({}, async ({ hub }) => {
    const h = await hub.health();
    assert.equal(h.gateway, 'hub');
    assert.equal(h.upstreams.aaa.eligible_keys, 1);
    assert.equal(h.upstreams.bbb.eligible_keys, 2);
    assert.equal(h.totals.upstreams, 2);
    assert.equal(h.totals.eligible_keys, 3);
    assert.equal(h.totals.display_balance_usd, 15);
  });
});

test('hub: a 402 in one pool retires only that pool key, the other pool is untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-drain-'));
  const a = fakeUpstream({ models: ['alpha-model'], reply: 'from-A' });
  const b = fakeUpstream({ models: ['beta-model'], reply: 'from-B', failOnce: { key: 'kb1', status: 402, detail: 'insufficient wallet balance' } });
  const portA = await a.listen();
  const portB = await b.listen();
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  const retired = [];
  const mk = (id, port, keys, models) => {
    const accountsFile = join(dir, `${id}-accounts.jsonl`);
    for (const k of keys) appendJsonl(accountsFile, { email: `${k}@${id}`, status: 'verified', api_key: k, balance_usd: 5 });
    return {
      id, base: `http://127.0.0.1:${port}/v1`, accountsFile, usagePath: join(dir, `${id}-usage.jsonl`),
      rates: () => RATES, classifyFailure: classify, models, poolName: id,
      retire: (acct, reason, status) => retired.push({ id, email: acct.email, reason, status }),
    };
  };
  const hub = createHub({
    log,
    providers: [mk('aaa', portA, ['ka1'], ['alpha-model']), mk('bbb', portB, ['kb1', 'kb2'], ['beta-model'])],
  });
  try {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'beta-model', messages: [] })));
    assert.equal(r._state.code, 200, 'client still gets a clean 200');
    assert.match(r._state.body, /from-B/);
    assert.deepEqual(b.calls.map((c) => c.key), ['kb1', 'kb2'], 'rotated inside bbb only');
    assert.deepEqual(retired, [{ id: 'bbb', email: 'kb1@bbb', reason: 'balance', status: 402 }]);
    assert.equal((await hub.health()).upstreams.bbb.eligible_keys, 1);
    assert.equal((await hub.health()).upstreams.aaa.eligible_keys, 1);
  } finally {
    a.close();
    b.close();
  }
});

test('hub writes each upstream spend into its OWN ledger', async () => {
  await withHub({}, async ({ hub, dir }) => {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'alpha-model', messages: [] })));
    const rowsA = readUsageRows(join(dir, 'aaa-usage.jsonl'));
    const rowsB = readUsageRows(join(dir, 'bbb-usage.jsonl'));
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].note, 'aaa');
    assert.equal(rowsA[0].model, 'alpha-model');
    assert.equal(rowsB.length, 0);
  });
});

test('hub enforces one shared client token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-tok-'));
  const a = fakeUpstream({ models: ['alpha-model'] });
  const port = await a.listen();
  const accountsFile = join(dir, 'a.jsonl');
  appendJsonl(accountsFile, { email: 'k@a', status: 'verified', api_key: 'ka1', balance_usd: 5 });
  const hub = createHub({
    log: createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true }),
    token: 'secret-token',
    providers: [{ id: 'aaa', base: `http://127.0.0.1:${port}/v1`, accountsFile, usagePath: join(dir, 'u.jsonl'), rates: () => RATES, classifyFailure: classify, models: ['alpha-model'] }],
  });
  try {
    const server = hub.server;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const portG = server.address().port;
    const bad = await fetch(`http://127.0.0.1:${portG}/v1/models`);
    assert.equal(bad.status, 401);
    const ok = await fetch(`http://127.0.0.1:${portG}/v1/models`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(ok.status, 200);
    // Anthropic-style clients (Anthropic Messages SDKs) present the same token as x-api-key
    const xk = await fetch(`http://127.0.0.1:${portG}/v1/models`, { headers: { 'x-api-key': 'secret-token' } });
    assert.equal(xk.status, 200, 'x-api-key is the same one token');
    const badXk = await fetch(`http://127.0.0.1:${portG}/v1/models`, { headers: { 'x-api-key': 'wrong' } });
    assert.equal(badXk.status, 401);
    const body = await ok.json();
    assert.deepEqual(body.data.map((m) => m.id), ['alpha-model']);
    const health = await (await fetch(`http://127.0.0.1:${portG}/health`, { headers: { authorization: 'Bearer secret-token' } })).json();
    assert.equal(health.totals.eligible_keys, 1);
  } finally {
    a.close();
    await new Promise((r) => hub.server.close(r));
  }
});

test('hub/pool: per-upstream auth header and chat path are honoured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-auth-'));
  // upstream that takes x-api-key auth and serves chat at /v1/chat/
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, auth: req.headers['x-api-key'] || req.headers.authorization || '', body: Buffer.concat(chunks).toString() });
    if (req.url === '/api/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'kimi-k2' }] }));
    }
    if (req.url === '/v1/chat/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const accountsFile = join(dir, 'a.jsonl');
  appendJsonl(accountsFile, { email: 'k@a', status: 'verified', api_key: 'tmp_key_123', balance_usd: 1 });
  const hub = createHub({
    log: createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true }),
    providers: [{
      id: 'xkey', base: `http://127.0.0.1:${port}`, accountsFile, usagePath: join(dir, 'u.jsonl'),
      rates: () => RATES, classifyFailure: classify, models: ['kimi-k2'],
      authHeader: 'x-api-key', chatPath: '/v1/chat/', modelsPath: '/api/v1/models',
      balanceEligible: () => true,
    }],
  });
  try {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'kimi-k2', messages: [] })));
    assert.equal(r._state.code, 200);
    const chatCall = seen.find((c) => c.url === '/v1/chat/');
    assert.equal(chatCall.auth, 'tmp_key_123', 'x-api-key header carries the key, no Bearer');
    const models = (await hub.mergedModels()).data.map((m) => m.id);
    assert.deepEqual(models, ['kimi-k2'], 'custom models path discovered');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('catalog: one pull shared by models() and GET /v1/models; blocklist applies on read (no cache wait)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-cat-'));
  let pulls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      pulls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'keep' }, { id: 'doomed' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const accountsFile = join(dir, 'a.jsonl');
  appendJsonl(accountsFile, { email: 'k@a', status: 'verified', api_key: 'sk-x', balance_usd: 1 });
  let blocked = [];
  const hub = createHub({
    log: createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true }),
    providers: [{
      id: 'p', base: `http://127.0.0.1:${port}/v1`, accountsFile, usagePath: join(dir, 'u.jsonl'),
      rates: () => RATES, classifyFailure: classify, modelBlocklist: () => blocked,
    }],
  });
  try {
    assert.deepEqual((await hub.mergedModels()).data.map((m) => m.id), ['keep', 'doomed']);
    const r = fakeRes();
    await hub.providers[0].pool.handleModels(r);
    assert.equal(r._state.code, 200);
    assert.equal(pulls, 1, 'the HTTP face reuses the cached pull, no second fetch');
    assert.equal((await hub.health()).upstreams.p.models_cached, 2);

    // health.json delists a model: visible immediately, the cache is NOT re-pulled
    blocked = ['doomed'];
    assert.deepEqual((await hub.mergedModels()).data.map((m) => m.id), ['keep']);
    assert.equal(pulls, 1);
    assert.equal(await hub.route('doomed'), null, 'a delisted id is not routable by catalog');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('catalog: a failed re-pull after the TTL serves the LAST GOOD list, not an empty one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-stale-'));
  let pulls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      pulls += 1;
      if (pulls > 1) { res.writeHead(502); return res.end('{}'); }   // upstream blip
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const accountsFile = join(dir, 'a.jsonl');
  appendJsonl(accountsFile, { email: 'k@a', status: 'verified', api_key: 'sk-x', balance_usd: 1 });
  const hub = createHub({
    log: createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true }),
    providers: [{
      id: 'p', base: `http://127.0.0.1:${port}/v1`, accountsFile, usagePath: join(dir, 'u.jsonl'),
      rates: () => RATES, classifyFailure: classify, catalogTtlMs: 1,   // expires immediately
    }],
  });
  try {
    assert.deepEqual((await hub.mergedModels()).data.map((m) => m.id), ['m1']);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual((await hub.mergedModels()).data.map((m) => m.id), ['m1'], 'stale-on-error keeps routing alive');
    assert.equal(pulls, 2, 'it did try to refresh');
    assert.equal((await hub.route('m1'))?.provider.id, 'p');
    const r = fakeRes();
    await hub.providers[0].pool.handleModels(r);
    assert.equal(r._state.code, 200, 'HTTP face serves the cached list rather than relaying the 502');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('pool never forwards the client UA upstream (Cloudflare/bot-filter safety)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-ua-'));
  let seenUA = null;
  let seenHeaders = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === '/v1/chat/completions') {
      seenUA = req.headers['user-agent'];
      seenHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const accountsFile = join(dir, 'a.jsonl');
  appendJsonl(accountsFile, { email: 'k@a', status: 'verified', api_key: 'sk-x', balance_usd: 1 });
  const hub = createHub({
    log: createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true }),
    providers: [{
      id: 'alpha', base: `http://127.0.0.1:${port}/v1`, accountsFile, usagePath: join(dir, 'u.jsonl'),
      rates: () => RATES, classifyFailure: classify, models: ['m'],
    }],
  });
  try {
    const r = fakeRes();
    await hub.handleChat(fakeReq({ 'user-agent': 'python-urllib/3.14', 'x-api-key': 'hub-token', authorization: 'Bearer hub-token', 'anthropic-version': '2023-06-01' }), r,
      Buffer.from(JSON.stringify({ model: 'm', messages: [] })));
    assert.equal(r._state.code, 200);
    assert.ok(!String(seenUA).includes('python-urllib'), 'client UA must not leak upstream');
    assert.match(String(seenUA), /regkit-gateway/, 'gateway presents its own UA');
    // the client's gateway token never travels upstream in any spelling; the pool key does
    assert.equal(seenHeaders['x-api-key'], undefined, 'client x-api-key stripped');
    assert.equal(seenHeaders.authorization, 'Bearer sk-x', 'pool key in the upstream auth flavour');
    assert.equal(seenHeaders['anthropic-version'], '2023-06-01', 'protocol headers still pass');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});


test('hub: an alias two pools both declare is ambiguous — never first-wins; prefix/alias still forces a pool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-hub-alias-'));
  const a = fakeUpstream({ models: ['alpha-model'], reply: 'from-A' });
  const b = fakeUpstream({ models: ['beta-model'], reply: 'from-B' });
  const portA = await a.listen();
  const portB = await b.listen();
  const events = join(dir, 'events.jsonl');
  const hub = createHub({
    log: createLogger({ eventsFile: events, quiet: true }),
    providers: [
      providerFixture(dir, { id: 'aaa', base: `http://127.0.0.1:${portA}/v1`, keys: ['ka1'], aliases: { deepseek: 'alpha-model' }, models: ['alpha-model'] }),
      providerFixture(dir, { id: 'bbb', base: `http://127.0.0.1:${portB}/v1`, keys: ['kb1'], aliases: { deepseek: 'beta-model' }, models: ['beta-model'] }),
    ],
  });
  try {
    const r = fakeRes();
    await hub.handleChat(fakeReq(), r, Buffer.from(JSON.stringify({ model: 'deepseek', messages: [] })));
    assert.equal(r._state.code, 404, 'bare ambiguous alias is not routed');
    assert.equal(a.calls.length + b.calls.length, 0);
    const r2 = fakeRes();
    await hub.handleChat(fakeReq(), r2, Buffer.from(JSON.stringify({ model: 'bbb/deepseek', messages: [] })));
    assert.equal(r2._state.code, 200);
    assert.equal(b.calls.at(-1).model, 'beta-model');
    const ev = readFileSync(events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ev.some((e) => e.event === 'hub.alias_collision' && e.alias === 'deepseek'), 'collision announced at build');
    assert.ok(ev.some((e) => e.event === 'hub.ambiguous_model' && e.model === 'deepseek'), 'and at request time');
  } finally { a.close(); b.close(); }
});
