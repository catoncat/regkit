// fleet.mjs — capability layer for the regkit fleet.
// Async function library: the TUI, the headless patrol, and conversational
// agents all call these; fleet-cli.mjs ("fleet --json") is a thin shell.
//
// Truth model: each project declares itself in <project>/data/service.json;
// machine-level desired state + the port table live in fleet.local.json — reading
// and writing those is fleet-decl.mjs; launchd plumbing is fleet-launchd.mjs; this
// file is liveness, status, the management verbs, tick and doctor.
// Runtime state vocabulary (deriveState): running | stale | down | orphan | off —
// lifecycle (active|sunset|dead) is a separate, user-declared axis.

import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { latestWins, readTail, appendJsonl } from './jsonl.mjs';
import { loadHealth, updateHealth, readHealthState, gateDecision, delistedModelsOf, step as healthStep } from './health.mjs';
import { withFileLock, lockPathFor } from './lock.mjs';
import { compactUsage, createUsageReader, displayedBalance } from './usage.mjs';
import {
  DEFAULT_ROOTS, DEFAULT_FLEET_FILE, validateService, scanServices,
  loadFleetLocal, saveFleetLocal, allocPort, modelsOf, fleetEventsFileFor,
} from './fleet-decl.mjs';
import { labelFor, plistPathFor, renderPlist, listLaunchdLabels } from './fleet-launchd.mjs';

// Declarations (fleet-decl) and launchd (fleet-launchd) are separate modules;
// re-exported here so 'regkit/fleet' stays the one capability-layer import.
export * from './fleet-decl.mjs';
export * from './fleet-launchd.mjs';

const execFileP = promisify(execFile);

/** Runtime state vocabulary — the ONLY five values the panel may show. */
export function deriveState({ declared = true, enabled = true, alive = false, lastEventAgeMin = null, staleAfterMin = 1440 } = {}) {
  if (!declared) return 'orphan';
  if (!enabled) return 'off';
  if (alive) return (lastEventAgeMin != null && lastEventAgeMin > staleAfterMin) ? 'stale' : 'running';
  return 'down';
}

/** TCP connect probe: is anything listening on 127.0.0.1:port? */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host });
    const done = (ok) => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** HTTP probe for external units (e.g. a remote pool's /healthz). */
export async function probeUrl(url, { timeoutMs = 2000 } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch { return false; }
}

/** Is the pid inside a lock file still alive? */
export function lockPidAlive(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/** Minutes since the last event in events.jsonl (null = no events/readable tail). */
export function lastEventAgeMin(eventsFile, now = new Date()) {
  const tail = readTail(eventsFile, 64 * 1024);
  const last = tail.length ? tail[tail.length - 1] : null;
  const ts = last && Date.parse(last.ts);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (now.getTime() - ts) / 60000);
}

/** Pool facts from accounts.jsonl (latest-wins): counts + recorded balance + as-of. */
/** Incremental ledger readers by usage path: status() runs once per panel frame,
 *  and a real ledger is >1 MB, so never re-parse the whole file per unit. */
const usageReaders = new Map();
function usageStateFor(usageFile) {
  if (!usageFile) return { state: 'missing', rows: [] };
  let reader = usageReaders.get(usageFile);
  if (!reader) { reader = createUsageReader(usageFile); usageReaders.set(usageFile, reader); }
  try { return reader.read(); } catch { return { state: 'unreadable', rows: [] }; }
}

/**
 * Pool summary for the panel / status JSON. `balance` is DISPLAYED balance
 * (authoritative anchor minus locally recorded spend since that anchor), not the
 * raw anchor: the panel and the sunset→dead rule must agree with what the gateway
 * will actually serve, or they promise budget the pool no longer has (review P2).
 * An unreadable ledger reports the balance as unknown (balance_known: 0) instead
 * of as the untouched anchor, which would over-state the fleet.
 */
export function poolSummary(accountsFile, usageFile = null) {
  if (!accountsFile || !existsSync(accountsFile)) return null;
  const accts = latestWins(accountsFile);
  const verified = accts.filter((a) => a.status === 'verified');
  const ledger = usageStateFor(usageFile);
  let balance = 0;
  let balanceKnown = 0;
  let spend = 0;
  for (const a of verified) {
    const field = Number.isFinite(Number(a.balance_usd)) ? 'balance_usd' : 'available_usd';
    const anchor = Number(a[field]);
    if (!Number.isFinite(anchor)) continue;
    if (ledger.state === 'unreadable') continue;      // spend unknown -> balance unknown
    // displayedBalance needs a numeric anchor; normalise so string balances (which
    // the old summary tolerated) still count.
    const shown = displayedBalance({ ...a, [field]: anchor }, ledger.rows, { balanceField: field });
    if (shown === null) continue;
    balance += shown;
    spend += anchor - shown;
    balanceKnown++;
  }
  let asOf = null; // file mtime = last refresh; rendered as as_of
  try { asOf = statSync(accountsFile).mtime.toISOString(); } catch { /* ignore */ }
  return {
    total: accts.length, verified: verified.length,
    balance: Math.round(balance * 100) / 100, balance_known: balanceKnown,
    spend_local_usd: Math.round(spend * 10000) / 10000, as_of: asOf,
    ...(ledger.state === 'unreadable' ? { ledger: 'unreadable' } : {}),
  };
}

const REGISTER_CMD_RE = /src\/[\w.-]+\.mjs\s+register\b/;

/** Process table as [{ pid, etime, cmd }]. */
export async function psList() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,etime=,command=']);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), etime: m[2], cmd: m[3] } : null;
    })
    .filter(Boolean);
}

