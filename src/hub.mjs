// Multi-upstream hub gateway — ONE local port serving MANY upstreams.
//
// Routing order (first hit wins): provider alias → explicit prefix (whose rest may be that pool's alias) →
// catalog unique match → defaultUpstream → 404 model_not_found.
// GET /v1/models merges every catalog (collisions get prefixed mirrors);
// GET /health reports every pool separately plus totals.
//
// Providers may be { disabled: reason } (classify load
// failure) — excluded from routing and catalog. opts.gate is an async
// per-provider liveness check (health.json hot state); gated providers are
// skipped by route() / mergedModels() / ?upstream= but stay visible in health()
// with gated:true.
// Faces: /v1/chat/completions, /v1/responses, /v1/messages(+count_tokens) —
// routed by model like chat; the pool answers face_not_supported itself.

import { createServer } from 'node:http';
import { createKeyPool, sendJson } from './pool.mjs';

/** Read a request body to a Buffer. */
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * @param opts {
 *   log,
 *   providers: [ providerDescriptor | { disabled: reason, ...data } ],
 *   token: '', defaultUpstream: id,
 *   gate: async (provider) => boolean   // false = temporarily excluded
 * Catalog caching is a pool concern (provider.catalogTtlMs / provider.models).
 * }
 */
export function createHub(opts) {
  const { log, token = '', defaultUpstream = null } = opts;
  const gate = opts.gate || (async () => true);
  const providers = (opts.providers || []).map((p) => {
    if (p.disabled) return { ...p, prefix: p.prefix || p.id, aliases: p.aliases || {}, pool: null };
    const pool = createKeyPool({ ...p, log: p.log || log });
    return { ...p, prefix: p.prefix || p.id, aliases: p.aliases || {}, pool };
  });
  const byId = new Map(providers.map((p) => [p.id, p]));

  if (!providers.length) throw new Error('createHub requires at least one provider');

  const usable = async (p) => !p.disabled && (await gate(p));

  // A bare alias two pools both declare is as ambiguous as a colliding catalog id
  // (目录唯一): never silently first-wins. Clients force a pool with prefix/alias.
  const aliasOwners = new Map();
  for (const p of providers) for (const a of Object.keys(p.aliases)) aliasOwners.set(a, [...(aliasOwners.get(a) || []), p.id]);
  const ambiguousAliases = new Set([...aliasOwners].filter(([, ids]) => ids.length > 1).map(([a]) => a));
  for (const a of ambiguousAliases) log?.event?.('hub.alias_collision', { alias: a, upstreams: aliasOwners.get(a) });

  /** Catalogue for one provider — the pool owns it (static list / cached discovery /
   *  live blocklist); the hub keeps no second copy to fall out of sync. */
  const catalogOf = (p) => (p.pool ? p.pool.models() : Promise.resolve([]));

  /** model -> { provider, model } or null. */
  async function route(model) {
    if (!model) return null;
    // 1. alias (bare, and only when exactly one pool declares it)
    if (!ambiguousAliases.has(model)) {
      for (const p of providers) {
        if (!(await usable(p))) continue;
        const target = p.aliases[model];
        if (target) return { provider: p, model: target, via: 'alias' };
      }
    } else {
      log?.event?.('hub.ambiguous_model', { model, upstreams: aliasOwners.get(model), via: 'alias' });
    }
    // 2. prefix
    const slash = model.indexOf('/');
    if (slash > 0) {
      const head = model.slice(0, slash);
      const p = providers.find((x) => x.prefix === head || x.id === head);
      if (p && (await usable(p))) {
        // The rest may itself be one of that pool's aliases (prefix/alias): a
        // client forcing a pool must not lose the alias it would have had bare.
        const rest = model.slice(slash + 1);
        return { provider: p, model: p.aliases[rest] || rest, via: p.aliases[rest] ? 'prefix+alias' : 'prefix' };
      }
    }
    // 3. catalog match (fetch once per provider, cached)
    const hits = [];
    for (const p of providers) {
      if (!(await usable(p))) continue;
      const cat = await catalogOf(p);
      if (cat.includes(model)) hits.push(p);
    }
    if (hits.length === 1) return { provider: hits[0], model, via: 'catalog' };
    if (hits.length > 1) {
      // "Unique in catalog": more than one pool serving the id is NOT a match.
      // Say so and fall through to the default pool (or 404) rather than silently
      // picking one — a client forces a pool with `prefix/<model>`, and those
      // mirrors are published by mergedModels().
      log?.event?.('hub.ambiguous_model', { model, upstreams: hits.map((p) => p.id) });
    }
    // 4. default
    if (defaultUpstream && byId.has(defaultUpstream)) {
      const p = byId.get(defaultUpstream);
      if (await usable(p)) return { provider: p, model, via: 'default' };
    }
    return null;
  }

  async function mergedModels() {
    const out = [];
    const seen = new Map(); // id -> count
    const catalogs = [];    // [provider, ids] for the mirror pass (one pull per provider)
    for (const p of providers) {
      if (!(await usable(p))) continue;
      const ids = await catalogOf(p);
      catalogs.push([p, ids]);
      for (const id of ids) {
        out.push({ id, object: 'model', owned_by: p.id });
        seen.set(id, (seen.get(id) || 0) + 1);
      }
    }
    // colliding ids: add prefixed mirrors so the client can force a provider
    for (const [p, ids] of catalogs) {
      for (const id of ids) {
        if ((seen.get(id) || 0) > 1) out.push({ id: `${p.prefix}/${id}`, object: 'model', owned_by: p.id });
      }
    }
    return { object: 'list', data: out };
  }

  /**
   * Build-time state + pool facts + the gate's current verdict. Since health never
   * disables a provider at build time, `gated` is the only way /health can answer
   * "why is this pool not serving?"; gated pools stay listed with their pool facts
   * but are left out of the serving totals.
   */
  async function health() {
    const upstreams = {};
    let keys = 0;
    let drained = 0;
    let balance = 0;
    let gatedCount = 0;
    for (const p of providers) {
      if (p.disabled) {
        upstreams[p.id] = { disabled: p.disabled, base: p.base };
        continue;
      }
      const gated = !(await gate(p));
      const h = p.pool.health();   // carries models_cached
      upstreams[p.id] = { ...h, base: p.base, gated };
      if (gated) { gatedCount++; continue; }
      keys += h.eligible_keys;
      drained += h.drained_keys;
      balance += h.display_balance_usd;
    }
    return {
      ok: true,
      gateway: 'hub',
      upstreams,
      totals: {
        upstreams: providers.length, gated: gatedCount,
        eligible_keys: keys, drained_keys: drained, display_balance_usd: Math.round(balance * 10000) / 10000,
      },
    };
  }

  /** Shared model routing for every face; rewrites body model on alias/prefix. */
  async function handleModelRequest(req, res, bodyBuf, face, { metering = false } = {}) {
    let model = null;
    try { model = JSON.parse(bodyBuf.toString('utf8'))?.model || null; } catch { /* passthrough */ }
    const hit = await route(model);
    if (!hit) {
      const names = providers.filter((p) => !p.disabled).map((p) => p.prefix).join(', ');
      log?.event?.('hub.model_not_found', { model, face });
      return sendJson(res, 404, {
        error: {
          message: `model '${model}' is not served by any upstream (${names}); use '<upstream>/<model>' to force one`,
          type: 'model_not_found',
        },
      });
    }
    let body = bodyBuf;
    if (hit.model !== model) {
      try {
        const j = JSON.parse(bodyBuf.toString('utf8'));
        j.model = hit.model;
        body = Buffer.from(JSON.stringify(j), 'utf8');
      } catch { /* forward as-is */ }
    }
    log?.event?.('hub.route', { model, upstream: hit.provider.id, via: hit.via, mapped: hit.model, face });
    if (face === 'responses') return hit.provider.pool.handleResponses(req, res, body);
    if (face === 'messages') return hit.provider.pool.handleMessages(req, res, body, { metering });
    return hit.provider.pool.handleChat(req, res, body);
  }

  async function handleChat(req, res, bodyBuf) {
    return handleModelRequest(req, res, bodyBuf, 'chat');
  }

  const server = createServer(async (req, res) => {
    if (token) {
      // One token, three faces: OpenAI clients send it as Bearer, Anthropic
      // clients (Anthropic Messages SDKs) as x-api-key. Both are the
      // same secret; neither is ever forwarded upstream (wire.upstreamHeaders).
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
      if (got !== token) return sendJson(res, 401, { error: { message: 'bad gateway token', type: 'auth_error' } });
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) return sendJson(res, 200, await health());
    if (req.method === 'GET' && path === '/v1/models') {
      const only = url.searchParams.get('upstream');
      if (only) {
        const p = byId.get(only);
        if (!p || p.disabled) return sendJson(res, 404, { error: { message: `unknown upstream '${only}'`, type: 'not_found' } });
        // Same rule as the merged catalog: a health-gated pool is not served, so it
        // has no catalog to show (it stays visible in /health).
        if (!(await gate(p))) return sendJson(res, 404, { error: { message: `upstream '${only}' is gated by health`, type: 'upstream_gated' } });
        const ids = await catalogOf(p);
        return sendJson(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: p.id })) });
      }
      return sendJson(res, 200, await mergedModels());
    }
    if (req.method === 'POST' && path === '/v1/models/refresh') {
      // Manual catalog refresh.
      const only = url.searchParams.get('upstream');
      const refreshed = [];
      for (const p of providers) {
        if (p.disabled || p.pool.staticCatalog) continue;
        if (only && p.id !== only && p.prefix !== only) continue;
        p.pool.clearModelsCache();
        refreshed.push(p.id);
      }
      const merged = await mergedModels(); // re-pulls what was cleared
      log?.event?.('hub.catalog_refresh', { upstream: only || 'all', refreshed });
      return sendJson(res, 200, { refreshed, models: merged.data.length });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions' || path === '/v1/completions')) {
      return handleModelRequest(req, res, await readBody(req), 'chat');
    }
    if (req.method === 'POST' && path === '/v1/responses') {
      return handleModelRequest(req, res, await readBody(req), 'responses');
    }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      return handleModelRequest(req, res, await readBody(req), 'messages', { metering: true });
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      return handleModelRequest(req, res, await readBody(req), 'messages');
    }
    sendJson(res, 404, { error: { message: 'unsupported path ' + path, type: 'not_found' } });
  });

  return {
    server, health, route, handleChat, handleModelRequest, mergedModels,
    providers: providers.map((p) => ({ id: p.id, pool: p.pool, prefix: p.prefix, aliases: p.aliases, disabled: p.disabled || null })),
    borrow: (id, convo) => byId.get(id)?.pool?.borrow(convo),
    state: new Map(providers.map((p) => [p.id, p.pool?.state ?? null])),
  };
}
