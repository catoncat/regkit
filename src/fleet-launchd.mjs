// fleet-launchd.mjs — the one place the fleet touches launchd. Plist rendering is pure and tested; the
// launchctl wrappers are thin external side effects.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const LABEL_PREFIX = 'com.regkit.fleet.';
export const labelFor = (id) => LABEL_PREFIX + id;
export const plistPathFor = (id) => join(homedir(), 'Library', 'LaunchAgents', labelFor(id) + '.plist');

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a launchd plist. keepAlive=true for resident services; pass
 *  intervalSec for interval-driven jobs (StartInterval, no KeepAlive).
 *  Node resolves to process.execPath. `env` becomes EnvironmentVariables —
 *  launchd jobs get a near-empty PATH by default, so anything that shells
 *  out to user-installed CLIs (cloud-mail et al.) needs PATH passed in. */
export function renderPlist({ label, cmd, cwd, logPath, keepAlive = true, intervalSec = null, env = null }) {
  const tokens = String(cmd).split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('renderPlist: empty cmd');
  const argv = (tokens[0] === 'node' ? [process.execPath, ...tokens.slice(1)] : tokens).map(
    (t) => '    <string>' + escapeXml(t) + '</string>',
  ).join('\n');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + escapeXml(label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    argv,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + escapeXml(cwd) + '</string>',
  ];
  if (env && Object.keys(env).length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of Object.entries(env)) {
      lines.push('    <key>' + escapeXml(k) + '</key>', '    <string>' + escapeXml(v) + '</string>');
    }
    lines.push('  </dict>');
  }
  if (keepAlive) lines.push('  <key>KeepAlive</key>', '  <true/>');
  lines.push('  <key>RunAtLoad</key>', '  <true/>');
  if (intervalSec != null) lines.push('  <key>StartInterval</key>', '  <integer>' + Number(intervalSec) + '</integer>');
  lines.push(
    '  <key>StandardOutPath</key>',
    '  <string>' + escapeXml(logPath) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + escapeXml(logPath) + '</string>',
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

/** launchctl wrappers — external side effects, kept thin (not unit-tested). */
export async function bootstrapUnit({ id, plistPath = null } = {}) {
  const uid = process.getuid?.();
  if (uid == null) throw new Error('no uid on this platform');
  const path = plistPath ?? plistPathFor(id);
  await execFileP('launchctl', ['bootout', 'gui/' + uid + '/' + labelFor(id)]).catch(() => {});
  return execFileP('launchctl', ['bootstrap', 'gui/' + uid, path]);
}
export async function bootoutUnit({ id } = {}) {
  const uid = process.getuid?.();
  if (uid == null) throw new Error('no uid on this platform');
  return execFileP('launchctl', ['bootout', 'gui/' + uid + '/' + labelFor(id)]).catch(() => {});
}

/** launchctl list -> Set of loaded labels (injectable for tests). */
export async function listLaunchdLabels() {
  const { stdout } = await execFileP('launchctl', ['list']);
  return new Set(stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/).pop()).filter(Boolean));
}
