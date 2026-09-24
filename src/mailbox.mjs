// Mailbox polling via the cloud-mail CLI (provider-neutral contract):
//   <cli> messages --email <addr> --limit N  -> JSON { items: [...] }
// Each item carries text_body/html_body/subject/sender, and cloud-mail
// pre-extracts `code` when the provider classifies one.
//
// Extraction is parameterized: one upstream wants a 6-digit code from a given
// sender, another wants a verify link from a given host. Projects pass an
// `extract(items) -> payload | null` function and `waitFor` polls until it
// yields something or times out.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Mailbox {
  constructor({ cli = 'cloud-mail' } = {}) {
    this.cli = cli;
  }

  async messages(email, limit = 10, timeoutMs = 20000) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          this.cli,
          ['messages', '--email', email, '--limit', String(limit)],
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        );
        const data = JSON.parse(stdout);
        const items = data.items || [];
        if (!Array.isArray(items)) throw new Error('mailbox response missing items array');
        return items;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(1200); // transient CLI/TLS noise — retry
      }
    }
    throw lastErr;
  }

  /**
   * Poll until `extract(items)` returns a truthy payload, or timeout.
   * `say` is a plain fn OR a logger object — a wrong-shaped callback used to
   * surface as a bogus timeout, so coerce defensively.
   */
  async waitFor(email, extract, { timeoutMs = 120000, intervalMs = 3000, say = () => {} } = {}) {
    const log = typeof say === 'function' ? say : () => {};
    const deadline = Date.now() + timeoutMs;
    let seen = 0, okPolls = 0, lastErr = null;
    while (Date.now() < deadline) {
      let items = [];
      try {
        items = await this.messages(email, 10);
        okPolls++;
      } catch (err) {
        lastErr = err;
        log(`[mailbox] poll error: ${err.message}`);
      }
      if (items.length > seen) log(`[mailbox] ${items.length} message(s) for ${email}`);
      seen = Math.max(seen, items.length);
      const payload = extract(items);
      if (payload) return payload;
      await sleep(intervalMs);
    }
    // 全程 poll 都失败(CLI 不存在/环境不对)不是「没等到邮件」——点名根因,
    // 不然 spawn ENOENT 会被误报成收件超时,把配置/环境问题藏成上游问题。
    if (okPolls === 0 && lastErr) {
      throw new Error(`mailbox poll never succeeded within ${Math.round(timeoutMs / 1000)}s for ${email}: ${lastErr.message}`);
    }
    throw new Error(`no matching mail within ${Math.round(timeoutMs / 1000)}s for ${email}`);
  }
}

/** Code extractor factory: 6-digit code whose sender endsWith `senderSuffix`
 *  and subject matches `subjectRe`. Resistant to catch-all noise. */
export function makeCodeExtractor({ senderSuffix, subjectRe = /verification code/i }) {
  return function extractCode(items) {
    for (const item of items) {
      const sender = String(item.sender || '');
      const subject = String(item.subject || '');
      const code = item.code ?? codeFromBody(item.text_body || item.html_body || '');
      if (!code || !/^\d{6}$/.test(String(code))) continue;
      if (senderSuffix && !sender.endsWith(senderSuffix)) continue;
      if (subjectRe && !subjectRe.test(subject)) continue;
      return String(code);
    }
    return null;
  };
}

/** Link extractor factory: first URL matching `host` (+ optional path prefix). */
export function makeLinkExtractor({ host, pathPrefix = '' }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`https://${esc(host)}${esc(pathPrefix)}[^\\s"'<>]*`);
  return function extractLink(items) {
    for (const item of items) {
      const body = [item.text_body, item.html_body].join('\n');
      const m = body.match(re);
      if (m) return m[0];
    }
    return null;
  };
}

/** Fallback extraction straight from the body. */
export function codeFromBody(body) {
  const m = body.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

/** Mail provider factory: 'cloud-mail' (default) or 'none' (always null).
 *  Anything else throws so misconfiguration is loud. */
export function createMailProvider(mode = 'cloud-mail', { cli = 'cloud-mail', extract = null } = {}) {
  if (!mode || mode === 'none') {
    return { name: 'none', async waitPayload() { return null; } };
  }
  if (mode === 'cloud-mail') {
    if (!extract) throw new Error('createMailProvider("cloud-mail") requires an extract(items) function');
    const mb = new Mailbox({ cli });
    return {
      name: 'cloud-mail',
      waitPayload: async (email, opts) => mb.waitFor(email, extract, opts),
    };
  }
  throw new Error(`unknown mailMode '${mode}' (expected 'none' | 'cloud-mail')`);
}
