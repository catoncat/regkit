// Append-only account store. Thin wrappers over regkit's jsonl helpers with
// the registrar's field conventions (email-keyed, latest-wins).

import { appendMergeLatest, latestWins, seenKeys } from './jsonl.mjs';
import { displayedBalance } from './usage.mjs';

/** Append (merge-over-previous) one account record. */
export function appendAccount(file, record) {
  return appendMergeLatest(file, record, 'email');
}

/** Latest record per email — the append-only file's read contract. */
export function readAccounts(file) {
  return latestWins(file, 'email');
}

/** Existing emails (for batch dedup). */
export function loadSeenEmails(file) {
  return seenKeys(file, 'email');
}

export function printAccount(record) {
  // never print secrets to stdout (proxy-safe); keys stay in the file
  const { password, api_key, ...safe } = record;
  console.log(JSON.stringify(safe));
}

/** Displayed pool balance over the verified accounts = Σ usage.displayedBalance
 *  (authoritative anchor minus locally recorded spend since it). One balance
 *  rule in the codebase, not a second copy of it. */
export function displayedPoolBalance(accounts, usageRows, { key = 'email', balanceField = 'balance_usd', checkedAtField = 'checked_at' } = {}) {
  return accounts
    .filter((a) => a.status === 'verified')
    .reduce((s, a) => s + (displayedBalance(a, usageRows, { balanceField, checkedAtField, emailField: key }) ?? 0), 0);
}
