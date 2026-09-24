// Per-upstream key pool + multi-face OpenAI/Anthropic passthrough machinery.
//
// One pool = one upstream base + one accounts.jsonl + one usage ledger + one
// failure taxonomy. Rotation contract (unchanged): borrow a healthy key, forward,
// and on a hard failure rotate to a DIFFERENT key inside the same HTTP call.
//
// Faces: chat/completions + responses + messages(+count_tokens).
// No protocol translation — the upstream speaks what it speaks; provider.faces
// declares which faces exist, unsupported faces get a clean face_not_supported.
//
// Dialect: injectFields (any face),
// rewriteRoles / ensureAssistantFields (chat face only — responses/messages
// carry no chat dialect), stripOn400 (declared one-shot degradation retry).
// The body/header/usage shaping those rules need is pure and lives in wire.mjs;
// this file is the stateful part: key rotation, affinity, ledger, catalog cache.

import { readAccounts, appendAccount } from './accounts.mjs';
import { recordUsage, displayedBalance, createUsageReader } from './usage.mjs';
import {
  estimateCostUsd, conversationId, extractUsage, normalizeUsage, injectIncludeUsage,
  applyInjectFields, applyChatDialect, stripFields, estimateTokensLocal,
  DEFAULT_UPSTREAM_UA, authHeadersFor, upstreamHeaders, applyExtraHeaders, responseHeaders,
  sendJson, errorText, resolveBlocklist,
} from './wire.mjs';

// The pure wire helpers moved to wire.mjs; re-exported so the pool surface is unchanged.
export * from './wire.mjs';

