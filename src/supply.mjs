// Threshold replenishment: when the displayed pool balance drops below the
// target, spawn one register batch as a child process. Single-flight — never
// two batches at once, and never within checkIntervalMs of the last exit.
//
// Project injects `balance()` and `spawnBatch(need, workers)` (which must
// return the spawned ChildProcess — the controller hooks its 'exit' to clear
// the single-flight guard). The pacing machinery is generic.
//
// balance() may return null = UNKNOWN (the ledger cannot be read). Unknown is
// not "below target": the controller holds (no spawn), says so once per check
// interval via supply.hold, and re-evaluates on the next interval.
//
// Circuit breaker (zero-yield stall): registering is only worth a spawn if it
// MOVES the pool balance. An account minted with no credit changes nothing, and
// from inside this loop "slow batch" and "the upstream stopped granting credit"
// look identical — so a loop that only compares balance against target spends
// every batch forever on a channel that cannot yield, filling the pool with
// accounts worth $0. After `stallBatches` consecutive batches that ended with no
// gain, the loop stops and emits supply.stall. It re-arms when the balance rises
// above the level it stalled at (credit arrived by another path) or when the
// process restarts — a human decision, not a timer that keeps spending on a dead
// channel.

// A balance move smaller than this is accounting noise, not credit.
const EPS_USD = 0.01;

export function createSupplyController(hooks) {
  const {
    targetUsd,
    perAccountUsd,
    checkIntervalMs = 30_000,
    maxBatch = 24,
    maxWorkers = 8,
    stallBatches = 3,
    balance,           // () -> number | null (displayed pool balance; null = unknown)
    spawnBatch,        // (need, workers) -> ChildProcess
    emit = () => {},
  } = hooks;

  let child = null;
  let lastEnd = Date.now();
  let baseline = null;      // balance when the in-flight batch was spawned
  let zeroYield = 0;        // consecutive batches that added no credit
  let stalledAt = null;     // balance the breaker opened at; null = closed

  /** A finished batch either paid for itself (reset) or adds to the stall count. */
  function accountBatch(after) {
    if (after == null || baseline == null) return;   // unknown balance proves nothing
    if (after > baseline + EPS_USD) { zeroYield = 0; return; }
    if (++zeroYield < stallBatches || stalledAt != null) return;
    stalledAt = after;
    emit('supply.stall', { balance_usd: after, target: targetUsd, batches: zeroYield });
  }

  function check() {
    if (child) return;
    if (stalledAt != null) {
      const moved = balance();
      if (moved == null || Number.isNaN(moved) || moved <= stalledAt + EPS_USD) return;
      emit('supply.resume', { balance_usd: moved, was_usd: stalledAt, target: targetUsd });
      stalledAt = null; zeroYield = 0; baseline = null;
    }
    if (Date.now() - lastEnd < checkIntervalMs) return;
    const bal = balance();
    if (bal == null || Number.isNaN(bal)) {
      lastEnd = Date.now();   // hold for one interval, do not spam the event stream
      emit('supply.hold', { reason: 'balance-unknown', target: targetUsd });
      return;
    }
    if (bal >= targetUsd) return;
    const need = Math.min(maxBatch, Math.ceil((targetUsd - bal) / perAccountUsd));
    const workers = Math.min(maxWorkers, need);
    emit('supply.spawn', { balance_usd: bal, target: targetUsd, count: need, workers });
    const proc = spawnBatch(need, workers);
    if (!proc) return;
    baseline = bal;
    child = proc;
    proc.once('exit', () => {
      child = null;
      lastEnd = Date.now();
      accountBatch(balance());
    });
  }

  return {
    check,
    get childPid() { return child?.pid ?? null; },
    /** remaining cooldown seconds before the next check can spawn (for display) */
    get cooldownSec() { return Math.max(0, (lastEnd + checkIntervalMs - Date.now()) / 1000); },
    /** open-breaker facts for the panel; null = spawning normally */
    get stalled() { return stalledAt == null ? null : { atUsd: stalledAt, batches: zeroYield }; },
  };
}
