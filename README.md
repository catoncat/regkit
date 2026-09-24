# regkit

Zero-dependency Node.js (ESM, >= 20) building blocks for running an
OpenAI-compatible gateway in front of a pool of API keys — plus the machinery
to provision those keys, keep the pool topped up, and watch it.

Each upstream service gets its own small project that only describes the
upstream's protocol. Everything reusable — pacing, mail polling, the account
store, the usage ledger, the gateway, the watcher — lives here.

## What's inside

| Module | Purpose |
|---|---|
| `pool` | Key pool for one upstream: rotation, sticky affinity, balance pre-check, usage accounting, retry on a different key inside the same request |
| `gateway` | Single-upstream OpenAI-compatible HTTP gateway (= one pool + HTTP) |
| `hub` | One port, many pools, routed by `model` (alias → `prefix/model` → unique catalog match → default) |
| `wire` | Pure request/response shaping: body dialects, usage/cost extraction, header policy |
| `usage` | Append-only usage ledger; displayed balance = last authoritative anchor − local spend |
| `accounts` | Append-only account store (JSONL, latest record wins) |
| `watch` / `watch-render` | Resident watcher: balance rotation, threshold-based supply, terminal panel |
| `supply` | Single-flight top-up when pool balance falls below a target |
| `pacer` | AIMD pacing for a rate-limited submit step |
| `mailbox` / `domains` | Poll a mailbox CLI for codes or links; round-robin mail domains |
| `http` | `fetch` wrapper that emits one event per call and classifies failures |
| `logger` / `events` | stderr + `events.jsonl` logging; windowed stats over events |
| `lock` / `jsonl` | Single-instance lock, cross-process file lock, atomic JSONL I/O |
| `config` / `names` | env + `.env.local` config loader; identity generator from word lists |
| `fleet*` / `health` / `patrol` | Optional: run many upstream projects on one machine (see below) |

Every module is importable as a subpath: `import { createHub } from 'regkit/hub'`.

## Install

regkit is not published to npm. Clone it next to your upstream projects and
depend on it by path:

```bash
git clone https://github.com/catoncat/regkit.git
# in an upstream project's package.json:  "dependencies": { "regkit": "file:../regkit" }
```

## Mail: cloud-mail

