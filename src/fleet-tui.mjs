// fleet-tui.mjs — the fleet panel. Three screens:
// Projects (manage) → Detail (enter) → Models (catalog). Render functions are
// pure and tested; the interactive loop is a thin shell. Character grid only.
//
// The panel answers two independent questions per project, in two columns,
// because they have two independent answers (a sunset registrar whose pool is
// still serving is the normal case, not an edge case):
//   供给  — is it still minting accounts?      (user lifecycle > user switch > system stop > liveness)
//   网关    — is the fleet gateway serving it?    (the hub's own gate decision, never re-derived here)
// plus 余额 (money, right-aligned, with its age and how many accounts have no figure).
// Zero narration: every cell comes from status()/health.json; vocabularies are closed.

import { ansi, paint, termSize, clipLine } from './tui.mjs';
import {
  status, setMode, bootstrapUnit, bootoutUnit, loadFleetLocal, probePort, recover,
  refreshCatalog, projectHealth, DEFAULT_FLEET_FILE,
} from './fleet.mjs';

// ── Closed vocabularies ───────────────────────────────────────────────────

/** Stop-reason / gate-reason codes -> plain Chinese. */
const REASON_ZH = {
  'no-credit': '新号没额度', // 新注册的号是空的;池子里旧余额照用
  'register-broken': '注册失效',
  'pool-broken': '池子坏了',
  'model-delisted': '模型下架',
  'health-unreadable': '健康文件读不透',
  'upstream-flaky': '上游抽风',
  'patrol: mechanism-changed': '判官:机制变了',
};
export const reasonZh = (reason) => REASON_ZH[reason] || reason || '未知';

/** Lifecycle (user axis). ONE mapping for list, detail and models view. */
export const LIFECYCLE_ZH = Object.freeze({ active: '在用', sunset: '落日', dead: '退役' });

/** The four keeper actions -> what the system is doing to this project. */
const ACTION_ZH = { stopRegistrar: '停注册', stopSupply: '停补货', removeModels: '摘模型', haltProject: '停项目' };
export const actionsZh = (actions) => (Array.isArray(actions) && actions.length ? actions.map((a) => ACTION_ZH[a] || a).join(' ') : '');

/** Column widths — the only layout numbers in the file. */
const COL = Object.freeze({ id: 14, registrar: 18, gateway: 20, money: 8 });
const RULE = '─'.repeat(70);

