// patrol contracts: needsPatrol gating, sanitized evidence, verdict
// parsing, judge selection (own gateway first), conservative applyVerdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsPatrol, collectCase, judge, selectJudge, applyVerdict, runPatrol, runFleetPatrol, parseVerdict } from '../src/patrol.mjs';
import { renderPlist } from '../src/fleet.mjs';
import { loadHealth } from '../src/health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-patrol-'));
const now = new Date('2026-09-15T14:00:00Z');
const mkunit = (root, name) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
};
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('needsPatrol: unseen failure signature triggers; known does not', () => {
  const dir = mkunit(tmp(), 'u');
  const eventsFile = join(dir, 'data', 'events.jsonl');
  writeFileSync(eventsFile, [
    JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'reg.fail', klass: 'http', detail: 'new error 555' }),
  ].join('\n') + '\n');
  const r1 = needsPatrol({ unitDir: dir, eventsFile, now });
  assert.equal(r1.need, true);
  assert.equal(r1.why, 'unseen-signatures');
  // mark known -> no longer needed
  writeFileSync(join(dir, 'data', 'patrol-signatures.json'), JSON.stringify({ known: r1.unseen }));
  assert.equal(needsPatrol({ unitDir: dir, eventsFile, now }).need, false);
});

test('needsPatrol: halted without patrol for >24h triggers daily judgment', () => {
  const dir = mkunit(tmp(), 'u');
  writeFileSync(join(dir, 'data', 'health.json'), JSON.stringify({ status: 'halted', reason: 'no-credit', patrol: { at: '2026-09-13T00:00:00Z' } }));
  const r = needsPatrol({ unitDir: dir, eventsFile: join(dir, 'data', 'events.jsonl'), now });
  assert.equal(r.need, true);
  assert.equal(r.why, 'halted-daily');
});

test('collectCase: sanitized samples (masked email, no credentials), counts, pool', () => {
  const dir = mkunit(tmp(), 'u');
  const eventsFile = join(dir, 'data', 'events.jsonl');
  writeFileSync(eventsFile, [
    JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'ai.fail', klass: 'balance', detail: 'key sk-SECRET123 for bob.smith@mail.com failed', status: 402 }),
    JSON.stringify({ ts: '2026-09-15T13:01:00Z', event: 'ai.ok' }),
  ].join('\n') + '\n');
  const accountsFile = join(dir, 'data', 'accounts.jsonl');
  writeFileSync(accountsFile, JSON.stringify({ email: 'a@x', status: 'verified', api_key: 'K', balance_usd: 5 }) + '\n');
  const c = collectCase({ unitDir: dir, eventsFile, accountsFile, now });
  assert.equal(c.counts['ai.fail:balance'], 1);
  assert.equal(c.counts['ai.ok'], 1);
  assert.equal(c.pool.verified, 1);
  const sample = JSON.stringify(c.samples);
  assert.ok(!sample.includes('bob.smith@mail.com'), 'email masked');
  assert.ok(sample.includes('bo***@mail.com'));
  assert.ok(!sample.includes('api_key'), 'no credential fields');
});

test('judge: parses strict verdict, tolerates prose wrap, marks garbage unclear', async () => {
  const cfg = { baseUrl: 'http://j/v1', apiKey: 'k', model: 'm' };
  const good = await judge({
    judge: cfg, casePackage: {},
    fetchFn: async () => jsonResp({ choices: [{ message: { content: 'here you go: {"verdict":"transient","reason":"429 storm, recovers","suggestedAction":"keep"} tail' } }] }),
  });
  assert.equal(good.verdict, 'transient');
  assert.equal(good.suggestedAction, 'keep');
  const garbage = await judge({
    judge: cfg, casePackage: {},
    fetchFn: async () => jsonResp({ choices: [{ message: { content: 'i have no idea' } }] }),
  });
  assert.equal(garbage.verdict, 'unclear');
  await assert.rejects(() => judge({ judge: cfg, casePackage: {}, fetchFn: async () => jsonResp({}, 500) }), /HTTP 500/);
  // the request is a capped, deterministic classification call
  let sent = null;
  await judge({ judge: cfg, casePackage: {}, fetchFn: async (url, init) => { sent = JSON.parse(init.body); return jsonResp({ choices: [{ message: { content: '{"verdict":"unclear","reason":"","suggestedAction":"none"}' } }] }); } });
  assert.equal(sent.max_tokens, 800);
  assert.equal(sent.temperature, 0);
  assert.equal(sent.stream, false);
});

