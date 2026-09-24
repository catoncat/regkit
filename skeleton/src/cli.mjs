#!/usr/bin/env node
// CLI 入口:register / accounts / probe / balance / gateway / watch
// 接线层——通用逻辑全部来自 regkit,这里只有上游字段名与命令组合。

import { makeConfigLoader } from 'regkit/config';
import { createLogger } from 'regkit/logger';
import { createSignupPacer } from 'regkit/pacer';
import { loadDomains, makeDomainPicker } from 'regkit/domains';
import { appendAccount, printAccount, loadSeenEmails, readAccounts } from 'regkit/accounts';
import { join } from 'node:path';
import { ROOT, DEFAULTS } from './config.local.mjs';
import { registerOne, makeIdentity } from './register.mjs';
import * as proto from './protocol.mjs';

/** Accepts any of the given flag spellings: arg('--count', '-c', '5'). */
function arg(...namesAndDef) {
  const def = namesAndDef.pop();
  for (const name of namesAndDef) {
    const i = process.argv.indexOf(name);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  }
  return def;
}
function flag(name) { return process.argv.includes(name); }

function usage() {
  console.log('usage: node src/cli.mjs <register|accounts|probe|balance|gateway|watch> [options]');
  process.exit(flag('--help') ? 0 : 2);
}

const cmd = process.argv[2];
if (!cmd || flag('--help')) usage();

const cfg = makeConfigLoader(ROOT, DEFAULTS)({
  accountsFile: arg('--accounts', '-a', ''),
});
const log = createLogger({
  eventsFile: arg('--events', '', '') || cfg.eventsFile,
  level: 'info',
  quiet: false,
});
if (flag('--verbose') || flag('-V')) log.setVerbose();

function readAllAccounts() {
  // Canonical latest-wins reader (regkit/accounts). The old version parsed every
  // raw line, so any account with more than one line counted twice — balance and
  // counts silently doubled after a re-check.
  return readAccounts(cfg.accountsFile);
}

if (cmd === 'register') {
  const count = Number(arg('--count', '-c', String(cfg.count)));
  const workers = Number(arg('--workers', '-w', String(cfg.workers)));
  const domain = arg('--domain', '-d', '');
  const doProbe = flag('--probe');
  const reuseIdentities = !flag('--fresh');

  const domains = domain ? [domain] : await loadDomains(cfg);
  const pickDomain = makeDomainPicker(domains);
  const seen = reuseIdentities ? loadSeenEmails(cfg.accountsFile) : new Set();
  const usedLocal = new Set();

  const pacer = createSignupPacer({
    minGapMs: cfg.signupMinGapMs,
    startGapMs: cfg.signupStartGapMs,
    maxGapMs: cfg.signupMaxGapMs,
    log: (m) => log.info(m),
  });

  log.event('batch.start', { count, workers, domains: domains.length, domain: domain || null, probe: doProbe });
  log.info(`batch: ${count} account(s), workers=${workers}, domains=${domains.length}${domain ? ` (fixed ${domain})` : ''}, probe=${doProbe}`);

  let next = 0;
  let okCount = 0;
  let failCount = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const id = makeIdentity(usedLocal);
      while (seen.has(`${id.localPart}@`)) id.localPart += Math.floor(Math.random() * 90 + 10);
      const email = `${id.localPart}@${pickDomain()}`;
      seen.add(email);
      // Persist identity BEFORE touching upstream: any crash mid-flow must
      // never orphan an account that already exists on the other side.
      const base = {
        seq: i + 1, email, password: id.password,
        company_name: id.companyName, name: id.fullName,
        created_at: new Date().toISOString(), status: 'pending',
      };
      let persisted = false;
      try {
        appendAccount(cfg.accountsFile, base);
        persisted = true;
        const rec = await registerOne(cfg, log, {
          email, password: id.password,
          companyName: id.companyName, fullName: id.fullName,
          pacer, probe: doProbe,
        });
        rec.seq = i + 1;
        appendAccount(cfg.accountsFile, rec);
        printAccount({ seq: rec.seq, status: rec.status, email: rec.email, balance_usd: rec.balance_usd ?? null, api_key_hint: rec.api_key ? rec.api_key.slice(0, 12) + '…' : null });
        if (rec.status === 'verified') okCount++;
        else failCount++;
      } catch (err) {
        failCount++;
        log.error(`unexpected error on ${email}: ${err.message}`);
        log.event('reg.crash', { email, error: String(err?.stack || err).slice(0, 500), persisted });
        if (persisted) {
          try {
            appendAccount(cfg.accountsFile, { ...base, status: 'failed', note: String(err?.message || err).slice(0, 200) });
          } catch { /* disk-level failure; pending record already on file */ }
        }
      }
      if (i + 1 < count && cfg.delayMs > 0) await new Promise((r) => setTimeout(r, cfg.delayMs));
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, workers) }, worker));
  log.event('batch.done', { ok: okCount, failed: failCount, gap_ms: pacer.gapMs });
  log.info(`done: ${okCount} verified, ${failCount} failed -> ${cfg.accountsFile}`);
  process.exit(okCount > 0 ? 0 : 1);
}

if (cmd === 'accounts') {
  const want = arg('--status', '', '');
  const recs = readAllAccounts().filter((r) => !want || r.status === want);
  if (flag('--json')) {
    console.log(JSON.stringify(recs, null, 2));
  } else {
    const byStatus = {};
    for (const r of recs) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const bal = recs.filter((r) => typeof r.balance_usd === 'number').reduce((s, r) => s + r.balance_usd, 0);
    console.log(`total ${recs.length}`, JSON.stringify(byStatus), `balance $${bal.toFixed(2)}`);
  }
  process.exit(0);
}

if (cmd === 'probe') {
  const limit = Number(arg('--limit', '-n', '5'));
  const recs = readAccounts(cfg.accountsFile)
    .filter((r) => r.status === 'verified' && r.api_key)
    .slice(-limit);
  for (const r of recs) {
    const pr = await proto.probeKey(cfg, log, r.api_key);
    console.log(JSON.stringify({ email: r.email, ok: pr.ok, status: pr.status, model: pr.model, latency_ms: pr.latency_ms, error: pr.error }));
  }
  process.exit(0);
}

if (cmd === 'balance') {
  const bal = readAllAccounts().filter((r) => typeof r.balance_usd === 'number').reduce((s, r) => s + r.balance_usd, 0);
  console.log(`$${bal.toFixed(2)}`);
  process.exit(0);
}

if (cmd === 'gateway') {
  const { createGateway } = await import('./gateway.mjs');
  const port = Number(arg('--port', '-p', String(cfg.gatewayPort)));
  const host = arg('--host', '', '127.0.0.1');
  const gw = createGateway({ cfg, log, usagePath: cfg.usageFile });
  await new Promise((resolve, reject) => {
    gw.server.once('error', reject);
    gw.server.listen(port, host, resolve);
  });
  log.event('gateway.start', { port, host });
  console.log(`gateway listening on http://${host}:${port}/v1`);
} else if (cmd === 'watch') {
  await import('./watch.mjs');
} else {
  usage();
}
