// Wire-contract tests. The backend 422s on any field-name drift, and every
// failed attempt burns a real email + pacer slot — so the exact request
// bodies are pinned here instead of being discovered against production.
// Also pins the two operational invariants whose violation produces dead
// accounts:
//   * money is NEVER asserted without an authoritative read (billing)
//   * register is NEVER called without a mailbox-confirmed code

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOne } from '../src/register.mjs';
import { createLogger } from 'regkit/logger';
import { Mailbox } from 'regkit/mailbox';
import { jsonResponse, mockFetch, testCfg } from './helpers.mjs';

const SESSION = {
  access_token: 'jwt-token',
  token_type: 'bearer',
  expires_in: 3600,
  user: { id: 'u-1', email: 'x@y.z', role: 'admin' },
  company: { id: 'c-1', name: 'North Labs' },
  developer_api_key: 'sk-test-abcdef1234567890abcdef',
};

function happyRoutes() {
  return {
    'POST /api/v1/auth/verification-code': () => jsonResponse(201, { verification_id: 'vid-1', expires_in: 600 }),
    'POST /api/v1/auth/register': () => jsonResponse(201, SESSION),
    'GET /api/v1/billing': () => jsonResponse(200, { currency: 'USD', balance_usd: '5', available_usd: '5' }),
  };
}

function tempLogger() {
  const dir = mkdtempSync(join(tmpdir(), 'skeleton-test-'));
  const file = join(dir, 'events.jsonl');
  const log = createLogger({ eventsFile: file, level: 'error' });
  const events = () =>
    readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { log, events };
}

test('happy path sends exactly the bodies the API expects', async () => {
  const cfg = testCfg();
  const { calls, restore } = mockFetch(happyRoutes());
  const { log } = tempLogger();
  const origWait = Mailbox.prototype.waitFor;
  Mailbox.prototype.waitFor = async () => '360407';
  try {
    const rec = await registerOne(cfg, log, { email: 'a@b.test', password: 'p'.repeat(12), companyName: 'C', fullName: 'N' });
    assert.equal(rec.status, 'verified');
    assert.equal(rec.api_key, SESSION.developer_api_key);
    assert.equal(rec.balance_usd, 5);

    const req = calls.find((c) => c.path.endsWith('/auth/verification-code'));
    assert.deepEqual(Object.keys(req.body).sort(), ['company_name', 'email', 'name', 'password']);
    const reg = calls.find((c) => c.path.endsWith('/auth/register'));
    assert.deepEqual(reg.body, { verification_id: 'vid-1', verification_code: '360407' });
  } finally {
    restore();
    Mailbox.prototype.waitFor = origWait;
  }
});

test('billing read failure keeps the account but never asserts a balance', async () => {
  const cfg = testCfg();
  const routes = happyRoutes();
  routes['GET /api/v1/billing'] = () => jsonResponse(500, { detail: 'boom' });
  const { restore } = mockFetch(routes);
  const { log, events } = tempLogger();
  const origWait = Mailbox.prototype.waitFor;
  Mailbox.prototype.waitFor = async () => '222222';
  try {
    const rec = await registerOne(cfg, log, { email: 'a@b.test', password: 'x', companyName: 'C', fullName: 'N' });
    assert.equal(rec.status, 'verified');
    assert.equal(rec.balance_usd, undefined);
    assert.match(rec.note, /balance unverified/);
    assert.ok(events().some((e) => e.event === 'reg.ok'));
  } finally {
    restore();
    Mailbox.prototype.waitFor = origWait;
  }
});

test('mail timeout fails the account and register is never called', async () => {
  const cfg = testCfg();
  const { calls, restore } = mockFetch(happyRoutes());
  const { log } = tempLogger();
  const origWait = Mailbox.prototype.waitFor;
  Mailbox.prototype.waitFor = async () => {
    throw new Error('no verification code within 1s');
  };
  try {
    const rec = await registerOne(cfg, log, { email: 'a@b.test', password: 'x', companyName: 'C', fullName: 'N' });
    assert.equal(rec.status, 'failed');
    assert.match(rec.error, /code-mail timeout/);
    assert.equal(calls.filter((c) => c.path.endsWith('/auth/register')).length, 0);
  } finally {
    restore();
    Mailbox.prototype.waitFor = origWait;
  }
});

test('429 classifies rate_fast, feeds the pacer, and logs the upstream body', async () => {
  const cfg = testCfg();
  const { restore } = mockFetch({
    'POST /api/v1/auth/verification-code': () => jsonResponse(429, { detail: 'Too Many Requests' }),
  });
  const { log, events } = tempLogger();
  const reports = [];
  const pacer = { slot: async () => {}, report: (k) => reports.push(k), stats: {}, gapMs: 0 };
  try {
    const rec = await registerOne(cfg, log, { email: 'a@b.test', password: 'x', companyName: 'C', fullName: 'N', pacer });
    assert.equal(rec.status, 'failed');
    assert.equal(rec.reject_class, 'rate_fast');
    assert.ok(reports.includes('rate_fast'), 'pacer must hear about rate walls to back off');
    const httpEvent = events().find((e) => e.event === 'http' && e.status === 429);
    assert.ok(httpEvent?.detail, 'upstream body snippet must be captured for strategy tuning');
  } finally {
    restore();
  }
});