test('parseVerdict: reasoning-model output — <think> with braces, fenced json, several objects — the LAST parsable one wins', () => {
  const thinky = '<think>Let me weigh {"verdict": maybe transient? counts: {a:1} hmm</think>\n```json\n{"verdict":"mechanism-changed","reason":"signup endpoint now 404s for all","suggestedAction":"halt"}\n```';
  assert.deepEqual(parseVerdict(thinky), { verdict: 'mechanism-changed', reason: 'signup endpoint now 404s for all', suggestedAction: 'halt' });
  // a draft object followed by the final one
  const two = '{"verdict":"unclear","reason":"draft","suggestedAction":"none"} — on reflection: {"verdict":"transient","reason":"one 5xx","suggestedAction":"keep"}';
  assert.equal(parseVerdict(two).verdict, 'transient');
  // braces inside strings do not confuse the scanner
  const strBraces = '{"verdict":"transient","reason":"error body was {code: 502}","suggestedAction":"keep"}';
  assert.equal(parseVerdict(strBraces).reason, 'error body was {code: 502}');
  // unknown enum values degrade, never throw
  assert.deepEqual(parseVerdict('{"verdict":"maybe","suggestedAction":"panic"}'), { verdict: 'unclear', reason: '', suggestedAction: 'none' });
  assert.equal(parseVerdict('{"verdict": broken').verdict, 'unclear');
});

test('selectJudge: own gateway first, fallback otherwise, null when nothing', async () => {
  const root = tmp();
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'tok' }));
  const up = await selectJudge({
    fleetFile, probe: async () => true,
    fetchFn: async () => jsonResp({ data: [{ id: 'ds-flash' }] }),
  });
  assert.equal(up.via, 'fleet-gateway');
  assert.equal(up.model, 'ds-flash');
  assert.equal(up.apiKey, 'tok');
  const down = await selectJudge({
    fleetFile, probe: async () => false,
    fallback: { baseUrl: 'https://x/v1', apiKey: 'k2', model: 'gpt-x' },
  });
  assert.equal(down.via, 'fallback');
  assert.equal(down.model, 'gpt-x');
  const none = await selectJudge({ fleetFile, probe: async () => false });
  assert.equal(none, null);
});

test('applyVerdict: mechanism-changed+halt transitions; transient only records patrol', () => {
  const dir = mkunit(tmp(), 'u');
  const eventsFile = join(dir, 'data', 'events.jsonl');
  writeFileSync(eventsFile, '');
  const halt = applyVerdict({
    unitDir: dir, eventsFile, now, providerUsed: 'fleet-gateway',
    verdict: { verdict: 'mechanism-changed', reason: 'signup endpoint gone', suggestedAction: 'halt' },
  });
  assert.equal(halt.transitioned, true);
  assert.equal(halt.next.status, 'halted');
  assert.equal(halt.next.reason, 'patrol: mechanism-changed');
  const transitions = readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(transitions.at(-1).via, 'patrol');

  const dir2 = mkunit(tmp(), 'u2');
  const keep = applyVerdict({
    unitDir: dir2, now, providerUsed: 'fallback',
    verdict: { verdict: 'transient', reason: '429 storm', suggestedAction: 'keep' },
  });
  assert.equal(keep.transitioned, false);
  assert.equal(keep.next.status, 'ok');
  assert.equal(loadHealth(join(dir2, 'data', 'health.json')).patrol.provider, 'fallback');
});