/** Register processes with no matching declared spawn.pattern (visible, not managed). */
export function findOrphans({ processes, declared }) {
  const patterns = declared.map((d) => d.decl?.spawn?.pattern).filter(Boolean);
  return processes
    .filter((p) => REGISTER_CMD_RE.test(p.cmd) && !patterns.some((pat) => p.cmd.includes(pat)))
    .map((p) => ({ pid: p.pid, etime: p.etime, cmd: p.cmd }));
}

async function observeUnit({ unitDir, decl, fleetLocal, now, probe, probeExternal, processes = [] }) {
  const unitCfg = fleetLocal.units[decl.id] || {};
  const enabled = unitCfg.enabled ?? (decl.lifecycle !== 'dead');
  const port = fleetLocal.ports[decl.id] ?? decl.gateway?.port ?? null;
  // Liveness = four independent sources. The last two exist because a project can
  // be run by another session (or a launchd unit of its own) without holding our
  // port/lock — the panel must not call that "down".
  const patterns = [decl.resident?.pattern, decl.spawn?.pattern].filter(Boolean);
  const procAlive = patterns.length > 0 && processes.some((p) => patterns.some((pat) => String(p.cmd).includes(pat)));
  const activityAliveMin = Number.isFinite(decl.activityAliveMin) ? decl.activityAliveMin : 180;
  const ageMin = lastEventAgeMin(decl.events, now);
  let alive;
  const aliveBy = [];   // which sources said "alive" — 'activity' alone is soft evidence (a quit event counts)
  if (decl.kind === 'external' && decl.remoteHealth) {
    alive = await probeExternal(decl.remoteHealth);
    if (alive) aliveBy.push('remote');
  } else {
    if (port && await probe(port)) aliveBy.push('port');
    if (lockPidAlive(join(unitDir, 'data', '.watch-keeper.lock'))) aliveBy.push('lock');
    if (procAlive) aliveBy.push('proc');
    if (ageMin != null && ageMin <= activityAliveMin) aliveBy.push('activity');
    alive = aliveBy.length > 0;
  }
  // Serving verdict comes from the SAME decision the gateway applies per request
  // (gateDecision): the panel must never say "1 个模型能用" for a pool the hub is
  // refusing, including the unreadable-health case (unknown => gated, review P1).
  const healthRead = readHealthState(join(unitDir, 'data', 'health.json'));
  const gate = gateDecision(healthRead);
  const health = healthRead.health;
  const delisted = delistedModelsOf(health);
  const models = modelsOf(decl);
  const modelsAvailable = gate.gated ? [] : models.filter((m) => !delisted.includes(m));
  const pool = decl.accounts ? poolSummary(decl.accounts, decl.usage) : null;
  // D6: sunset pool drained to zero => effectively dead (leaves the daily view).
  // Only on a KNOWN balance: an unreadable ledger must not retire a unit.
  const effectiveLifecycle = decl.lifecycle === 'sunset' && pool && pool.balance_known > 0 && pool.balance <= 0 ? 'dead' : decl.lifecycle;
  return {
    id: decl.id,
    kind: decl.kind,
    adopted: decl.id in fleetLocal.units,          // 没收编的没有开关
    managed: typeof decl.resident?.cmd === 'string', // harvest 只旁观,不由 fleet 拉起
    lifecycle: decl.lifecycle,
    effective_lifecycle: effectiveLifecycle,
    enabled,
    port,
    state: deriveState({ declared: true, enabled, alive, lastEventAgeMin: ageMin, staleAfterMin: decl.staleAfterMin }),
    // Raw liveness sources, independent of desired state: 'off' hides them, and
    // "declared off but something still runs it" is exactly the drift doctor/TUI
    // must surface (a hand-started watch-loop kept a sunset registrar alive for
    // days). Only 'activity' is soft evidence (a just-quit watch leaves an event).
    alive_by: aliveBy,
    last_event_age_min: ageMin == null ? null : Math.round(ageMin),
    pool,
    models,
    models_available: modelsAvailable,
    // The serving axis, separate from the registrar axis: a sunset unit whose
    // registrar is off still has gateway.gated=false and keeps serving.
    gateway: decl.gateway ? { gated: gate.gated, gate_reason: gate.reason, models: modelsAvailable.length } : null,
    health: health ? {
      status: health.status, reason: health.reason ?? null, recoverable: health.recoverable === true,
      patrol_at: health.patrol?.at ?? null,
      actions: Array.isArray(health.actions) ? health.actions : [],
    } : healthRead.state === 'unreadable' ? {
      status: 'unreadable', reason: 'health-unreadable', recoverable: false, patrol_at: null, actions: [],
    } : null,
    unit_dir: unitDir,
  };
}

