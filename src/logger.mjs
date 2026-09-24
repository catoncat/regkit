// Dual-channel logger built for fast upstream-strategy tuning.
//
//   stderr  : human-readable, timestamped, grep-friendly (always on)
//   events  : data/events.jsonl — one JSON object per upstream interaction,
//             append-only, 0600. This file is THE diagnostic surface: when
//             success rates drop, group by klass/status/path and the new wall
//             names itself (new protection = new error text / new status).
//
// Levels: debug < info < warn < error. --verbose raises stderr to debug;
// events.jsonl always records everything including debug (disk is cheap,
// blind spots are not).

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_EVENTS_BYTES = 50 * 1024 * 1024;

export function createLogger({ eventsFile = 'data/events.jsonl', level = 'info', quiet = false } = {}) {
  let stderrLevel = LEVELS[level] ?? LEVELS.info;

  if (eventsFile) mkdirSync(dirname(eventsFile), { recursive: true, mode: 0o700 });
  // rotate at 50 MB so one bad batch cannot make the file unopenable
  if (eventsFile && existsSync(eventsFile) && statSync(eventsFile).size > MAX_EVENTS_BYTES) {
    try {
      renameSync(eventsFile, eventsFile.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
    } catch { /* rotation is best-effort */ }
  }

  function write(levelName, line) {
    if (!quiet && (LEVELS[levelName] ?? 0) >= stderrLevel) {
      const ts = new Date().toISOString().slice(11, 23);
      process.stderr.write(`${ts} ${levelName.padEnd(5)} ${line}\n`);
    }
  }

  function event(name, fields = {}) {
    if (!eventsFile) return;
    try {
      appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), event: name, ...fields }) + '\n', { mode: 0o600 });
    } catch {
      // never let logging kill a registration
    }
  }

  return {
    debug: (line) => write('debug', line),
    info: (line) => write('info', line),
    warn: (line) => write('warn', line),
    error: (line) => write('error', line),
    event,
    setVerbose: () => { stderrLevel = LEVELS.debug; },
    get verbose() { return stderrLevel <= LEVELS.debug; },
  };
}

/** No-op logger for headless duty loops that must not spam stderr. */
export const NOOP_LOG = Object.freeze({
  debug() {}, info() {}, warn() {}, error() {}, event() {}, setVerbose() {}, verbose: false,
});
