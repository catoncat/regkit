#!/usr/bin/env node
// 薄接线:把 protocol 的余额刷新/补货命令接进 regkit 的 watch 引擎。
// 新上游只需改 protocol.mjs + config.local.mjs,本文件通常不用动。

import { runWatch } from 'regkit/watch';
import { makeConfigLoader } from 'regkit/config';
import { createLogger } from 'regkit/logger';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DEFAULTS } from './config.local.mjs';
import * as proto from './protocol.mjs';
import { createGateway } from './gateway.mjs';

const cfg = makeConfigLoader(ROOT, DEFAULTS)({});
const log = createLogger({ eventsFile: cfg.eventsFile, level: 'info' });

await runWatch({
  root: ROOT,
  cfg,
  eventsFile: cfg.eventsFile,
  accountsFile: cfg.accountsFile,
  usageFile: cfg.usageFile,

  targetUsd: cfg.targetUsd,
  windowMin: cfg.windowMin,
  gatewayPort: cfg.gatewayPort,
  supplyCheckSec: cfg.supplyCheckSec,
  balanceRotateSec: cfg.balanceRotateSec,
  supplyWorkers: cfg.supplyWorkers,
  supplyMaxBatch: cfg.supplyMaxBatch,
  perAccountUsd: cfg.perAccountUsd,

  once: process.argv.includes('--once') || process.env.WATCH_ONCE === '1',

  emit: (name, fields) => log.event(name, fields),

  // 余额轮转:重新登录 -> 读权威 billing -> 返回合并后的记录(带 checked_at)
  refreshBalance: async (account) => {
    const sess = await proto.login(cfg, log, { email: account.email, password: account.password });
    const b = await proto.fetchBilling(cfg, log, sess.access_token);
    const bal = Number(b.balance_usd);
    return {
      ...account,
      balance_usd: Number.isFinite(bal) ? bal : account.balance_usd,
      available_usd: b.available_usd ?? account.available_usd ?? null,
      checked_at: new Date().toISOString(),
    };
  },

  // 补货:spawn 一个批量注册子进程,返回 ChildProcess
  spawnBatch: (need, workers) =>
    spawn(process.execPath, [
      join(ROOT, 'src', 'cli.mjs'), 'register',
      '--count', String(need), '--workers', String(workers), '--probe',
    ], { cwd: ROOT, stdio: 'ignore' }),

  // 网关默认不在这里起:fleet 网关从同一批文件服务这个池。要单独调试才开。
  createGateway,
  embedGateway: process.env.EX_EMBED_GATEWAY === '1',
});
