---
name: regkit
description: >-
  Build or extend projects on regkit, a zero-dependency Node.js toolkit for
  OpenAI-compatible gateways over pools of API keys (key rotation, usage ledger,
  multi-upstream routing, account provisioning, resident watcher). Use when wiring
  a new upstream from the skeleton, changing shared pool/gateway/watch machinery,
  configuring a multi-upstream hub, or operating the optional fleet layer.
---

# regkit

## Layout

- `src/` — the shared machinery. One module per concern; pure functions and I/O engines
  live in separate files (`wire` vs `pool`, `watch-render` vs `watch`), re-exported so
  subpath imports stay stable.
- `skeleton/` — a tested template for one upstream project. A template, not a framework:
  copy it and fill it in.
- Upstream-specific facts (endpoints, bodies, prices, failure codes) never go into `src/`.
  They belong in the upstream project's `src/protocol.mjs`.

## Wire a new upstream

1. `cp -R skeleton ../<name> && cd ../<name>`, then link regkit:
   `mkdir -p node_modules && ln -s ../../regkit node_modules/regkit`.
2. Edit only these files:
   - `src/protocol.mjs`: `gateway` (`upstreamBase`, `rates`, `classifyFailure`, `poolName`),
     `mailExtract`, and the protocol steps (`requestCode`, `submitRegistration`, `login`,
     `fetchBilling`, `probeKey`). Rename or add steps if the upstream's flow differs;
     adjust `src/register.mjs` to match.
   - `src/config.local.mjs`: defaults under the project's `<UPSTREAM>_*` env prefix.
   - `src/words.mjs`: optional word lists for generated identities.
3. Update `test/contract.test.mjs` so it pins the real request bodies, then `npm test`.
4. Done when `npm test` passes and `node src/cli.mjs register --probe` yields a verified
   account whose key answers an inference request.

Measure the upstream before encoding it: record real request/response pairs, status
codes and rate-limit behaviour, and write only observed facts into `protocol.mjs`.
If the upstream's signup requires a real browser, HTTP replay will not work. You then
need your own browser-driven provisioning; the pool, gateway and watcher still apply.

## Mail dependency

`mailbox` and `domains` shell out to a mailbox CLI (default `cloud-mail`,
https://github.com/catoncat/cloud-mail). Contract:

- `<cli> domains list` → `{ items: [{ domain, enabled }] }`
- `<cli> messages --email <addr> --limit <n>` → `{ items: [{ sender, subject, text_body, html_body, code? }] }`

Use `makeCodeExtractor({ senderSuffix, subjectRe })` or `makeLinkExtractor({ host, pathPrefix })`;
both ignore unrelated mail arriving at catch-all addresses. If every poll fails,
`waitFor` reports the CLI error rather than a mail timeout. Check the CLI before
blaming the upstream.

## Gateway and hub

- One upstream: `createGateway`. Several upstreams on one port: `createHub({ providers })`.
- Routing order: alias → `prefix/<model or alias>` → unique catalog match → `defaultUpstream`.
  Bare ids served by several pools return 404, so clients should always send the prefix.
- Keys with displayed balance <= 0 are skipped. A pool with no balance anchor (free tier)
  must set `balanceEligible: () => true` or it never serves.
- Client User-Agent is not forwarded; set per-pool `userAgent` if an upstream filters it.
- Non-OpenAI surfaces: per-pool `authHeader` (`bearer` | `x-api-key` | `apikey`),
  `authScheme`, `chatPath`, `modelsPath`.
- `classifyFailure(status, text)` returns `balance` (retire key), `model_mismatch` (rotate, keep),
  `concurrency` / `network` (back off, rotate) or `client` (pass through). A request that retires
  3 keys stops and returns the upstream error. That usually means a wrong classifier, not empty wallets.

## Watcher and fleet

- `runWatch` does balance rotation and threshold supply for one or many upstreams
  (`upstreams: [{ id, accountsFile, usageFile, targetUsd, perAccountUsd, refreshBalance, spawnBatch, ... }]`).
- The fleet layer (macOS launchd) runs one shared gateway for every project that ships
  `data/service.json`. Discovery roots default to regkit's parent directory; extra roots go in
  `fleet.local.json` under `roots`. Use `node src/fleet-cli.mjs status` for the live picture and
  `doctor` to compare desired and actual state.
- Health gating is decided per request, never baked in at gateway start, so `fleet recover`
  takes effect without a restart.

## Invariants when changing `src/`

- Unknown is never empty. If a ledger or health file can't be read, no keys are issued, no
  supply runs, and the balance shows `$—`. New money or gating paths must distinguish
  missing / ok / unreadable.
- Coordination files are read-modify-written under a lock: `updateHealth` for health.json,
  `withFileLock` for fleet.local.json and ledgers. Atomic writes alone lose concurrent decisions.
- Emit failure events through `REG_FAILURE_EVENTS` rather than string literals. Detectors keyed
  on a misspelled name never fire, and unit tests still pass.
- Status values are lowercase: `pending verified failed exhausted dead cooldown recycled orphan`.
  Output fields are snake_case, modules kebab-case.
- Add an abstraction only when a second real consumer needs it.
- `npm test` (root suite + skeleton suite) must pass before committing.
