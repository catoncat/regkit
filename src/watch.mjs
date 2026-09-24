// Resident watcher ENGINE: reads accounts/events/ledger, runs keeper duties
// (balance rotation, supply replenishment, embedded gateway) and hands one frame
// context per second to a render. The panels themselves are pure functions in
// watch-render.mjs. Every upstream-specific bit (balance refresh, supply spawn, gateway
// construction, target/port values) is injected.
//
// Duties run only in the keeper-holding process (single-instance via
// data/.watch-keeper.lock) so two panes never double-spawn batches.
//
// Usage:
//   node src/watch.mjs            TTY live panel (alt-screen)
//   node src/watch.mjs --once     single frame snapshot, no duties

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';
import { readAccounts as readAccountsFile, appendAccount } from './accounts.mjs';
import { readTail, fileSig } from './jsonl.mjs';
import { displayedBalance, createUsageReader } from './usage.mjs';
import { createSupplyController } from './supply.mjs';
import { readHealthState, gateDecision } from './health.mjs';
import { windowStats, inflight } from './events.mjs';
import { ansi, termSize } from './tui.mjs';
import { defaultRender, defaultRenderMulti, spendByUpstream, feedLine } from './watch-render.mjs';

// The panels live in watch-render.mjs (pure); re-exported so existing imports
// from 'regkit/watch' keep resolving.
export { defaultRender, defaultRenderMulti, spendByUpstream, feedLine };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Accounts data layer (canonical reader + signature cache) ────
/**
 * One parse implementation, not two: the canonical latest-wins reader from
 * accounts.mjs, behind a file-signature cache so a panel frame does not re-parse a
 * multi-MB accounts.jsonl. (This used to re-implement the JSONL latest-wins rule
 * locally — a second, divergent copy of the read contract.)
 */
export function createAccountReader(accountsFile) {
  let cache = { sig: '', value: [] };
  return function readAccounts() {
    if (!existsSync(accountsFile)) return [];
    const sig = fileSig(accountsFile);
    if (sig && cache.sig === sig) return cache.value;
    cache = { sig, value: readAccountsFile(accountsFile) };
    return cache.value;
  };
}

// ── Watch engine ───────────────────────────────────────────────
/**
 * Run the watcher.
 *
 * @param H {
 *   root, eventsFile, accountsFile, usageFile,
 *   targetUsd, windowMin, gatewayPort,
 *   supplyCheckSec, balanceRotateSec, supplyWorkers, supplyMaxBatch, perAccountUsd,
 *   supplyEnabled,                     // false = no replenishment (panel + gateway only)
 *   refreshBalance(account),          // async; appends authoritative balance
 *   rotatable(account),             // optional; who gets balance-rotated (default verified && password)
 *   spawnBatch(need, workers),        // -> pid
 *   createGateway(hooks),             // optional; (cfg,log,usagePath) wiring — ONLY used with embedGateway
 *   embedGateway,                     // true = also listen on gatewayPort here (debug). Default false:
 *                                     //   the fleet gateway (:48790) serves every declared pool from
 *                                     //   the same files; two processes issuing one pool's keys is not a feature.
 *   render(ctx, H),                   // optional override (default defaultRender)
 *   emit(name, fields),               // optional event writer
 *   once,                             // --once single frame
 * }
 */
/**
 * One keeper supply tick, health-gated. The four linkage actions
 * map to mechanics as follows: stopRegistrar / stopSupply / haltProject are all
 * "the keeper does not spawn" (registration only ever happens via supply); the
 * fourth action, removeModels, is enforced gateway-side (health.json gate +
 * blocklist in fleet-hub/pool). Health unreadable => fail-CLOSED (buildKeeperHealthFor
 * hands back a stopSupply verdict). A ledger the balance() hook cannot read is
 * handled inside the supply controller (unknown balance never spawns).
 * no-credit is degraded (pool keeps serving) but its actions include stopSupply,
 * so the keeper reads ACTIONS, not just status. It READS health.json and never
 * writes it: `fleet tick` is its only writer.
 */
