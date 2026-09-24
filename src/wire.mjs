// wire.mjs — pure request/response shaping for the OpenAI/Anthropic passthrough.
// No I/O, no pool state: everything here is a function of a body buffer, a
// header map or a usage object, so it is unit-testable without a server.
//
//   dialect: applyInjectFields (any face),
//     applyChatDialect (rewriteRoles / ensureAssistantFields, chat face only),
//     stripFields (declared 400 degradation), injectIncludeUsage
//   money: extractUsage / normalizeUsage / estimateCostUsd / estimateTokensLocal
//   headers: upstreamHeaders (never forwards the client UA), authHeadersFor,
//     responseHeaders (hop-by-hop stripped), DEFAULT_UPSTREAM_UA
//   misc: conversationId (affinity key), sendJson, errorText, resolveBlocklist
//
// pool.mjs re-exports this whole surface, so 'regkit/pool' / 'regkit/gateway'
// importers are unaffected by the split.

import { createHash } from 'node:crypto';

/** USD cost from an OpenAI usage object at local rates; 8dp ledger precision, >= 0. */
export function estimateCostUsd(rates, usage) {
  if (!usage) return 0;
  const pin = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const pout = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const usd = (pin * rates.in + pout * rates.out) / 1e6;
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 100000000) / 100000000;
}

/** Stable id for the immutable prompt head so one conversation keeps one key. */
export function conversationId(bodyBuf) {
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    if (!j || typeof j !== 'object') return null;
    const head = [j.system, Array.isArray(j.messages) ? j.messages[0] : null]
      .filter((p) => p != null)
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(String.fromCharCode(0));
    if (!head) return null;
    return createHash('sha256').update(head).digest('hex').slice(0, 16);
  } catch { return null; }
}

/** Pull usage from a buffered non-stream JSON or SSE body.
 *  Shapes: OpenAI chat (j.usage), Anthropic stream (message.usage on
 *  message_start / usage on message_delta), Responses stream (response.usage). */
export function extractUsage(raw, streaming) {
  if (!raw) return null;
  if (!streaming) {
    try { return JSON.parse(raw).usage || null; } catch { return null; }
  }
  let usage = null;
  for (const line of raw.split(String.fromCharCode(10))) {
    if (!line.startsWith('data:')) continue;
    const data = line.replace(/^data:\s?/, '').trim();
    if (!data || data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      const eventUsage = j.usage || j.message?.usage || j.response?.usage;
      if (eventUsage) usage = { ...(usage || {}), ...eventUsage };
    } catch { /* partial chunk */ }
  }
  return usage;
}

/** Normalize any face's usage to the ledger shape (prompt/completion/cached). */
export function normalizeUsage(usage, face = 'chat') {
  if (!usage) return null;
  if (face === 'chat') return usage;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? 0,
  ) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached };
}

/** Additive-only: ask the upstream to include usage in the final SSE chunk. */
export function injectIncludeUsage(bodyBuf) {
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    if (!j || typeof j !== 'object' || !j.stream || j.stream_options?.include_usage) return bodyBuf;
    j.stream_options = { ...(j.stream_options || {}), include_usage: true };
    return Buffer.from(JSON.stringify(j), 'utf8');
  } catch { return bodyBuf; }
}

/** Dialect level 2a: set declared top-level fields only when absent (any face). */
export function applyInjectFields(bodyBuf, fields) {
  if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) return bodyBuf;
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return bodyBuf;
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (j[k] === undefined) { j[k] = v; changed = true; }
    }
    return changed ? Buffer.from(JSON.stringify(j), 'utf8') : bodyBuf;
  } catch { return bodyBuf; }
}

