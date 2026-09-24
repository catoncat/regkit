// fleet-tui render contracts: two axes per row — 供给 / 网关 — plus 余额;
// closed vocabularies; attention order; contextual next step; detail leads with the axes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registrarLabel, gatewayLabel, balanceCell, reasonZh, actionsZh, LIFECYCLE_ZH,
  renderProjects, renderModels, renderDetail, groupModels, attentionRank, sortByAttention,
  nextActionHint, fmtAge, displayWidth, padW,
} from '../src/fleet-tui.mjs';

const NOW = new Date('2026-09-16T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const UP = { port: 48790, up: true };
const DOWN = { port: 48790, up: false };

const unit = (over) => ({
  id: 'x', kind: 'registrar', lifecycle: 'active', effective_lifecycle: over?.lifecycle ?? 'active', enabled: true, state: 'running',
  models: [], models_available: [], gateway: { gated: false, gate_reason: null, models: 0 }, health: null, pool: null, ...over,
});
const serving = (n, over = {}) => unit({ models_available: Array.from({ length: n }, (_, i) => 'm' + i), gateway: { gated: false, gate_reason: null, models: n }, ...over });

// ── 供给 axis ──
test('registrarLabel: who decided wins — dead > sunset > user switch > system stop > liveness', () => {
  assert.equal(registrarLabel(unit({ lifecycle: 'dead' })), '退役');
  assert.equal(registrarLabel(unit({ lifecycle: 'sunset', effective_lifecycle: 'dead' })), '退役', 'drained sunset is dead');
  assert.equal(registrarLabel(unit({ lifecycle: 'sunset' })), '落日·不再注册');
  assert.equal(registrarLabel(unit({ lifecycle: 'sunset', enabled: false, health: { status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar'] } })), '落日·不再注册', 'sunset says it all');
  assert.equal(registrarLabel(unit({ enabled: false })), '已关');
  assert.equal(registrarLabel(unit({ enabled: false, health: { status: 'halted', reason: 'x' } })), '已关', '用户轴压系统轴');
  // declared off but hard liveness evidence says otherwise: a drift the column must show (soft 'activity' alone is not)
  assert.equal(registrarLabel(unit({ enabled: false, state: 'off', alive_by: ['port', 'activity'] })), '已关·但还在跑');
  assert.equal(registrarLabel(unit({ enabled: false, state: 'off', alive_by: ['activity'] })), '已关', 'a just-quit watch leaves a recent event, not a process');
  assert.equal(registrarLabel(unit({ lifecycle: 'sunset', enabled: false, state: 'off', alive_by: ['proc'] })), '已关·但还在跑', 'drift beats the sunset word: sunset means the registrar is OFF');
  assert.equal(attentionRank(unit({ enabled: false, state: 'off', alive_by: ['proc'] })), 2, 'ranks with the other things that need you');
  assert.match(nextActionHint(unit({ enabled: false, state: 'off', alive_by: ['proc'] }), UP), /fleet doctor/);
  assert.equal(registrarLabel(unit({ health: { status: 'halted', reason: 'register-broken' } })), '自停:注册失效');
  assert.equal(registrarLabel(unit({ health: { status: 'halted', reason: null } })), '自停:未知');
  // degraded no-credit stops the registrar too (keeper action) — the column must say so
  assert.equal(registrarLabel(unit({ health: { status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar', 'stopSupply'] } })), '自停:新号没额度');
  // degraded pool-broken does NOT stop the registrar
  assert.equal(registrarLabel(unit({ health: { status: 'degraded', reason: 'pool-broken', actions: ['removeModels'] } })), '在跑');
  assert.equal(registrarLabel(unit({})), '在跑');
  assert.equal(registrarLabel(unit({ state: 'stale' })), '在跑');
  assert.equal(registrarLabel(unit({ state: 'down' })), '没跑');
});

test('registrarLabel: external and harvest have their own two words; dead still wins', () => {
  assert.equal(registrarLabel(unit({ kind: 'external' })), '在');
  assert.equal(registrarLabel(unit({ kind: 'external', state: 'down' })), '挂');
  assert.equal(registrarLabel(unit({ kind: 'external', enabled: false })), '已关');
  assert.equal(registrarLabel(unit({ kind: 'external', lifecycle: 'dead' })), '退役');
  assert.equal(registrarLabel(unit({ kind: 'harvest' })), '在跑');
  assert.equal(registrarLabel(unit({ kind: 'harvest', state: 'down' })), '没跑');
  assert.equal(registrarLabel(unit({ kind: 'harvest', lifecycle: 'dead', enabled: false, state: 'off' })), '退役');
});

// ── 网关 axis ──
test('gatewayLabel: serving axis is independent of the registrar axis', () => {
  // the delta case: registrar off (sunset), pool still serving
  const ot = serving(1, { lifecycle: 'sunset', enabled: false, state: 'off', health: { status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar', 'stopSupply'] } });
  assert.equal(registrarLabel(ot), '落日·不再注册');
  assert.equal(gatewayLabel(ot, UP), '在服务 · 1 模型');
  assert.equal(gatewayLabel(serving(2), UP), '在服务 · 2 模型');
  assert.equal(gatewayLabel(unit({ gateway: { gated: true, gate_reason: 'register-broken', models: 0 } }), UP), '已摘:注册失效');
  assert.equal(gatewayLabel(unit({ gateway: { gated: true, gate_reason: 'pool-broken', models: 0 } }), UP), '已摘:池子坏了');
  assert.equal(gatewayLabel(unit({ gateway: { gated: true, gate_reason: 'health-unreadable', models: 0 } }), UP), '已摘:健康文件读不透');
  assert.equal(gatewayLabel(unit({ health: { status: 'degraded', reason: 'model-delisted' } }), UP), '没模型:模型下架');
  assert.equal(gatewayLabel(unit({}), UP), '没模型');
  // unknown spend ≠ zero spend: an unreadable ledger means the pool withholds keys
  assert.equal(gatewayLabel(serving(2, { pool: { ledger: 'unreadable', balance_known: 0, verified: 3 } }), UP), '停发 key:账本读不透');
  // no gateway declared (harvest / most external)
  assert.equal(gatewayLabel(unit({ kind: 'harvest', gateway: null }), UP), '—');
  // the fleet gateway down: nothing serves, whatever health says
  assert.equal(gatewayLabel(serving(2), DOWN), '网关挂');
  assert.equal(gatewayLabel(unit({ kind: 'external', gateway: null }), DOWN), '—');
});

// ── 余额 ──
test('balanceCell: right-aligned money, age and unknown-count caveats, never a fake $0', () => {
  assert.equal(balanceCell(unit({})), '—');
  assert.equal(balanceCell(unit({ pool: { balance: 941.76, balance_known: 542, verified: 542, as_of: daysAgo(0) } }), NOW), ' $941.76');
  assert.equal(balanceCell(unit({ pool: { balance: 80, balance_known: 4, verified: 4, as_of: daysAgo(5) } }), NOW), '  $80.00  5 天前');
  assert.equal(balanceCell(unit({ pool: { balance: 28.35, balance_known: 10, verified: 17, as_of: daysAgo(0) } }), NOW), '  $28.35  7 号没数');
  assert.equal(balanceCell(unit({ pool: { balance: 0, balance_known: 0, verified: 3, as_of: daysAgo(1) } }), NOW), '未知');
  assert.equal(balanceCell(unit({ pool: { balance: 0, balance_known: 0, verified: 0, as_of: daysAgo(1) } }), NOW), '—');
  assert.equal(balanceCell(unit({ pool: { ledger: 'unreadable', balance: 500, balance_known: 0, verified: 3 } }), NOW), '未知·账本读不透');
});

test('vocabularies: reason codes, lifecycle, keeper actions all have one plain-Chinese name', () => {
  assert.equal(reasonZh('no-credit'), '新号没额度');
  assert.equal(reasonZh('register-broken'), '注册失效');
  assert.equal(reasonZh('pool-broken'), '池子坏了');
  assert.equal(reasonZh('model-delisted'), '模型下架');
  assert.equal(reasonZh('health-unreadable'), '健康文件读不透');
  assert.equal(reasonZh('weird-new-code'), 'weird-new-code'); // 未知码原样透传
  assert.deepEqual(LIFECYCLE_ZH, { active: '在用', sunset: '落日', dead: '退役' });
  assert.equal(actionsZh(['stopRegistrar', 'stopSupply']), '停注册 停补货');
  assert.equal(actionsZh([]), '');
});

// ── attention ──
test('attentionRank: 没跑 > 自停可恢复 > 自停/已摘/降级 > 已关 > 落日/退役 > 在跑', () => {
  const down = unit({ id: 'down', state: 'down' });
  const recov = unit({ id: 'recov', health: { status: 'halted', reason: 'no-credit', recoverable: true } });
  const halted = unit({ id: 'halted', health: { status: 'halted', reason: 'register-broken', recoverable: false } });
  const gated = serving(0, { id: 'gated', gateway: { gated: true, gate_reason: 'pool-broken', models: 0 } });
  const off = unit({ id: 'off', enabled: false });
  const sunsetU = unit({ id: 'sunset', lifecycle: 'sunset' });
  const fine = serving(2, { id: 'fine' });
  const sorted = sortByAttention([fine, sunsetU, off, halted, gated, recov, down]);
  assert.deepEqual(sorted.map((u) => u.id), ['down', 'recov', 'halted', 'gated', 'off', 'sunset', 'fine']);
  assert.equal(attentionRank(halted), attentionRank(gated), 'system-handled problems share one rank (stable sort keeps input order)');
  assert.equal(attentionRank(serving(1, { pool: { ledger: 'unreadable' } })), 2, 'unreadable ledger is a system-handled problem, not fine');
});

// ── next step ──
test('nextActionHint: one line, only when there is a step; the gateway being down trumps everything', () => {
  assert.equal(nextActionHint(serving(2), UP), null);
  assert.match(nextActionHint(unit({ state: 'down' }), UP), /fleet doctor/);
  assert.match(nextActionHint(unit({ enabled: false }), UP), /space 开回来/);
  assert.match(nextActionHint(unit({ health: { status: 'halted', recoverable: true } }), UP), /^r 恢复/);
  assert.match(nextActionHint(unit({ health: { status: 'halted', recoverable: false } }), UP), /强制恢复/);
  assert.match(nextActionHint(unit({ id: 'ot', lifecycle: 'sunset' }), UP), /fleet retire ot/);
  assert.match(nextActionHint(unit({ lifecycle: 'dead' }), UP), /ls --all/);
  assert.match(nextActionHint(unit({ gateway: { gated: true, gate_reason: 'pool-broken' } }), UP), /已摘/);
  assert.match(nextActionHint(unit({ id: 'p', health: { status: 'degraded', reason: 'no-credit', actions: ['stopRegistrar'] } }), UP), /fleet sunset p/);
  assert.match(nextActionHint(serving(2), DOWN), /kickstart/);
  assert.equal(nextActionHint(unit({ kind: 'external', gateway: null }), DOWN), null, 'no gateway declared: the fleet gateway being down is not this row\'s problem');
  assert.match(nextActionHint(unit({ kind: 'harvest', gateway: null, state: 'down', id: 'amp' }), UP), /fleet retire amp/);
});

test('fmtAge: 分钟/小时/天/从未', () => {
  assert.equal(fmtAge(new Date(NOW.getTime() - 3 * 60000).toISOString(), NOW), '3 分钟前');
  assert.equal(fmtAge(daysAgo(0.5), NOW), '12 小时前');
  assert.equal(fmtAge(daysAgo(12), NOW), '12 天前');
  assert.equal(fmtAge(null, NOW), '从未');
});

test('padW: CJK chars count as two columns (alignment contract)', () => {
  assert.equal(displayWidth('项目'), 4);
  assert.equal(displayWidth('alpha'), 5);
  assert.equal(displayWidth(padW('项目', 14)), 14);
  assert.equal(displayWidth(padW('alpha', 14)), 14);
});

// ── Projects frame ──
test('renderProjects: four columns, header counts SERVING models, selected row gets its next step', () => {
  const units = [
    serving(1, { id: 'delta', lifecycle: 'sunset', enabled: false, state: 'off',
      pool: { balance: 941.76, balance_known: 542, verified: 542, as_of: daysAgo(0) },
      health: { status: 'degraded', reason: 'no-credit', recoverable: false, actions: ['stopRegistrar', 'stopSupply'], patrol_at: daysAgo(0.25) } }),
    serving(2, { id: 'alpha', state: 'down', pool: { balance: 80, balance_known: 4, verified: 4, as_of: daysAgo(5) } }),
    serving(0, { id: 'broken', gateway: { gated: true, gate_reason: 'pool-broken', models: 0 }, models: ['m'], health: { status: 'degraded', reason: 'pool-broken', actions: ['removeModels'] } }),
  ];
  const lines = renderProjects({ units, orphans: [], gateway: UP, selected: 1, tty: false, now: NOW });
  assert.match(lines[0], /3 项目 · 3 模型在服务/, 'gated pool contributes 0');
  assert.match(lines[0], /网关 :48790 在/);
  assert.match(lines[0], /巡检 6 小时前/);
  assert.match(lines[2], /项目\s+供给\s+网关\s+余额/);
  const grid = lines.join('\n');
  assert.match(grid, /delta\s+落日·不再注册\s+在服务 · 1 模型\s+\$941\.76/);
  assert.match(grid, /> alpha\s+没跑\s+在服务 · 2 模型\s+\$80\.00  5 天前/);
  assert.match(grid, /broken\s+在跑\s+已摘:池子坏了/);
  // column edges line up (CJK-aware) for every row
  const rows = lines.slice(3, 6);
  const col = (s, w) => displayWidth(s.slice(0, s.indexOf('在服务') > 0 ? s.indexOf('在服务') : s.indexOf('已摘')));
  assert.equal(new Set(rows.map((r) => col(r))).size, 1, 'gateway column starts at one offset');
  // last line = the selected row's next step
  assert.match(lines.at(-1), /^alpha 没跑 — .*fleet doctor/);
  assert.ok(!grid.includes('未收编'));
});

test('renderProjects: header says 挂 and every serving cell says 网关挂 when the fleet gateway is down', () => {
  const lines = renderProjects({ units: [serving(2, { id: 'a' })], gateway: DOWN, selected: 0, tty: false, now: NOW });
  assert.match(lines[0], /0 模型在服务 · 网关 :48790 挂/);
  assert.match(lines.join('\n'), /a\s+在跑\s+网关挂/);
  assert.match(lines.at(-1), /kickstart/);
});

test('renderProjects: no selection (fleet ls) = no hint line; orphan 行用中文', () => {
  const lines = renderProjects({
    units: [serving(1, { id: 'a' })],
    orphans: [{ pid: 42, etime: '1:00', cmd: 'node src/cli.mjs register' }],
    gateway: UP, selected: -1, tty: false,
  });
  assert.match(lines.join('\n'), /未收编 ×1.*pid 42/);
  assert.ok(!lines.at(-1).includes(' — '), 'no next-step line without a selection');
});

// ── Models view ──
test('renderModels: grouped by project with lifecycle tag; declared fallback is labelled as not callable', () => {
  const units = [
    serving(2, { id: 'alpha', models_available: ['deepseek', 'minimax'] }),
    serving(1, { id: 'gamma', lifecycle: 'sunset', enabled: false, models_available: ['ds-pro'] }),
  ];
  const down = renderModels({ units, gateway: DOWN, tty: false });
  assert.match(down[0], /3 个已声明/);
  assert.ok(down[0].includes('现在调不了'));
  assert.match(down.join('\n'), /alpha · 2 个/);
  assert.match(down.join('\n'), /gamma · 1 个 · 落日/);
  assert.ok(!down.join('\n').includes('ds-pro '));
  const ex = renderModels({ units, gateway: DOWN, tty: false, selected: 1, expanded: 'gamma' });
  assert.match(ex.join('\n'), /> gamma · 1 个 · 落日\n    ds-pro/);
  const live = [
    { id: 'claude-x@gamma', owned_by: 'gamma' },
    { id: 'ds-flash', owned_by: 'delta' },
    { id: 'ds-flash@delta', owned_by: 'delta' },
  ];
  const up = renderModels({ units, live, gateway: UP, tty: false });
  assert.match(up[0], /3 个在服务/);
  assert.match(up.join('\n'), /gamma · 1 个 · 落日/);
  assert.match(up.join('\n'), /delta · 2 个/);
  assert.equal(groupModels({ units, live })[0].lifecycle, 'sunset');
});

// ── Detail ──
test('renderDetail: axes first, then money, evidence with keeper actions, one next step', () => {
  const u = serving(2, {
    id: 'beta', port: 48792, unit_dir: '/x/beta', models_available: ['glm', 'glm-5.2'],
    health: { status: 'halted', reason: 'no-credit', recoverable: true, actions: ['stopRegistrar', 'stopSupply', 'haltProject'] },
    gateway: { gated: true, gate_reason: 'no-credit', models: 0 }, models: ['glm', 'glm-5.2'],
    pool: { total: 34, verified: 17, balance: 28.35, balance_known: 10, spend_local_usd: 0.12, as_of: daysAgo(0.1) },
  });
  const health = {
    status: 'halted', reason: 'no-credit', since: daysAgo(1), recoverable: true, probe_note: 'http 200',
    actions: ['stopRegistrar', 'stopSupply', 'haltProject'],
    probe: { at: daysAgo(0.5), model: 'glm', http: 200, ok: true },
    patrol: { at: daysAgo(0.25), verdict: 'transient', reason: '429 storm', provider: 'fleet-gateway' },
  };
  const lines = renderDetail({ unit: u, health, gateway: UP, now: NOW, tty: false });
  const grid = lines.join('\n');
  assert.match(lines[0], /^beta · 在用 · 端口 48792/);
  assert.match(grid, /供给\s+自停:新号没额度 · 期望 开 · 进程 running/);
  assert.match(grid, /网关\s+已摘:新号没额度 · 声明 glm glm-5\.2/);
  assert.match(grid, /余额\s+\$28\.35  7 号没数 · 10\/17 验证号有数 · 34 号总 · 本地已花 \$0\.12 · 数更新于 2 小时前/);
  assert.match(grid, /健康\s+halted · 新号没额度 · 始于 1 天前 · 系统动作:停注册 停补货 停项目 · 可恢复 · 复探 http 200/);
  assert.match(grid, /探测\s+12 小时前 · glm · http 200 · 通/);
  assert.match(grid, /巡检\s+6 小时前 · transient · 429 storm · 走 fleet-gateway/);
  assert.match(lines.at(-1), /^下一步\s+r 恢复/);
  // sunset + serving: the two axes disagree on purpose and both are shown
  const ot = serving(1, { id: 'delta', lifecycle: 'sunset', enabled: false, state: 'off', models_available: ['ds-flash'],
    pool: { total: 1864, verified: 542, balance: 941.76, balance_known: 542, as_of: daysAgo(0) } });
  const otLines = renderDetail({ unit: ot, health: { status: 'degraded', reason: 'no-credit', since: daysAgo(1), actions: ['stopRegistrar', 'stopSupply'] }, gateway: UP, now: NOW, tty: false }).join('\n');
  assert.match(otLines, /供给\s+落日·不再注册 · 期望 关 · 进程 off/);
  assert.match(otLines, /网关\s+在服务 · 1 模型 · ds-flash/);
  assert.match(otLines, /下一步\s+余额用完自动退役 · 现在就退役:fleet retire delta/);
  // no health.json yet / unreadable
  assert.match(renderDetail({ unit: unit({ id: 'amp', kind: 'harvest', gateway: null }), health: null, now: NOW, tty: false }).join('\n'), /健康\s+没有记录/);
  const unread = unit({ id: 'u', health: { status: 'unreadable', reason: 'health-unreadable', actions: [] }, gateway: { gated: true, gate_reason: 'health-unreadable', models: 0 } });
  assert.match(renderDetail({ unit: unread, health: null, now: NOW, tty: false }).join('\n'), /健康\s+健康文件读不透/);
});
