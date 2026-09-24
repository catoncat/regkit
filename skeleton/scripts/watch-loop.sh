#!/bin/sh
# Resident supervisor for the watcher (= panel + keeper + embedded gateway).
# Quitting the TUI (q) or a crash respawns in 2s. Real stop: touch data/.watch-stop
# (or Ctrl-C the pane job), then rm data/.watch-stop before next start.
cd "$(dirname "$0")/.." || exit 1
while [ ! -f data/.watch-stop ]; do
  env WATCH_ONCE=0 node src/watch.mjs
  echo "watcher exited ($?) — restarting in 2s (stop: touch data/.watch-stop)"
  sleep 2
done
rm -f data/.watch-stop