/** Dialect level 2b: chat-face message-shape rules (rewriteRoles, ensureAssistantFields). */
export function applyChatDialect(bodyBuf, dialect = {}) {
  const { rewriteRoles, ensureAssistantFields } = dialect;
  const hasRoles = rewriteRoles && typeof rewriteRoles === 'object' && Object.keys(rewriteRoles).length;
  const hasAssistant = ensureAssistantFields && typeof ensureAssistantFields === 'object' && Object.keys(ensureAssistantFields).length;
  if (!hasRoles && !hasAssistant) return bodyBuf;
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    if (!j || typeof j !== 'object' || !Array.isArray(j.messages)) return bodyBuf;
    let changed = false;
    for (const m of j.messages) {
      if (!m || typeof m !== 'object') continue;
      if (hasRoles && rewriteRoles[m.role] !== undefined) { m.role = rewriteRoles[m.role]; changed = true; }
      if (hasAssistant && m.role === 'assistant') {
        for (const [k, v] of Object.entries(ensureAssistantFields)) {
          if (m[k] === undefined) { m[k] = v; changed = true; }
        }
      }
    }
    return changed ? Buffer.from(JSON.stringify(j), 'utf8') : bodyBuf;
  } catch { return bodyBuf; }
}

/** Dialect level 2c: declared 400 degradation — drop listed fields, retry once. */
export function stripFields(bodyBuf, fields) {
  try {
    const txt = bodyBuf.toString('utf8');
    if (!fields.some((f) => txt.includes('"' + f + '"'))) return null;
    const j = JSON.parse(txt);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    for (const f of fields) delete j[f];
    return Buffer.from(JSON.stringify(j), 'utf8');
  } catch { return null; }
}

/** Local token estimate for messages/count_tokens when the upstream stalls.
 *  Budget estimate, not billing: ASCII ≈ 4 chars/token, CJK ≈ 1. */
export function estimateTokensLocal(bodyBuf) {
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    const parts = [j.system, ...(Array.isArray(j.messages) ? j.messages : [])].map((m) => {
      if (m == null) return '';
      if (typeof m === 'string') return m;
      const c = m?.content;
      return typeof c === 'string' ? c : JSON.stringify(c ?? '');
    });
    const text = parts.join(' ');
    let ascii = 0;
    let cjk = 0;
    for (const ch of text) {
      if (ch.codePointAt(0) > 0x2e80) cjk += 1;
      else ascii += 1;
    }
    return Math.max(1, Math.ceil(ascii / 4) + cjk);
  } catch { return 0; }
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Default UA we present to upstreams. Several upstreams sit behind
 *  Cloudflare/bot filters that reject unusual client UA strings, so the
 *  gateway MUST NOT forward the client's UA verbatim. Per-pool override. */
export const DEFAULT_UPSTREAM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) regkit-gateway/1.0';

/** Auth headers for one upstream flavour:
 *    'bearer' (default) | 'x-api-key' | 'apikey' (double header).
 *  `authScheme` overrides the bearer prefix. */
export function authHeadersFor(provider, key) {
  const header = provider.authHeader || 'bearer';
  if (header === 'x-api-key') return { 'x-api-key': key };
  if (header === 'apikey') return { apikey: key, authorization: 'Bearer ' + key };
  const scheme = provider.authScheme === undefined ? 'Bearer ' : provider.authScheme;
  return { authorization: scheme + key };
}

export function upstreamHeaders(req, key, provider = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    // Client credentials (the gateway token in any of its spellings) never travel
    // upstream; the pool key is set below in the upstream's own auth flavour.
    if (value == null || HOP.has(lower) || lower === 'host' || lower === 'content-length'
      || lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key' || lower === 'user-agent') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('user-agent', provider.userAgent || DEFAULT_UPSTREAM_UA);
  for (const [k, v] of Object.entries(authHeadersFor(provider, key))) headers.set(k, v);
  return headers;
}

/** Extra declared static headers (e.g. an upstream that requires fixed x-client-* headers). */
export function applyExtraHeaders(headers, extra) {
  if (!extra || typeof extra !== 'object') return;
  for (const [k, v] of Object.entries(extra)) headers.set(k, String(v));
}

export function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP.has(lower) || lower === 'content-length' || lower === 'content-encoding') continue;
    headers[name] = value;
  }
  return headers;
}

export function sendJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

/** Best-effort error text out of OpenAI/Anthropic failure bodies. */
export function errorText(failureBody) {
  try {
    const e = JSON.parse(failureBody.toString('utf8'))?.error;
    if (!e) return '';
    return e.detail || e.message || e.code || e.type || '';
  } catch { return ''; }
}

export function resolveBlocklist(bl) {
  if (!bl) return new Set();
  if (typeof bl === 'function') {
    try { return new Set(bl() || []); } catch { return new Set(); }
  }
  return new Set(Array.isArray(bl) ? bl : []);
}