// ── Desired state: adopt / set-mode (plist + launchctl in fleet-launchd) ──

/**
 * Adopt a project into the fleet: validate its service.json, allocate a port,
 * record desired state, render its launchd plist. dryRun returns the plan only.
 * Does NOT bootstrap launchd (that's bootstrapUnit — external side effect).
 */
export async function adopt({ unitDir, fleetFile = DEFAULT_FLEET_FILE, dryRun = false, writePlist = !dryRun, plistPath = null } = {}) {
  const file = join(unitDir, 'data', 'service.json');
  if (!existsSync(file)) {
    throw new Error('no data/service.json in ' + unitDir + ' — copy skeleton/service.example.json and fill it');
  }
  const decl = validateService(JSON.parse(readFileSync(file, 'utf8')), { unitDir });
  const cmd = decl.resident?.cmd ?? (decl.kind === 'harvest' ? null : 'node src/cli.mjs watch');
  const plist = cmd
    ? renderPlist({ label: labelFor(decl.id), cmd, cwd: unitDir, logPath: join(unitDir, 'data', 'fleet-watch.log'), env: { PATH: process.env.PATH || '' } })
    : null; // harvest: nothing for launchd to keep alive — we only observe its pattern
  const planFor = (port) => ({
    id: decl.id, port, cmd, label: labelFor(decl.id),
    plist, plist_path: plist ? (plistPath ?? plistPathFor(decl.id)) : null,
    enabled: true, dry_run: dryRun,
  });
  if (dryRun) {
    const fl = loadFleetLocal(fleetFile);
    return planFor(fl.ports[decl.id] ?? allocPort({ table: fl.ports, taken: [fl.gatewayPort], preferred: decl.gateway?.port ?? null }));
  }
  // Serialized against every other desired-state writer: two concurrent adopts
  // must not hand out the same port, and the resident gateway's port is reserved
  // too (it is not in the unit table, so allocPort would happily reuse it).
  const port = withFileLock(lockPathFor(fleetFile), () => {
    const fl = loadFleetLocal(fleetFile);
    const p = fl.ports[decl.id] ?? allocPort({ table: fl.ports, taken: [fl.gatewayPort], preferred: decl.gateway?.port ?? null });
    fl.ports[decl.id] = p;
    fl.units[decl.id] = { ...(fl.units[decl.id] || {}), enabled: true };
    saveFleetLocal(fleetFile, fl);
    return p;
  });
  const plan = planFor(port);
  if (writePlist && plist) writeFileSync(plan.plist_path, plist, { mode: 0o644 });
  return plan;
}

