// 编排层:按协议事实把 regkit 积木串起来。每个上游的 step 顺序不同
// (本例: 发码→收码→开户即返 key→billing;有的上游还多一步 claim),
// 所以这一步留在项目里,但它只是薄接线。

import { Mailbox } from 'regkit/mailbox';
import { nullPacer } from 'regkit/pacer';
import { poolPassword } from 'regkit/names';
import { ROOT } from './config.local.mjs';
import { names } from './words.mjs';
import * as proto from './protocol.mjs';

const keyHint = (k) => (k ? k.slice(0, 12) + '…' : null);

/**
 * Register one account end-to-end. Identity may be provided (retries) or is
 * generated. Never throws for business failures — the returned record carries
 * status='failed' and an error note; only caller-level bugs throw.
 */
export async function registerOne(cfg, log, { email, password, companyName, fullName, pacer = nullPacer(), probe = false } = {}) {
  const mail = new Mailbox({ cli: cfg.mailboxCli });

  const result = {
    email, password, company_name: companyName, name: fullName,
    created_at: new Date().toISOString(), status: 'pending',
  };
  log?.event('reg.start', { email });
  log?.info(`[·] ${email}: requesting verification code`);

  // 1. request the code (serialized by the pacer — shared server bucket).
  await pacer.slot();
  let vdata;
  try {
    vdata = await proto.requestCode(cfg, log, {
      companyName: result.company_name, name: result.name,
      email: result.email, password: result.password,
    });
    pacer.report('ok');
    log?.info(`[+] code requested — verification_id ${String(vdata.verification_id || '').slice(0, 8)}… expires ${vdata.expires_in}s`);
  } catch (err) {
    pacer.report(err.klass || 'other');
    result.status = 'failed';
    result.reject_class = err.klass || 'unknown';
    result.error = err.message;
    log?.event('reg.fail', { email, step: 'verification-code', klass: result.reject_class, error: err.message });
    log?.error(`[!] ${email}: verification-code failed (${result.reject_class}): ${err.message}`);
    return result;
  }

  // 2. wait for the code in the mailbox.
  const tWait = Date.now();
  let code;
  try {
    code = await mail.waitFor(result.email, proto.mailExtract, {
      timeoutMs: cfg.mailTimeout * 1000,
      intervalMs: cfg.mailPollInterval * 1000,
      say: (m) => log.info(m),
    });
  } catch (err) {
    result.status = 'failed';
    result.error = `code-mail timeout after ${cfg.mailTimeout}s`;
    log?.event('code.timeout', { email, timeout_s: cfg.mailTimeout });
    log?.event('reg.fail', { email, step: 'mailbox', klass: 'mail_timeout', error: result.error });
    log?.error(`[!] ${email}: ${result.error}`);
    return result;
  }
  const waitMs = Date.now() - tWait;
  result.code_requested_at = new Date().toISOString();
  log?.event('code.received', { email, wait_ms: waitMs });
  log?.info(`[+] code arrived in ${(waitMs / 1000).toFixed(1)}s`);

  // 3. create the account.
  let session;
  try {
    session = await proto.submitRegistration(cfg, log, { verificationId: vdata.verification_id, code });
  } catch (err) {
    result.status = 'failed';
    result.reject_class = err.klass || 'register_rejected';
    result.error = err.message;
    log?.event('reg.fail', { email, step: 'register', klass: result.reject_class, error: err.message });
    log?.error(`[!] ${email}: register rejected: ${err.message}`);
    return result;
  }

  result.status = 'verified';
  result.user_id = session.user?.id;
  result.company_id = session.company?.id;
  result.role = session.user?.role;
  result.api_key = session.developer_api_key || null;
  result.token_expires_in = session.expires_in;
  log?.info(`[+] ${email}: registered (role=${result.role}, key ${keyHint(result.api_key)})`);

  // 4. authoritative money check — never infer balance from anything else.
  try {
    const billing = await proto.fetchBilling(cfg, log, session.access_token);
    const bal = Number(billing.balance_usd);
    result.balance_usd = Number.isFinite(bal) ? bal : String(billing.balance_usd);
    result.available_usd = Number(billing.available_usd);
    log?.info(`[+] balance $${result.balance_usd} (available $${result.available_usd})`);
  } catch (err) {
    result.note = [result.note, `billing read failed: ${err.message}; balance unverified`].filter(Boolean).join(' | ');
    log?.warn(`[!] billing read failed — recording account WITHOUT asserting balance`);
  }

  // 5. optional end-to-end inference probe.
  if (probe) {
    if (!result.api_key) {
      result.note = [result.note, 'probe skipped: no api_key'].filter(Boolean).join(' | ');
    } else {
      const pr = await proto.probeKey(cfg, log, result.api_key);
      result.probe_ok = pr.ok;
      result.probe_model = pr.model || cfg.probeModel;
      if (pr.ok) log?.info(`[+] inference probe ok (${pr.model}, ${pr.latency_ms}ms)`);
      else {
        result.note = [result.note, `inference probe http ${pr.status}: ${pr.error}`].filter(Boolean).join(' | ');
        log?.warn(`[!] inference probe failed: http ${pr.status}`);
      }
    }
  }

  log?.event('reg.ok', {
    email, user_id: result.user_id, key_hint: keyHint(result.api_key),
    balance_usd: result.balance_usd ?? null, wait_ms: waitMs,
    probe_ok: result.probe_ok ?? null,
  });
  return result;
}

/** Build a fresh identity for one account. */
export function makeIdentity(usedLocalParts) {
  return {
    localPart: names.generateLocalPart(usedLocalParts),
    fullName: names.generateFullName(),
    companyName: names.generateCompanyName(),
    password: poolPassword(ROOT, { envKey: 'EX_POOL_PASSWORD', prefix: 'Ex-' }),
  };
}
