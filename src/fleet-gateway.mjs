#!/usr/bin/env node
// fleet gateway: one port, one token, every declared pool.
// Resident via launchd (fleet adopt installs it); restart picks up new declarations,
// health.json transitions apply live via the gate (no restart needed).

import { createLogger } from './logger.mjs';
import { buildFleetHub } from './fleet-hub.mjs';
import { loadFleetLocal, DEFAULT_FLEET_FILE } from './fleet-decl.mjs';

const fleetFile = process.env.FLEET_FILE || DEFAULT_FLEET_FILE;
const fleetLocal = loadFleetLocal(fleetFile);
const port = Number(process.env.FLEET_GATEWAY_PORT || fleetLocal.gatewayPort);
const host = process.env.FLEET_GATEWAY_HOST || '127.0.0.1';
const log = createLogger({ eventsFile: process.env.FLEET_EVENTS || 'data/fleet-events.jsonl', level: 'info' });

const roots = process.env.FLEET_ROOTS ? process.env.FLEET_ROOTS.split(',') : undefined;
const hub = await buildFleetHub({ log, fleetFile, ...(roots ? { roots } : {}) });

try {
  await new Promise((resolve, reject) => {
    hub.server.once('error', reject);
    hub.server.listen(port, host, resolve);
  });
} catch (err) {
  // launchd restarts us; a stack trace per attempt is noise, one line says what to do.
  const busy = err?.code === 'EADDRINUSE';
  log.event('fleet.gateway.fail', { port, host, code: err?.code ?? null, error: String(err?.message || err).slice(0, 120) });
  console.error(busy
    ? 'fleet gateway: port ' + host + ':' + port + ' is busy — another fleet gateway (or a stale one) is listening; lsof -nP -iTCP:' + port + ' -sTCP:LISTEN'
    : 'fleet gateway: cannot listen on ' + host + ':' + port + ': ' + (err?.message || err));
  process.exit(1);
}
log.event('fleet.gateway.start', { port, host });
console.log('fleet gateway listening on http://' + host + ':' + port + '/v1');