/** Set a unit's desired mode. Returns the boot action the caller should perform. */
export async function setMode({ id, mode, fleetFile = DEFAULT_FLEET_FILE, dryRun = false } = {}) {
  if (!['auto', 'off'].includes(mode)) throw new Error("mode must be 'auto' or 'off'");
  if (!loadFleetLocal(fleetFile).units[id]) throw new Error('unit not adopted: ' + id);
  const enabled = mode === 'auto';
  if (!dryRun) {
    // Serialized read-modify-write: a concurrent adopt must not lose this flip.
    withFileLock(lockPathFor(fleetFile), () => {
      const fl = loadFleetLocal(fleetFile);
      if (!fl.units[id]) throw new Error('unit not adopted: ' + id);
      fl.units[id] = { ...fl.units[id], enabled };
      saveFleetLocal(fleetFile, fl);
    });
  }
  return { id, mode, enabled, action: enabled ? 'bootstrap' : 'bootout', label: labelFor(id), dry_run: dryRun };
}

/** The whole fleet, one JSON-able structure. I/O is injectable for tests. */
export async function status({
  roots = DEFAULT_ROOTS,
  fleetFile = DEFAULT_FLEET_FILE,
  now = new Date(),
  probe = probePort,
  probeExternal = probeUrl,
  listProcesses = psList,
  includeOrphans = true,
} = {}) {
  const fleetLocal = loadFleetLocal(fleetFile);
  const found = scanServices({ roots });
  const processes = await listProcesses();   // one ps call: liveness + orphan detection
  const units = [];
  const errors = [];
  for (const f of found) {
    if (!f.decl) { errors.push({ unitDir: f.unitDir, error: f.error }); continue; }
    units.push(await observeUnit({ ...f, fleetLocal, now, probe, probeExternal, processes }));
  }
  const orphans = includeOrphans
    ? findOrphans({ processes, declared: found.filter((f) => f.decl) })
    : [];
  const totals = {
    projects: units.length,
    models: units.reduce((s, u) => s + u.models_available.length, 0),
    running: units.filter((u) => u.state === 'running').length,
    stale: units.filter((u) => u.state === 'stale').length,
    down: units.filter((u) => u.state === 'down').length,
    off: units.filter((u) => u.state === 'off').length,
    orphan: orphans.length,
    errors: errors.length,
  };
  return { as_of: now.toISOString(), gateway: { port: fleetLocal.gatewayPort }, units, orphans, errors, totals };
}

// ── Management verbs ────────────────────────────────────────

/** One-key recovery for a halted unit. User axis beats the machine:
 *  recoverable=false just means the daily reprobe hasn't passed yet — we say so. */
export async function recover({ id, roots = DEFAULT_ROOTS, now = new Date() } = {}) {
  const f = scanServices({ roots }).find((x) => x.decl?.id === id);
  if (!f) throw new Error('unknown unit: ' + id);
  const healthPath = join(f.unitDir, 'data', 'health.json');
  // Locked: the user's recover must not race a tick/patrol write (review P1).
  const applied = updateHealth(healthPath, (cur) => {
    if (!cur || cur.status !== 'halted') return null;
    return { ...cur, status: 'ok', reason: null, since: now.toISOString(), recoverable: false, actions: [] };
  });
  if (!applied.next) return { id, recovered: false, why: 'not-halted' };
  const forced = !applied.before.recoverable;
  try {
    appendJsonl(f.decl.events, {
      ts: now.toISOString(), event: 'health.transition',
      from: { status: 'halted', reason: applied.before.reason ?? null },
      to: { status: 'ok', reason: null },
      actions: [], via: forced ? 'user-force' : 'user',
    });
  } catch { /* best effort */ }
  return { id, recovered: true, forced };
}

