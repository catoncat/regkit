// ★ PROTOCOL LAYER — the only file you must write for a new upstream.
//
// This file is a worked example against a fictional upstream (api.example.com).
// To wire a real upstream, replace the bodies with that upstream's measured
// protocol: endpoint shapes, failure semantics, mail extractor, pricing, probe.

import { jsonCall, probe as probeHttp } from 'regkit/http';
import { makeCodeExtractor } from 'regkit/mailbox';

// ── 1. gateway wiring ─────────────────────────────────────────
export const gateway = {
  // OpenAI-compatible inference base (the gateway appends /chat/completions)
  upstreamBase: 'https://api.example.com/v1',

  // $/1M input+output, env-overridable (<UPSTREAM>_PRICE_IN/_PRICE_OUT)
  rates(model, env = process.env) {
    return {
      in: Number(env.EX_PRICE_IN) || 0.15,
      out: Number(env.EX_PRICE_OUT) || 0.35,
    };
  },

  // Upstream failure → rotation decision.
  //   'balance'         retire the key permanently (402 = credit gone)
  //   'model_mismatch'  rotate WITHOUT retiring (key scoped to another model)
  //   'concurrency'     brief backoff then rotate (429)
  //   'network'         backoff then rotate (5xx / transport)
  //   'client'          genuine client error — pass through untouched
  classifyFailure(status, codeText = '') {
    if (status === 402) return 'balance';
    if (status === 404) return 'model_mismatch';
    if (status === 429) return 'concurrency';
    if (status >= 500 || status === 0) return 'network';
    return 'client';
  },

  poolName: 'example',
  gatewayTokenEnv: 'EX_GATEWAY_KEY',
};

// ── 2. mail extractor ─────────────────────────────────────────
// The verification code arrives from no-reply@example.com with a subject
// containing "verification code"; the body carries a 6-digit code.
export const mailExtract = makeCodeExtractor({
  senderSuffix: 'example.com',
  subjectRe: /verification code/i,
});

// ── 3. protocol steps ─────────────────────────────────────────

/** POST verification-code -> { verification_id, expires_in } (600s measured). */
export function requestCode(cfg, log, { companyName, name, email, password }) {
  return jsonCall({
    base: cfg.siteOrigin + cfg.apiPrefix,
    path: '/auth/verification-code',
    name: 'verification-code',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: companyName, name, email, password }),
    log,
  });
}

/** POST register { verification_id, verification_code } -> session + api key
 *  in one response (no separate claim step). */
export function submitRegistration(cfg, log, { verificationId, code }) {
  return jsonCall({
    base: cfg.siteOrigin + cfg.apiPrefix,
    path: '/auth/register',
    name: 'register',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verification_id: verificationId, verification_code: code }),
    log,
  });
}

/** POST login -> same session shape as register. */
export function login(cfg, log, { email, password }) {
  return jsonCall({
    base: cfg.siteOrigin + cfg.apiPrefix,
    path: '/auth/login',
    name: 'login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    log,
  });
}

/** GET billing -> authoritative balance. Money only counts here. */
export function fetchBilling(cfg, log, accessToken) {
  return jsonCall({
    base: cfg.siteOrigin + cfg.apiPrefix,
    path: '/billing',
    name: 'billing',
    headers: { Authorization: `Bearer ${accessToken}` },
    log,
  });
}

/** End-to-end inference probe — the only proof that a key is usable. */
export function probeKey(cfg, log, apiKey) {
  return probeHttp({
    url: cfg.siteOrigin + '/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: cfg.probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    log,
    name: 'probe',
  });
}
