// Turnstile via the cfsolve `challenge` binary (zero npm deps, same idea as mailbox):
//   challenge --page <url> <empty-dir> --solve --fingerprint <profile.json>
//       [--sitekey K] [--action A] [--cdata C] [--blank-page] [--proxy URL]
// stdout is one line: the widget token, or `cf_clearance=<value>` for a
// challenge page. Progress stays on stderr. The default `cfsolve` binary is
// the offline deobfuscator — point RH_CFSOLVE_BIN at `challenge`.
//
// The proxy egress must be the one the later business request uses. A
// cf_clearance cookie also needs that request's TLS fingerprint and
// User-Agent to match the profile; a widget token usually only needs the IP.
// User-Agent is not on stdout; it is read from transport.headers in the profile.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

export function resolveCfsolve({ binary, profile } = {}) {
  return {
    binary: binary != null ? binary : (process.env.RH_CFSOLVE_BIN || 'challenge'),
    profile: profile != null ? profile : (process.env.RH_CFSOLVE_PROFILE || null),
  };
}

export function userAgentFromProfile(data) {
  const headers = data?.transport?.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'user-agent' && value) return String(value);
  }
  return '';
}

function checkProxy(proxy) {
  if (!proxy) return;
  let url;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(`proxy 不是 URL: ${proxy}`);
  }
  if (!PROXY_SCHEMES.has(url.protocol) || !url.hostname) {
    throw new Error(`proxy 只接受 http/https/socks5/socks5h 且必须带 host: ${proxy}`);
  }
}

/** Argv after the program name. Pure: no process, no filesystem. */
export function buildCfsolveArgs({
  pageUrl, outDir, profile, sitekey = null, proxy = null,
  action = null, cdata = null, blankPage = false,
} = {}) {
  if (!pageUrl) throw new Error('pageUrl 不能为空');
  if (!profile) throw new Error('fingerprint profile 不能为空');
  if (!outDir) throw new Error('outDir 不能为空');
  if ((action || cdata || blankPage) && !sitekey) {
    throw new Error('action、cdata、blankPage 都要求 sitekey');
  }
  checkProxy(proxy);
  const args = ['--page', pageUrl, outDir, '--solve', '--fingerprint', profile];
  if (sitekey) args.push('--sitekey', sitekey);
  if (action) args.push('--action', action);
  if (cdata) args.push('--cdata', cdata);
  if (blankPage) args.push('--blank-page');
  if (proxy) args.push('--proxy', proxy);
  return args;
}

/** Last non-empty stdout line. Progress is on stderr and never arrives here. */
export function parseCfsolveStdout(stdout) {
  let line = '';
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    if (raw.trim()) line = raw.trim();
  }
  if (!line) throw new Error('cfsolve 没有输出 token');
  const prefix = 'cf_clearance=';
  if (line.startsWith(prefix)) {
    const value = line.slice(prefix.length);
    if (!value) throw new Error('cfsolve 输出了空的 cf_clearance');
    return { token: '', cfClearance: value, userAgent: '' };
  }
  return { token: line, cfClearance: '', userAgent: '' };
}

export function explainCfsolveFailure(err, binary, timeoutMs) {
  if (err?.code === 'ENOENT') {
    return new Error(`找不到 cfsolve 二进制 ${binary};设置 RH_CFSOLVE_BIN`);
  }
  if (err?.killed || /timed out/i.test(String(err?.message || ''))) {
    return new Error(`cfsolve 超时(${Math.round(timeoutMs / 1000)}s)`);
  }
  const tail = String(err?.stderr || err?.stdout || err?.message || '').trim().slice(-800);
  return new Error(`cfsolve 退出 ${err?.code ?? '?'}: ${tail}`);
}

async function defaultRun(binary, args, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout ?? '');
  } catch (err) {
    throw explainCfsolveFailure(err, binary, timeoutMs);
  }
}

async function readProfile(profile) {
  let text;
  try {
    text = await readFile(profile, 'utf8');
  } catch (err) {
    throw new Error(`fingerprint profile 不存在或不可读: ${profile}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`无法读取 profile ${profile}: ${err.message}`);
  }
}

export class TurnstileSolver {
  constructor({ binary, profile, timeoutMs = 120000, run = null } = {}) {
    const resolved = resolveCfsolve({ binary, profile });
    this.binary = resolved.binary;
    this.profile = resolved.profile;
    this.timeoutMs = timeoutMs;
    this.run = run || defaultRun;
  }

  /**
   * @returns {Promise<{token: string, cfClearance: string, userAgent: string}>}
   * The field that was not produced is "".
   * `outDir` is kept for the caller; otherwise a temp dir is removed afterwards.
   * proxy is never taken from the environment.
   */
  async solve({
    pageUrl, sitekey = null, proxy = null, action = null, cdata = null,
    blankPage = false, outDir = null, profile = null, binary = null, timeoutMs = null,
  } = {}) {
    const bin = binary ?? this.binary;
    const prof = profile ?? this.profile;
    const timeout = timeoutMs ?? this.timeoutMs;
    if (!prof) throw new Error('未配置 fingerprint profile;设置 RH_CFSOLVE_PROFILE 或传入 profile');
    if (!bin) throw new Error('binary 不能为空');
    const userAgent = userAgentFromProfile(await readProfile(prof));
    const owned = outDir == null;
    const directory = outDir ?? await mkdtemp(join(tmpdir(), 'rk-cfsolve-'));
    try {
      const args = buildCfsolveArgs({
        pageUrl, outDir: directory, profile: prof,
        sitekey: sitekey || null, proxy, action, cdata, blankPage,
      });
      const stdout = await this.run(bin, args, timeout);
      const parsed = parseCfsolveStdout(stdout);
      parsed.userAgent = userAgent;
      return parsed;
    } finally {
      if (owned) await rm(directory, { recursive: true, force: true });
    }
  }
}

export function solveTurnstile(opts = {}) {
  return new TurnstileSolver({
    binary: opts.binary,
    profile: opts.profile,
    timeoutMs: opts.timeoutMs,
  }).solve(opts);
}
