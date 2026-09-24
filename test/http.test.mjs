// http wrapper contracts: every call emits an http event (success included),
// klass classification is stable, non-2xx carries the upstream body snippet,
// transport errors map to klass transport with status 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { jsonCall, probe, classifyStatus, ApiError } from '../src/http.mjs';
import { createLogger } from '../src/logger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address();
      try { await fn(`http://127.0.0.1:${port}`); resolve(); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

test('jsonCall logs ok + parses JSON, emits http event with ms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-http-'));
  const events = join(dir, 'events.jsonl');
  const log = createLogger({ eventsFile: events, quiet: true });
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (base) => {
    const data = await jsonCall({ base, path: '/x', name: 'test', log });
    assert.deepEqual(data, { ok: true });
    const { readJsonl } = await import('../src/jsonl.mjs');
    const evts = readJsonl(events);
    assert.equal(evts.length, 1);
    assert.equal(evts[0].event, 'http');
    assert.equal(evts[0].status, 200);
    assert.equal(evts[0].klass, 'ok');
  });
});

test('non-2xx throws ApiError with klass + detail snippet, logs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-http-'));
  const events = join(dir, 'events.jsonl');
  const log = createLogger({ eventsFile: events, quiet: true });
  await withServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { detail: 'You are doing that a bit fast' } }));
  }, async (base) => {
    await assert.rejects(
      () => jsonCall({ base, path: '/submit', name: 'submit', method: 'POST', log }),
      (err) => err instanceof ApiError && err.status === 429 && err.klass === 'rate_fast' && /a bit fast/.test(err.message),
    );
    const { readJsonl } = await import('../src/jsonl.mjs');
    const [evt] = readJsonl(events);
    assert.equal(evt.klass, 'rate_fast');
    assert.ok(evt.detail.includes('a bit fast'));
  });
});

test('transport error maps to klass transport, status 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-http-'));
  const events = join(dir, 'events.jsonl');
  const log = createLogger({ eventsFile: events, quiet: true });
  await assert.rejects(
    () => jsonCall({ base: 'http://127.0.0.1:1', path: '/x', name: 't', log, timeoutMs: 500 }),
    (err) => err.klass === 'transport' && err.status === 0,
  );
});

test('probe never throws, returns ok/status/latency', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'm1' }));
  }, async (base) => {
    const r = await probe({ url: base + '/v1/chat/completions' });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'm1');
    assert.ok(r.latency_ms >= 0);
    const bad = await probe({ url: 'http://127.0.0.1:1/x', timeoutMs: 300 });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 0);
  });
});

test('classifyStatus is stable across known codes', () => {
  assert.equal(classifyStatus(429), 'rate_fast');
  assert.equal(classifyStatus(403), 'forbidden');
  assert.equal(classifyStatus(0), 'transport');
  assert.equal(classifyStatus(503), 'server_error');
  assert.equal(classifyStatus(422), 'http');
  assert.equal(classifyStatus(200), 'http');
});