Provisioning flows that verify by email need a mailbox you control.
`mailbox` and `domains` talk to [cloud-mail](https://github.com/catoncat/cloud-mail),
a self-hosted receive-only mail service on Cloudflare, through its CLI:

```bash
git clone https://github.com/catoncat/cloud-mail.git
cd cloud-mail/apps/intake && npm install
node scripts/cli.mjs setup          # deploys the Worker, needs Cloudflare credentials
npm run install:global              # installs ~/bin/cloud-mail
cloud-mail domains list             # should list your enabled domains
```

regkit only relies on two commands, so any tool with the same contract works
(point `MAILBOX_CLI` at it):

| Command | Expected stdout |
|---|---|
| `<cli> domains list` | `{ "items": [{ "domain": "…", "enabled": true }] }` |
| `<cli> messages --email <addr> --limit <n>` | `{ "items": [{ "sender", "subject", "text_body", "html_body", "code"? }] }` |

Set a fixed domain list instead (`<UPSTREAM>_FIXED_POOL=a.com,b.com`) to skip
`domains list`.

## Start a new upstream project

`skeleton/` is a complete, tested template wired against a fictional upstream.

```bash
cp -R regkit/skeleton my-upstream && cd my-upstream
mkdir -p node_modules && ln -s ../../regkit node_modules/regkit
npm test                             # contract tests pass against the example
```

Then replace three files with the real upstream's facts:

- `src/protocol.mjs` — endpoints, request bodies, failure classification, pricing, mail extractor, probe
- `src/config.local.mjs` — defaults under your `<UPSTREAM>_*` env prefix
- `src/words.mjs` — word lists for generated identities (optional)

`cli.mjs`, `register.mjs`, `gateway.mjs` and `watch.mjs` are thin wiring and
rarely change. See [skeleton/README.md](skeleton/README.md) for the protocol contract.

## Gateway

Single upstream:

```js
import { createGateway } from 'regkit/gateway';

const gw = createGateway({
  log, accountsFile: 'data/accounts.jsonl', usagePath: 'data/usage.jsonl',
  upstreamBase: 'https://api.example.com/v1',
  rates: () => ({ in: 0.15, out: 0.35 }),          // $ per 1M tokens
  classifyFailure: (status) => (status === 402 ? 'balance' : status === 429 ? 'concurrency' : 'client'),
  gatewayToken: process.env.GATEWAY_KEY, poolName: 'example',
});
gw.server.listen(48787, '127.0.0.1');
```

Several upstreams on one port:

```js
import { createHub } from 'regkit/hub';

createHub({ log, token, providers: [
  { id: 'a', prefix: 'a', base: 'https://api.a.example.com/v1', accountsFile, usagePath, rates, classifyFailure,
    aliases: { cheap: 'vendor/actual-model-id' } },
  { id: 'b', base: 'https://api.b.example.com/v1', accountsFile: fileB, usagePath: usageB, rates, classifyFailure,
    balanceEligible: () => true },   // free tier with no balance anchor
] });
```

Behaviour worth knowing:

- Clients should always send `prefix/model`; a bare id served by several pools is rejected with 404.
- Keys with displayed balance <= 0 are skipped. Pools without a balance anchor need `balanceEligible: () => true`.
- The client's User-Agent is never forwarded (default `regkit-gateway/1.0`, per-pool `userAgent` overrides it).
- Per-pool `authHeader` (`bearer` | `x-api-key` | `apikey`), `chatPath` and `modelsPath` cover non-OpenAI surfaces.
- Faces: `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (+ `count_tokens`), `/v1/models`, `/health`.
- If one request retires 3 keys as out-of-balance, the pool stops and returns the upstream's own error instead of draining further.

## Fleet (optional, macOS)

The fleet layer runs many upstream projects on one machine: one launchd-managed
gateway on `:48790` serves every pool, each project's watcher runs as its own
launchd job, and a periodic `tick` gates pools on detected failures.

A project joins the fleet by shipping `data/service.json`
(see [skeleton/service.example.json](skeleton/service.example.json)).
Projects are discovered in the directory regkit is checked out in; add more
search directories with `roots` in `fleet.local.json` (machine state, not committed):

```json
{ "roots": ["/path/to/projects", "/another/path"] }
```

```bash
node src/fleet-cli.mjs                    # interactive panel
node src/fleet-cli.mjs status             # JSON: declarations, liveness, health, balances
node src/fleet-cli.mjs adopt <dir>        # register a project, allocate a port, install its launchd job
node src/fleet-cli.mjs gateway --install  # install the shared gateway
node src/fleet-cli.mjs tick --install     # failure detection every 5 minutes
node src/fleet-cli.mjs doctor             # desired state vs launchd vs processes vs ports
```

Other verbs: `ls`, `health <id>`, `probe`, `set-mode <id> auto|off`, `recover <id>`,
`sunset <id>`, `retire <id>`, `refresh-catalog [id]`, `patrol`.

## Conventions

- Account status values: `pending / verified / failed / exhausted / dead / cooldown / recycled / orphan`.
- Records are JSONL, appended; state files are written atomically. Coordination files are
  updated under a file lock.
- Unknown is never treated as empty: an unreadable ledger or health file blocks key
  issuance and supply instead of assuming zero.
- Credentials live in env or `.env.local` (0600). `data/` is never committed.

## Agent skill

[skills/regkit/SKILL.md](skills/regkit/SKILL.md) teaches a coding agent how to use
and extend regkit. Copy or symlink it into your agent's skills directory.

## Tests

```bash
npm test    # root suite + skeleton contract suite
```

## License

MIT
