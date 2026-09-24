// fleet-hub.mjs — declarations -> hub providers.
// The gateway is fleet unit 0: pools assemble from project service.json files,
// classifyFailure loads dynamically from each project's own protocol.mjs
// (failure isolates that ONE pool), and health.json gates routing live
// (halted / pool-broken / unreadable => excluded per request; model-delisted =>
// blocklist). Health never disables a provider at build time: recover must
// take effect without a gateway restart.

import { join } from 'node:path';
import { scanServices, loadFleetLocal, DEFAULT_ROOTS, DEFAULT_FLEET_FILE } from './fleet-decl.mjs';
import { readHealthState, gateDecision, delistedModelsOf } from './health.mjs';
import { createHub } from './hub.mjs';
import { classifyDefault } from './pool.mjs';

/** Standard OpenAI-gateway failure taxonomy — defined once in pool.mjs (the only
 *  place that consumes it), re-exported here for the declaration path. */
export { classifyDefault };

/** Dynamic protocol loading. Searches every shape real projects
 *  actually use: classifyFailure / gateway.classifyFailure / classifyOt, and
 *  rates / gateway.rates / ratesFor. Errors never throw — they isolate. */
export async function loadProtocol(protocolPath) {
  try {
    const mod = await import(protocolPath);
    // Accepted protocol-module shapes: gateway.classifyFailure / gateway.rates,
    // a top-level classifyOt, or a flat ratesFor.
    const classifyFailure = mod.classifyFailure ?? mod.gateway?.classifyFailure ?? mod.classifyOt ?? null;
    const rates = mod.rates ?? mod.gateway?.rates ?? mod.ratesFor ?? null;
    return {
      classifyFailure: typeof classifyFailure === 'function' ? classifyFailure : null,
      rates: typeof rates === 'function' ? rates : null,
      ...(typeof classifyFailure === 'function' ? {} : { error: 'no classifyFailure export in ' + protocolPath }),
    };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

/** Back-compat wrapper: classify only. */
export async function loadClassify(protocolPath) {
  const p = await loadProtocol(protocolPath);
  return p.classifyFailure ? { classifyFailure: p.classifyFailure } : { error: p.error };
}

const healthPathFor = (unitDir) => join(unitDir, 'data', 'health.json');

/**
 * Build provider descriptors from every declaration that has a gateway section.
 * Returns { providers, entries } — entries carry healthPath for the live gate.
 */
export async function buildFleetProviders({ roots = DEFAULT_ROOTS, log } = {}) {
  const found = scanServices({ roots });
  const providers = [];
  const entries = new Map();
  for (const f of found) {
    if (!f.decl || !f.decl.gateway) continue;
    const d = f.decl;
    const gw = d.gateway;
    const healthPath = healthPathFor(f.unitDir);
    entries.set(d.id, { healthPath, unitDir: f.unitDir });

    // Health is NOT decided here. A unit that is halted (or has an unreadable
    // health.json) at gateway boot still gets a live pool; createHealthGate
    // excludes it per request and lets it back in the moment `fleet recover`
    // (or a tick) flips health.json — no gateway restart. Baking the boot-time
    // verdict into a `disabled` provider made "一键恢复" silently require one.
    // Only permanent build failures (classify load) disable a provider.
    let classifyFailure = classifyDefault;
    let protocolRates = null;
    if (d.protocol) {
      const loaded = await loadProtocol(d.protocol);
      if (loaded.error) {
        providers.push({ id: d.id, prefix: gw.prefix ?? d.id, base: gw.base, disabled: 'classify-load-failed: ' + loaded.error });
        continue;
      }
      classifyFailure = loaded.classifyFailure;
      protocolRates = loaded.rates;
      log?.event?.('fleet.classify_loaded', { upstream: d.id, protocol: d.protocol });
    }

    const rates = protocolRates ?? (d.rates && Number.isFinite(d.rates.in) ? () => d.rates : () => ({ in: 0, out: 0 }));
    providers.push({
      id: d.id,
      prefix: gw.prefix ?? d.id,
      base: gw.base,
      accountsFile: d.accounts,
      usagePath: d.usage,
      rates,
      classifyFailure,
      aliases: gw.aliases || {},
      log,
      poolName: d.id,
      ...(gw.authHeader ? { authHeader: gw.authHeader } : {}),
      ...(gw.authScheme !== undefined ? { authScheme: gw.authScheme } : {}),
      ...(gw.chatPath ? { chatPath: gw.chatPath } : {}),
      ...(gw.modelsPath ? { modelsPath: gw.modelsPath } : {}),
      ...(gw.responsesPath ? { responsesPath: gw.responsesPath } : {}),
      ...(gw.messagesPath ? { messagesPath: gw.messagesPath } : {}),
      ...(gw.userAgent ? { userAgent: gw.userAgent } : {}),
      ...(gw.anthropicVersion ? { anthropicVersion: gw.anthropicVersion } : {}),
      ...(Array.isArray(gw.faces) ? { faces: gw.faces } : {}),
      ...(gw.extraHeaders ? { extraHeaders: gw.extraHeaders } : {}),
      ...(gw.dialect ? { dialect: gw.dialect } : {}),
      ...(Array.isArray(gw.models) ? { models: gw.models } : {}),
      ...(gw.balanceEligible === 'always' ? { balanceEligible: () => true } : {}),
      modelBlocklist: () => delistedModelsOf(gateDecision(readHealthState(healthPath)).health),
    });
  }
  return { providers, entries };
}

/** Live health gate with a small TTL so transitions exclude pools without a restart. */
export function createHealthGate(entries, { ttlMs = 5000, now = () => Date.now() } = {}) {
  const cache = new Map(); // id -> { at, gated }
  return async function gate(p) {
    const e = entries.get(p.id);
    if (!e?.healthPath) return true;
    const c = cache.get(p.id);
    if (c && now() - c.at < ttlMs) return !c.gated;
    const gated = gateDecision(readHealthState(e.healthPath)).gated;
    cache.set(p.id, { at: now(), gated });
    return !gated;
  };
}

/** Unit 0: the one-port, one-token hub over every declared pool. */
export async function buildFleetHub({ log, roots = DEFAULT_ROOTS, fleetFile = DEFAULT_FLEET_FILE, token, gateTtlMs } = {}) {
  const fleetLocal = loadFleetLocal(fleetFile);
  const { providers, entries } = await buildFleetProviders({ roots, log });
  if (!providers.length) throw new Error('no declared gateway providers found (scan roots: ' + roots.join(', ') + ')');
  return createHub({
    log,
    token: token ?? fleetLocal.gatewayToken,
    providers,
    gate: createHealthGate(entries, gateTtlMs ? { ttlMs: gateTtlMs } : {}),
  });
}
