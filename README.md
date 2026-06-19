# Auto Model Router

![Dashboard](dashboard.png)

An OpenAI-compatible proxy that **automatically switches models AND API keys when
a usage/rate limit is exceeded**. Each model has a pool of keys; when a model+key
returns `429` (rate limit) or `402` (out of credits), the router cools that slot
down and rotates to the next **key**, then the next **model** — transparently,
in the same request. It only fails once *every key of every model* is spent.

```
client / Continue ──► router (/v1/chat/completions)
   deepseek-free (OpenRouter)  key0 →429→ key1 →429→ ┐
   llama-free    (OpenRouter)  key0 →429→ key1 →429→ ┤ rotate key, then model
   hf-qwen       (HuggingFace) key0 →429→ key1  ✅  ◄┘
```

## Features
- **Model switching** on `429` / `402` / network errors.
- **API-key rotation** — each model holds a key pool; a limited key is skipped
  and the next key (even a different account) is tried automatically.
- **Usage tracking** — counts requests per `(model, key)` per day (persisted to
  `usage.json`) and proactively skips a slot once it hits its `dailyLimit`.
- **Per-minute rate limit** — a token bucket per slot (`rpm`) rotates to another
  slot *before* the upstream returns `429`, smoothing load across keys/models.
- **Cooldown** — a slot that just hit a limit is skipped for `cooldownMs`.
- **Transient retries** — `5xx` / timeouts retry the same model before switching.
- **Streaming passthrough** (`stream: true`) and non-streaming.
- **Two endpoints** behind the same routing: `/v1/chat/completions` (chat/edit)
  and `/v1/completions` (autocomplete/FIM). A slot that 404s the completions
  endpoint is skipped, so a mixed chain still serves autocomplete.
- Drop-in **OpenAI-compatible** endpoint → works with Continue, OpenAI SDKs, curl.

## Setup
```bash
npm install
cp .env.example .env      # add OPENROUTER_API_KEY and HF_API_KEY
npm start
```
Edit `config.yaml` to change the model `chain`, `dailyLimit`s, and `cooldownMs`.

## Use it

### curl
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```
The response header `X-Router-Model` tells you which model actually answered.

### Continue (config.yaml)
```yaml
models:
  - name: Auto Router
    provider: openai
    model: auto
    apiBase: http://localhost:8787/v1
    apiKey: dummy   # router holds the real keys
    roles:
      - chat
      - edit
      - apply
      - autocomplete   # uses /v1/completions, routed the same way
```
Skip the `embed` / `rerank` roles — the router only proxies completions, not
embeddings. Use separate Continue models for those.

### Inspect
- **`GET /`** — live **dashboard** (auto-refreshes every 2s): one card per model,
  a row per key-slot showing status, today's count vs `dailyLimit`, tokens/min,
  and cooldown countdown. Open <http://localhost:8787/> in a browser.
  **Add / remove models right from the dashboard** — the "+ Add a model" form has a
  **searchable model picker** that pulls the live catalog from the provider
  (`GET /admin/catalog?provider=…`, proxying OpenRouter's and HuggingFace's public
  model lists), filterable to free models, with the ID and key-env auto-filled.
  The ✕ on each card removes it. Both write to `config.yaml` and hot-reload the
  chain (no restart). Backed by `POST /admin/models` and `DELETE /admin/models/:id`.
  Note: editing via the dashboard normalizes `config.yaml` and drops inline comments.
  **Manage API keys from the dashboard too** — the "🔑 API keys" panel lists each
  key pool (masked) and lets you add/remove keys. Adding a key appends it to the
  right env var in `.env`, updates the live process, and hot-reloads — so a model
  that was inactive for lack of keys goes live immediately. Backed by
  `GET/POST/DELETE /admin/keys`.
  **Drag-to-reorder priority** — drag the model cards to change the chain order
  (each card shows its `#priority`). On drop it persists and hot-reloads via
  `PUT /admin/models/order`. Unlisted/inactive models keep their slots.
  **Test** a model (per-card button) fires one real request through just that
  model and shows ok/latency/sample or the error — confirms a key/slug works
  (`POST /admin/models/:id/test`, not counted toward usage). **Edit** (✎) changes
  a model's `rpm`/`dailyLimit` inline (`PATCH /admin/models/:id`). **Test all**
  (button by the header) pings every model in parallel and reports `healthy/total`
  plus which ids are dead (`POST /admin/test-all`). Test results persist across the
  2s auto-refresh.
- `GET /status` — the dashboard's data: configured chain merged with live usage,
  including a per-slot `history` array (last 30 one-minute buckets of served
  requests) rendered as a **sparkline** in each slot's "Traffic · 30m" column.
  Each card also shows **"Today: N of T left"** — remaining requests vs. the
  combined daily budget (`dailyLimit × #keys`), resetting at UTC midnight.
- `GET /admin/credits` — OpenRouter account tier + credit usage ($), and the
  derived **`freeDailyLimit`** (50/day on free tier, 1000/day once ≥10 credits
  bought). The header shows an accurate **OpenRouter free pool: N of T left** —
  the free cap is per key and **shared across all `:free` models**, so this sums
  today's requests over every free OpenRouter slot (`freeDailyLimit × #keys`).
- `GET /usage`  — raw per-slot counts + remaining cooldown.
- `GET /health` — liveness + model count.
- `GET /v1/models` — the chain as OpenAI-style model list.

## How "limit exceeded" is detected
| Upstream status | Action |
|---|---|
| `429`, `402`        | cool down this `(model, key)` → **rotate key, then model** |
| `500/502/503/504`   | retry same slot (`transientRetries`), then rotate |
| other `4xx`         | return to client (won't be fixed by switching) |
| `2xx`               | success → record usage for that `(model, key)` |

The response header `X-Router-Key` tells you which key index answered (alongside
`X-Router-Model`). Slots in `/usage` are labelled `modelId#keyIndex`.

## Notes
- Free-tier daily caps change; tune `dailyLimit` per model in `config.yaml`.
- Daily counters roll over at **UTC midnight**.
- OpenRouter also has native multi-model fallback; this router adds value by
  mixing providers and tracking caps across them.