export async function keeperSupplyTick({ upstreams, healthFor = async () => null }) {
  for (const u of upstreams) {
    let h = null;
    try { h = await healthFor(u); } catch { h = null; }
    const acts = Array.isArray(h?.actions) ? h.actions : [];
    if (h?.status === 'halted' || acts.includes('stopSupply')) continue;
    try { u.supply?.check(); } catch { /* keep panel alive */ }
  }
}

/**
 * Per-unit health READER for the keeper gate (single mode: H.healthFile; multi:
 * u.healthFile). Read-only by design: `fleet tick` is the only writer of
 * health.json. A watcher running health.step here would race tick on the
 * same file and hand the keeper a state no other consumer agrees with.
 * Fail-closed: an unreadable file blocks supply (unknown != healthy) and says so
 * in the event stream; a merely MISSING file stays fail-open.
 */
export function buildKeeperHealthFor(H, upstreams, emit = () => {}) {
  const anyHealth = H.healthFile || upstreams.some((u) => u.healthFile);
  if (!anyHealth) return async () => null;
  return async (u) => {
    const healthPath = u.healthFile ?? null;
    if (!healthPath) return null;
    const gate = gateDecision(readHealthState(healthPath));
    if (gate.reason === 'health-unreadable') {
      emit('health.unreadable', { upstream: u.id, health: healthPath });
      return { status: 'halted', reason: 'health-unreadable', actions: ['stopSupply'] };
    }
    return gate.health;
  };
}

