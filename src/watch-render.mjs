// watch-render.mjs — the watcher's panels as PURE functions over a frame context.
// No file I/O here: runWatch (watch.mjs) reads accounts/events/ledger and hands
// this module a ctx; projects that want a different panel pass `render(ctx, H)`
// and reuse feedLine/spendByUpstream. Two layouts ship: defaultRender (one
// upstream) and defaultRenderMulti (one block per upstream, one hub gateway).
//
// ctx: { accts, evts, stats, flight, now, cols, rows, tty, gatewayState, keeper,
//        balance (single mode; null = ledger unreadable) | upstreams[] (multi) }

import {
  ansi, paint, stripAnsi, packFrame, padVisible,
  money, moneyBook, fmtDur, fmtAge, ageSec, shortEmail, clockOf, percentile,
} from './tui.mjs';
import { throughputSpark, classifyMood } from './events.mjs';

// ── Default panel (the standard glance layout) ─────────────────
/**
 * Single-upstream panel. PURE: reads only ctx/H. The caller (runWatch) must
 * supply `ctx.balance` = displayed pool balance, or null when the ledger is
 * unreadable — this function no longer computes it from files (a missing
 * ctx.balance renders as unknown, on purpose: never guess money).
 */
export function defaultRender(ctx, H) {
  const { accts, evts, stats, flight, now, cols, rows, tty } = ctx;
  const { targetUsd, windowMin, gatewayPort } = H;
  // Runtime facts travel in ctx (runWatch puts them there every frame); H only
  // ever held them for direct callers. Reading them from H alone left the
  // single-upstream panel saying "gateway off" while the port was listening.
  const gatewayState = ctx.gatewayState ?? H.gatewayState ?? 'off';
  const supply = ctx.keeper ?? H.supply ?? null;
  const c = (code, s) => paint(tty, code, s);
  const lastAny = evts.length ? Date.parse(evts[evts.length - 1].ts) : null;
  const lastEventAgeMin = lastAny != null ? (now - lastAny) / 60_000 : null;
  const mood = classifyMood({ accts, stats, flight, lastEventAgeMin });
  const head = conclusion(mood, stats, flight, accts, windowMin);

  const verified = accts.filter((a) => a.status === 'verified');
  const probed = verified.filter((a) => a.probe_ok).length;
  const balance = ctx.balance ?? null;       // anchor − local spend (runWatch computes it); null = ledger unreadable
  const pct = balance != null && targetUsd > 0 ? Math.min(1, balance / targetUsd) : 0;
  let checkedAt = 0;
  for (const a of verified) if (a.checked_at) checkedAt = Math.max(checkedAt, Date.parse(a.checked_at));

  const accent =
    mood.word === 'BLOCKED' || mood.word === 'STALLED' ? ansi.red
      : mood.word === 'HEALTHY' || mood.word === 'RUNNING' ? ansi.green
        : ansi.yellow;

  const gutter = 2;
  const W = Math.max(44, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');

  // 1 HARVEST
  add('');
  add(
    c(ansi.bold, c(accent, moneyBook(balance))) +
    c(ansi.dim, '  of ' + money(targetUsd) + ' target') +
    (balance == null ? c(ansi.red, '  ledger unreadable — balance unknown, keys withheld') : ''),
  );
  add(c(ansi.bold, c(accent, head.title)) + c(ansi.dim, '  ' + head.sub));

  const barW = Math.min(W - 8, 46);
  const n = Math.max(0, Math.min(barW, Math.round(pct * barW)));
  add(c(accent, '▰'.repeat(n)) + c(ansi.gray, '▱'.repeat(barW - n)) + c(ansi.dim, ' ' + Math.round(pct * 100) + '%'));
  add(
    c(ansi.dim, 'accounts  ') +
    c(ansi.green, verified.length + ' verified') +
    c(ansi.dim, ' · ') + c(ansi.cyan, probed + ' probe-ok') +
    c(ansi.dim, ' · ' + (accts.length - verified.length) + ' not verified') +
    (lastOkOf(evts) ? c(ansi.dim, '  ·  last reg ' + fmtAge(ageSec(Date.parse(lastOkOf(evts).ts))) + ' ago') : '') +
    (checkedAt ? c(ansi.dim, '  ·  $ checked ' + fmtAge(ageSec(checkedAt)) + ' ago') : c(ansi.dim, '  ·  $ never checked')),
  );
  add('');

  // 2 REGISTER
  if (!flight.workers.length) {
    add(c(ansi.dim, 'register  idle') +
      (flight.done + flight.failed ? c(ansi.dim, ', last run +' + flight.done + ' / -' + flight.failed) : ''));
  } else {
    const chips = flight.workers.slice(0, 6).map((w) => {
      const col = w.stage === 'done' ? ansi.green : w.stage === 'fail' ? ansi.red : ansi.yellow;
      const age = ageSec(w.at);
      return c(col, w.stage) + c(ansi.dim, ' ' + shortEmail(w.email) + (age != null ? ' ' + fmtAge(age) : ''));
    });
    add(c(ansi.dim, 'register  ') + chips.join(c(ansi.dim, '  ·  ')));
  }
  // 2b KEEPER + AI SPEND
  add(
    c(ansi.dim, 'ai       ') +
    (stats.aiCalls
      ? c(ansi.green, String(stats.aiCalls) + ' calls') +
        c(ansi.yellow, '  -$' + stats.aiCost.toFixed(4)) +
        (stats.aiFails ? c(ansi.red, '  ' + stats.aiFails + ' fail') : '') +
        c(ansi.dim, '  (' + windowMin + 'm)')
      : c(ansi.dim, 'no calls · gateway idle (' + windowMin + 'm)')),
  );
  if (supply) {
    add(
      c(ansi.dim, 'supply   ') +
      (supply.childPid
        ? c(ansi.yellow, 'refilling pid ' + supply.childPid)
        : supply.active
          ? c(ansi.dim, 'idle · target ' + money(targetUsd) + (supply.cooldownSec > 0 ? ' · next check ' + Math.ceil(supply.cooldownSec) + 's' : ''))
          : c(ansi.gray, 'off (another watcher owns duties)')),
    );
  }
  add(
    c(ansi.dim, 'gateway  ') +
      (gatewayState === 'up'
        ? c(ansi.green, 'http://127.0.0.1:' + gatewayPort + '/v1') + c(ansi.dim, ' (embedded)')
        : gatewayState === 'skipped'
          ? c(ansi.yellow, 'port busy — served elsewhere')
          : gatewayState === 'fleet'
            ? c(ansi.gray, 'fleet gateway serves this pool') + c(ansi.dim, '  (embedded off · <UP>_EMBED_GATEWAY=1 to debug on :' + gatewayPort + ')')
            : c(ansi.gray, 'off')),
  );
  add('');

  // 3 WINDOW
  const epNames = Object.keys(stats.byEndpoint);
  if (epNames.length) {
    add(c(ansi.dim, 'window ' + windowMin + 'm     ok  429  403  5xx   net       p50     p95'));
    for (const name of epNames.slice(0, 5)) {
      const ep = stats.byEndpoint[name];
      const cell = (v, col) => padVisible(c(v ? col : ansi.gray, String(v || '·')), 5);
      const p50 = percentile(ep.lat, 50), p95 = percentile(ep.lat, 95);
      const fmtP = (v) => v == null ? '—' : v >= 10_000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms';
      add(
        '  ' + padVisible(name, 16) +
        cell(ep.ok, ansi.green) + cell(ep.c429, ansi.yellow) +
        cell(ep.c4xx, ansi.red) + cell(ep.c5xx, ansi.red) +
        cell(ep.transport, ansi.gray) + '  ' +
        padVisible(fmtP(p50), 8) + padVisible(fmtP(p95), 8),
      );
    }
    add('');
    add(
      c(ansi.dim, 'req ' + throughputSpark(evts, now)) +
      c(ansi.dim, '  fails ×' + stats.fails +
        '  mail⏱ ×' + stats.mailTimeout +
        '  +' + stats.regsOk + ' reg'),
    );
    add('');
  }

  // 4 LIVE FEED
  const footerReserve = 1;
  const spare = rows - footerReserve - out.length;
  if (spare >= 3) {
    add(c(ansi.dim, 'live  newest first'));
    const budget = Math.max(1, rows - footerReserve - out.length - 1);
    const tail = evts.slice(-budget).reverse();
    if (!tail.length) add(c(ansi.dim, 'waiting for traffic…'));
    else for (const e of tail) add(feedLine(e, c, W));
  }

  const dock = ['q quit', 'window ' + windowMin + 'm'].join('  ·  ');
  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const gap = Math.max(2, cols - gutter * 2 - stripAnsi(dock).length - clock.length);
  const footer = pad(c(ansi.dim, dock) + ' '.repeat(gap) + c(ansi.dim, clock));
  if (!tty) return [...out, '', footer].join('\n') + '\n';
  return packFrame(out, footer, cols, rows);
}

function lastOkOf(evts) {
  for (let i = evts.length - 1; i >= 0; i--) if (evts[i].event === 'reg.ok') return evts[i];
  return null;
}

/** ai.ok spend grouped by upstream id (for the multi-upstream panel). */
export function spendByUpstream(evts, now, windowMin) {
  const cut = now - windowMin * 60_000;
  const out = new Map();
  for (const e of evts) {
    const name = typeof e.event === 'string' ? e.event : null;
    if (name !== 'ai.ok' && name !== 'ai.fail') continue;
    const t = Date.parse(e.ts) || 0;
    if (t < cut) continue;
    const id = e.upstream || 'default';
    const rec = out.get(id) || { calls: 0, fails: 0, cost: 0, lastMs: null };
    if (name === 'ai.ok') {
      rec.calls += 1;
      rec.cost += Number(e.cost_usd || 0);
      if (e.ms != null) rec.lastMs = e.ms;
    } else rec.fails += 1;
    out.set(id, rec);
  }
  return out;
}

/** Multi-upstream panel: one block per upstream pool, then the shared feed.
 *  PURE: each ctx.upstreams[i] arrives with its `balance` precomputed (null = ledger unreadable). */
export function defaultRenderMulti(ctx, H) {
  const { upstreams, evts, stats, flight, now, cols, rows, tty } = ctx;
  const windowMin = H.windowMin;
  const c = (code, s) => paint(tty, code, s);
  const unknown = upstreams.filter((u) => u.balance == null).length;   // ledger unreadable
  const totalBal = upstreams.reduce((s, u) => s + (u.balance ?? 0), 0);
  const totalTarget = upstreams.reduce((s, u) => s + (u.targetUsd || 0), 0);
  const pct = totalTarget > 0 ? Math.min(1, totalBal / totalTarget) : 0;
  const accent = pct >= 0.7 ? ansi.green : pct >= 0.3 ? ansi.yellow : ansi.red;
  const gutter = 2;
  const W = Math.max(44, cols - gutter * 2);
  const pad = (s) => ' '.repeat(gutter) + s;
  const out = [];
  const add = (s = '') => out.push(s.length ? pad(s) : '');
  const spend = spendByUpstream(evts, now, windowMin);

  add('');
  add(c(ansi.bold, c(accent, moneyBook(totalBal))) + c(ansi.dim, '  of ' + money(totalTarget) + ' target  ·  ' + upstreams.length + ' upstreams')
    + (unknown ? c(ansi.red, '  ' + unknown + ' ledger(s) unreadable — balance partial') : ''));
  const barW = Math.min(W - 8, 46);
  const n = Math.max(0, Math.min(barW, Math.round(pct * barW)));
  add(c(accent, '▰'.repeat(n)) + c(ansi.gray, '▱'.repeat(barW - n)) + c(ansi.dim, ' ' + Math.round(pct * 100) + '%'));
  add('');

  const idW = Math.max(6, Math.min(16, ...upstreams.map((u) => u.id.length)));
  for (const u of upstreams) {
    const verified = u.accts.filter((a) => a.status === 'verified').length;
    const up = u.balance == null || u.prevBalance == null ? 0 : u.balance - u.prevBalance;
    const arrow = u.balance == null || u.prevBalance == null ? '' : up > 1e-9 ? c(ansi.green, ' ↑') : up < -1e-9 ? c(ansi.red, ' ↓') : c(ansi.dim, ' ·');
    const sp = spend.get(u.id);
    const supplyTxt = u.supplyEnabled === false
      ? c(ansi.gray, 'off')
      : u.supply.childPid
        ? c(ansi.yellow, 'pid ' + u.supply.childPid)
        : c(ansi.dim, 'idle' + (u.supply.cooldownSec > 0 ? ' ' + Math.ceil(u.supply.cooldownSec) + 's' : ''));
    add(
      c(ansi.bold, padVisible(u.id, idW)) +
      c(ansi.dim, ' ') + c(ansi.green, String(verified).padStart(3) + ' ok') +
      c(ansi.dim, ' ') + c(ansi.bold, money(u.balance).padStart(9)) + arrow +
      c(ansi.dim, '/') + c(ansi.gray, money(u.targetUsd)) +
      c(ansi.dim, '  supply ') + supplyTxt +
      (sp
        ? c(ansi.dim, '  ai ') + c(ansi.green, String(sp.calls)) + c(ansi.yellow, ' -$' + sp.cost.toFixed(4)) +
          (sp.fails ? c(ansi.red, ' ' + sp.fails + '✗') : '')
        : c(ansi.dim, '  ai ·')),
    );
  }
  add('');

  const gate = ctx.gatewayState;
  add(
    c(ansi.dim, 'gateway  ') +
      (gate === 'up'
        ? c(ansi.green, 'http://127.0.0.1:' + H.gatewayPort + '/v1') + c(ansi.dim, '  hub (' + upstreams.length + ' upstreams, one port)')
        : gate === 'skipped'
          ? c(ansi.yellow, 'port busy — served elsewhere')
          : gate === 'fleet'
            ? c(ansi.gray, 'fleet gateway serves these pools') + c(ansi.dim, '  (embedded off)')
            : c(ansi.gray, 'off')),
  );
  if (stats.aiCalls) {
    add(c(ansi.dim, 'window   ') + c(ansi.green, stats.aiCalls + ' calls') + c(ansi.yellow, '  -$' + stats.aiCost.toFixed(4)) + c(ansi.dim, '  (' + windowMin + 'm)'));
  }
  add('');

  const footerReserve = 1;
  const spare = rows - footerReserve - out.length;
  if (spare >= 3) {
    add(c(ansi.dim, 'live  newest first'));
    const budget = Math.max(1, rows - footerReserve - out.length - 1);
    const tail = evts.slice(-budget).reverse();
    if (!tail.length) add(c(ansi.dim, 'waiting for traffic…'));
    else for (const e of tail) add(feedLine(e, c, W));
  }
  const dock = ['q quit', 'window ' + windowMin + 'm', upstreams.length + ' upstreams'].join('  ·  ');
  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });
  const gap = Math.max(2, cols - gutter * 2 - stripAnsi(dock).length - clock.length);
  const footer = pad(c(ansi.dim, dock) + ' '.repeat(gap) + c(ansi.dim, clock));
  if (!tty) return [...out, '', footer].join('\n') + '\n';
  return packFrame(out, footer, cols, rows);
}


