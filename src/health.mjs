// health.mjs — linkage detectors: events -> health.json.
// Pure derivation: readTail(events.jsonl) + latestWins(accounts.jsonl) -> findings
// -> state machine transition. Only four actions exist: stopRegistrar / stopSupply /
// removeModels / haltProject. Code judges what code can judge; the headless
// patrol only sees what these rules cannot classify.
//
// States: ok -> degraded(reason) -> halted(reason) -> daily reprobe -> ok | keep.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { latestWins, readTail, appendJsonl } from './jsonl.mjs';
import { REG_FAILURE_EVENTS } from './events.mjs';
import { withFileLock, lockPathFor } from './lock.mjs';

export const DEFAULT_THRESHOLDS = Object.freeze({
  registerBatches: 3,      // consecutive batch.done with ok=0
  registerMinFails: 3,     // …and at least this many reg.fail/reg.crash events
  signatureShare: 0.5,     // top normalized failure signature share = "clustered"
  noCreditAccounts: 3,     // newest verified accounts with ~zero balance
  noCreditEpsilon: 0.01,
  aiWindow: 20,            // ai.* events examined for pool health
  poolMinFails: 5,
  poolFailRatio: 0.8,
  delistMinFails: 3,       // model_mismatch repeats for one model
  flakyNetRatio: 0.5,
  reprobeHours: 24,
});

/** The four linkage actions. Recovery is NOT an action: leaving
 *  degraded/halted simply means the stop* actions are no longer in force, so
 *  `actions` goes back to []. */
export const ACTIONS = Object.freeze(['stopRegistrar', 'stopSupply', 'removeModels', 'haltProject']);

/** Single source for "this unit is gated out of the gateway" (was inlined ×3). */
export function isGated(h) {
  return h?.status === 'halted' || (h?.status === 'degraded' && h?.reason === 'pool-broken');
}
/** Single source for the delisted-model list (was health?.evidence?.delistedModels chains). */
export function delistedModelsOf(h) {
  return Array.isArray(h?.evidence?.delisted_models) ? h.evidence.delisted_models : [];
}

/** One writer for health.transition events (was duplicated across health/patrol/fleet). */
export function emitTransition(eventsFile, { now = new Date(), from, to, actions = [], via } = {}) {
  try {
    appendJsonl(eventsFile, {
      ts: now.toISOString(), event: 'health.transition', from, to, actions, ...(via ? { via } : {}),
    });
  } catch { /* best effort */ }
}

/** Normalize a failure detail into a cluster signature (strip volatile bits). */
export function signatureOf(ev) {
  const text = String(ev.klass || '') + '|' + String(ev.detail || ev.error || '').toLowerCase();
  return text.replace(/[\d]+/g, '#').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '@').slice(0, 80);
}

/** Deterministic findings from the event window + current accounts. */
export function analyze({ events = [], accounts = [], thresholds = DEFAULT_THRESHOLDS } = {}) {
  const T = thresholds;
  const findings = { registerBroken: false, noCredit: false, poolBroken: false, delistedModels: [], flaky: false, evidence: {} };

  // 1) register-broken: last T.registerBatches batch.done all ok=0, with clustered failures
  const batches = events.filter((e) => e.event === 'batch.done').slice(-T.registerBatches);
  if (batches.length >= T.registerBatches && batches.every((b) => Number(b.ok) === 0)) {
    const fails = events.filter((e) => REG_FAILURE_EVENTS.includes(e.event));
    const bySig = new Map();
    for (const f of fails) {
      const s = signatureOf(f);
      bySig.set(s, (bySig.get(s) || 0) + 1);
    }
    const top = [...bySig.entries()].sort((a, b) => b[1] - a[1])[0];
    const clustered = fails.length >= T.registerMinFails && top && top[1] / fails.length >= T.signatureShare;
    if (clustered) {
      findings.registerBroken = true;
      findings.evidence.register = { batches: batches.length, fails: fails.length, top_signature: top[0], share: Math.round((top[1] / fails.length) * 100) / 100 };
    }
  }

  // 2) no-credit: newest T.noCreditAccounts verified accounts all have ~zero anchor balance
  const verified = accounts
    .filter((a) => a.status === 'verified')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, T.noCreditAccounts);
  if (verified.length >= T.noCreditAccounts) {
    const balances = verified.map((a) => Number(a.balance_usd ?? a.available_usd));
    if (balances.every((b) => Number.isFinite(b) && b <= T.noCreditEpsilon)) {
      findings.noCredit = true;
      findings.evidence.no_credit = { accounts: verified.length, max_balance: Math.max(...balances) };
    }
  }

  // 3) pool health from the last T.aiWindow ai.* events
  const ai = events.filter((e) => e.event === 'ai.ok' || e.event === 'ai.fail').slice(-T.aiWindow);
  const fails = ai.filter((e) => e.event === 'ai.fail');
  if (fails.length >= T.poolMinFails && fails.length / Math.max(1, ai.length) >= T.poolFailRatio) {
    const hard = fails.filter((e) => ['balance', 'dead'].includes(e.klass));
    if (hard.length / fails.length >= 0.5) {
      findings.poolBroken = true;
      findings.evidence.pool = { window: ai.length, fails: fails.length, hard: hard.length };
    }
  }

  // 4) model-delisted: same model hits model_mismatch >= T.delistMinFails in window
  const byModel = new Map();
  for (const e of ai) {
    if (e.event === 'ai.fail' && e.klass === 'model_mismatch' && e.model) {
      byModel.set(e.model, (byModel.get(e.model) || 0) + 1);
    }
  }
  for (const [model, n] of byModel) if (n >= T.delistMinFails) findings.delistedModels.push(model);
  if (findings.delistedModels.length) findings.evidence.delisted_models = [...findings.delistedModels];

  // 5) upstream-flaky: network-dominated fails, keys not dying
  if (ai.length >= T.aiWindow / 2 && fails.length > 0) {
    const net = fails.filter((e) => e.klass === 'network').length;
    if (net / fails.length >= T.flakyNetRatio && !findings.poolBroken) findings.flaky = true;
  }

  return findings;
}

