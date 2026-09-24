// Event-stream analysis: rolling window stats, throughput sparkline, and
// in-flight registration tracking. All pure functions over parsed event
// arrays (from regkit's jsonl.readTail). The event vocabulary is shared
// across registrars: http / reg.start / reg.ok / reg.fail / reg.crash /
// code.received / code.timeout / batch.start / batch.done / ai.ok / ai.fail /
// balance.ok / balance.fail / supply.spawn.

import { sparkline } from './tui.mjs';

/**
 * Registration-failure vocabulary — the only names a registrar emits when one
 * attempt failed (skeleton/src/register.mjs + skeleton/src/cli.mjs: reg.fail for
 * every business failure, reg.crash for a caller-level bug). Detectors (health
 * rule 1, patrol) MUST filter on this constant and never on a re-typed literal:
 * a mistyped name silently disables register-broken and patrol for real traffic,
 * while tests that fabricate their own event names stay green.
 */
export const REG_FAILURE_EVENTS = Object.freeze(['reg.fail', 'reg.crash']);

/** Rolling window facts over recent http/reg/code events. */
export function windowStats(evts, nowMs, { windowMin = 10 } = {}) {
  const cut = nowMs - windowMin * 60_000;
  const s = {
    ok: 0, ratelimit: 0, forbidden: 0, server: 0, transport: 0,
    mailTimeout: 0, fails: 0, regsOk: 0, lat: [],
    aiCalls: 0, aiFails: 0, aiCost: 0, aiMs: [],
    byEndpoint: Object.create(null),
  };
  for (const e of evts) {
    const t = Date.parse(e.ts);
    if (!(t >= cut)) continue;
    if (e.event === 'http') {
      const ep = (s.byEndpoint[e.name] ||= { ok: 0, c429: 0, c4xx: 0, c5xx: 0, transport: 0, lat: [] });
      if (e.status > 0 && e.status < 300) { s.ok++; ep.ok++; ep.lat.push(e.ms || 0); s.lat.push(e.ms || 0); }
      else if (e.status === 429) { s.ratelimit++; ep.c429++; }
      else if (e.status === 403 || e.status === 401) { s.forbidden++; ep.c4xx++; }
      else if (e.status >= 500) { s.server++; ep.c5xx++; }
      else { s.transport++; ep.transport++; }
    } else if (e.event === 'ai.ok') { s.aiCalls++; s.aiCost += e.cost_usd || 0; if (e.ms) s.aiMs.push(e.ms); }
    else if (e.event === 'ai.fail') { s.aiFails++; }
    else if (e.event === 'code.timeout') { s.mailTimeout++; s.fails++; }
    else if (REG_FAILURE_EVENTS.includes(e.event)) { s.fails++; }
    else if (e.event === 'reg.ok') { s.regsOk++; }
  }
  s.lat.sort((a, b) => a - b);
  for (const ep of Object.values(s.byEndpoint)) ep.lat.sort((a, b) => a - b);
  return s;
}

/** Requests/min sparkline over the last N minutes in binMs bins. */
export function throughputSpark(evts, nowMs, { binMs = 6_000, bins = 50 } = {}) {
  const vals = new Array(bins).fill(0);
  const cut = nowMs - bins * binMs;
  for (const e of evts) {
    if (e.event !== 'http') continue;
    const t = Date.parse(e.ts);
    if (!(t >= cut)) continue;
    const i = Math.min(bins - 1, Math.floor((t - cut) / binMs));
    vals[i]++;
  }
  return sparkline(vals);
}

/**
 * In-flight registrations derived from events after the last batch.start.
 * Returns { workers:[{email,stage,at}], done, failed }. Stage sequence:
 * signup -> mail -> registering -> billing -> probing -> done | fail.
 * Endpoint names in `http` events (name field) drive stage transitions:
 * `submitName` = the code-request step, `registerName` = register step,
 * `billingName` = balance step.
 */
export function inflight(evts, { submitName = 'verification-code', registerName = 'register', billingName = 'billing' } = {}) {
  let startIdx = -1;
  for (let i = evts.length - 1; i >= 0; i--) {
    if (evts[i].event === 'batch.start') { startIdx = i; break; }
  }
  if (startIdx === -1) return { workers: [], done: 0, failed: 0 };
  const cur = new Map();
  let done = 0, failed = 0;
  for (let i = startIdx + 1; i < evts.length; i++) {
    const e = evts[i];
    const t = Date.parse(e.ts);
    if (e.event === 'batch.done') return { workers: [...cur.values()], done, failed };
    if (e.event === 'reg.start' || e.event === 'code.requested') {
      cur.set(e.email, { email: e.email, stage: 'signup', at: t });
    } else if (e.event === 'http' && e.name === submitName && e.klass === 'ok') {
      const w = lastWorker(cur, 'signup');
      if (w) { w.stage = 'mail'; w.at = t; }
    } else if (e.event === 'code.received') {
      const w = cur.get(e.email); if (w) { w.stage = 'registering'; w.at = t; }
    } else if (e.event === 'http' && e.name === registerName && e.klass === 'ok') {
      const w = lastWorker(cur, 'registering'); if (w) { w.stage = 'billing'; w.at = t; }
    } else if (e.event === 'http' && e.name === billingName && e.klass === 'ok') {
      const w = lastWorker(cur, 'billing'); if (w) { w.stage = 'probing'; w.at = t; }
    } else if (e.event === 'code.timeout') {
      const w = cur.get(e.email); if (w) { w.stage = 'fail'; w.at = t; } failed++;
    } else if (REG_FAILURE_EVENTS.includes(e.event)) {
      const w = cur.get(e.email);
      if (w) { w.stage = 'fail'; w.at = t; }
      failed++;
    } else if (e.event === 'reg.ok') {
      const w = cur.get(e.email); if (w) { w.stage = 'done'; w.at = t; } done++;
    }
  }
  return { workers: [...cur.values()], done, failed };

  function lastWorker(map, wantStage) {
    let best = null;
    for (const w of map.values()) if (w.stage === wantStage && (!best || w.at >= best.at)) best = w;
    return best;
  }
}

/** One-word mood + support sentence for the whole system. */
export function classifyMood({ accts, stats, flight, lastEventAgeMin }) {
  const verified = accts.filter((a) => a.status === 'verified');
  if (stats.forbidden >= 2 && stats.ok === 0) return { word: 'BLOCKED', tip: 'forbidden responses with zero ok — check IP/domain reputation' };
  if (stats.ratelimit >= 3 && stats.ratelimit > stats.regsOk) return { word: 'THROTTLED', tip: 'rate wall: pacer gap should be climbing' };
  if (flight.workers.length && flight.done + flight.failed === 0 && stats.fails >= 3) return { word: 'STALLED', tip: 'workers in flight but no outcomes — check events tail' };
  if (lastEventAgeMin != null && lastEventAgeMin > 3) return { word: 'QUIET', tip: 'no events for 3+ min — is the registrar alive?' };
  if (verified.length === 0) return { word: 'EMPTY', tip: 'no verified accounts yet — run register' };
  return { word: 'HEALTHY', tip: null };
}
