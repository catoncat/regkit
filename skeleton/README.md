# skeleton

Template for one upstream project built on regkit. It is wired against a
fictional upstream (`api.example.com`) and its contract tests pass as-is.

Copy it, then replace three files: `src/protocol.mjs`, `src/config.local.mjs`,
`src/words.mjs`. Everything else comes from regkit.

## Layout

```
src/
  protocol.mjs        upstream protocol — the file you write
  config.local.mjs    defaults under your <UPSTREAM>_* env prefix
  words.mjs           word lists for generated identities (optional)
  register.mjs        orchestration: runs the protocol steps with regkit's pacer and mailbox
  cli.mjs             register / accounts / probe / balance / gateway / watch
  gateway.mjs         wires protocol.gateway into regkit's createGateway
  watch.mjs           wires balance refresh and supply into regkit's runWatch
scripts/
  watch-loop.sh       keeps the watcher running (touch data/.watch-stop to stop)
test/
  contract.test.mjs   pins request bodies and the money / mail invariants
service.example.json  declaration for the optional fleet layer (copy to data/service.json)
```

## What protocol.mjs exports

| Export | Purpose | Used by |
|---|---|---|
| `gateway` | `{ upstreamBase, rates(model, env), classifyFailure(status, text), poolName, gatewayTokenEnv }` | `gateway.mjs` |
| `mailExtract` | `(items) -> code \| link \| null` | `register.mjs` |
| `requestCode(cfg, log, identity)` | start signup, returns `{ verification_id, ... }` | `register.mjs` |
| `submitRegistration(cfg, log, { verificationId, code })` | finish signup, returns a session with the API key | `register.mjs` |
| `login(cfg, log, { email, password })` | fresh session for balance refresh | `watch.mjs` |
| `fetchBilling(cfg, log, token)` | authoritative balance | `register.mjs`, `watch.mjs` |
| `probeKey(cfg, log, key)` | one real inference call | `register.mjs`, `cli.mjs` |

If the upstream's flow has different steps, change `register.mjs` to match. It is
plain wiring.

## Run

```bash
mkdir -p node_modules && ln -s ../../regkit node_modules/regkit
npm test
node src/cli.mjs register --probe      # one account end to end
node src/cli.mjs accounts
node src/cli.mjs gateway               # local OpenAI-compatible endpoint
node src/cli.mjs watch                 # balance rotation + supply
```

Configuration is read from env and `.env.local` (see `.env.example`). Mail is received
through the `cloud-mail` CLI; see the root README.
