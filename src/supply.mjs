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

export function createSupplyController(hooks) {
  const {
    targetUsd,
    perAccountUsd,
    checkIntervalMs = 30_000,
    maxBatch = 24,
    maxWorkers = 8,
    balance,           // () -> number | null (displayed pool balance; null = unknown)
    spawnBatch,        // (need, workers) -> ChildProcess
    emit = () => {},
  } = hooks;

  let child = null;
  let lastEnd = Date.now();

  function check() {
    if (child) return;
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
    child = proc;
    proc.once('exit', () => { child = null; lastEnd = Date.now(); });
  }

  return {
    check,
    get childPid() { return child?.pid ?? null; },
    /** remaining cooldown seconds before the next check can spawn (for display) */
    get cooldownSec() { return Math.max(0, (lastEnd + checkIntervalMs - Date.now()) / 1000); },
  };
}
