// patrol.mjs — headless patrol judge: the LLM judges ONLY what
// the deterministic detectors cannot classify (unseen failure signatures).
// Deterministic tool-use (collectCase via the capability layer) + one capped
// judgment call. Self-sufficient: the judge call goes to our own fleet gateway
// first, any reachable provider as fallback; the provider used is recorded.
//
// Samples leave the machine (free upstreams behind the gateway), so collectCase
// masks emails and never includes credentials.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { latestWins, readTail } from './jsonl.mjs';
import { loadHealth, updateHealth, signatureOf, emitTransition, DEFAULT_THRESHOLDS } from './health.mjs';
import { REG_FAILURE_EVENTS } from './events.mjs';
import { probePort } from './fleet.mjs';
import { loadFleetLocal, scanServices, DEFAULT_ROOTS, DEFAULT_FLEET_FILE } from './fleet-decl.mjs';

const SIGNATURES_FILE = 'patrol-signatures.json';

function loadKnownSignatures(unitDir) {
  try { return new Set(JSON.parse(readFileSync(join(unitDir, 'data', SIGNATURES_FILE), 'utf8')).known || []); }
  catch { return new Set(); }
}
function saveKnownSignatures(unitDir, known) {
  mkdirSync(join(unitDir, 'data'), { recursive: true, mode: 0o700 });
  const file = join(unitDir, 'data', SIGNATURES_FILE);
  const tmpFile = file + '.tmp-' + process.pid;   // atomic write, same rule as health.json
  writeFileSync(tmpFile, JSON.stringify({ known: [...known] }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpFile, file);
}

const maskEmail = (s) => String(s).replace(/([\w.+-]{1,2})[\w.+-]*(@[\w-]+(\.[\w-]+)+)/g, '$1***$2');

/** Does this unit need LLM judgment? (unseen failure signature, or halted > 24h without patrol) */
export function needsPatrol({ unitDir, eventsFile, now = new Date(), windowEvents = 50 }) {
  const health = loadHealth(join(unitDir, 'data', 'health.json'));
  const tail = existsSync(eventsFile) ? readTail(eventsFile, 128 * 1024) : [];
  const fails = tail.filter((e) => REG_FAILURE_EVENTS.includes(e.event) || e.event === 'ai.fail').slice(-windowEvents);
  const known = loadKnownSignatures(unitDir);
  const unseen = [...new Set(fails.map(signatureOf))].filter((s) => !known.has(s));
  if (unseen.length) return { need: true, why: 'unseen-signatures', unseen, fails: fails.length };
  if (health?.status === 'halted') {
    const patrolAt = health.patrol?.at ? Date.parse(health.patrol.at) : 0;
    if (now.getTime() - patrolAt > DEFAULT_THRESHOLDS.reprobeHours * 3600 * 1000) {
      return { need: true, why: 'halted-daily', unseen: [], fails: fails.length };
    }
  }
  return { need: false };
}

/** Evidence package for the judge. Sanitized: masked emails, no credentials ever. */
export function collectCase({ unitDir, eventsFile, accountsFile, now = new Date(), windowEvents = 50 }) {
  const health = loadHealth(join(unitDir, 'data', 'health.json'));
  const tail = existsSync(eventsFile) ? readTail(eventsFile, 128 * 1024) : [];
  const window = tail.slice(-windowEvents);
  const counts = {};
  for (const e of window) {
    const k = e.event + (e.klass ? ':' + e.klass : '');
    counts[k] = (counts[k] || 0) + 1;
  }
  const samples = window
    .filter((e) => REG_FAILURE_EVENTS.includes(e.event) || e.event === 'ai.fail')
    .slice(-3)
    .map((e) => ({
      event: e.event, status: e.status ?? null, klass: e.klass ?? null,
      detail: maskEmail(String(e.detail || e.error || '').slice(0, 160)),
    }));
  let pool = null;
  if (accountsFile && existsSync(accountsFile)) {
    const accts = latestWins(accountsFile);
    pool = { total: accts.length, verified: accts.filter((a) => a.status === 'verified').length };
  }
  return {
    unit: unitDir.split('/').pop(),
    at: now.toISOString(),
    health: health ? { status: health.status, reason: health.reason ?? null, since: health.since ?? null } : null,
    counts, samples, pool,
  };
}

const JUDGE_SYSTEM = [
  'You are a patrol judge for an AI-account registration fleet.',
  'Given recent failure evidence for ONE project, decide whether the failures are transient',
  '(upstream flakiness, retry later) or a mechanism change (registration flow/model/accounts',
  'fundamentally broken, human must adapt). Reply with JSON only:',
  '{"verdict":"transient"|"mechanism-changed"|"unclear","reason":"<20 words","suggestedAction":"keep"|"halt"|"none"}',
].join(' ');

/** Every balanced {...} in the text, outermost only, in order. */
function jsonObjectsIn(text) {
  const out = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

/**
 * Reasoning models wrap the answer in <think>…</think> and/or ```json fences, and
 * may mention braces while thinking; a greedy first-{ to last-} match then fails
 * to parse (surfacing as "bad-json-in-reply"). Strip the thinking,
 * take the LAST balanced object that parses — the final answer is the last thing said.
 */
export function parseVerdict(text) {
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const candidates = jsonObjectsIn(cleaned);
  if (!candidates.length) return { verdict: 'unclear', reason: 'no-json-in-reply', suggestedAction: 'none' };
  for (const c of candidates.reverse()) {
    let j;
    try { j = JSON.parse(c); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const verdict = ['transient', 'mechanism-changed', 'unclear'].includes(j.verdict) ? j.verdict : 'unclear';
    const suggestedAction = ['keep', 'halt', 'none'].includes(j.suggestedAction) ? j.suggestedAction : 'none';
    return { verdict, reason: String(j.reason || '').slice(0, 200), suggestedAction };
  }
  return { verdict: 'unclear', reason: 'bad-json-in-reply', suggestedAction: 'none' };
}

/** One capped judgment call against an OpenAI-compatible endpoint. fetchFn injectable. */
export async function judge({ judge: cfg, casePackage, fetchFn = fetch }) {
  const r = await fetchFn(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: JSON.stringify(casePackage) },
      ],
      stream: false,
      max_tokens: 800,     // a classification; a reasoning model must not run away with the pool's money
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status !== 200) throw new Error('judge upstream HTTP ' + r.status);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content ?? '';
  return parseVerdict(text);
}

/** Pick the judge endpoint: own fleet gateway first, fallback provider otherwise.
 *  The judge model is a DECLARED choice (fleet.local.json patrol.judge_model) —
 *  a classification call must not burn an arbitrary frontier model just because
 *  it happens to sort first in the catalog. */
export async function selectJudge({
  fleetFile = DEFAULT_FLEET_FILE,
  fallback = null,
  probe = probePort,
  fetchFn = fetch,
} = {}) {
  const fl = loadFleetLocal(fleetFile);
  if (await probe(fl.gatewayPort).catch(() => false)) {
    const declared = fl.patrol?.judge_model;
    if (declared) {
      return { baseUrl: 'http://127.0.0.1:' + fl.gatewayPort + '/v1', apiKey: fl.gatewayToken, model: declared, via: 'fleet-gateway' };
    }
    try {
      const r = await fetchFn('http://127.0.0.1:' + fl.gatewayPort + '/v1/models', {
        headers: { authorization: 'Bearer ' + fl.gatewayToken },
        signal: AbortSignal.timeout(3000),
      });
      const j = await r.json();
      const first = j?.data?.[0]?.id;
      if (first) {
        return { baseUrl: 'http://127.0.0.1:' + fl.gatewayPort + '/v1', apiKey: fl.gatewayToken, model: first, via: 'fleet-gateway' };
      }
    } catch { /* fall through to fallback */ }
  }
  if (fallback?.baseUrl && fallback?.model) return { ...fallback, via: 'fallback' };
  return null;
}

/** Write the verdict back to health.json patrol field; only mechanism-changed+halt acts. */
export function applyVerdict({ unitDir, verdict, providerUsed, now = new Date(), eventsFile }) {
  const healthPath = join(unitDir, 'data', 'health.json');
  const patrolField = { at: now.toISOString(), provider: providerUsed, verdict: verdict.verdict, reason: verdict.reason };
  let transitioned = false;
  // Locked read-modify-write against the CURRENT file: tick or a user recover may
  // have touched health.json since we collected the case, and the patrol verdict
  // must be merged into that state, not written over it (review P1).
  const applied = updateHealth(healthPath, (cur) => {
    const prev = cur || { status: 'ok', reason: null, since: now.toISOString() };
    let next = { ...prev, patrol: patrolField };
    if (verdict.verdict === 'mechanism-changed' && verdict.suggestedAction === 'halt' && prev.status !== 'halted') {
      next = {
        ...next,
        status: 'halted',
        reason: 'patrol: mechanism-changed',
        since: now.toISOString(),
        actions: ['stopRegistrar', 'stopSupply', 'haltProject'],
      };
      transitioned = true;
    }
    return next;
  });
  if (transitioned && eventsFile) {
    emitTransition(eventsFile, {
      now,
      from: { status: applied.before?.status ?? 'ok', reason: applied.before?.reason ?? null },
      to: { status: 'halted', reason: 'patrol: mechanism-changed' },
      actions: applied.next.actions, via: 'patrol',
    });
  }
  return { prev: applied.before, next: applied.next, transitioned };
}

/** Patrol every declared unit (the launchd entry point). */
export async function runFleetPatrol({ roots = DEFAULT_ROOTS, dryRun = false, now = new Date(), ...io } = {}) {
  const found = scanServices({ roots });
  const results = [];
  for (const f of found) {
    if (!f.decl) continue;
    // Retired = you stopped caring; its old failures are not worth a judge call.
    if (f.decl.lifecycle === 'dead') { results.push({ unit: f.decl.id, patrolled: false, why: 'retired' }); continue; }
    // Per-unit fault isolation: one judge hang/failure must not skip the rest.
    try {
      results.push(await runPatrol({
        unitDir: f.unitDir,
        eventsFile: f.decl.events,
        accountsFile: f.decl.accounts,
        dryRun, now, ...io,
      }));
    } catch (err) {
      results.push({ unit: f.decl.id, patrolled: false, why: 'judge-error', error: String(err?.message || err).slice(0, 80) });
    }
  }
  return { as_of: now.toISOString(), patrolled: results.filter((r) => r.patrolled).length, results };
}

/** Full patrol for one unit. All I/O injectable. */
export async function runPatrol({
  unitDir, eventsFile, accountsFile,
  selectJudgeFn = selectJudge, judgeFn = judge, fetchFn, now = new Date(), dryRun = false,
  fleetFile = DEFAULT_FLEET_FILE,
} = {}) {
  const check = needsPatrol({ unitDir, eventsFile, now });
  if (!check.need) return { unit: unitDir.split('/').pop(), patrolled: false, why: 'not-needed' };
  const casePackage = collectCase({ unitDir, eventsFile, accountsFile, now });
  // Fallback judge: fleet.local.json patrol.fallback, else PATROL_FALLBACK_* env.
  const fl = loadFleetLocal(fleetFile);
  const envFb = process.env.PATROL_FALLBACK_BASE
    ? { baseUrl: process.env.PATROL_FALLBACK_BASE, apiKey: process.env.PATROL_FALLBACK_KEY || '', model: process.env.PATROL_FALLBACK_MODEL || '' }
    : null;
  const fallback = fl.patrol?.fallback ?? envFb ?? null;
  const judgeCfg = await selectJudgeFn({ fetchFn, fleetFile, fallback });
  if (!judgeCfg) return { unit: casePackage.unit, patrolled: false, why: 'no-judge-available', casePackage };
  if (dryRun) return { unit: casePackage.unit, patrolled: false, why: 'dry-run', casePackage, judge_via: judgeCfg.via };
  const verdict = await judgeFn({ judge: judgeCfg, casePackage, fetchFn });
  const applied = applyVerdict({ unitDir, verdict, providerUsed: judgeCfg.via, now, eventsFile });
  // mark current failure signatures as seen so the next patrol only fires on NEW ones
  const known = loadKnownSignatures(unitDir);
  const tail = existsSync(eventsFile) ? readTail(eventsFile, 128 * 1024) : [];
  for (const e of tail.filter((x) => REG_FAILURE_EVENTS.includes(x.event) || x.event === 'ai.fail')) known.add(signatureOf(e));
  saveKnownSignatures(unitDir, known);
  return { unit: casePackage.unit, patrolled: true, via: judgeCfg.via, verdict, transitioned: applied.transitioned };
}
