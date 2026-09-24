// Mailbox domain resolution. Two sources:
//   1. cfg.fixedPool (comma-separated in env/.env.local) — used as-is.
//   2. Live discovery via `<mailboxCli> domains list` (enabled entries only).
// Round-robin with a per-process cursor so a batch spreads across the pool.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function loadDomains(cfg) {
  if (cfg.fixedPool && cfg.fixedPool.length) return [...cfg.fixedPool];
  const { stdout } = await execFileAsync(cfg.mailboxCli || 'cloud-mail', ['domains', 'list'], {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const data = JSON.parse(stdout);
  const items = data.items || [];
  const enabled = items.filter((d) => d.enabled === 1 || d.enabled === true).map((d) => d.domain);
  if (!enabled.length) throw new Error(`no enabled mailbox domains found by ${cfg.mailboxCli || 'cloud-mail'}`);
  return enabled;
}

/** Spread local parts across domains round-robin. */
export function makeDomainPicker(domains) {
  let i = Math.floor(Math.random() * domains.length);
  return function next() {
    const d = domains[i % domains.length];
    i++;
    return d;
  };
}
