// Generic config loader. Loads <root>/.env.local (gitignored) then merges
// process.env on top, and applies project defaults under a config object.
// Projects call makeConfigLoader with their default shape; regkit itself only
// reads the generic keys (mailboxCli etc.) it needs.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function projectRoot(importMetaUrl) {
  return join(dirname(fileURLToPath(importMetaUrl)), '..');
}

export function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Comma-separated env list -> cleaned array (strips leading '@'). */
export function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Build the config loader for one upstream.
 *
 * @param root      absolute project root (for .env.local lookup)
 * @param defaults  plain object of default values (may contain functions)
 * @returns function (overrides) -> cfg
 *
 * Env keys are read as-is (projects use their own <UPSTREAM>_* prefix via the
 * defaults object's env mapper). Overrides with undefined/'' are stripped so a
 * CLI parser can pass empty args without clobbering defaults.
 */
export function makeConfigLoader(root, defaults) {
  return function loadConfig(overrides = {}) {
    const env = { ...loadDotEnv(join(root, '.env.local')), ...process.env };
    const cfg = {};
    for (const [key, def] of Object.entries(defaults)) {
      cfg[key] = typeof def === 'function' ? def(env, root) : def;
    }
    for (const [key, v] of Object.entries(overrides)) {
      if (v !== undefined && v !== '') cfg[key] = v;
    }
    return cfg;
  };
}