/** Lifecycle is user intent, declared in the project's own service.json.
 *  sunset/dead also flips desired state to off (registrar stops; the pool keeps
 *  serving via the fleet gateway until drained). */
export async function setLifecycle({ id, lifecycle, roots = DEFAULT_ROOTS, fleetFile = DEFAULT_FLEET_FILE } = {}) {
  if (!['active', 'sunset', 'dead'].includes(lifecycle)) throw new Error('lifecycle must be active|sunset|dead');
  const f = scanServices({ roots }).find((x) => x.decl?.id === id);
  if (!f) throw new Error('unknown unit: ' + id);
  const file = join(f.unitDir, 'data', 'service.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.lifecycle = lifecycle;
  const tmpFile = file + '.tmp-' + process.pid;
  writeFileSync(tmpFile, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpFile, file);
  let mode = null;
  if (lifecycle !== 'active') {
    const fl = loadFleetLocal(fleetFile);
    if (fl.units[id]) mode = await setMode({ id, mode: 'off', fleetFile });
  }
  return { id, lifecycle, mode };
}
export const sunset = (opts) => setLifecycle({ ...opts, lifecycle: 'sunset' });
export const retire = (opts) => setLifecycle({ ...opts, lifecycle: 'dead' });

/** One unit, full detail: status entry + health.json contents. */
export async function projectHealth({ id, roots = DEFAULT_ROOTS, fleetFile = DEFAULT_FLEET_FILE } = {}) {
  const st = await status({ roots, fleetFile });
  const u = st.units.find((x) => x.id === id);
  if (!u) throw new Error('unknown unit: ' + id);
  return { unit: u, health: loadHealth(join(u.unit_dir, 'data', 'health.json')) };
}

/** Ask the live gateway to re-pull catalogs (manual refresh, D2: no auto-probing). */
export async function refreshCatalog({ id = null, fleetFile = DEFAULT_FLEET_FILE, fetchFn = fetch } = {}) {
  const fl = loadFleetLocal(fleetFile);
  const url = 'http://127.0.0.1:' + fl.gatewayPort + '/v1/models/refresh' + (id ? '?upstream=' + encodeURIComponent(id) : '');
  const r = await fetchFn(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + fl.gatewayToken },
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ...j };
}

// ── Viability probe: does each pool actually serve right now? ──────────────

/**
 * End-to-end viability: call each unit's first available model through the
 * fleet gateway with a real key. This is the machine-judgeable half of
 * "state"; user intent (retire vs wait) is not this function's business.
 */
export async function probeFleet({
  roots = DEFAULT_ROOTS,
  fleetFile = DEFAULT_FLEET_FILE,
  fetchFn = fetch,
  now = new Date(),
  timeoutMs = 60000,
} = {}) {
  const fl = loadFleetLocal(fleetFile);
  const st = await status({ roots, fleetFile, now, includeOrphans: false });
  const results = [];
  for (const u of st.units) {
    const model = u.models_available[0];
    if (!model) {
      results.push({ id: u.id, ok: null, why: 'no-models', lifecycle: u.lifecycle, state: u.state });
      continue;
    }
    const started = Date.now();
    let rec;
    try {
      const r = await fetchFn('http://127.0.0.1:' + fl.gatewayPort + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + fl.gatewayToken },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 4 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let detail = '';
      try {
        const j = await r.json();
        detail = j?.choices?.[0]?.message?.content || j?.error?.type || j?.error?.message || '';
      } catch { /* non-json */ }
      rec = { id: u.id, model, ok: r.status === 200, http: r.status, ms: Date.now() - started, detail: String(detail).slice(0, 60) };
    } catch (e) {
      rec = { id: u.id, model, ok: false, http: 0, ms: Date.now() - started, detail: String(e?.message || e).slice(0, 60) };
    }
    // record the verdict next to the unit's health (panel/detail consumers),
    // merged under the coordination lock so a concurrent tick/patrol cannot lose it
    try {
      const hp = join(u.unit_dir, 'data', 'health.json');
      updateHealth(hp, (cur) => ({
        ...(cur || { status: 'ok', reason: null, since: now.toISOString() }),
        probe: { at: now.toISOString(), model, http: rec.http, ok: rec.ok, ms: rec.ms },
      }));
    } catch { /* best effort */ }
    results.push(rec);
  }
  return { as_of: now.toISOString(), gateway: { port: fl.gatewayPort }, results };
}

