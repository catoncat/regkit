// Global signup pacer — serializes the submission POST across workers and
// adapts the gap AIMD-style. Concurrency does not buy signup throughput
// when the server keeps a shared submission bucket; only the pace of the
// submit step matters. Everything after submit (mail RTT, claim, key) is
// per-account and stays parallel.
//
// Defaults are intentionally conservative; each upstream should pass its own
// measured min/start/max via config.

export function createSignupPacer({ minGapMs = 4000, startGapMs = 15000, maxGapMs = 240000, log = () => {} } = {}) {
  let gap = startGapMs;
  let nextAt = 0;
  let chain = Promise.resolve();
  const stats = { slots: 0, ok: 0, fast: 0, other: 0 };

  /** Reserve the next submit slot (FIFO across workers). Resolves when it's your turn. */
  function slot() {
    const run = chain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextAt - now);
      if (waitMs > 0) {
        log(`[pace] waiting ${(waitMs / 1000).toFixed(1)}s before submit (gap ${(gap / 1000).toFixed(1)}s)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      nextAt = Date.now() + gap;
      stats.slots++;
    });
    chain = run.catch(() => {});
    return run;
  }

  /** Feed back the outcome class of a submit so the gap adapts. */
  function report(klass) {
    if (klass === 'ok') {
      stats.ok++;
      gap = Math.max(minGapMs, Math.round(gap * 0.7));
    } else if (klass === 'rate_fast') {
      stats.fast++;
      gap = Math.min(maxGapMs, Math.round(gap * 2));
      // The shared bucket is empty right now; make the next slot wait a full
      // gap even if the previous reservation was already consumed.
      nextAt = Math.max(nextAt, Date.now() + gap);
      log(`[pace] rate wall -> gap now ${(gap / 1000).toFixed(1)}s`);
    } else {
      stats.other++;
    }
  }

  return { slot, report, stats, get gapMs() { return gap; } };
}

/** No-op pacer for single-shot CLI runs. */
export function nullPacer() {
  return { slot: async () => {}, report: () => {}, stats: {}, gapMs: 0 };
}