function conclusion(mood, stats, flight, accts, windowMin) {
  const verified = accts.filter((a) => a.status === 'verified').length;
  switch (mood.word) {
    case 'BLOCKED':
      return { title: 'BLOCKED', sub: '403 ×' + stats.forbidden + ' in window · protection tightened, stop and reassess' };
    case 'THROTTLED':
      return { title: 'THROTTLED', sub: '429 ×' + stats.ratelimit + ' in window · pacer backing off, watch recovery' };
    case 'STALLED':
      return { title: 'STALLED', sub: 'workers active but failing ×' + stats.fails + ' — check feed for the broken step' };
    case 'MAIL-SLOW':
      return { title: 'MAIL-SLOW', sub: 'mailbox timeouts ×' + stats.mailTimeout + ' · consider rotating domains' };
    case 'RUNNING':
      return {
        title: 'RUNNING',
        sub: flight.workers.length + ' in pipeline (' +
          flight.workers.map((w) => w.stage).join(', ') + ')' +
          ' · +' + flight.done + ' ok / -' + flight.failed + ' fail this run',
      };
    case 'IDLE':
      return { title: 'IDLE', sub: 'no activity in ' + windowMin + ' min · ' + verified + ' accounts banked' };
    default:
      return { title: 'HEALTHY', sub: 'last run +' + flight.done + ' ok · ' + verified + ' verified total' };
  }
}