export const TIMEOUT = 120000;
export const MAX_KEY_ATTEMPTS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Standard OpenAI-gateway failure taxonomy — the ONE default classification
 * (an upstream's protocol.mjs classifyFailure overrides it). Doubles as the
 * fallback when a project classifier throws, so a classifier bug cannot take the
 * request path down with it.
 */
export function classifyDefault(status) {
  if (status === 401 || status === 402) return 'balance';
  if (status === 404) return 'model_mismatch';
  if (status === 429) return 'concurrency';
  if (status >= 500 || status === 0) return 'network';
  return 'client';
}

/** Balance-drains tolerated inside one request before the breaker trips (see serveWithRotation). */
export const MAX_DRAINS_PER_REQUEST = 3;

/** Conversation affinity bounds: stick to a key, but never forever. */
export const AFFINITY_TTL_MS = 30 * 60 * 1000;
export const AFFINITY_MAX = 2000;

/**
 * Create the key pool + passthrough for ONE upstream.
 * Beyond createGateway-era hooks: faces, responsesPath, messagesPath,
 * anthropicVersion, dialect, modelBlocklist (array or () => array),
 * extraHeaders, models (static catalog), catalogTtlMs.
 */
export function createKeyPool(provider) {
  const {
    id = 'upstream', base, accountsFile, usagePath, rates, classifyFailure, log,
    poolName = id,
  } = provider;
  const chatPath = provider.chatPath || '/chat/completions';
  const modelsPath = provider.modelsPath || '/models';
  const responsesPath = provider.responsesPath || '/responses';
  const messagesPath = provider.messagesPath || '/messages';
  const dialect = provider.dialect || {};
  const faces = new Set(Array.isArray(provider.faces) && provider.faces.length ? provider.faces : ['chat']);
  const eligible = provider.eligible || ((a) => a.status === 'verified' && a.api_key);
  const balanceEligible = provider.balanceEligible || ((a, rows) => {
    const bal = displayedBalance(a, rows);
    return bal === null || bal > 0;
  });
  const retireProvided = typeof provider.retire === 'function';
  const exhausted = new Set();
  const lastUsed = new Map();
  // convo -> { email, at }: bounded + TTL'd, so a long-lived gateway cannot grow
  // this map forever and a stale pin cannot outlive its usefulness.
  const affinity = new Map();

  /** Affinity write with LRU eviction (Map insertion order == recency). */
  function rememberAffinity(convo, email, nowMs) {
    if (!convo) return;
    affinity.delete(convo);
    affinity.set(convo, { email, at: nowMs });
    while (affinity.size > AFFINITY_MAX) affinity.delete(affinity.keys().next().value);
  }

  /** Affinity read; an expired pin is dropped rather than honoured. */
  function affinityFor(convo, nowMs) {
    const hit = convo ? affinity.get(convo) : null;
    if (!hit) return null;
    if (nowMs - hit.at > AFFINITY_TTL_MS) { affinity.delete(convo); return null; }
    return hit.email;
  }

  /**
   * Default retirement PERSISTS the drained key. Without it a 402 only lived in
   * memory, so the next restart resurrected a key the upstream had already
   * refused (review P2). A project can still override with its own retire hook.
   */
  function defaultRetire(account, reason, status) {
    appendAccount(accountsFile, {
      email: account.email,
      status: 'exhausted',
      balance_usd: 0,
      checked_at: new Date().toISOString(),
      note: `drained via gateway HTTP ${status} (${reason})`,
    });
  }
  const retire = retireProvided ? provider.retire : defaultRetire;

  // ── catalog — the ONE place an upstream's /models is pulled ──
  // A declared static list (provider.models) wins and never hits the network.
  // Discovery is cached for catalogTtlMs; the blocklist is applied on READ, so a
  // delisting in health.json shows the moment the gate flips, not when the cache
  // expires. hub.mjs delegates here rather than caching a second copy.
  const staticModels = Array.isArray(provider.models) && provider.models.length ? [...provider.models] : null;
  const catalogTtlMs = provider.catalogTtlMs ?? 300000;
  let modelsCache = null;
  let modelsCacheAt = 0;
  const cacheFresh = () => !!modelsCache && Date.now() - modelsCacheAt < catalogTtlMs;
  const visibleModels = (ids) => {
    const blocked = resolveBlocklist(provider.modelBlocklist);
    return ids.filter((mid) => mid && !blocked.has(mid));
  };

  // ── ledger (usage) plumbing — the money side of the pool ──
  // Rows are tailed incrementally (a 1 MB ledger must not be re-parsed per
  // request). An UNREADABLE ledger means unknown spend, and unknown spend must
  // never read as "no spend": the pool stops handing out keys until it can read
  // what the pool already burned. A row we failed to record (even to the spool)
  // disqualifies that one key, because its remaining budget is now a guess.
  const usageReader = usagePath ? createUsageReader(usagePath) : null;
  const ledgerSuspect = new Set();
  let ledgerState = 'missing';

  function usageRows() {
    if (!usageReader) return [];
    try {
      const r = usageReader.read();
      ledgerState = r.state;
      return r.state === 'unreadable' ? [] : r.rows;
    } catch { ledgerState = 'unreadable'; return []; }
  }
  const ledgerHealthy = () => ledgerState !== 'unreadable';

  function eligibleAccounts() {
    const rows = usageRows();
    if (!ledgerHealthy()) return [];   // fail closed: never issue budget we cannot account for
    return readAccounts(accountsFile)
      .filter((a) => eligible(a) && !exhausted.has(a.email) && !ledgerSuspect.has(a.email) && balanceEligible(a, rows));
  }

  /**
   * Borrow: honour conversation affinity first, else least-recently-used.
   * `exclude` = the keys already tried in THIS request. Rotation depends on it:
   * without it a pinned key that just failed would be borrowed again and again,
   * burning up to MAX_KEY_ATTEMPTS × TIMEOUT on one dead key (review P2).
   */
  function borrow(convo, exclude = null) {
    const nowMs = Date.now();
    const pool = eligibleAccounts().filter((a) => !exclude || !exclude.has(a.email));
    if (!pool.length) return null;
    const pinnedEmail = affinityFor(convo, nowMs);
    if (pinnedEmail) {
      const pinned = pool.find((a) => a.email === pinnedEmail);
      if (pinned) { lastUsed.set(pinned.email, nowMs); return pinned; }
    }
    pool.sort((a, b) => (lastUsed.get(a.email) || 0) - (lastUsed.get(b.email) || 0));
    const rec = pool[0];
    lastUsed.set(rec.email, nowMs);
    return rec;
  }

  function headersFor(req, key, face) {
    const headers = upstreamHeaders(req, key, provider);
    if (face === 'messages') {
      headers.delete('authorization');
      headers.delete('apikey');
      headers.delete('x-api-key');
      headers.set('x-api-key', key);
      headers.set('anthropic-version', String(req.headers['anthropic-version'] || provider.anthropicVersion || '2023-06-01'));
    }
    applyExtraHeaders(headers, provider.extraHeaders);
    return headers;
  }

  const faceNotSupported = (res, face) => sendJson(res, 404, {
    error: {
      message: id + ' does not serve the ' + face + ' face (has: ' + [...faces].join(', ') + ')',
      type: 'face_not_supported',
      faces: [...faces],
    },
  });

  async function serveWithRotation({ req, res, bodyBuf, path, face, metering = false }) {
    const convo = conversationId(bodyBuf);
    let model = null;
    let streaming = false;
    try {
      const j = JSON.parse(bodyBuf.toString('utf8'));
      model = j.model || null;
      streaming = !!j.stream;
    } catch { /* upstream reports malformed json */ }

    // Health-driven delisting: reject blocked models before touching the pool.
    const blocked = resolveBlocklist(provider.modelBlocklist);
    if (model && blocked.has(model)) {
      return sendJson(res, 404, {
        error: { message: "model '" + model + "' was delisted from the " + id + ' pool', type: 'model_delisted' },
      });
    }

    if (metering) {
      // count_tokens: one attempt, short budget, local CJK estimate on stall.
      const rec = borrow(convo);
      if (!rec) return sendJson(res, 200, { input_tokens: estimateTokensLocal(bodyBuf) });
      try {
        const upstream = await fetch(base + path, {
          method: 'POST', headers: headersFor(req, rec.api_key, face), body: bodyBuf,
          signal: AbortSignal.timeout(3000),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, responseHeaders(upstream));
        return res.end(body);
      } catch {
        return sendJson(res, 200, { input_tokens: estimateTokensLocal(bodyBuf) });
      }
    }

    const tried = new Set();
    let lastHard = null;
    const started = Date.now();
    let strippedOnce = false;
    let drains = 0;
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
      const rec = borrow(convo, tried);
      if (!rec) break;
      tried.add(rec.email);

      let upstream;
      try {
        upstream = await fetch(base + path, {
          method: 'POST', headers: headersFor(req, rec.api_key, face), body: bodyBuf,
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (e) {
        log.event('ai.fail', { upstream: id, email: rec.email, klass: 'network', error: String(e).slice(0, 80) });
        lastHard = { status: 0, reason: 'network' };
        await sleep(500);
        continue;
      }

      // Declared 400 degradation (e.g. tools): strip listed fields, retry same key once.
      if (!strippedOnce && upstream.status === 400 && Array.isArray(dialect.stripOn400) && dialect.stripOn400.length) {
        const strippedBody = stripFields(bodyBuf, dialect.stripOn400);
        if (strippedBody) {
          strippedOnce = true;
          log.event('ai.strip400', { upstream: id, email: rec.email, fields: dialect.stripOn400 });
          try {
            upstream = await fetch(base + path, {
              method: 'POST', headers: headersFor(req, rec.api_key, face), body: strippedBody,
              signal: AbortSignal.timeout(TIMEOUT),
            });
            bodyBuf = strippedBody;
          } catch { /* keep the original 400 response */ }
        }
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        res.writeHead(upstream.status, responseHeaders(upstream));
        const chunks = [];
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        res.end();
        const raw = Buffer.concat(chunks).toString('utf8');
        const usage = normalizeUsage(extractUsage(raw, streaming), face);
        const cost = estimateCostUsd(rates(model, process.env), usage);
        if (convo) rememberAffinity(convo, rec.email, Date.now());
        if (usage || cost > 0) {
          const rec2 = recordUsage(usagePath, {
            email: rec.email, kind: 'gateway', model,
            cost_usd: cost,
            prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens,
            note: id,
          });
          if (!rec2.ok) {
            // The response is already out; the spend is not on record. A spooled
            // row is replayed on the next read; if even the spool failed, this
            // key's budget is unknown — stop issuing it (review P1).
            if (!rec2.spooled) ledgerSuspect.add(rec.email);
            log.event('usage.write_failed', {
              upstream: id, email: rec.email, spooled: !!rec2.spooled, cost_usd: cost, error: rec2.error,
            });
          }
        }
        log.event('ai.ok', {
          upstream: id, email: rec.email, model: model || null, ms: Date.now() - started,
          prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
          cost_usd: cost, stream: streaming, attempts: tried.size, face,
        });
        log.info(`ai ${id} ${rec.email} ${model || '?'} ${upstream.status} ${Date.now() - started}ms $${cost.toFixed(4)}`);
        return;
      }

      const failureBody = Buffer.from(await upstream.arrayBuffer());
      // A project classifier is loaded code we do not control: if it throws, fall
      // back to the standard taxonomy and record it — never fail the request.
      let reason;
      try {
        reason = classifyFailure(upstream.status, errorText(failureBody));
      } catch (err) {
        reason = classifyDefault(upstream.status);
        log.event('classify.fail', { upstream: id, status: upstream.status, error: String(err?.message || err).slice(0, 80), fallback: reason });
      }
      if (!reason) reason = classifyDefault(upstream.status);
      log.event('ai.fail', { upstream: id, email: rec.email, status: upstream.status, klass: reason, detail: String(errorText(failureBody)).slice(0, 80) });

      if (reason === 'client') {
        res.writeHead(upstream.status, responseHeaders(upstream));
        res.end(failureBody);
        return;
      }
      lastHard = { status: upstream.status, reason };
      if (reason === 'balance') {
        // Drain-storm breaker: wallets empty one at a time across many requests;
        // N keys all "out of balance" inside ONE request is a model-level refusal
        // the classifier did not recognise (e.g. "model X requires a paid balance"),
        // not N simultaneously empty wallets. Stop retiring and hand the client
        // the upstream's own answer — a wrong 'balance' verdict can otherwise burn
        // every key in the pool within a single request.
        if (drains >= MAX_DRAINS_PER_REQUEST) {
          log.event('pool.drain_storm', { upstream: id, model: model || null, drained: drains, status: upstream.status, detail: String(errorText(failureBody)).slice(0, 80) });
          res.writeHead(upstream.status, responseHeaders(upstream));
          res.end(failureBody);
          return;
        }
        drains++;
        exhausted.add(rec.email);
        try { retire(rec, reason, upstream.status); } catch (e) { log.event('retire.fail', { upstream: id, email: rec.email, error: String(e).slice(0, 80) }); }
        log.event('key.drained', { upstream: id, email: rec.email, via: 'http-' + upstream.status, retire: retireProvided ? 'project' : 'default' });
        continue;
      }
      if (reason === 'model_mismatch') continue;      // rotate, do not retire
      await sleep(reason === 'concurrency' ? 1000 : 400); // backoff, rotate
    }

    sendJson(res, 503, {
      error: {
        message: `${poolName} pool exhausted after ${tried.size} key attempt(s). Last: ${lastHard ? lastHard.status + ' ' + lastHard.reason : 'n/a'}`,
        type: 'pool_exhausted',
      },
    });
    log.event('pool.exhausted', { upstream: id, tried: tried.size, last: lastHard || null });
  }

  async function handleChat(req, res, bodyBuf) {
    bodyBuf = injectIncludeUsage(applyChatDialect(applyInjectFields(bodyBuf, dialect.injectFields), dialect));
    return serveWithRotation({ req, res, bodyBuf, path: chatPath, face: 'chat' });
  }

  async function handleResponses(req, res, bodyBuf) {
    if (!faces.has('responses')) return faceNotSupported(res, 'responses');
    bodyBuf = injectIncludeUsage(applyInjectFields(bodyBuf, dialect.injectFields));
    return serveWithRotation({ req, res, bodyBuf, path: responsesPath, face: 'responses' });
  }

  async function handleMessages(req, res, bodyBuf, { metering = false } = {}) {
    if (!faces.has('messages')) return faceNotSupported(res, 'messages');
    bodyBuf = applyInjectFields(bodyBuf, dialect.injectFields);
    return serveWithRotation({ req, res, bodyBuf, path: metering ? messagesPath + '/count_tokens' : messagesPath, face: 'messages', metering });
  }

  /**
   * One upstream /models pull with a borrowed key. Fills the cache on 200.
   * Returns { status, ids | null, body | null, error | null } so the HTTP face
   * can relay the upstream's own failure while models() just sees "nothing".
   */
  async function fetchCatalog() {
    const rec = borrow(null);
    if (!rec) return { status: 503, ids: null, body: null, error: 'no eligible keys' };
    try {
      const upstream = await fetch(base + modelsPath, {
        headers: { ...authHeadersFor(provider, rec.api_key), 'user-agent': provider.userAgent || DEFAULT_UPSTREAM_UA },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (upstream.status !== 200) return { status: upstream.status, ids: null, body, error: null };
      const j = JSON.parse(body.toString('utf8'));
      const ids = (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [])
        .map((m) => (typeof m === 'string' ? m : m?.id))
        .filter(Boolean);
      modelsCache = ids;
      modelsCacheAt = Date.now();
      return { status: 200, ids, body, error: null };
    } catch (e) {
      return { status: 502, ids: null, body: null, error: String(e).slice(0, 60) };
    }
  }

  /**
   * Model ids this pool serves right now: static list or cached discovery, minus
   * the blocklist. When a re-pull fails after the TTL, the LAST GOOD catalog is
   * served (stale-on-error): an upstream blip must not make every model-name
   * request 404 at the hub — the pool's own rotation/ai.fail path is where an
   * outage is supposed to surface. [] only when nothing was ever discovered.
   */
  async function models() {
    if (staticModels) return visibleModels(staticModels);
    if (cacheFresh()) return visibleModels(modelsCache);
    const r = await fetchCatalog();
    if (r.ids) return visibleModels(r.ids);
    return modelsCache ? visibleModels(modelsCache) : [];
  }

  const listOf = (ids) => ({ object: 'list', data: ids.map((mid) => ({ id: mid, object: 'model' })) });

  /** GET /v1/models face: same catalog as models() (incl. stale-on-error); relays the
   *  upstream failure only when there is nothing cached to serve. */
  async function handleModels(res) {
    if (staticModels || cacheFresh()) return sendJson(res, 200, listOf(await models()));
    const r = await fetchCatalog();
    if (r.status === 200) return sendJson(res, 200, listOf(visibleModels(r.ids)));
    if (modelsCache) return sendJson(res, 200, listOf(visibleModels(modelsCache)));
    if (r.body) {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      return res.end(r.body);
    }
    if (r.status === 503) return sendJson(res, 503, { error: { message: r.error, type: 'pool_exhausted' } });
    return sendJson(res, 502, { error: { message: 'models upstream failed: ' + r.error, type: 'upstream_error' } });
  }

  function health() {
    const pool = eligibleAccounts();
    const rows = usageRows();
    const bal = pool.reduce((s, a) => s + (displayedBalance(a, rows) ?? 0), 0);
    return {
      eligible_keys: pool.length, drained_keys: exhausted.size,
      display_balance_usd: Math.round(bal * 10000) / 10000, faces: [...faces],
      ledger: { state: ledgerState, suspect_keys: ledgerSuspect.size },
      models_cached: staticModels ? staticModels.length : modelsCache ? modelsCache.length : null,
    };
  }

  /** Drop the cached upstream catalog (manual refresh path). */
  function clearModelsCache() {
    modelsCache = null;
    modelsCacheAt = 0;
  }

  return {
    id, base, borrow,
    handleChat, handleResponses, handleMessages, handleModels, models, clearModelsCache, health,
    faces: [...faces],
    staticCatalog: !!staticModels,
    state: { exhausted, affinity, lastUsed },
  };
}