/** State machine transition. prev may be null (fresh start = ok). */
export function deriveTransition(prev, findings, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const cur = prev || { status: 'ok', reason: null, since: nowIso, last_reprobe_at: null, patrol: null };
  // A state that persists keeps the actions that put it there: a halted unit
  // whose triggering evidence has aged out of the window is STILL halted, and
  // stopRegistrar/stopSupply/haltProject are still in force until the user
  // recovers it. Only a real transition rewrites the action list.
  const keep = { ...cur, evidence: findings.evidence, flaky: findings.flaky, actions: Array.isArray(cur.actions) ? cur.actions : [] };

  const go = (status, reason, actions, extra = {}) => ({
    ...keep,
    status, reason,
    since: cur.status === status && cur.reason === reason ? cur.since : nowIso,
    actions,
    ...extra,
  });

  if (findings.registerBroken) return go('halted', 'register-broken', ['stopRegistrar', 'stopSupply', 'haltProject']);
  // no-credit says the REGISTRAR mints empty accounts — it says nothing about
  // keys already in the pool. Stop registering/supplying, keep serving the
  // remaining balance (degraded, NOT halted: isGated must not pull the pool).
  if (findings.noCredit) return go('degraded', 'no-credit', ['stopRegistrar', 'stopSupply']);
  if (findings.poolBroken) return go('degraded', 'pool-broken', ['removeModels']);
  if (findings.delistedModels.length) return go('degraded', 'model-delisted', ['removeModels']);
  // nothing firing: recover degraded back to ok; halted stays until reprobe (step() handles it)
  if (cur.status === 'degraded') return go('ok', null, []);
  return keep;
}

/**
 * Read the coordination file, distinguishing "never written" from "cannot be
 * trusted". Missing is normal (nothing detected yet); unreadable is NOT the same
 * as healthy — gates fail closed on it (see gateDecision).
 */
export function readHealthState(path) {
  if (!existsSync(path)) return { state: 'missing', health: null, error: null };
  try {
    const health = JSON.parse(readFileSync(path, 'utf8'));
    if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('health.json is not an object');
    return { state: 'ok', health, error: null };
  } catch (err) {
    return { state: 'unreadable', health: null, error: String(err?.message || err).slice(0, 120) };
  }
}

/** Lenient read for display paths (panel, status JSON): unknown -> null. */
export function loadHealth(path) { return readHealthState(path).health; }

/**
 * The ONE place "may this unit serve / register?" is answered from health.json.
 *   ok         -> gated exactly when isGated(health)
 *   missing    -> NOT gated: a project whose detector never wrote anything must
 *                 still work (counters the "everything silently ungated" risk
 *                 from the other side, not by inventing a halt)
 *   unreadable -> gated: an unreadable coordination state is UNKNOWN, and unknown
 *                 must never be treated as "all good" (review P1)
 */
export function gateDecision(read) {
  const r = read && typeof read === 'object' && 'state' in read ? read : { state: 'missing', health: null, error: null };
  if (r.state === 'ok') {
    const gated = isGated(r.health);
    return { gated, health: r.health, reason: gated ? (r.health.reason || r.health.status) : null };
  }
  if (r.state === 'missing') return { gated: false, health: null, reason: null };
  return { gated: true, health: null, reason: 'health-unreadable' };
}

