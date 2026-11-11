// cfsolve argv / stdout contract. The challenge binary is not executed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCfsolve, userAgentFromProfile, buildCfsolveArgs, parseCfsolveStdout,
  explainCfsolveFailure, TurnstileSolver, solveTurnstile,
} from '../src/turnstile.mjs';

test('resolveCfsolve: explicit values beat RH_CFSOLVE_*', () => {
  const prevBin = process.env.RH_CFSOLVE_BIN;
  const prevProfile = process.env.RH_CFSOLVE_PROFILE;
  process.env.RH_CFSOLVE_BIN = '/env/challenge';
  process.env.RH_CFSOLVE_PROFILE = '/env/p.json';
  try {
    assert.deepEqual(resolveCfsolve(), { binary: '/env/challenge', profile: '/env/p.json' });
    assert.deepEqual(resolveCfsolve({ binary: '/kw/challenge', profile: '/kw/p.json' }), {
      binary: '/kw/challenge', profile: '/kw/p.json',
    });
  } finally {
    if (prevBin == null) delete process.env.RH_CFSOLVE_BIN;
    else process.env.RH_CFSOLVE_BIN = prevBin;
    if (prevProfile == null) delete process.env.RH_CFSOLVE_PROFILE;
    else process.env.RH_CFSOLVE_PROFILE = prevProfile;
  }
});

test('buildCfsolveArgs names the widget and rejects flags that need a sitekey', () => {
  assert.deepEqual(buildCfsolveArgs({
    pageUrl: 'https://auth.example/sign-up',
    outDir: '/tmp/out',
    profile: 'profiles/safari.json',
    sitekey: '0x4AAA',
    proxy: 'http://127.0.0.1:8080',
    action: 'login',
    cdata: 'abc',
    blankPage: true,
  }), [
    '--page', 'https://auth.example/sign-up', '/tmp/out',
    '--solve', '--fingerprint', 'profiles/safari.json',
    '--sitekey', '0x4AAA', '--action', 'login', '--cdata', 'abc',
    '--blank-page', '--proxy', 'http://127.0.0.1:8080',
  ]);
  const challenge = buildCfsolveArgs({
    pageUrl: 'https://example/', outDir: '/tmp/out', profile: 'p.json',
  });
  assert.equal(challenge.includes('--sitekey'), false);
  assert.equal(challenge.includes('--blank-page'), false);
  assert.throws(() => buildCfsolveArgs({
    pageUrl: 'https://example/', outDir: '/tmp/out', profile: 'p.json', action: 'login',
  }), /sitekey/);
  assert.throws(() => buildCfsolveArgs({
    pageUrl: 'https://example/', outDir: '/tmp/out', profile: 'p.json',
    sitekey: 'k', proxy: 'ftp://h',
  }), /proxy/);
});

test('parseCfsolveStdout reads a token or cf_clearance and ignores earlier lines', () => {
  assert.deepEqual(parseCfsolveStdout('noise\n0.token-value\n'), {
    token: '0.token-value', cfClearance: '', userAgent: '',
  });
  assert.deepEqual(parseCfsolveStdout('cf_clearance=abc.def'), {
    token: '', cfClearance: 'abc.def', userAgent: '',
  });
  assert.throws(() => parseCfsolveStdout('  \n'), /没有输出/);
  assert.throws(() => parseCfsolveStdout('cf_clearance='), /空的 cf_clearance/);
});

test('userAgentFromProfile and explainCfsolveFailure', () => {
  assert.equal(userAgentFromProfile({ transport: { headers: { 'User-Agent': 'Safari/26' } } }), 'Safari/26');
  assert.equal(userAgentFromProfile({}), '');
  assert.match(explainCfsolveFailure({ code: 'ENOENT' }, '/bin/challenge', 120000).message, /RH_CFSOLVE_BIN/);
  assert.match(explainCfsolveFailure({ killed: true }, '/bin/challenge', 120000).message, /超时\(120s\)/);
  assert.match(explainCfsolveFailure({ code: 2, stderr: 'Error: Rejected' }, '/bin/challenge', 1000).message, /Rejected/);
});

async function withProfile(fn) {
  const root = await mkdtemp(join(tmpdir(), 'rk-cfsolve-test-'));
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ transport: { headers: { 'User-Agent': 'TestUA/1' } } }));
  try {
    await fn(root, profile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('TurnstileSolver.solve returns the token and removes its work dir', async () => {
  await withProfile(async (_root, profile) => {
    let argv = null;
    let seenDir = null;
    const solver = new TurnstileSolver({
      binary: '/bin/challenge',
      profile,
      run: async (bin, args) => {
        argv = [bin, ...args];
        seenDir = args[2];
        return 'token-from-cli\n';
      },
    });
    const got = await solver.solve({
      pageUrl: 'https://auth.example/sign-up',
      sitekey: '0x4AAA',
      proxy: 'socks5h://127.0.0.1:1080',
    });
    assert.equal(argv[0], '/bin/challenge');
    assert.equal(argv.includes('--sitekey'), true);
    assert.equal(argv.includes('socks5h://127.0.0.1:1080'), true);
    assert.deepEqual(got, { token: 'token-from-cli', cfClearance: '', userAgent: 'TestUA/1' });
    await assert.rejects(readDirExists(seenDir));
  });
});

async function readDirExists(dir) {
  const { stat } = await import('node:fs/promises');
  await stat(dir);
}

test('TurnstileSolver keeps a caller-owned directory and parses clearance', async () => {
  await withProfile(async (root, profile) => {
    const solver = new TurnstileSolver({
      profile,
      run: async () => 'cf_clearance=cookie-value\n',
    });
    const got = await solver.solve({ pageUrl: 'https://example/', outDir: root });
    assert.equal(got.cfClearance, 'cookie-value');
    assert.equal(got.token, '');
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(root)).isDirectory(), true);
  });
});

test('solveTurnstile fails before spawn when the profile is unset', async () => {
  const prev = process.env.RH_CFSOLVE_PROFILE;
  delete process.env.RH_CFSOLVE_PROFILE;
  try {
    await assert.rejects(
      () => solveTurnstile({ pageUrl: 'https://example/' }),
      /RH_CFSOLVE_PROFILE/,
    );
  } finally {
    if (prev == null) delete process.env.RH_CFSOLVE_PROFILE;
    else process.env.RH_CFSOLVE_PROFILE = prev;
  }
});
