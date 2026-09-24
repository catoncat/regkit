// Timed + event-logged fetch wrapper. Every call emits an `http` event for
// EVERY outcome (success included — absence of traffic is itself diagnostic).
// On non-2xx the upstream body snippet goes into both the event and the
// thrown ApiError — new protection modes announce themselves in that text.
//
// klass enum: ok / rate_fast(429) / forbidden(403) / http / server_error(5xx)
//             / transport(0) / unknown

export const KLASS = Object.freeze({
  RATE_FAST: 'rate_fast',
  FORBIDDEN: 'forbidden',
  TRANSPORT: 'transport',
  SERVER: 'server_error',
  HTTP: 'http',
  OK: 'ok',
});

export function classifyStatus(status) {
  if (status === 429) return KLASS.RATE_FAST;
  if (status === 403) return KLASS.FORBIDDEN;
  if (status === 0) return KLASS.TRANSPORT;
  if (status >= 500) return KLASS.SERVER;
  return KLASS.HTTP;
}

export class ApiError extends Error {
  constructor(message, { status, detail, klass } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.detail = detail;
    this.klass = klass || classifyStatus(status);
  }
}

/** Flatten a FastAPI-style 422 detail array into "field: msg" lines. */
export function describeDetail(detail) {
  if (!Array.isArray(detail)) return typeof detail === 'string' ? detail : '';
  return detail.map((d) => `${(d.loc || []).slice(-1)[0] || '?'}: ${d.msg}`).join('; ');
}

/**
 * Timed + logged JSON fetch against `base + path`.
 *
 * @param opts { base, path, name, method, headers, body, log, timeoutMs }
 * @returns parsed JSON body on 2xx
 * @throws ApiError on transport error or non-2xx
 */
export async function jsonCall({ base, path, name, method = 'GET', headers = {}, body, log, timeoutMs = 60000 }) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = String(err?.message || err).split('\n')[0].slice(0, 200);
    log?.event('http', { name, method, path, status: 0, klass: KLASS.TRANSPORT, ms, detail: msg });
    throw new ApiError(`transport: ${msg}`, { status: 0, klass: KLASS.TRANSPORT });
  }
  const ms = Date.now() - t0;
  const text = await res.text();

  if (res.ok) {
    log?.event('http', { name, method, path, status: res.status, klass: KLASS.OK, ms });
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(`non-JSON response (http ${res.status}): ${text.slice(0, 160)}`, { status: res.status });
    }
  }

  // Non-2xx: capture the upstream body verbatim-ish. This is where new walls
  // (rate buckets, WAF pages, new validation rules) show up first.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* raw snippet is itself evidence */ }
  const snippet = text.slice(0, 300);
  const klass = classifyStatus(res.status);
  const msg = describeDetail(parsed?.detail) || snippet.slice(0, 120) || `http ${res.status}`;
  log?.event('http', { name, method, path, status: res.status, klass, ms, detail: snippet });
  throw new ApiError(`${name} rejected (http ${res.status}): ${msg}`, { status: res.status, detail: parsed?.detail, klass });
}

/** Raw probe that never throws — the only proof that matters for a key.
 *  `logPath` overrides the path recorded in the http event (defaults to url). */
export async function probe({ url, method = 'POST', headers = {}, body, log, name = 'probe', timeoutMs = 30000, logPath = null }) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t0;
    const text = await res.text();
    const p = logPath || url;
    if (res.ok) {
      let model = null;
      try { model = JSON.parse(text).model; } catch { /* non-JSON ok */ }
      log?.event('http', { name, method, path: p, status: res.status, klass: KLASS.OK, ms, model });
      return { ok: true, status: res.status, model, latency_ms: ms };
    }
    log?.event('http', { name, method, path: p, status: res.status, klass: classifyStatus(res.status), ms, detail: text.slice(0, 300) });
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  } catch (err) {
    log?.event('http', { name, method, path: logPath || url, status: 0, klass: KLASS.TRANSPORT, ms: Date.now() - t0, detail: String(err?.message || err).slice(0, 200) });
    return { ok: false, status: 0, error: String(err?.message || err).slice(0, 200) };
  }
}