test('runPatrol end-to-end: patrols once, marks signatures, second run skips', async () => {
  const dir = mkunit(tmp(), 'u');
  const eventsFile = join(dir, 'data', 'events.jsonl');
  writeFileSync(eventsFile, JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'reg.fail', klass: 'http', detail: 'weird 555' }) + '\n');
  const io = {
    selectJudgeFn: async () => ({ baseUrl: 'http://j/v1', apiKey: 'k', model: 'm', via: 'fleet-gateway' }),
    judgeFn: async () => ({ verdict: 'transient', reason: 'one-off', suggestedAction: 'keep' }),
  };
  const r1 = await runPatrol({ unitDir: dir, eventsFile, now, ...io });
  assert.equal(r1.patrolled, true);
  assert.equal(r1.via, 'fleet-gateway');
  const r2 = await runPatrol({ unitDir: dir, eventsFile, now, ...io });
  assert.equal(r2.patrolled, false);
  assert.equal(r2.why, 'not-needed');
});

test('selectJudge: declared patrol.judge_model wins over first-in-catalog (cheap by decree)', async () => {
  const root = tmp();
  const fleetFile = join(root, 'fleet.local.json');
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'hub-local', patrol: { judge_model: 'deepseek' } }));
  let fetched = false;
  const j = await selectJudge({
    fleetFile,
    probe: async () => true,
    fetchFn: async () => { fetched = true; return jsonResp({ data: [{ id: 'model-x@gamma' }] }); },
  });
  assert.equal(j.model, 'deepseek');       // declared cheap alias, NOT the first catalog row
  assert.equal(j.via, 'fleet-gateway');
  assert.equal(fetched, false);            // no catalog round-trip needed
  // undeclared: falls back to first catalog entry (old behavior)
  writeFileSync(fleetFile, JSON.stringify({ gatewayPort: 48790, gatewayToken: 'hub-local' }));
  const j2 = await selectJudge({
    fleetFile,
    probe: async () => true,
    fetchFn: async () => jsonResp({ data: [{ id: 'whatever-first' }] }),
  });
  assert.equal(j2.model, 'whatever-first');
});

test('runFleetPatrol: one unit\'s judge error does not skip the others', async () => {
  const root = tmp();
  const mk = (name, detail) => {
    const dir = mkunit(root, name);
    writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify({ id: name }));
    writeFileSync(join(dir, 'data', 'events.jsonl'), JSON.stringify({ ts: '2026-09-15T13:00:00Z', event: 'reg.fail', klass: 'http', detail }) + '\n');
    return dir;
  };
  mk('bad', 'weird 111');
  mk('good', 'weird 222');
  const deadDir = mk('gone', 'weird 333');
  writeFileSync(join(deadDir, 'data', 'service.json'), JSON.stringify({ id: 'gone', lifecycle: 'dead' }));   // retired: no judge call
  const r = await runFleetPatrol({
    roots: [root], now,
    selectJudgeFn: async () => ({ baseUrl: 'http://j/v1', apiKey: 'k', model: 'm', via: 'fleet-gateway' }),
    judgeFn: async ({ casePackage }) => {
      if (casePackage.unit === 'bad') throw new Error('judge timeout');
      return { verdict: 'transient', reason: 'one-off', suggestedAction: 'keep' };
    },
  });
  const byUnit = Object.fromEntries(r.results.map((x) => [x.unit, x]));
  assert.equal(byUnit.bad.why, 'judge-error');
  assert.match(byUnit.bad.error, /judge timeout/);
  assert.equal(byUnit.good.patrolled, true);
  assert.equal(byUnit.gone.why, 'retired');
  assert.equal(r.patrolled, 1);
});

test('renderPlist interval mode: StartInterval present, no KeepAlive', () => {
  const xml = renderPlist({ label: 'com.regkit.fleet.patrol', cmd: 'node src/fleet-cli.mjs patrol', cwd: '/x', logPath: '/x/p.log', keepAlive: false, intervalSec: 86400 });
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>86400<\/integer>/);
  assert.ok(!xml.includes('KeepAlive'));
  assert.ok(xml.includes(process.execPath));
});