export function saveHealth(path, h) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpFile = path + '.tmp-' + process.pid;
  writeFileSync(tmpFile, JSON.stringify(h, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpFile, path);
}

/** Every health.json writer takes this same lock file. */
export const healthLockPath = (healthPath) => lockPathFor(healthPath);

/**
 * Serialized read-modify-write of one unit's health.json. tick, patrol and the fleet verbs all mutate through here,
 * so no writer can overwrite another's decision with a stale copy. The atomic
 * write alone only prevents torn files, not lost decisions.
 *
 * fn(currentHealth) -> newHealth | null (null = leave the file untouched).
 * Returns { before, next }.
 */
export function updateHealth(healthPath, fn) {
  return withFileLock(healthLockPath(healthPath), () => {
    const before = loadHealth(healthPath);
    const next = fn(before);
    if (next) saveHealth(healthPath, next);
    return { before, next };
  });
}

export function dueReprobe(h, now = new Date(), reprobeHours = DEFAULT_THRESHOLDS.reprobeHours) {
  if (!h || h.status !== 'halted') return false;
  const last = h.last_reprobe_at ? Date.parse(h.last_reprobe_at) : 0;
  return now.getTime() - last >= reprobeHours * 3600 * 1000;
}

/**
 * One orchestration step for one project: analyze -> transition -> (reprobe if due)
 * -> persist health.json -> emit health.transition event on status change.
 * probe is injected: async () => ({ ok: boolean, note? }).
 */
export async function step({
  healthPath, eventsFile, accountsFile,
  fleetEventsFile = null, unitId = null,
  now = new Date(), thresholds = DEFAULT_THRESHOLDS,
  probe = async () => ({ ok: false }),
} = {}) {
  const prev = loadHealth(healthPath);
  // Two evidence sources: the project's own events.jsonl (registration
  // side) and the fleet gateway's fleet-events.jsonl (serving side — the pool's
  // ai.ok/ai.fail live THERE, tagged with upstream=<unitId>). Merged by ts.
  const projectEvents = eventsFile && existsSync(eventsFile) ? readTail(eventsFile, 256 * 1024) : [];
  let events = projectEvents;
  if (fleetEventsFile && unitId && existsSync(fleetEventsFile)) {
    const fleetEvents = readTail(fleetEventsFile, 512 * 1024)
      .filter((e) => e.upstream === unitId && (e.event === 'ai.ok' || e.event === 'ai.fail'));
    events = [...projectEvents, ...fleetEvents].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  const accounts = accountsFile && existsSync(accountsFile) ? latestWins(accountsFile) : [];
  const findings = analyze({ events, accounts, thresholds });

  // halted units get one reprobe per reprobeHours; a pass marks recoverable but
  // NEVER auto-resumes — the user presses recover. The probe is a network
  // call, so it stays OUTSIDE the coordination lock (a slow holder would starve
  // every other writer); its result is merged by the short locked write below.
  const reprobe = dueReprobe(prev, now, thresholds.reprobeHours)
    ? await probe().catch((err) => ({ ok: false, note: String(err?.message || err).slice(0, 60) }))
    : null;

  // Derive + persist under the lock, from the file's CURRENT content rather than
  // the copy read above: a patrol verdict or a user recover that landed meanwhile
  // must survive this pass instead of being overwritten by a stale derivation.
  const applied = updateHealth(healthPath, (cur) => {
    let next = deriveTransition(cur, findings, { now });

    // Arm the daily reprobe timer when a unit first lands in halted — otherwise the
    // very next step would reprobe immediately after the halt we just recorded.
    if (next.status === 'halted' && (!cur || cur.status !== 'halted')) {
      next = { ...next, last_reprobe_at: now.toISOString() };
    }
    if (reprobe) {
      next = {
        ...next,
        last_reprobe_at: now.toISOString(),
        recoverable: !!reprobe.ok,
        probe_note: reprobe.note ?? null,
      };
    } else if (cur && next.status === cur.status) {
      next = { ...next, last_reprobe_at: cur.last_reprobe_at ?? null };
    }

    const changed = !cur || cur.status !== next.status || cur.reason !== next.reason
      || cur.last_reprobe_at !== next.last_reprobe_at || cur.recoverable !== next.recoverable;
    if (!changed) return null;
    if (eventsFile && (!cur || cur.status !== next.status || cur.reason !== next.reason)) {
      emitTransition(eventsFile, {
        now,
        from: cur ? { status: cur.status, reason: cur.reason } : null,
        to: { status: next.status, reason: next.reason },
        actions: next.actions,
      });
    }
    return next;
  });

  return { prev, next: applied.next ?? applied.before, changed: !!applied.next, findings };
}
