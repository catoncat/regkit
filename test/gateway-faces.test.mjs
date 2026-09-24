// Three protocol faces + dialect contracts. Fetch-stub style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl } from '../src/jsonl.mjs';
import { createLogger } from '../src/logger.mjs';
import { createKeyPool } from '../src/pool.mjs';

const RATES = { in: 1, out: 2 };
const classify = (s) => (s === 402 || s === 401 ? 'balance' : s === 404 ? 'model_mismatch' : s === 429 ? 'concurrency' : s >= 500 ? 'network' : 'client');
const req = { headers: {} };
const res = () => {
  const st = { code: 0, body: '', headers: {} };
  return {
    writeHead(code, h) { st.code = code; st.headers = h || {}; },
    write(c) { st.body += Buffer.from(c || '').toString('utf8'); return true; },
    end(b) { if (b) st.body += Buffer.from(b).toString('utf8'); },
    _state: st,
  };
};

function mkPool(dir, extra = {}) {
  const accountsFile = join(dir, 'accounts.jsonl');
  appendJsonl(accountsFile, { email: 'a@x', status: 'verified', api_key: 'k1', balance_usd: 5 });
  const log = createLogger({ eventsFile: join(dir, 'events.jsonl'), quiet: true });
  return createKeyPool({
    id: 'test', base: 'http://upstream/v1', accountsFile, usagePath: join(dir, 'usage.jsonl'),
    rates: () => RATES, classifyFailure: classify, log, ...extra,
  });
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(Buffer.from(init.body).toString('utf8')) : null;
    calls.push({ url: String(url), body, headers: init?.headers });
    const result = handler(String(url), body, init);
    // honour AbortSignal like real fetch (metering relies on the 3s budget)
    if (init?.signal) {
      return Promise.race([result, new Promise((_, rej) => {
        if (init.signal.aborted) return rej(new Error('The operation was aborted'));
        init.signal.addEventListener('abort', () => rej(new Error('The operation was aborted')), { once: true });
      })]);
    }
    return result;
  };
  return { restore: () => { globalThis.fetch = real; }, calls };
}
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('chat face applies injectFields + rewriteRoles + ensureAssistantFields (additive)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, {
    dialect: {
      injectFields: { th_confirm_spend: true },
      rewriteRoles: { developer: 'system' },
      ensureAssistantFields: { reasoning_content: '' },
    },
  });
  const s = stubFetch(() => jsonResp({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  try {
    await pool.handleChat(req, res(), Buffer.from(JSON.stringify({
      model: 'm',
      messages: [
        { role: 'developer', content: 'dev' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', reasoning_content: 'keep-me' },
        { role: 'assistant', content: 'b' },
      ],
    })));
  } finally { s.restore(); }
  const sent = s.calls[0].body;
  assert.equal(sent.th_confirm_spend, true);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[2].reasoning_content, 'keep-me'); // never overwrites
  assert.equal(sent.messages[3].reasoning_content, '');
});

test('responses face: injectFields applied, chat dialect NOT applied, include_usage injected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, {
    faces: ['chat', 'responses'],
    dialect: { injectFields: { th_confirm_spend: true }, rewriteRoles: { developer: 'system' } },
  });
  const s = stubFetch(() => jsonResp({ usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } }));
  try {
    const r = res();
    await pool.handleResponses(req, r, Buffer.from(JSON.stringify({
      model: 'm', stream: true, input: [{ role: 'developer', content: 'dev' }],
    })));
    assert.equal(r._state.code, 200);
  } finally { s.restore(); }
  const sent = s.calls[0].body;
  assert.equal(sent.th_confirm_spend, true);
  assert.equal(sent.input[0].role, 'developer'); // chat dialect must not leak onto this face
  assert.equal(sent.stream_options.include_usage, true);
});

test('stripOn400: declared degradation retries once without the field, same key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, { dialect: { stripOn400: ['tools', 'tool_choice'] } });
  const s = stubFetch((url, body) => (body.tools ? jsonResp({ error: { message: 'tools unsupported' } }, 400) : jsonResp({ usage: { prompt_tokens: 1, completion_tokens: 1 } })));
  try {
    const r = res();
    await pool.handleChat(req, r, Buffer.from(JSON.stringify({
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto',
    })));
    assert.equal(r._state.code, 200);
  } finally { s.restore(); }
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].body.tools.length, 1);
  assert.equal(s.calls[1].body.tools, undefined);
  assert.equal(s.calls[1].body.tool_choice, undefined);
});

test('messages face: x-api-key + anthropic-version, usage from anthropic SSE shapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, { faces: ['chat', 'messages'] });
  const NL = String.fromCharCode(10);
  const sse = [
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 4 } } }),
    'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }),
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 6 } }),
    '',
  ].join(NL);
  const s = stubFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const r = res();
    await pool.handleMessages(req, r, Buffer.from(JSON.stringify({
      model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }],
    })));
    assert.equal(r._state.code, 200);
  } finally { s.restore(); }
  const headers = s.calls[0].headers;
  assert.equal(headers.get('x-api-key'), 'k1');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('authorization'), null);
  // ledger booked normalized usage
  const { readUsageRows } = await import('../src/usage.mjs');
  const rows = readUsageRows(join(dir, 'usage.jsonl'));
  assert.equal(rows.at(-1).prompt_tokens, 11);
  assert.equal(rows.at(-1).completion_tokens, 6);
});

test('count_tokens: upstream stall falls back to local CJK-aware estimate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, { faces: ['messages'] });
  const s = stubFetch(() => new Promise(() => {})); // never resolves
  const started = Date.now();
  try {
    const r = res();
    await pool.handleMessages(req, r, Buffer.from(JSON.stringify({
      model: 'm', messages: [{ role: 'user', content: '你好世界你好世界' }],
    })), { metering: true });
    assert.equal(r._state.code, 200);
    const est = JSON.parse(r._state.body).input_tokens;
    assert.ok(est >= 8 && est <= 12, 'CJK estimate in range, got ' + est);
  } finally { s.restore(); }
  assert.ok(Date.now() - started < 4000, 'must not wait the full LLM timeout');
});

test('face_not_supported: clean 404 listing available faces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  const pool = mkPool(dir, {}); // chat only
  const r = res();
  await pool.handleResponses(req, r, Buffer.from(JSON.stringify({ model: 'm', input: 'hi' })));
  assert.equal(r._state.code, 404);
  const err = JSON.parse(r._state.body).error;
  assert.equal(err.type, 'face_not_supported');
  assert.deepEqual(err.faces, ['chat']);
});

test('modelBlocklist: blocked model 404s before any upstream call (fn form)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-face-'));
  let blocked = ['old-model'];
  const pool = mkPool(dir, { modelBlocklist: () => blocked });
  let upstreamCalls = 0;
  const s = stubFetch(() => { upstreamCalls++; return jsonResp({}); });
  try {
    const r = res();
    await pool.handleChat(req, r, Buffer.from(JSON.stringify({ model: 'old-model', messages: [] })));
    assert.equal(r._state.code, 404);
    assert.equal(JSON.parse(r._state.body).error.type, 'model_delisted');
  } finally { s.restore(); }
  assert.equal(upstreamCalls, 0);
});
