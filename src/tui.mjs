// Zero-dependency ANSI TUI helpers for the watch panel. All pure functions;
// rendering happens only when a frame is packed.

export const ansi = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
  hide: '\x1b[?25l', show: '\x1b[?25h',
  altOn: '\x1b[?1049h', altOff: '\x1b[?1049l',
  clear: '\x1b[H\x1b[J', eraseLine: '\x1b[K',
};

export function paint(enabled, code, s) {
  if (!enabled || !code) return s;
  return code + s + ansi.reset;
}

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function termSize({ once = false, fallbackCols = 80, fallbackRows = 24 } = {}) {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || fallbackCols;
  const rows = process.stdout.rows || Number(process.env.LINES) || fallbackRows;
  return { cols: Math.max(48, cols), rows: once ? 40 : Math.max(12, rows) };
}

/** Clip a line to cols, preserving ANSI color codes. */
export function clipLine(line, cols) {
  if (stripAnsi(line).length <= cols) return line;
  let out = '';
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (n >= cols - 1) break;
    out += line[i];
    n++;
  }
  return out;
}

/** Pack exactly rows lines; erase-to-EOL every row so old frames never ghost. */
export function packFrame(contentLines, footerLine, cols, rows) {
  const foot = clipLine(footerLine || '', cols);
  const budget = Math.max(1, rows - 1);
  const body = contentLines.map((l) => clipLine(l, cols)).slice(0, budget);
  while (body.length < budget) body.push('');
  return [...body, foot].map((l) => l + ansi.eraseLine).join('\n');
}

export function padVisible(s, width) {
  const v = stripAnsi(s).length;
  if (v === width) return s;
  if (v > width) return clipLine(s, width);
  return s + ' '.repeat(width - v);
}

export function money(n) {
  if (n == null || Number.isNaN(n)) return '$—';
  return '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
export function moneyBook(n) {
  if (n == null || Number.isNaN(n)) return '$—';
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return '~' + Math.round(sec / 60) + ' min';
  return '~' + (sec / 3600).toFixed(1) + ' h';
}
export function fmtAge(sec) {
  if (sec == null || sec < 0) return '';
  if (sec < 60) return Math.floor(sec) + 's';
  return Math.floor(sec / 60) + 'm' + String(Math.floor(sec % 60)).padStart(2, '0');
}
export function ageSec(at) { return at ? (Date.now() - at) / 1000 : null; }
export function sharePct(pct) {
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return pct.toFixed(1) + '%';
  return pct.toFixed(0) + '%';
}
export function shortEmail(e, maxLocal = 14) {
  const s = stripAnsi(String(e || ''));
  const at = s.indexOf('@');
  if (at === -1) return s.slice(0, 22);
  const local = s.slice(0, at);
  const dom = s.slice(at + 1).split('.')[0];
  return (local.length > maxLocal ? local.slice(0, maxLocal - 1) + '…' : local) + '@' + dom;
}
export function clockOf(t) { return new Date(t).toLocaleTimeString('en-GB', { hour12: false }); }
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
export function sparkline(values) {
  const glyphs = '▁▂▃▄▅▆▇█';
  if (!values.length) return '▁';
  const max = Math.max(...values, 1);
  return values.map((v) => glyphs[Math.round((v / max) * (glyphs.length - 1))]).join('');
}
