// fleet slice-2 tests: adopt / set-mode / plist rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPlist, adopt, setMode, loadFleetLocal, labelFor } from '../src/fleet.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fleet2-'));
const mkproj = (root, name, service) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'service.json'), JSON.stringify(service));
  return dir;
};

test('renderPlist: label, argv with process.execPath, cwd, keepalive, xml-escaped', () => {
  const xml = renderPlist({ label: 'com.regkit.fleet.alpha', cmd: 'node src/cli.mjs watch', cwd: '/Users/a & b/alpha', logPath: '/x/y.log' });
  assert.match(xml, /<string>com\.regkit\.fleet\.alpha<\/string>/);
  assert.ok(xml.includes('<string>' + process.execPath + '</string>'));
  assert.ok(xml.includes('<string>src/cli.mjs</string>') && xml.includes('<string>watch</string>'));
  assert.ok(xml.includes('/Users/a &amp; b/alpha'));
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(!xml.includes('EnvironmentVariables')); // no env -> no block
});

test('renderPlist: env becomes EnvironmentVariables (launchd PATH fix), xml-escaped', () => {
  const xml = renderPlist({ label: 'com.regkit.fleet.x', cmd: 'node a.mjs', cwd: '/x', logPath: '/x/y.log', env: { PATH: '/Users/a & b/bin:/usr/bin' } });
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.ok(xml.includes('<key>PATH</key>'));
  assert.ok(xml.includes('<string>/Users/a &amp; b/bin:/usr/bin</string>'));
});

test('adopt: allocates preferred port, writes fleet.local + plist, idempotent', async () => {
  const root = tmp();
  const proj = mkproj(root, 'alpha', { id: 'alpha', gateway: { port: 48791 }, resident: { cmd: 'node src/cli.mjs watch' } });
  const fleetFile = join(root, 'fleet.local.json');
  const plistPath = join(root, 'alpha.plist');

  const plan = await adopt({ unitDir: proj, fleetFile, plistPath });
  assert.equal(plan.port, 48791);
  assert.equal(plan.label, labelFor('alpha'));
  assert.ok(existsSync(plistPath));
  const fl = loadFleetLocal(fleetFile);
  assert.equal(fl.ports.alpha, 48791);
  assert.equal(fl.units.alpha.enabled, true);

  const again = await adopt({ unitDir: proj, fleetFile, plistPath });
  assert.equal(again.port, 48791); // same port kept
});

test('adopt: next free port when preferred is taken by another unit', async () => {
  const root = tmp();
  const p1 = mkproj(root, 'a', { id: 'aaa', gateway: { port: 48795 } });
  const p2 = mkproj(root, 'b', { id: 'bbb', gateway: { port: 48795 } });
  const fleetFile = join(root, 'fleet.local.json');
  await adopt({ unitDir: p1, fleetFile, plistPath: join(root, 'a.plist') });
  const plan2 = await adopt({ unitDir: p2, fleetFile, plistPath: join(root, 'b.plist') });
  assert.equal(plan2.port, 48780); // range scan skips the taken 48795
});

test('adopt: the resident gateway port is reserved, never handed to a unit', async () => {
  const root = tmp();
  // 48790 is FLEET_LOCAL_DEFAULTS.gatewayPort — the resident gateway is unit 0
  // and already bound there, so a unit preferring it must be moved (review P1).
  const proj = mkproj(root, 'a', { id: 'aaa', gateway: { port: 48790 } });
  const fleetFile = join(root, 'fleet.local.json');
  const plan = await adopt({ unitDir: proj, fleetFile, plistPath: join(root, 'a.plist') });
  assert.equal(plan.port, 48780);
  assert.equal(loadFleetLocal(fleetFile).ports.aaa, 48780);
});

test('adopt: dryRun writes nothing; missing service.json points at skeleton', async () => {
  const root = tmp();
  const proj = mkproj(root, 'ph', { id: 'beta' });
  const fleetFile = join(root, 'fleet.local.json');
  const plan = await adopt({ unitDir: proj, fleetFile, dryRun: true, plistPath: join(root, 'ph.plist') });
  assert.equal(plan.dry_run, true);
  assert.equal(existsSync(fleetFile), false);
  assert.equal(existsSync(join(root, 'ph.plist')), false);
  await assert.rejects(() => adopt({ unitDir: join(root, 'ghost'), fleetFile }), /service\.example\.json/);
});

test('setMode: toggles enabled, returns boot action, unknown unit throws', async () => {
  const root = tmp();
  const proj = mkproj(root, 'ot', { id: 'ot' });
  const fleetFile = join(root, 'fleet.local.json');
  await adopt({ unitDir: proj, fleetFile, plistPath: join(root, 'ot.plist') });

  const off = await setMode({ id: 'ot', mode: 'off', fleetFile });
  assert.equal(off.action, 'bootout');
  assert.equal(loadFleetLocal(fleetFile).units.ot.enabled, false);

  const auto = await setMode({ id: 'ot', mode: 'auto', fleetFile });
  assert.equal(auto.action, 'bootstrap');
  assert.equal(loadFleetLocal(fleetFile).units.ot.enabled, true);

  await assert.rejects(() => setMode({ id: 'ghost', mode: 'off', fleetFile }), /not adopted/);
  await assert.rejects(() => setMode({ id: 'ot', mode: ' sideways ', fleetFile }), /auto.*off/);
});
