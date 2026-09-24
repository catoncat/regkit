// Human-style identity generation — parameterized word lists.
//
// Projects pass their own first/last name lists (and optional company
// adjective/noun lists). The generator produces realistic mailbox local-parts
// like emma.chen, liam.walker92 — no project prefix, no consecutive hex, no
// shared template a risk engine could fingerprint. Weighted templates are
// rolled once per call.

/** Build the identity generator for one upstream.
 *  @param words { first[], last[], adj?[], noun?[] }
 *  @returns { generateLocalPart, generateFullName, generateCompanyName, generatePassword } */
export function makeNames(words) {
  const FIRST = words.first || [];
  const LAST = words.last || [];
  const ADJ = words.adj || [];
  const NOUN = words.noun || [];
  if (!FIRST.length || !LAST.length) throw new Error('makeNames requires first[] and last[] word lists');

  const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

  /** 2-3 digit random number. */
  function digits(rng, min = 2, max = 3) {
    const n = min + Math.floor(rng() * (max - min + 1));
    const base = 10 ** (n - 1);
    return String(Math.floor(base + rng() * (9 * base)));
  }

  /** Human-style local part: emma.chen, liam.walker92, sarahmiller ... */
  function generateLocalPart(used = new Set(), rng = Math.random) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const t = rng();
      let local;
      if (t < 0.28) local = `${pick(FIRST, rng)}.${pick(LAST, rng)}`;
      else if (t < 0.52) local = `${pick(FIRST, rng)}.${pick(LAST, rng)}${digits(rng)}`;
      else if (t < 0.66) local = `${pick(FIRST, rng)}${pick(LAST, rng)}`;
      else if (t < 0.78) local = `${pick(FIRST, rng)}${pick(LAST, rng)}${digits(rng)}`;
      else if (t < 0.88) local = `${pick(FIRST, rng)}.${pick(LAST, rng)}${year(rng)}`;
      else if (t < 0.94) local = `${pick(FIRST, rng)[0]}.${pick(LAST, rng)}${digits(rng)}`;
      else if (t < 0.98) local = `${pick(FIRST, rng)}_${digits(rng, 2, 2)}`;
      else local = `${pick(FIRST, rng)}${digits(rng, 1, 2)}`;
      if (local.length > 40) continue;
      if (!used.has(local)) { used.add(local); return local; }
    }
    // Extremely unlikely (tiny wordlists + dedup). Fall back to name+digits.
    const local = `${pick(FIRST, rng)}.${pick(LAST, rng)}${digits(rng, 3, 3)}`;
    if (!used.has(local)) used.add(local);
    return local;
  }

  /** Birth-year style suffix: 1975-2005. */
  function year(rng) {
    return String(1975 + Math.floor(rng() * 31));
  }

  function generateFullName(rng = Math.random) {
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    return `${cap(pick(FIRST, rng))} ${cap(pick(LAST, rng))}`;
  }

  function generateCompanyName(rng = Math.random) {
    if (!ADJ.length || !NOUN.length) return null;
    const name = pick(ADJ, rng)[0].toUpperCase() + pick(ADJ, rng).slice(1);
    return `${name} ${pick(NOUN, rng)}`;
  }

  /** Strong password (>=20 chars). */
  function generatePassword(rng = Math.random) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    let out = '';
    for (let i = 0; i < 20; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
    return out;
  }

  return { generateLocalPart, generateFullName, generateCompanyName, generatePassword };
}

/**
 * Stable pool password — NOT random. One shared passphrase lives in
 * data/pool-password (0600, gitignored). Every new registration uses it so a
 * lost accounts.jsonl can always be rebuilt by re-logging-in every known email
 * (random per-account passwords make funded accounts unrecoverable once the
 * file is lost). Override via env for tests.
 */
export function poolPassword(root, { env = process.env, envKey, prefix = 'Pool-' } = {}) {
  if (env[envKey]) return env[envKey];
  const file = join(root, 'data', 'pool-password');
  try {
    const v = readFileSync(file, 'utf8').trim();
    if (v) return v;
  } catch { /* first run */ }
  const v = prefix + Math.random().toString(36).slice(2, 12) + '!9';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, v + String.fromCharCode(10), { mode: 0o600 });
  return v;
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
