// ★ Upstream config defaults. The generic machinery (regkit) reads only
// mailboxCli etc.; everything else is this upstream's own <UPSTREAM>_* prefix.

import { splitList, projectRoot } from 'regkit/config';

export const ROOT = projectRoot(import.meta.url);

// defaults: value | (env, root) => value
export const DEFAULTS = {
  siteOrigin: (env) => env.EX_SITE_ORIGIN || 'https://api.example.com',
  apiPrefix: (env) => env.EX_API_PREFIX || '/api/v1',
  mailboxCli: (env) => env.MAILBOX_CLI || 'cloud-mail',

  count: (env) => Number(env.EX_COUNT || 1),
  workers: (env) => Number(env.EX_WORKERS || 1),
  delayMs: (env) => Number(env.EX_DELAY_MS || 1500),

  mailTimeout: (env) => Number(env.EX_MAIL_TIMEOUT || 120),
  mailPollInterval: (env) => Number(env.EX_MAIL_POLL_INTERVAL || 3),

  accountsFile: (env) => env.EX_ACCOUNTS_FILE || 'data/accounts.jsonl',
  eventsFile: (env) => env.EX_EVENTS || 'data/events.jsonl',
  usageFile: (env) => env.EX_USAGE_FILE || 'data/usage.jsonl',

  signupMinGapMs: (env) => Number(env.EX_SIGNUP_MIN_GAP_MS || 3000),
  signupStartGapMs: (env) => Number(env.EX_SIGNUP_START_GAP_MS || 10000),
  signupMaxGapMs: (env) => Number(env.EX_SIGNUP_MAX_GAP_MS || 120000),

  fixedPool: (env) => splitList(env.EX_FIXED_POOL),
  probeModel: (env) => env.EX_PROBE_MODEL || 'example-small',

  // gateway / watch
  gatewayPort: (env) => Number(env.EX_GATEWAY_PORT || 48787),   // 仅调试网关用(EX_EMBED_GATEWAY=1);正常由 fleet 网关服务
  gatewayKey: (env) => env.EX_GATEWAY_KEY || '',
  targetUsd: (env) => Number(env.EX_TARGET_USD || 1000),
  supplyWorkers: (env) => Number(env.EX_SUPPLY_WORKERS || 8),
  supplyMaxBatch: () => 24,
  perAccountUsd: () => 5,
  balanceRotateSec: (env) => Number(env.EX_BALANCE_ROTATE_S || 300),
  supplyCheckSec: (env) => Number(env.EX_SUPPLY_CHECK_S || 30),
  windowMin: () => 10,
};
