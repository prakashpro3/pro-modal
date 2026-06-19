# Development

Running, testing, and publishing **auto-modal** from source. For everyday usage
see the [README](README.md).

## Run from source

```bash
git clone https://github.com/prakashpro3/pro-modal.git
cd pro-modal
npm install
cp .env.example .env          # add your keys (comma-separated for multiple)
npm start                     # → http://localhost:8787
```

`.env`:
```bash
OPENROUTER_API_KEYS=sk-or-1...,sk-or-2...   # as many as you have; rotated automatically
HF_API_KEYS=hf_1...,hf_2...
```

Verify: `curl -s http://localhost:8787/health` → `{"ok":true,"models":N}`.
Open the dashboard at <http://localhost:8787/> to manage models/keys visually.

> `npm start` self-guards: a `prestart` hook (`scripts/free-port.mjs`) kills any
> stale instance already on the port, so two routers never fight over state.

### Scripts
| Script | Does |
|---|---|
| `npm start` | start the router (frees the port first) |
| `npm run dev` | start with `--watch` (auto-restart on change) |
| `npm run restart` | force a clean restart (free port → start) |
| `npm test` | run the integration test suite |

When running from source, config/`.env`/`usage.json` default to the **project dir**.
Override paths with `ROUTER_CONFIG`, `ROUTER_ENV`, `ROUTER_USAGE`. The global CLI
(`bin/cli.mjs`) instead points these at `~/.auto-modal` (or `AUTOMODAL_HOME`).

## Project layout

```
bin/cli.mjs            global CLI (automodal): start / claude / init / where
src/
  server.js            express app, routing core, all endpoints
  config.js            load/validate config.yaml, resolve ${ENV} key pools
  usage.js             per-(model,key) daily counts, cooldowns, rpm buckets, history
  envfile.js           read/write key pools in .env (dashboard 🔑 panel)
  anthropic.js         Anthropic ⇄ OpenAI translation (Claude Code /v1/messages)
  dashboard.js         self-contained dashboard HTML/JS (no build step)
  loadenv.js           dotenv loader honoring ROUTER_ENV
scripts/free-port.mjs  kills a stale instance on the configured port
config.default.yaml    starter chain shipped to ~/.auto-modal on first run
test/*.test.mjs        integration tests (spawn the server against mock upstreams)
```

## Tests

```bash
npm test     # 10 integration suites
```

Each `test/*.test.mjs` spins up the real server (on an isolated port + temp
`ROUTER_CONFIG`/`ROUTER_ENV`/`ROUTER_USAGE`) against a mock upstream and asserts
behavior over HTTP. Coverage:

| Suite | Verifies |
|---|---|
| `fallback` | model switch + key rotation, cooldown skip, per-slot usage |
| `rpm` | per-minute token bucket rotates before upstream 429 |
| `completions` | `/v1/completions` (FIM), 404-slot skip |
| `admin` | add/delete models, hot-reload, validation |
| `keys` | add/remove keys in `.env`, activate key-less models |
| `reorder` | priority reorder, unlisted entries keep slots |
| `edit-test` | edit rpm/dailyLimit, per-model + test-all |
| `history` | per-slot request history (sparklines) |
| `requested-model` | route by id/slug/`claude-` alias, auto fallback |
| `messages` | Anthropic `/v1/messages`: non-stream, tools, streaming SSE |

Add a test as `test/<name>.test.mjs` and append it to the `test` script in
`package.json`. Use a unique port and temp dirs so suites stay isolated.

## Publishing a new version

The package is published as the scoped public package `@prakashpro1/auto-modal`
(unscoped names like `auto-modal`/`pro-modal` are blocked by npm as too similar to
existing packages). Account 2FA is enabled, so publishing needs an OTP.

```bash
npm test                       # green first
npm version patch              # bump version + create a git tag (patch|minor|major)
git push --follow-tags
npm publish --otp=<code>       # access:public is set in publishConfig
```

`files` in `package.json` is an allowlist — only `src/`, `bin/`, `scripts/`,
`config.default.yaml`, `.env.example`, `claude-router.sh`, `README.md` (+ `LICENSE`)
ship. Verify before publishing:

```bash
npm pack --dry-run             # inspect the tarball; ensure no .env / secrets
```

## Notes for contributors

- **No build step.** Plain ESM (`"type": "module"`), Node ≥ 20 (uses global
  `fetch` + web streams). The dashboard is a single template string in
  `dashboard.js` — no bundler.
- **Hot reload:** dashboard edits write `config.yaml` and call `reload()` in
  `server.js`, which rebuilds the in-memory `cfg`. No restart needed.
- **Routing core:** `routeRequest()` in `server.js` is shared by all three
  endpoints via `opts.body` / `opts.onOk` / `opts.onExhausted` — add new dialects
  there rather than duplicating the slot-rotation loop.