// ── Fleet-level detection + drift audit ───────
// Detection lives at FLEET level, not inside project watchers: the serving
// evidence (ai.ok/ai.fail) is written by the gateway into the fleet events
// file, and sunset units run no watcher at all. `fleet tick` (launchd
// interval, 5 min) is the one place health.step runs; keepers and the
// gateway gate consume health.json — the loop closes with no daemon.


/**
 * Reprobe for a halted unit: ONE verified key, direct GET on the upstream's
 * models endpoint. Deliberately NOT through the fleet gateway — the gateway
 * health-gate would block a halted unit and the reprobe could never pass.
 */
export async function probeUnitDirect({ decl, fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const gw = decl?.gateway;
  if (!gw?.base) return { ok: false, note: 'no-gateway-declared' };
  const accts = decl.accounts && existsSync(decl.accounts) ? latestWins(decl.accounts) : [];
  const rec = accts.find((a) => a.status === 'verified' && (a.api_key || a.key || a.access_token));
  if (!rec) return { ok: false, note: 'no-verified-key' };
  const key = rec.api_key || rec.key || rec.access_token;
  const style = gw.authHeader ?? 'bearer';
  const headers = style === 'x-api-key' ? { 'x-api-key': key } : style === 'apikey' ? { apikey: key } : { authorization: 'Bearer ' + key };
  try {
    const r = await fetchFn(gw.base.replace(/\/+$/, '') + (gw.modelsPath ?? '/models'), {
      headers, signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: r.status === 200, note: 'http ' + r.status };
  } catch (e) {
    return { ok: false, note: String(e?.message || e).slice(0, 60) };
  }
}

/**
 * One detection pass over every declared unit. For each: merge the project's
 * events.jsonl with the fleet gateway's events (filtered by upstream), run
 * health.step, persist health.json. Sunset units included (they have no
 * watcher — this is their ONLY detector); dead/drained units skipped.
 */
export async function tick({
  roots = DEFAULT_ROOTS, fleetFile = DEFAULT_FLEET_FILE, now = new Date(),
  fetchFn = fetch, thresholds, probeForUnit = null,
} = {}) {
  const fleetEventsFile = fleetEventsFileFor(fleetFile);
  const found = scanServices({ roots });
  const results = [];
  for (const f of found) {
    if (!f.decl) { results.push({ id: basename(f.unitDir), skipped: 'bad-service.json' }); continue; }
    const decl = f.decl;
    if (decl.lifecycle === 'dead') { results.push({ id: decl.id, skipped: 'dead' }); continue; }
    if (decl.lifecycle === 'sunset') {
      const pool = decl.accounts ? poolSummary(decl.accounts, decl.usage) : null;
      if (pool && pool.balance_known > 0 && pool.balance <= 0) { results.push({ id: decl.id, skipped: 'effective-dead' }); continue; }
    }
    const probe = probeForUnit
      ? () => probeForUnit(decl)
      : () => probeUnitDirect({ decl, fetchFn });
    const r = await healthStep({
      healthPath: join(f.unitDir, 'data', 'health.json'),
      eventsFile: decl.events,
      accountsFile: decl.accounts,
      fleetEventsFile,
      unitId: decl.id,
      now,
      ...(thresholds ? { thresholds } : {}),
      probe,
    });
    // Bounded ledger maintenance, in the one scheduled place (no daemon).
    // Only rows older than every anchor are archived — they cannot affect any
    // displayed balance, so this is exact rather than approximate (review P1).
    let usage = null;
    if (decl.usage && decl.accounts) {
      try { usage = compactUsage(decl.usage, latestWins(decl.accounts)); }
      catch (err) { usage = { error: String(err?.message || err).slice(0, 60) }; }
    }
    results.push({
      id: decl.id,
      from: r.prev?.status ?? null,
      to: r.next.status,
      reason: r.next.reason ?? null,
      changed: r.changed,
      ...(r.next.recoverable ? { recoverable: true } : {}),
      ...(usage && usage.moved ? { usage_moved: usage.moved } : {}),
      ...(usage?.error ? { usage_error: usage.error } : {}),
    });
  }
  return { as_of: now.toISOString(), results };
}

/**
 * Drift audit: desired state (fleet.local.json) vs launchd vs process vs port.
 * Reports; never mutates. Every drift is a plain-Chinese string.
 */
export async function doctor({
  roots = DEFAULT_ROOTS, fleetFile = DEFAULT_FLEET_FILE, now = new Date(),
  probe = probePort, listProcesses = psList, listLaunchd = listLaunchdLabels,
  plistDir = join(homedir(), 'Library', 'LaunchAgents'),
} = {}) {
  const st = await status({ roots, fleetFile, now, probe, listProcesses, includeOrphans: false });
  const decls = new Map(scanServices({ roots }).filter((f) => f.decl).map((f) => [f.decl.id, f.decl]));
  const loaded = await listLaunchd();
  const gatewayListening = await probe(st.gateway.port).catch(() => false);
  const gatewayLoaded = loaded.has(labelFor('gateway'));
  const gatewayDrifts = [];
  if (!gatewayLoaded) gatewayDrifts.push('fleet 网关没交给 launchd 管');
  if (!gatewayListening) gatewayDrifts.push('网关端口 ' + st.gateway.port + ' 没在听');
  // Two declarations claiming one bare alias: the hub refuses to route it, so
  // whoever typed that alias into a client gets 404 until one project renames it.
  const aliasOwners = new Map();
  for (const d of decls.values()) for (const a of Object.keys(d.gateway?.aliases || {})) aliasOwners.set(a, [...(aliasOwners.get(a) || []), d.id]);
  for (const [a, ids] of aliasOwners) if (ids.length > 1) gatewayDrifts.push('别名 ' + a + ' 被 ' + ids.join(' 和 ') + ' 同时声明,裸名不路由(客户端只能写 前缀/' + a + ')');

  const rows = [];
  for (const u of st.units) {
    const decl = decls.get(u.id);
    const managed = typeof decl?.resident?.cmd === 'string'; // harvest: pattern-only, never launchd-managed
    const label = labelFor(u.id);
    const isLoaded = loaded.has(label);
    const plistExists = existsSync(join(plistDir, label + '.plist'));
    const portListening = u.port ? await probe(u.port).catch(() => false) : null;
    const drifts = [];
    // enabled only drives something for fleet-managed units; external/harvest have no switch to flip
    if (managed && u.lifecycle !== 'active' && u.enabled) drifts.push('已' + (u.lifecycle === 'sunset' ? '落日' : '退役') + '但期望态还开着(sunset/retire 应翻成 off)');
    if (managed && u.enabled && !isLoaded) drifts.push('期望在跑但 launchd 没加载(没人拉起它)');
    if (managed && !u.enabled && isLoaded) drifts.push('已关但 launchd 还加载着');
    // hard evidence only: a just-quit watch leaves a recent event, which is not "still running"
    if (managed && !u.enabled && (u.alive_by || []).some((s) => s !== 'activity')) drifts.push('已关但还有进程在跑它(不是 launchd 拉的——手起的 watch/loop?)' + (portListening ? ',端口 ' + u.port + ' 在听' : ''));
    if (managed && u.enabled && isLoaded && (u.state === 'down')) drifts.push('launchd 加载了但进程没活');
    // (No "port not listening" drift: a project's own gateway is
    // debug-only (<UP>_EMBED_GATEWAY=1); the fleet gateway serves every pool. The port table
    // only reserves numbers so a debug gateway never collides.)
    if (managed && u.enabled && !plistExists) drifts.push('plist 文件不存在(没 adopt 或被删了)');
    rows.push({
      id: u.id, lifecycle: u.lifecycle, enabled: u.enabled, state: u.state,
      launchd_loaded: isLoaded, plist_exists: plistExists,
      port: u.port, port_listening: portListening, drifts,
    });
  }
  const ok = !gatewayDrifts.length && rows.every((r) => !r.drifts.length);
  return {
    as_of: now.toISOString(), ok,
    gateway: { port: st.gateway.port, listening: gatewayListening, launchd_loaded: gatewayLoaded, drifts: gatewayDrifts },
    rows,
  };
}