/** Rolling event → one feed row. Newest first at render time. */
export function feedLine(ev, c, W) {
  const t = c(ansi.dim, clockOf(Date.parse(ev.ts)));
  const evName = typeof ev.event === 'string' ? ev.event : (ev.event && ev.event.event) || 'unknown';
  switch (evName) {
    case 'reg.ok':
      return t + ' ' + padVisible(c(ansi.green, '+ new account'), 17) +
        c(ansi.green, ('$' + (ev.balance_usd != null ? ev.balance_usd.toFixed(2) : '?')).padStart(8)) +
        c(ansi.dim, '  ' + shortEmail(ev.email) + (ev.probe_ok ? '' : '  no-probe'));
    case 'reg.fail':
      return t + ' ' + padVisible(c(ansi.red, 'fail ' + ev.step), 17) +
        c(ansi.dim, '  ' + shortEmail(ev.email)) +
        c(ansi.yellow, '  ' + String(ev.klass || '') + ' ' + String(ev.error || '').slice(0, 40));
    case 'reg.crash':
      return t + ' ' + padVisible(c(ansi.red, 'crash'), 17) +
        c(ansi.dim, '  ' + shortEmail(ev.email)) +
        c(ansi.yellow, '  ' + String(ev.error || '').split('\n')[0].slice(0, 44));
    case 'code.received':
      return t + ' ' + padVisible(c(ansi.cyan, '✉ code'), 17) +
        c(ansi.dim, '  ' + shortEmail(ev.email) + ' (' + fmtDur((ev.wait_ms || 0) / 1000) + ')');
    case 'code.timeout':
      return t + ' ' + padVisible(c(ansi.yellow, '⏱ mailbox'), 17) +
        c(ansi.dim, '  timeout ' + shortEmail(ev.email));
    case 'http': {
      const st = ev.status || 0;
      const name = padVisible(String(ev.name || ''), 15);
      const ms = (ev.ms != null ? Math.round(ev.ms) + 'ms' : '').padStart(7);
      if (st > 0 && st < 300) return t + ' ' + c(ansi.gray, ' ' + st) + ' ' + c(ansi.dim, name) + c(ansi.gray, ms);
      if (st === 429) return t + ' ' + c(ansi.yellow, ' ' + st) + ' ' + c(ansi.bold, name) + c(ansi.yellow, ms + '  rate limited');
      if (st === 403 || st === 401) return t + ' ' + c(ansi.red, ' ' + st) + ' ' + c(ansi.bold, name) + c(ansi.red, ms + '  forbidden');
      if (st >= 500) return t + ' ' + c(ansi.red, ' ' + st) + ' ' + name + c(ansi.red, ms);
      return t + ' ' + c(ansi.dim, ' net') + ' ' + name + c(ansi.gray, ms + '  transport');
    }
    case 'gateway.start':
      return t + ' ' + padVisible(c(ansi.blue, '▲ gateway'), 17) +
        c(ansi.dim, '  listening :' + (ev.port || ''));
    case 'ai.ok':
      return t + ' ' + padVisible(c(ansi.green, '$ ai' + (ev.upstream ? ':' + String(ev.upstream).slice(0, 6) : '')), 17) +
        c(ansi.dim, '  ' + shortEmail(ev.email)) +
        c(ansi.gray, '  ' + (ev.model || '?').slice(0, 18)) +
        c(ansi.yellow, '  -$' + Number(ev.cost_usd ?? 0).toFixed(4)) +
        c(ansi.dim, '  ' + (ev.ms ?? '?') + 'ms');
    case 'key.drained':
      return t + ' ' + padVisible(c(ansi.red, '✝ drained'), 17) +
        c(ansi.red, '  ' + shortEmail(ev.email)) + c(ansi.dim, '  ' + (ev.upstream ? ev.upstream + ' ' : '') + 'http-402');
    case 'pool.exhausted':
      return t + ' ' + padVisible(c(ansi.red, '! pool'), 17) +
        c(ansi.red, '  ' + (ev.upstream ? ev.upstream + ': ' : '') + 'exhausted after ' + (ev.tried ?? '?') + ' keys — waiting for supply');
    case 'balance.ok':
      return t + ' ' + padVisible(c(ansi.gray, '$ balance'), 17) +
        c(ansi.dim, '  ' + shortEmail(ev.email)) + c(ansi.gray, '  $' + Number(ev.balance_usd ?? 0).toFixed(2));
    case 'balance.fail':
      return t + ' ' + padVisible(c(ansi.yellow, '$ balance'), 17) +
        c(ansi.red, '  refresh failed ' + String(ev.error || '').slice(0, 34));
    case 'gateway.skip':
      return t + ' ' + c(ansi.yellow, 'gateway') + c(ansi.dim, '  port busy · ' + String(ev.error || '').slice(0, 30));
    case 'supply.spawn':
      return t + ' ' + padVisible(c(ansi.blue, '▲ supply'), 17) +
        c(ansi.yellow, '  +' + ev.count + ' needed') +
        c(ansi.dim, '  $' + Number(ev.balance_usd ?? 0).toFixed(2) + ' < target ' + money(ev.target));
    case 'supply.hold':
      return t + ' ' + padVisible(c(ansi.yellow, '▲ supply'), 17) +
        c(ansi.yellow, '  held') + c(ansi.dim, '  ' + (ev.upstream ? ev.upstream + ' ' : '') + String(ev.reason || ''));
    case 'batch.start':
      return t + ' ' + c(ansi.dim, 'batch') + c(ansi.dim, '  start ×' + (ev.count || 1) + ' workers=' + (ev.workers || 1));
    case 'batch.done':
      return t + ' ' + c(ansi.blue, 'batch') +
        c(ev.failed ? ansi.yellow : ansi.green, '  done +' + (ev.ok || 0) + ' / -' + (ev.failed || 0)) +
        c(ansi.dim, '  gap ' + (ev.gap_ms || 0) + 'ms');
    default:
      return t + ' ' + c(ansi.gray, '· ' + ev.event);
  }
}

