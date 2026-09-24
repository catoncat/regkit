// Local OpenAI-compatible gateway — the single endpoint clients point at.
// Everything upstream-specific (pricing, failure mapping, upstream base,
// gateway token, pool name) is injected via `hooks`; the passthrough/SSE/key
// rotation/affinity machinery lives in pool.mjs (shared with hub.mjs).
//
// A client configures ONE baseUrl (http://127.0.0.1:PORT/v1) and ONE static local
// token; the gateway borrows a healthy pool key per request, forwards it
// upstream, and on hard failure rotates to a DIFFERENT key inside the same
// HTTP call — clients see a clean success or a clean pool-exhausted error.
//
// Every successful call appends to the local usage ledger and emits an
// ai.ok event, so the watcher shows AI spend live — no upstream billing
// polling anywhere.
//
// Serving SEVERAL upstreams from one port/process is `createHub` in hub.mjs
// (one pool per upstream, routed by requested model).

import { createServer } from 'node:http';
import { createKeyPool, sendJson } from './pool.mjs';

export {
  estimateCostUsd, extractUsage, injectIncludeUsage, conversationId, createKeyPool,
} from './pool.mjs';

/**
 * Create (not start) the single-upstream gateway. Returns the server plus
 * state accessors so tests can drive it without binding a port.
 *
 * @param hooks { cfg, log, accountsFile, usagePath, upstreamBase, rates,
 *                classifyFailure, gatewayToken, poolName, eligible,
 *                balanceEligible, retire }  (see createKeyPool for the rest)
 */
export function createGateway(hooks) {
  const { cfg, log, gatewayToken = '' } = hooks;
  const pool = createKeyPool({
    id: hooks.id || hooks.poolName || 'gateway',
    base: hooks.upstreamBase,
    accountsFile: hooks.accountsFile,
    usagePath: hooks.usagePath,
    rates: hooks.rates,
    classifyFailure: hooks.classifyFailure,
    poolName: hooks.poolName,
    eligible: hooks.eligible,
    balanceEligible: hooks.balanceEligible,
    retire: hooks.retire,
    log,
  });

  function health() {
    const h = pool.health();
    return { ok: true, ...h };
  }

  const server = createServer(async (req, res) => {
    if (gatewayToken) {
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== gatewayToken) return sendJson(res, 401, { error: { message: 'bad gateway token', type: 'auth_error' } });
    }
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) return sendJson(res, 200, health());
    if (req.method === 'GET' && path === '/v1/models') return pool.handleModels(res);
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions' || path === '/v1/completions')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return pool.handleChat(req, res, Buffer.concat(chunks));
    }
    sendJson(res, 404, { error: { message: 'unsupported path ' + path, type: 'not_found' } });
  });

  return {
    server, health,
    borrow: pool.borrow,
    handleChat: pool.handleChat,
    handleModels: pool.handleModels,
    state: pool.state,
  };
}