export async function runWatch(H) {
  const root = H.root;
  const tty = !!process.stdout.isTTY && !H.once;
  const keeper = H.once ? false : acquireLock(join(root, 'data', '.watch-keeper.lock'));
  const emit = H.emit || (() => {});

  // Normalize to a list of upstream pools: H.upstreams = multi-upstream mode
  // (one watcher for many registrars); the legacy single-upstream fields fold
  // into a one-element list so nothing about existing projects changes.
  const multi = Array.isArray(H.upstreams) && H.upstreams.length > 0;
  const upstreams = (multi ? H.upstreams : [{
    id: H.poolName || 'upstream',
    accountsFile: H.accountsFile,
    usageFile: H.usageFile,
    targetUsd: H.targetUsd,
    perAccountUsd: H.perAccountUsd,
    refreshBalance: H.refreshBalance,
    spawnBatch: H.spawnBatch,
    rotatable: H.rotatable,
    supplyEnabled: H.supplyEnabled,
    supplyCheckSec: H.supplyCheckSec,
    supplyWorkers: H.supplyWorkers,
    supplyMaxBatch: H.supplyMaxBatch,
  }]).map((u, i) => ({
    id: u.id || ('upstream-' + i),
    accountsFile: u.accountsFile,
    // healthFile must survive normalization or the keeper gate silently no-ops in
    // multi-upstream mode (the reader keys off the per-upstream field).
    healthFile: u.healthFile ?? H.healthFile ?? null,
    usageFile: u.usageFile || u.usagePath,
    targetUsd: u.targetUsd ?? H.targetUsd ?? 0,
    perAccountUsd: u.perAccountUsd ?? H.perAccountUsd ?? 1,
    refreshBalance: u.refreshBalance || H.refreshBalance,
    spawnBatch: u.spawnBatch || H.spawnBatch,
    rotatable: u.rotatable || ((a) => a.status === 'verified' && a.password),
    supplyEnabled: u.supplyEnabled ?? H.supplyEnabled,
    supplyCheckSec: u.supplyCheckSec ?? H.supplyCheckSec ?? 30,
    supplyWorkers: u.supplyWorkers ?? H.supplyWorkers ?? 4,
    supplyMaxBatch: u.supplyMaxBatch ?? H.supplyMaxBatch ?? 24,
    readAccounts: createAccountReader(u.accountsFile),
    balanceBusy: false,
    supply: null,
    prevBalance: null,
  }));
  const readAccounts = multi ? null : upstreams[0].readAccounts;
  const render = H.render || (multi ? defaultRenderMulti : defaultRender);
  const poolOpts = (u) => ({ usageFile: u.usageFile });
  // 'fleet'  = a gateway hook exists but we do not listen: the fleet gateway serves this pool (the norm)
  // 'off'    = no gateway hook at all
  let gatewayState = (H.createHub || H.createGateway) ? 'fleet' : 'off';

  // balance rotation duty (per upstream)
  async function refreshOneBalanceFor(u) {
    if (!u.refreshBalance || u.balanceBusy) return;
    const accts = u.readAccounts().filter(u.rotatable);
    if (!accts.length) return;
    u.balanceBusy = true;
    try {
      let pick = accts[0];
      for (const a of accts) {
        const at = a.checked_at ? Date.parse(a.checked_at) : 0;
        const pt = pick.checked_at ? Date.parse(pick.checked_at) : 0;
        if (at < pt) pick = a;
      }
      const fresh = await u.refreshBalance(pick); // { ...merged record } or throw
      if (fresh) {
        appendAccount(u.accountsFile, fresh);
        emit('balance.ok', { upstream: u.id, email: pick.email, balance_usd: fresh.balance_usd ?? null });
      }
    } catch (err) {
      emit('balance.fail', { upstream: u.id, error: String(err?.message || err).slice(0, 120) });
    } finally {
      u.balanceBusy = false;
    }
  }

  // supply duty per upstream (supplyEnabled:false -> no replenishment checks
  // or batch spawns for that pool; panel, gateway and balance rotation keep
  // running)
  for (const u of upstreams) {
    if (u.supplyEnabled === false || !u.spawnBatch) continue;
    u.supply = createSupplyController({
      targetUsd: u.targetUsd,
      perAccountUsd: u.perAccountUsd,
      checkIntervalMs: u.supplyCheckSec * 1000,
      maxBatch: u.supplyMaxBatch,
      maxWorkers: u.supplyWorkers,
      balance: () => poolBalance(u.readAccounts(), poolOpts(u)),
      spawnBatch: u.spawnBatch,
      emit: (name, fields) => emit(name, { upstream: u.id, ...fields }),
    });
  }
  const supply = multi ? null : upstreams[0].supply;

  if (keeper) {
    const needGateway = !!(H.createHub || H.createGateway) && H.embedGateway === true;
    if (needGateway) {
      try {
        // Gatekeep: the embedded gateway MUST feed its ai.ok / ai.fail /
        // key.drained / pool.exhausted events back into the shared emit
        // channel, or the panel's live feed + spend window stay dark while
        // real calls happen (log: NOOP was silently swallowing them).
        const gwLog = {
          event: (name, fields) => emit(name, fields),
          info() {}, warn() {}, error() {}, debug() {}, setVerbose() {},
        };
        const srv = H.createHub
          ? H.createHub({ cfg: H.cfg, log: gwLog, upstreams }).server
          : H.createGateway({ cfg: H.cfg, log: gwLog, usagePath: H.usageFile }).server;
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(H.gatewayPort, '127.0.0.1', resolve);
        });
        gatewayState = 'up';
        emit('gateway.start', { port: H.gatewayPort, host: '127.0.0.1', embedded: true, upstreams: upstreams.length });
      } catch (e) {
        gatewayState = 'skipped';
        emit('gateway.skip', { port: H.gatewayPort, error: String((e && e.code) || e).slice(0, 80) });
      }
    }
  }

  let quitting = false;
  const restore = () => {
    releaseLock(join(root, 'data', '.watch-keeper.lock'), keeper);
    if (!tty) return;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
      process.stdin.pause();
    } catch { /* ignore */ }
    process.stdout.write(ansi.show + ansi.altOff);
  };
  if (tty) {
    process.stdout.write(ansi.altOn + ansi.hide);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'q' || key === '\u0003') quitting = true;
      });
    }
    process.on('exit', restore);
    process.on('SIGINT', () => { quitting = true; });
  }

  // Keeper duties are the reason a headless resident exists, so their timers HOLD
  // the process (ref'd). With the embedded gateway opt-in, an unref'd keeper would
  // exit after one frame and launchd would respawn it every few seconds.
  const timers = [];
  if (keeper) {
    timers.push(setInterval(() => { for (const u of upstreams) refreshOneBalanceFor(u); }, H.balanceRotateSec * 1000));
    if (upstreams.some((u) => u.supply)) {
      const healthFor = buildKeeperHealthFor(H, upstreams, emit);
      timers.push(setInterval(() => { keeperSupplyTick({ upstreams, healthFor }); }, 5_000));
    }
    if (H.holdOpen === false) for (const t of timers) t.unref?.();   // tests: return after the frame
  }
  process.on('SIGTERM', () => { quitting = true; });

  try {
    do {
      const nowMs = Date.now();
      const evts = readTail(H.eventsFile);
      const stats = windowStats(evts, nowMs, { windowMin: H.windowMin });
      const flight = inflight(evts);
      const { cols, rows } = termSize({ once: H.once });
      let upRows = null;
      if (multi) {
        upRows = upstreams.map((u) => {
          const accts = u.readAccounts();
          const balance = poolBalance(accts, poolOpts(u));
          const row = {
            id: u.id, accts, balance, targetUsd: u.targetUsd,
            supplyEnabled: u.supplyEnabled !== false,
            supply: { childPid: u.supply?.childPid ?? null, cooldownSec: u.supply?.cooldownSec ?? 0 },
            prevBalance: u.prevBalance,
          };
          u._row = row;
          return row;
        });
      }
      const accts = multi ? upRows.flatMap((r) => r.accts) : readAccounts();
      const ctx = {
        accts,
        // single mode: the displayed balance is a data-layer fact, computed here so
        // the render stays pure (null = ledger unreadable)
        ...(multi ? {} : { balance: poolBalance(accts, poolOpts(upstreams[0])) }),
        evts, stats, flight, now: nowMs, cols, rows, tty,
        gatewayState,
        keeper: {
          active: keeper,
          childPid: supply?.childPid ?? null,
          cooldownSec: supply?.cooldownSec ?? 0,
        },
      };
      if (upRows) ctx.upstreams = upRows;
      const frame = render(ctx, H);
      if (upRows) for (const u of upstreams) u.prevBalance = u._row.balance;

      if (tty) {
        process.stdout.write(ansi.clear + frame);
        const tEnd = Date.now() + 1000;
        while (!quitting && Date.now() < tEnd) await sleep(40);
      } else {
        process.stdout.write(frame);
        // Headless resident (launchd): one frame to the log, then stay alive for
        // the keeper duties until SIGTERM/SIGINT. Non-keeper headless = one frame.
        if (keeper && H.holdOpen !== false) {
          emit('watch.resident', { headless: true, upstreams: upstreams.length, gateway: gatewayState });
          while (!quitting) await sleep(500);
        }
        break;
      }
    } while (tty && !quitting);
  } finally {
    for (const t of timers) clearInterval(t);
    restore();
  }
}

/** Incremental ledger readers by usage file. The panel calls this once per frame
 *  and a real ledger is >1 MB, so a full re-parse per frame is not acceptable. */
const usageReaders = new Map();
function usageStateCached(usageFile) {
  if (!usageFile) return { state: 'missing', rows: [] };
  let reader = usageReaders.get(usageFile);
  if (!reader) { reader = createUsageReader(usageFile); usageReaders.set(usageFile, reader); }
  try { return reader.read(); } catch { return { state: 'unreadable', rows: [] }; }
}

/**
 * Displayed pool balance = authoritative anchors minus local spend since.
 * Returns null when the ledger is UNREADABLE: unknown spend must not render (or
 * drive supply) as "no spend" — that over-states the pool exactly when the
 * gateway has already stopped issuing its keys (pool.mjs fails closed on the
 * same condition). money()/moneyBook() print null as a dash.
 */
export function poolBalance(accounts, H) {
  const ledger = usageStateCached(H.usageFile);
  if (ledger.state === 'unreadable') return null;
  return accounts
    .filter((a) => a.status === 'verified')
    .reduce((s, a) => s + (displayedBalance(a, ledger.rows) ?? 0), 0);
}