/** Age in plain Chinese: 3 分钟前 / 5 小时前 / 12 天前; null -> 从未. */
export function fmtAge(iso, now = new Date()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '从未';
  const min = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (min < 60) return min + ' 分钟前';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

const alive = (u) => u.state === 'running' || u.state === 'stale';
/** Declared off, yet something (a hand-started loop, another session) still runs it: a drift, not a state. */
const offButRunning = (u) => !u.enabled && (u.alive_by || []).some((s) => s !== 'activity');
const systemStoppedRegistrar = (u) =>
  u.health?.status === 'halted' || (u.health?.status === 'degraded' && (u.health.actions || []).includes('stopRegistrar'));

/**
 * 供给 column. Precedence = who decided: user lifecycle > user switch > the
 * system's stop > what the process table says.
 *   any kind, dead:      退役
 *   registrar/pool-only: 落日·不再注册 | 已关 | 自停:<原因> | 在跑 | 没跑
 *   external:            已关 | 在 | 挂          (fleet only watches it)
 *   harvest:             在跑 | 没跑             (no switch, no pool)
 */
export function registrarLabel(u) {
  if (u.lifecycle === 'dead' || u.effective_lifecycle === 'dead') return '退役';   // any kind: your decision wins
  if (u.kind === 'external') return !u.enabled ? '已关' : alive(u) ? '在' : '挂';
  if (u.kind === 'harvest') return alive(u) ? '在跑' : '没跑';
  if (offButRunning(u)) return '已关·但还在跑';
  if (u.lifecycle === 'sunset') return '落日·不再注册';
  if (!u.enabled) return '已关';
  if (systemStoppedRegistrar(u)) return '自停:' + reasonZh(u.health.reason);
  return alive(u) ? '在跑' : '没跑';
}

/**
 * 网关 column — the serving axis. Sourced from status().gateway, which is the
 * hub's own gateDecision, so panel and gateway can never disagree.
 *   —                  no gateway declared (harvest, most external)
 *   网关挂             the fleet gateway is not listening: nothing serves, whatever health says
 *   已摘:<原因>        health gate excludes this pool (halted / pool-broken / unreadable)
 *   停发 key:账本读不透  admitted, but the pool withholds keys until its ledger reads again
 *   没模型[:原因]      pool is admitted but has nothing left to route (delisted)
 *   在服务 · N 模型
 */
export function gatewayLabel(u, gw = { up: true }) {
  if (!u.gateway) return '—';
  if (gw.up === false) return '网关挂';
  if (u.gateway.gated) return '已摘:' + reasonZh(u.gateway.gate_reason);
  // The pool refuses to issue keys while its ledger cannot be read (unknown spend
  // ≠ zero spend) — admitted by the gate, but nothing is actually served.
  if (u.pool?.ledger === 'unreadable') return '停发 key:账本读不透';
  const n = u.gateway.models;
  if (n === 0) return '没模型' + (u.health?.reason === 'model-delisted' ? ':模型下架' : '');
  return '在服务 · ' + n + ' 模型';
}

/**
 * 余额 column: money right-aligned to COL.money, then its caveats.
 *   —                 no pool
 *   未知·账本读不透   ledger unreadable (gateway has stopped issuing this pool's keys)
 *   未知              accounts exist but none carries a figure
 *   $941.76           fresh
 *   $80.00  5 天前    stale figure — don't trust it fully
 *   $28.35  7 号没数  some verified accounts have no figure
 */
export function balanceCell(u, now = new Date()) {
  const pool = u.pool;
  if (!pool) return '—';
  if (pool.ledger === 'unreadable') return '未知·账本读不透';
  if (!(pool.balance_known > 0)) return (pool.verified ?? 0) > 0 ? '未知' : '—';
  let cell = ('$' + Number(pool.balance).toFixed(2)).padStart(COL.money);
  const days = pool.as_of ? Math.floor((now.getTime() - Date.parse(pool.as_of)) / 86400000) : null;
  if (days != null && days >= 1) cell += '  ' + days + ' 天前';
  const unknown = (pool.verified ?? 0) - (pool.balance_known ?? 0);
  if (unknown > 0) cell += '  ' + unknown + ' 号没数';
  return cell;
}

const registrarColor = (label) =>
  label === '没跑' || label === '挂' ? ansi.red
    : label.startsWith('自停') || label === '已关·但还在跑' ? ansi.yellow
      : label === '在跑' || label === '在' ? ansi.green
        : ansi.gray;                       // 已关 / 落日 / 退役:你自己的决定
const gatewayColor = (label) =>
  label.startsWith('已摘') || label === '网关挂' || label.startsWith('停发') ? ansi.red
    : label.startsWith('没模型') ? ansi.yellow
      : label === '—' ? ansi.gray : null;

/**
 * Attention order — the panel's first job is "今天要我管吗", so rows sort by it:
 *   0 该跑没跑 / 外部挂了                 the only thing that needs you now
 *   1 自停·可恢复                         press r
 *   2 自停 / 已摘 / 降级                  the system is handling it; glance at why
 *   3 已关                                your decision
 *   4 落日 / 退役                         your decision, draining
 *   5 在跑 · 在服务                       nothing to do
 */
export function attentionRank(u) {
  if (offButRunning(u) && u.kind !== 'external') return 2;   // drift: you said off, it is not
  if (u.lifecycle === 'sunset' || u.lifecycle === 'dead' || u.effective_lifecycle === 'dead') return 4;
  if (!u.enabled) return 3;
  if (u.health?.status === 'halted') return u.health.recoverable ? 1 : 2;
  if (u.gateway?.gated || u.pool?.ledger === 'unreadable' || u.health?.status === 'degraded' || u.health?.status === 'unreadable') return 2;
  if (alive(u)) return 5;
  return 0;
}
export const sortByAttention = (units) => [...units].sort((a, b) => attentionRank(a) - attentionRank(b));

/**
 * What to do about the selected row, in one line. Only says something when
 * there IS a next step; running/serving rows get the plain key hints.
 */
export function nextActionHint(u, gw = { up: true }) {
  if (gw.up === false && u.gateway) return '网关挂了,所有模型都调不了:launchctl kickstart -k gui/$(id -u)/com.regkit.fleet.gateway';
  if (u.kind === 'external') return alive(u) || !u.enabled ? null : '外部服务挂了:fleet 只旁观,去它自己的目录看';
  if (u.kind === 'harvest') return alive(u) ? null : '收割器没跑:fleet 只旁观;不要了就 fleet retire ' + u.id;
  if (offButRunning(u)) return '你关了它但还有进程在跑(手起的 watch/loop?) · fleet doctor 看是谁 · 停掉或 space 开回来';
  if (u.lifecycle === 'dead' || u.effective_lifecycle === 'dead') return '已退役,只在 fleet ls --all 里;想复活改它的 service.json lifecycle';
  if (u.lifecycle === 'sunset') return '余额用完自动退役 · 现在就退役:fleet retire ' + u.id;
  if (!u.enabled) return 'space 开回来(会真的注册,花邮箱/出口配额)';
  if (u.health?.status === 'halted') return u.health.recoverable ? 'r 恢复(复探已通)' : '复探还没通 · enter 看证据 · r 强制恢复';
  if (u.gateway?.gated) return '网关已摘这个池 · enter 看证据 · 修好后 tick 自动放回';
  if (u.pool?.ledger === 'unreadable') return '账本读不透,池子停发 key · 看 ' + (u.unit_dir ?? '<项目>') + '/data/usage.jsonl';
  if (u.health?.status === 'degraded' && systemStoppedRegistrar(u)) return '供给自停,余额照用 · 不要了就 fleet sunset ' + u.id;
  if (u.health?.status === 'degraded') return '系统在管(' + reasonZh(u.health.reason) + ') · enter 看证据';
  if (!alive(u)) return 'fleet doctor 看为什么没起来 · space 关再开重拉';
  return null;
}

/** CJK-aware padding: Chinese chars take two terminal columns. */
export const displayWidth = (s) => [...String(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
export const padW = (s, w) => String(s) + ' '.repeat(Math.max(0, w - displayWidth(s)));

/** Latest patrol across units (health.patrol.at), for the header's 巡检 age. */
const latestPatrolAt = (units) =>
  units.map((u) => u.health?.patrol_at).filter(Boolean).sort().pop() ?? null;

const servingModels = (units, gw) => (gw.up === false ? 0 : units.reduce((s, u) => s + (u.gateway && !u.gateway.gated ? u.models_available.length : 0), 0));

// ── Projects view ─────────────────────────────────────────────────────────

/** Projects frame lines (pure). Rows arrive in display order (sortByAttention). */
export function renderProjects({ units, orphans = [], gateway = { port: 0, up: false }, selected = 0, tty = true, action = null, now = new Date() }) {
  const c = (code, s) => paint(tty, code, s);
  const lines = [];
  lines.push(
    c(ansi.bold, 'fleet') + c(ansi.dim, ' · ') + units.length + ' 项目 · ' + servingModels(units, gateway) + ' 模型在服务'
    + c(ansi.dim, ' · 网关 :' + gateway.port + ' ') + (gateway.up ? c(ansi.green, '在') : c(ansi.red, '挂'))
    + c(ansi.dim, ' · 巡检 ' + fmtAge(latestPatrolAt(units), now)),
  );
  lines.push(c(ansi.dim, RULE));
  lines.push(c(ansi.dim, '  ' + padW('项目', COL.id) + padW('供给', COL.registrar) + padW('网关', COL.gateway) + '余额'));
  units.forEach((u, i) => {
    const mark = i === selected ? c(ansi.cyan, '>') : ' ';
    const reg = registrarLabel(u);
    const gw = gatewayLabel(u, gateway);
    const gwc = gatewayColor(gw);
    const recoverable = u.health?.recoverable ? c(ansi.yellow, ' ·可恢复') : '';
    lines.push(mark + ' ' + padW(u.id, COL.id)
      + c(registrarColor(reg), padW(reg, COL.registrar))
      + (gwc ? c(gwc, padW(gw, COL.gateway)) : padW(gw, COL.gateway))
      + balanceCell(u, now) + recoverable);
  });
  if (orphans.length) {
    lines.push(c(ansi.dim, RULE));
    lines.push(c(ansi.yellow, '未收编 ×' + orphans.length) + c(ansi.dim, '  pid ' + orphans[0].pid + ' ' + orphans[0].cmd.slice(0, 44)));
  }
  lines.push(c(ansi.dim, RULE));
  const sel = units[selected];
  if (sel) {
    const hint = nextActionHint(sel, gateway);
    lines.push(hint ? c(ansi.bold, sel.id) + ' ' + registrarLabel(sel) + c(ansi.dim, ' — ') + hint : c(ansi.dim, sel.id + ' 不用管 · space 关 · enter 详情'));
  }
  if (action) lines.push(c(action.ok ? ansi.green : ansi.red, action.text));
  return lines;
}

// ── Models view ───────────────────────────────────────────────────────────

/** Group the catalog by owning project (live gateway catalog, else declared aliases). */
export function groupModels({ units, live = null }) {
  const groups = new Map(); // owner -> { owner, lifecycle, models }
  const lifecycleOf = new Map(units.map((u) => [u.id, u.lifecycle]));
  if (live) {
    for (const m of live) {
      const owner = m.owned_by ?? '?';
      if (!groups.has(owner)) groups.set(owner, { owner, lifecycle: lifecycleOf.get(owner) ?? 'active', models: [] });
      groups.get(owner).models.push(m.id);
    }
  } else {
    for (const u of units) {
      if (!u.models_available.length) continue;
      groups.set(u.id, { owner: u.id, lifecycle: u.lifecycle, models: u.models_available });
    }
  }
  return [...groups.values()];
}

/** Models view: one row per project with a count; enter expands its models. */
export function renderModels({ units, live = null, gateway = { port: 0, up: false }, tty = true, action = null, selected = -1, expanded = null }) {
  const c = (code, s) => paint(tty, code, s);
  const groups = groupModels({ units, live });
  const total = groups.reduce((s, g) => s + g.models.length, 0);
  const lines = [];
  lines.push(
    c(ansi.bold, 'fleet') + c(ansi.dim, ' · 模型 · ') + total + (gateway.up ? ' 个在服务' : ' 个已声明')
    + c(ansi.dim, ' · 网关 :' + gateway.port + ' ') + (gateway.up ? c(ansi.green, '在') : c(ansi.red, '挂') + c(ansi.dim, ' · 以下是声明目录,现在调不了')),
  );
  lines.push(c(ansi.dim, RULE));
  if (!groups.length) lines.push(c(ansi.dim, '  (没有在服务的模型)'));
  groups.forEach((g, i) => {
    const mark = i === selected ? c(ansi.cyan, '>') : ' ';
    const tag = g.lifecycle !== 'active' ? ' · ' + LIFECYCLE_ZH[g.lifecycle] : '';
    lines.push(mark + ' ' + g.owner + c(ansi.dim, ' · ' + g.models.length + ' 个' + tag));
    if (expanded === g.owner) for (const m of g.models) lines.push('    ' + c(ansi.dim, m));
  });
  lines.push(c(ansi.dim, RULE));
  if (action) lines.push(c(action.ok ? ansi.green : ansi.red, action.text));
  return lines;
}

// ── Detail view ───────────────────────────────────────────────────────────

/**
 * Detail (enter on a project). Same two axes first, then money, then the
 * evidence, then the one next step. Every value is a program field.
 */
export function renderDetail({ unit, health, gateway = { port: 0, up: true }, now = new Date(), tty = true }) {
  const c = (code, s) => paint(tty, code, s);
  const reg = registrarLabel(unit);
  const gw = gatewayLabel(unit, gateway);
  const lines = [];
  lines.push(c(ansi.bold, unit.id) + c(ansi.dim, ' · ') + (LIFECYCLE_ZH[unit.lifecycle] ?? unit.lifecycle)
    + (unit.effective_lifecycle && unit.effective_lifecycle !== unit.lifecycle ? c(ansi.dim, '(实际按' + LIFECYCLE_ZH[unit.effective_lifecycle] + '算)') : '')
    + c(ansi.dim, ' · 端口 ' + (unit.port ?? '—')));
  lines.push(c(ansi.dim, RULE));
  const row = (k, v) => lines.push(padW(k, 10) + v);

  const wants = unit.kind === 'external' || unit.kind === 'harvest' ? '' : ' · 期望 ' + (unit.enabled ? '开' : '关');
  row('供给', c(registrarColor(reg), reg) + c(ansi.dim, wants + ' · 进程 ' + unit.state
    + (unit.last_event_age_min != null ? ' · 最近事件 ' + unit.last_event_age_min + ' 分钟前' : '')));

  const gwc = gatewayColor(gw);
  row('网关', (gwc ? c(gwc, gw) : gw)
    + (unit.gateway && !unit.gateway.gated && unit.models_available.length ? c(ansi.dim, ' · ' + unit.models_available.join(' ')) : '')
    + (unit.gateway?.gated ? c(ansi.dim, ' · 声明 ' + (unit.models.length ? unit.models.join(' ') : '—')) : ''));

  const pool = unit.pool;
  row('余额', pool
    ? balanceCell(unit, now).trim() + c(ansi.dim, ' · ' + (pool.balance_known ?? 0) + '/' + pool.verified + ' 验证号有数 · ' + pool.total + ' 号总'
      + (pool.spend_local_usd ? ' · 本地已花 $' + pool.spend_local_usd : '') + ' · 数更新于 ' + fmtAge(pool.as_of, now))
    : c(ansi.dim, '没有池子'));

  if (health) {
    row('健康', health.status
      + (health.reason ? ' · ' + reasonZh(health.reason) : '')
      + ' · 始于 ' + fmtAge(health.since, now)
      + (actionsZh(health.actions) ? c(ansi.dim, ' · 系统动作:') + actionsZh(health.actions) : '')
      + (health.recoverable ? c(ansi.yellow, ' · 可恢复') : '')
      + (health.probe_note ? c(ansi.dim, ' · 复探 ' + health.probe_note) : ''));
    if (health.probe) row('探测', fmtAge(health.probe.at, now) + ' · ' + health.probe.model + ' · http ' + health.probe.http + (health.probe.ok ? ' · 通' : ' · 不通'));
    if (health.patrol) row('巡检', fmtAge(health.patrol.at, now) + ' · ' + health.patrol.verdict + ' · ' + (health.patrol.reason ?? '') + ' · 走 ' + health.patrol.provider);
  } else if (unit.health?.status === 'unreadable') {
    row('健康', c(ansi.red, '健康文件读不透') + c(ansi.dim, ' · 未知不当没有:网关已摘这个池 · 修文件后 tick 自动放回'));
  } else {
    row('健康', c(ansi.dim, '没有记录(tick 还没跑过)'));
  }
  row('目录', c(ansi.dim, unit.unit_dir ?? '—'));
  lines.push(c(ansi.dim, RULE));
  const hint = nextActionHint(unit, gateway);
  row('下一步', hint ?? c(ansi.dim, '不用管'));
  return lines;
}

// ── Interactive loop ──────────────────────────────────────────────────────

/** alt-screen; projects j/k/space/r/enter/m/u, models j/k/enter/u, esc back, q quit. */
export async function runFleetTui({ roots, fleetFile = DEFAULT_FLEET_FILE, refreshMs = 5000, once = false } = {}) {
  const tty = process.stdout.isTTY === true;
  let view = 'projects';
  let selected = 0;
  let modelsSelected = 0;
  let expanded = null;
  let detail = null;
  let action = null;
  let data = null;
  let gatewayUp = false;
  let liveModels = null;
  let quitting = false;

  const visibleUnits = () => sortByAttention(data.units.filter((u) => u.effective_lifecycle !== 'dead')); // dead 退出日常视野
  const currentGroups = () => groupModels({ units: visibleUnits(), live: liveModels });
  const gw = () => ({ port: loadFleetLocal(fleetFile).gatewayPort, up: gatewayUp });

  async function refresh() {
    data = await status({ ...(roots ? { roots } : {}), fleetFile });
    const fl = loadFleetLocal(fleetFile);
    gatewayUp = await probePort(fl.gatewayPort).catch(() => false);
    liveModels = null;
    if (gatewayUp) {
      try {
        const r = await fetch('http://127.0.0.1:' + fl.gatewayPort + '/v1/models', {
          headers: { authorization: 'Bearer ' + fl.gatewayToken },
          signal: AbortSignal.timeout(5000),
        });
        const j = await r.json();
        liveModels = Array.isArray(j?.data) ? j.data : null;
      } catch { liveModels = null; }
    }
    if (selected >= visibleUnits().length) selected = Math.max(0, visibleUnits().length - 1);
    if (modelsSelected >= currentGroups().length) modelsSelected = Math.max(0, currentGroups().length - 1);
    if (detail) {
      try { detail = await projectHealth({ id: detail.unit.id, ...(roots ? { roots } : {}), fleetFile }); } catch { /* unit gone */ }
    }
  }

  function frame() {
    const { cols } = termSize({});
    const now = new Date();
    let lines;
    let dock;
    if (view === 'models') {
      lines = renderModels({ units: visibleUnits(), live: liveModels, gateway: gw(), tty, action, selected: modelsSelected, expanded });
      dock = 'j/k 选 · enter 展开 · u 重拉目录 · esc 返回 · q 退';
    } else if (view === 'detail' && detail) {
      lines = renderDetail({ unit: detail.unit, health: detail.health, gateway: gw(), now, tty });
      dock = 'space 开/关 · r 恢复 · esc 返回 · q 退';
    } else {
      lines = renderProjects({ units: visibleUnits(), orphans: data.orphans, gateway: gw(), selected, tty, action, now });
      dock = 'j/k 选 · space 开/关供给 · r 恢复 · enter 详情 · m 模型 · u 刷新 · q 退';
    }
    const body = lines.map((l) => clipLine(l, cols)).join('\n') + '\n' + paint(tty, ansi.dim, dock);
    process.stdout.write(ansi.clear + body);
  }

  await refresh();
  if (once || !tty) {
    const lines = renderProjects({ units: visibleUnits(), orphans: data.orphans, gateway: gw(), selected: -1, tty: false });
    console.log(lines.join('\n'));
    return;
  }

  process.stdout.write(ansi.altOn + ansi.hide);
  const restore = () => process.stdout.write(ansi.show + ansi.altOff);
  process.on('exit', restore);

  // The verbs work from Projects AND Detail (the detail row is the same selection).
  const selectedUnit = () => (view === 'detail' && detail ? detail.unit : visibleUnits()[selected]);
  async function toggle(u) {
    if (!u.managed) {
      action = { ok: false, text: u.id + ' 没有开关(不归 fleet 拉起);想退出面板: fleet retire ' + u.id };
      return;
    }
    const mode = u.enabled ? 'off' : 'auto';
    try {
      await setMode({ id: u.id, mode, fleetFile });
      if (mode === 'off') await bootoutUnit({ id: u.id });
      else await bootstrapUnit({ id: u.id });
      action = { ok: true, text: u.id + ' → ' + (mode === 'auto' ? '开' : '关') };
    } catch (err) {
      action = { ok: false, text: u.id + ': ' + String(err?.message || err).slice(0, 60) };
    }
    await refresh();
  }
  async function doRecover(u) {
    try {
      const r = await recover({ id: u.id, ...(roots ? { roots } : {}) });
      action = { ok: r.recovered, text: r.recovered ? u.id + (r.forced ? ' 已强制恢复(复探还没过)' : ' 已恢复') : u.id + ': ' + (r.why === 'not-halted' ? '没在自停状态' : r.why) };
    } catch (err) { action = { ok: false, text: String(err?.message || err).slice(0, 60) }; }
    await refresh();
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async (keyBuf) => {
    const key = keyBuf.toString('utf8');
    const inList = view === 'projects';
    try {
      if (key === 'q' || key === '\u0003') { quitting = true; }
      else if (inList && (key === 'j' || key === '\u001b[B')) { selected = Math.min(visibleUnits().length - 1, selected + 1); action = null; }
      else if (inList && (key === 'k' || key === '\u001b[A')) { selected = Math.max(0, selected - 1); action = null; }
      else if (inList && key === 'm') { view = 'models'; action = null; }
      else if (inList && key === '\r' && visibleUnits()[selected]) {
        const u = visibleUnits()[selected];
        try {
          detail = await projectHealth({ id: u.id, ...(roots ? { roots } : {}), fleetFile });
          view = 'detail'; action = null;
        } catch (err) { action = { ok: false, text: String(err?.message || err).slice(0, 60) }; }
      }
      else if (view === 'models' && (key === 'j' || key === '\u001b[B')) { modelsSelected = Math.min(currentGroups().length - 1, modelsSelected + 1); action = null; }
      else if (view === 'models' && (key === 'k' || key === '\u001b[A')) { modelsSelected = Math.max(0, modelsSelected - 1); action = null; }
      else if (view === 'models' && key === '\r') {
        const g = currentGroups()[modelsSelected];
        if (g) expanded = expanded === g.owner ? null : g.owner;
        action = null;
      }
      else if (key === '\u001b') { view = 'projects'; detail = null; action = null; }
      else if (view === 'models' && key === 'u') {
        // 手动重拉上游目录
        try {
          const r = await refreshCatalog({ fleetFile });
          action = { ok: r.http === 200, text: r.http === 200 ? '目录已重拉(' + (r.refreshed?.length ?? 0) + ' 池)' : '网关没应:' + r.http };
        } catch (err) { action = { ok: false, text: String(err?.message || err).slice(0, 60) }; }
        await refresh();
      }
      else if (inList && key === 'u') { await refresh(); action = { ok: true, text: '已刷新 ' + new Date().toLocaleTimeString('en-GB', { hour12: false }) }; }
      else if ((inList || view === 'detail') && key === 'r' && selectedUnit()) await doRecover(selectedUnit());
      else if ((inList || view === 'detail') && key === ' ' && selectedUnit()) await toggle(selectedUnit());
    } finally {
      if (!quitting) frame();
    }
  });

  const timer = setInterval(async () => { await refresh(); if (!quitting) frame(); }, refreshMs);
  timer.unref?.();
  frame();
  while (!quitting) await new Promise((r) => setTimeout(r, 200));
  // Exit path: raw-mode stdin stays resumed and pins the event loop — release it
  // or q / Ctrl+C hang the terminal forever.
  clearInterval(timer);
  process.stdin.removeAllListeners('data');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  restore();
}
