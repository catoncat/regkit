#!/usr/bin/env node
// fleet — thin shell over fleet.mjs.
//
//   fleet                        TUI(两视图)
//   fleet ls [--all]             一帧文本面板(--all 含 dead)
//   fleet status --json          全量 JSON(agent 用)
//   fleet health <id>            单项目:status + health.json
//   fleet probe                  走网关真实调一次每个池(判活)
//   fleet adopt <dir> [--dry-run]
//   fleet set-mode <id> auto|off [--dry-run]
//   fleet recover <id>           halted → 恢复(用户一键)
//   fleet sunset <id>            落日:停注册,余额照用
//   fleet retire <id>            退役:归档,退出日常视野
//   fleet refresh-catalog [id]   手动让网关重拉模型目录
//   fleet patrol [--dry-run|--install]
//   fleet tick [--install [--interval N]]   联动检测跑一轮(默认装成 5 分钟 launchd 间隔任务)
//   fleet doctor               对账:期望态 vs launchd vs 进程 vs 端口,只报告不动手
//   fleet gateway --install    把 fleet 网关安装到 launchd

import {
  status, adopt, setMode, bootstrapUnit, bootoutUnit, renderPlist, labelFor,
  plistPathFor, probeFleet, probePort, recover, sunset, retire, projectHealth, refreshCatalog,
  tick, doctor,
} from './fleet.mjs';
import { runFleetTui, renderProjects, sortByAttention } from './fleet-tui.mjs';
import { runFleetPatrol } from './patrol.mjs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// flags with values vs boolean switches — the old positional filter dropped
// any arg string-equal to a flag value; this parser does not have that bug.
const VALUE_FLAGS = new Set(['roots', 'fleet-file', 'interval']);
const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k)) flags[k] = args[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const verb = pos[0] ?? 'tui';
const roots = flags.roots ? flags.roots.split(',') : undefined;
const fleetFile = flags['fleet-file'] ?? undefined;
const dryRun = flags['dry-run'] === true;
const out = (x) => console.log(JSON.stringify(x, null, 2));

/**
 * Install one fleet-owned launchd job under the repo: resident (gateway, KeepAlive)
 * when intervalSec is null, else an interval task (tick / patrol). One code path for
 * the three `--install` verbs; bootstrapUnit boots any previous copy out first.
 */
async function installFleetJob({ id, script, verb = null, intervalSec = null }) {
  const cmd = process.execPath + ' ' + join(REPO_ROOT, 'src', script) + (verb ? ' ' + verb : '');
  const label = labelFor(id);
  const plist = renderPlist({
    label, cmd, cwd: REPO_ROOT, logPath: join(REPO_ROOT, 'data', 'fleet-' + id + '.log'),
    keepAlive: intervalSec == null, intervalSec, env: { PATH: process.env.PATH || '' },
  });
  const plistPath = plistPathFor(id);
  if (dryRun) return { dry_run: true, plist_path: plistPath, plist };
  writeFileSync(plistPath, plist, { mode: 0o644 });
  await bootstrapUnit({ id, plistPath });
  return { installed: true, label, plist_path: plistPath };
}

try {
  if (verb === 'tui') {
    await runFleetTui({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}), once: flags.once === true });
  } else if (verb === 'status') {
    out(await status({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) }));
  } else if (verb === 'ls') {
    const st = await status({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) });
    const units = sortByAttention(flags.all ? st.units : st.units.filter((u) => u.effective_lifecycle !== 'dead'));
    const up = await probePort(st.gateway.port).catch(() => false);
    console.log(renderProjects({ units, orphans: st.orphans, gateway: { port: st.gateway.port, up }, selected: -1, tty: false }).join('\n'));
  } else if (verb === 'health') {
    out(await projectHealth({ id: pos[1], ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) }));
  } else if (verb === 'probe') {
    out(await probeFleet({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) }));
  } else if (verb === 'adopt') {
    if (!pos[1]) throw new Error('usage: fleet adopt <unitDir> [--dry-run]');
    const plan = await adopt({ unitDir: pos[1], dryRun, ...(fleetFile ? { fleetFile } : {}) });
    if (!dryRun) await bootstrapUnit({ id: plan.id, plistPath: plan.plist_path }).catch(() => {});
    out(plan);
  } else if (verb === 'set-mode') {
    const [id, mode] = [pos[1], pos[2]];
    if (!id || !mode) throw new Error('usage: fleet set-mode <id> <auto|off> [--dry-run]');
    const r = await setMode({ id, mode, dryRun, ...(fleetFile ? { fleetFile } : {}) });
    if (!dryRun && r.action === 'bootout') await bootoutUnit({ id });
    if (!dryRun && r.action === 'bootstrap') await bootstrapUnit({ id });
    out(r);
  } else if (verb === 'recover') {
    out(await recover({ id: pos[1], ...(roots ? { roots } : {}) }));
  } else if (verb === 'sunset' || verb === 'retire') {
    const fn = verb === 'sunset' ? sunset : retire;
    const r = await fn({ id: pos[1], ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) });
    if (r.mode?.action === 'bootout') await bootoutUnit({ id: pos[1] });
    out(r);
  } else if (verb === 'refresh-catalog') {
    out(await refreshCatalog({ id: pos[1] ?? null, ...(fleetFile ? { fleetFile } : {}) }));
  } else if (verb === 'patrol') {
    if (flags.install) out(await installFleetJob({ id: 'patrol', script: 'fleet-cli.mjs', verb: 'patrol', intervalSec: Number(flags.interval || 86400) }));
    else out(await runFleetPatrol({ ...(roots ? { roots } : {}), dryRun }));
  } else if (verb === 'tick') {
    if (flags.install) out(await installFleetJob({ id: 'tick', script: 'fleet-cli.mjs', verb: 'tick', intervalSec: Number(flags.interval || 300) }));
    else out(await tick({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) }));
  } else if (verb === 'doctor') {
    const r = await doctor({ ...(roots ? { roots } : {}), ...(fleetFile ? { fleetFile } : {}) });
    out(r);
    if (!r.ok) process.exit(1);
  } else if (verb === 'gateway') {
    if (!flags.install) throw new Error('usage: fleet gateway --install (常驻走 launchd;前台调试: node src/fleet-gateway.mjs)');
    out(await installFleetJob({ id: 'gateway', script: 'fleet-gateway.mjs' }));
  } else {
    console.error('unknown verb: ' + verb + ' (tui/ls/status/health/probe/adopt/set-mode/recover/sunset/retire/refresh-catalog/patrol/tick/doctor/gateway)');
    process.exit(2);
  }
} catch (err) {
  console.error(JSON.stringify({ error: String(err?.message || err) }));
  process.exit(1);
}
