// fleet-decl.mjs — what the fleet is DECLARED to be, and nothing
// about whether it is alive. Pure file I/O, no network, no process table:
//   service.json  (per project)   validateService / scanServices / modelsOf
//   fleet.local.json (machine)    loadFleetLocal / saveFleetLocal / allocPort
// The gateway (fleet-hub) and patrol import this directly so they never pull in
// the liveness/launchd machinery of fleet.mjs just to read declarations.

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FLEET_FILE = join(REPO_ROOT, 'fleet.local.json');

/** Where to look for <project>/data/service.json: `roots` in fleet.local.json
 *  (machine state), else the directory regkit itself is checked out in. */
function defaultRoots() {
  try {
    const roots = JSON.parse(readFileSync(DEFAULT_FLEET_FILE, 'utf8')).roots;
    if (Array.isArray(roots) && roots.length) return roots.map(String);
  } catch { /* missing or unreadable: fall back to the sibling layout */ }
  return [dirname(REPO_ROOT)];
}
export const DEFAULT_ROOTS = defaultRoots();
export const PORT_RANGE = { lo: 48780, hi: 48799 };
export const FLEET_LOCAL_DEFAULTS = Object.freeze({
  gatewayPort: 48790, gatewayToken: 'hub-local', ports: {}, units: {},
});

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(['registrar', 'pool-only', 'harvest', 'external']);
const LIFECYCLES = new Set(['active', 'sunset', 'dead']);

/** Parse + normalize a data/service.json declaration. Throws on hard violations. */
export function validateService(raw, { unitDir = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('service.json: must be an object');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('service.json: bad id ' + JSON.stringify(raw.id));
  const kind = raw.kind ?? 'registrar';
  if (!KINDS.has(kind)) throw new Error('service.json: bad kind ' + JSON.stringify(kind));
  const lifecycle = raw.lifecycle ?? 'active';
  if (!LIFECYCLES.has(lifecycle)) throw new Error('service.json: bad lifecycle ' + JSON.stringify(lifecycle));
  const out = { id: raw.id, kind, lifecycle };
  if (raw.gateway != null) {
    if (typeof raw.gateway !== 'object' || Array.isArray(raw.gateway)) throw new Error('service.json: gateway must be an object');
    out.gateway = { ...raw.gateway }; // dialect fields are pass-through data
  }
  for (const k of ['accounts', 'usage']) {
    if (raw[k] != null) {
      if (typeof raw[k] !== 'string') throw new Error('service.json: ' + k + ' must be a path string');
      out[k] = unitDir ? join(unitDir, raw[k]) : raw[k];
    }
  }
  out.events = unitDir ? join(unitDir, 'data', 'events.jsonl') : 'data/events.jsonl';
  if (raw.protocol != null) out.protocol = unitDir ? join(unitDir, raw.protocol) : raw.protocol;
  if (raw.rates != null) out.rates = raw.rates;
  if (raw.spawn != null) {
    if (typeof raw.spawn !== 'object' || typeof raw.spawn.pattern !== 'string' || !raw.spawn.pattern) {
      throw new Error('service.json: spawn.pattern (non-empty string) is required when spawn is present');
    }
    out.spawn = { ...raw.spawn };
  }
  if (raw.resident != null) {
    // harvest units may declare resident.pattern without a cmd (their resident is
    // a binary we only watch, never spawn). Registrars must give cmd.
    const needCmd = kind !== 'harvest';
    if (typeof raw.resident !== 'object' || (needCmd && (typeof raw.resident.cmd !== 'string' || !raw.resident.cmd))) {
      throw new Error('service.json: resident.cmd (non-empty string) is required when resident is present (kind ' + kind + ')');
    }
    if (raw.resident.cmd != null && typeof raw.resident.cmd !== 'string') {
      throw new Error('service.json: resident.cmd must be a string when present');
    }
    if (raw.resident.pattern != null && typeof raw.resident.pattern !== 'string') {
      throw new Error('service.json: resident.pattern must be a string when present');
    }
    out.resident = { ...raw.resident };
  }
  if (Number.isFinite(raw.activityAliveMin)) out.activityAliveMin = Number(raw.activityAliveMin);
  if (raw.remoteHealth != null) out.remoteHealth = String(raw.remoteHealth);
  out.staleAfterMin = Number.isFinite(raw.staleAfterMin) ? Number(raw.staleAfterMin) : 1440;
  return out;
}

/** Discover <root>/<project>/data/service.json under every root. Broken files become error entries. */
export function scanServices({ roots = DEFAULT_ROOTS } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const unitDir = join(root, e.name);
      const file = join(unitDir, 'data', 'service.json');
      if (!existsSync(file)) continue;
      try {
        found.push({ unitDir, decl: validateService(JSON.parse(readFileSync(file, 'utf8')), { unitDir }) });
      } catch (err) {
        found.push({ unitDir, decl: null, error: String(err?.message || err) });
      }
    }
  }
  return found;
}

/** Machine-level desired state + port table. Missing file = defaults; broken file throws. */
export function loadFleetLocal(path = DEFAULT_FLEET_FILE) {
  if (!existsSync(path)) return { ...FLEET_LOCAL_DEFAULTS, ports: {}, units: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    gatewayPort: raw.gatewayPort ?? FLEET_LOCAL_DEFAULTS.gatewayPort,
    gatewayToken: raw.gatewayToken ?? FLEET_LOCAL_DEFAULTS.gatewayToken,
    ports: { ...(raw.ports || {}) },
    units: { ...(raw.units || {}) },
    ...(raw.patrol ? { patrol: raw.patrol } : {}),
    ...(Array.isArray(raw.roots) ? { roots: raw.roots } : {}),
  };
}

/** First free port in range, honouring the existing table and extra taken ports. */
export function allocPort({ table = {}, taken = [], preferred = null, lo = PORT_RANGE.lo, hi = PORT_RANGE.hi } = {}) {
  const used = new Set([...Object.values(table).map(Number), ...taken.map(Number)]);
  const pref = Number(preferred);
  if (preferred != null && pref >= lo && pref <= hi && !used.has(pref)) return pref;
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error('no free port in ' + lo + '-' + hi);
}


/** Declared model ids (aliases + static models); live catalog merge is the gateway's job. */
export function modelsOf(decl) {
  const gw = decl?.gateway || {};
  return [...new Set([...Object.keys(gw.aliases || {}), ...(Array.isArray(gw.models) ? gw.models : [])])];
}

/** Atomic write (tmp + rename), 0600. */
export function saveFleetLocal(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpFile = path + '.tmp-' + process.pid;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpFile, path);
}

/** The gateway's event log sits next to fleet.local.json (gateway cwd = repo). */
export const fleetEventsFileFor = (fleetFile = DEFAULT_FLEET_FILE) =>
  join(dirname(fleetFile), 'data', 'fleet-events.jsonl');
