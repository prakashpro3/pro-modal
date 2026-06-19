import "./loadenv.js";
import express from "express";
import { loadConfig, readRaw, writeRaw, buildConfig, PROVIDERS, resolveKeys } from "./config.js";
import { recordSuccess, tripCooldown, isAvailable, tryConsumeToken, snapshot, historyFor } from "./usage.js";
import { getKeysFor, addKey, removeKey, maskKey } from "./envfile.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { anthropicToOpenAI, openAIToAnthropic, streamAnthropic } from "./anthropic.js";

// `cfg` is reassigned on hot-reload when models are added/removed via the dashboard.
let cfg = loadConfig();
function reload() {
  cfg = loadConfig();
  console.log(`  reloaded chain: ${cfg.chain.map((m) => m.id).join(" -> ")}`);
}
const app = express();
app.use(express.json({ limit: "25mb" }));

// Errors that mean "this model is out of budget" -> switch to the next model.
const LIMIT_STATUS = new Set([429, 402]);
// Errors that are usually transient -> retry the same model briefly, then switch.
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Forward one request to a single upstream model + key, at the given path
// ("/chat/completions" for chat, "/completions" for autocomplete/FIM).
// Returns the raw fetch Response so the caller can stream or read it.
function callUpstream(model, apiKey, body, signal, path) {
  // Strip the client's "model" field; we set the real upstream model id.
  const payload = { ...body, model: model.model };
  return fetch(`${model.baseUrl}${path}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter likes these for attribution; harmless elsewhere.
      "HTTP-Referer": "http://localhost",
      "X-Title": "auto-modal",
    },
    body: JSON.stringify(payload),
  });
}

// Flatten given models into ordered (model, keyIndex) slots so we iterate keys
// AND models in one loop: model-A key0, model-A key1, model-B key0, ...
function slotsOf(models) {
  const out = [];
  for (const model of models) {
    for (let keyIdx = 0; keyIdx < model.keys.length; keyIdx++) {
      out.push({ model, keyIdx });
    }
  }
  return out;
}

// Which slots to use for a request. If the client asks for a specific model
// (by chain id or model slug), route to just that model's keys — so you get key
// rotation without falling through to other (e.g. text-only) models. "auto",
// empty, or an unknown id uses the full chain in priority order.
function slotsFor(requested) {
  if (requested && requested !== "auto") {
    // Accept the "claude-<id>" aliases we advertise for Claude Code discovery.
    const stripped = requested.startsWith("claude-") ? requested.slice(7) : requested;
    const matches = cfg.chain.filter(
      (m) => m.id === requested || m.model === requested || m.id === stripped
    );
    if (matches.length) return slotsOf(matches);
  }
  return slotsOf(cfg.chain);
}

// Shared routing core: walk the slots, apply limits, forward to `path`,
// rotate on limit errors. Used by /chat/completions, /completions, /messages.
// opts.body overrides the forwarded body (e.g. an Anthropic->OpenAI translation);
// opts.onOk(upstream, ctx) handles a successful response (else default passthrough);
// opts.onExhausted(res, tried) formats the all-slots-failed error.
async function routeRequest(req, res, path, opts = {}) {
  const sendBody = opts.body ?? req.body;
  const wantStream = sendBody?.stream === true;
  const tried = [];

  for (const { model, keyIdx } of slotsFor(sendBody?.model)) {
    const slotLabel = `${model.id}#key${keyIdx}`;
    if (!isAvailable(model, keyIdx)) {
      tried.push({ slot: slotLabel, skipped: "cooldown-or-daily-cap" });
      continue;
    }
    // Per-minute budget: skip (rotate) if this slot is out of tokens this minute.
    if (!tryConsumeToken(model, keyIdx)) {
      tried.push({ slot: slotLabel, skipped: "rpm-limit" });
      continue;
    }
    const apiKey = model.keys[keyIdx];

    let attempt = 0;
    while (attempt <= cfg.transientRetries) {
      attempt++;
      let upstream;
      try {
        upstream = await callUpstream(model, apiKey, sendBody, req.signal, path);
      } catch (err) {
        // Network-level failure -> treat as transient.
        if (attempt <= cfg.transientRetries) {
          await sleep(300 * attempt);
          continue;
        }
        tried.push({ slot: slotLabel, error: err.message });
        break;
      }

      if (upstream.ok) {
        recordSuccess(model.id, keyIdx);
        res.setHeader("X-Router-Model", model.id);
        res.setHeader("X-Router-Upstream", model.model);
        res.setHeader("X-Router-Key", `key${keyIdx}`);

        if (opts.onOk) return await opts.onOk(upstream, { model, keyIdx, wantStream, res });

        if (wantStream && upstream.body) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          // Pipe the SSE stream straight through.
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          return res.end();
        }

        const json = await upstream.json();
        return res.json(json);
      }

      // Not OK — decide whether to retry, switch, or fail.
      const status = upstream.status;
      const text = await upstream.text().catch(() => "");

      if (LIMIT_STATUS.has(status)) {
        // This key is rate-limited / out of credits -> cool it down and
        // rotate to the next (model, key) slot.
        tripCooldown(model.id, keyIdx, cfg.cooldownMs);
        tried.push({ slot: slotLabel, status, reason: "limit-exceeded -> rotated key/model" });
        break; // advance to next slot
      }

      if (TRANSIENT_STATUS.has(status) && attempt <= cfg.transientRetries) {
        await sleep(300 * attempt);
        continue; // retry same slot
      }

      // 404 = this slot doesn't offer this endpoint (e.g. a provider with no
      // /completions support). Rotate to the next slot; another may support it.
      if (status === 404) {
        tried.push({ slot: slotLabel, status, reason: "endpoint not supported -> rotated" });
        break;
      }

      // Other errors (e.g. 400 bad request): bubble up immediately,
      // since switching keys/models won't fix a malformed request.
      if (status >= 400 && status < 500 && !LIMIT_STATUS.has(status)) {
        return res.status(status).type("application/json").send(text || "{}");
      }

      tried.push({ slot: slotLabel, status, body: text.slice(0, 200) });
      break;
    }
  }

  // Every (model, key) slot was unavailable or failed.
  if (opts.onExhausted) return opts.onExhausted(res, tried);
  return res.status(503).json({
    error: {
      message: "All models and API keys are exhausted or unavailable.",
      type: "router_all_slots_exhausted",
      tried,
    },
  });
}

// Chat (sidebar, edit, apply).
app.post("/v1/chat/completions", (req, res) => routeRequest(req, res, "/chat/completions"));

// Text completions / FIM — used by Continue's autocomplete role.
app.post("/v1/completions", (req, res) => routeRequest(req, res, "/completions"));

// Anthropic Messages API — used by Claude Code. Translates the request to
// OpenAI, routes it through the chain, and translates the response back.
app.post("/v1/messages", (req, res) => {
  const model = req.body?.model || "auto";
  let openaiBody;
  try {
    openaiBody = anthropicToOpenAI(req.body || {});
  } catch (err) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: err.message } });
  }
  return routeRequest(req, res, "/chat/completions", {
    body: openaiBody,
    onOk: async (upstream, { wantStream }) => {
      if (wantStream && upstream.body) return streamAnthropic(upstream, res, model);
      const oj = await upstream.json();
      return res.json(openAIToAnthropic(oj, model));
    },
    onExhausted: (r) => r.status(529).json({
      type: "error",
      error: { type: "overloaded_error", message: "All models and API keys are exhausted or unavailable." },
    }),
  });
});

// Rough token count (Claude Code may call this). ~4 chars/token estimate.
app.post("/v1/messages/count_tokens", (req, res) => {
  const b = req.body || {};
  let chars = typeof b.system === "string" ? b.system.length : 0;
  for (const m of b.messages || []) {
    chars += typeof m.content === "string" ? m.content.length
      : (m.content || []).reduce((n, blk) => n + (blk.text?.length || 0), 0);
  }
  res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
});

// Advertise the chain as available "models". Each model is listed twice: under
// its real id (Continue / OpenAI SDKs) and a "claude-<id>" alias so Claude Code's
// gateway model discovery (which only shows claude/anthropic ids) can list them.
app.get("/v1/models", (_req, res) => {
  const data = [];
  for (const m of cfg.chain) {
    data.push({ id: m.id, object: "model", owned_by: m.provider });
    data.push({ id: `claude-${m.id}`, object: "model", owned_by: m.provider });
  }
  res.json({ object: "list", data });
});

app.get("/usage", (_req, res) => res.json(snapshot()));
app.get("/health", (_req, res) => res.json({ ok: true, models: cfg.chain.length }));

// Merge the configured chain with live per-slot usage for the dashboard.
function buildStatus() {
  const snap = snapshot();
  const chain = cfg.chain.map((model) => ({
    id: model.id,
    provider: model.provider,
    model: model.model,
    rpm: Number.isFinite(model.rpm) ? model.rpm : null,
    dailyLimit: Number.isFinite(model.dailyLimit) ? model.dailyLimit : null,
    slots: model.keys.map((_key, keyIdx) => {
      const u = snap[`${model.id}#${keyIdx}`] || {};
      return {
        keyIdx,
        count: u.count ?? 0,
        dailyLimit: Number.isFinite(model.dailyLimit) ? model.dailyLimit : null,
        cooldownRemainingMs: u.cooldownRemainingMs ?? 0,
        tokensThisMinute: u.tokensThisMinute ?? null,
        history: historyFor(`${model.id}#${keyIdx}`),
      };
    }),
  }));
  return { port: cfg.port, providers: PROVIDERS, chain };
}

app.get("/status", (_req, res) => res.json(buildStatus()));
app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));

// --- Model catalog: live list of available models per provider (for the picker) ---

const CATALOG_TTL = 10 * 60 * 1000; // cache 10 min
const catalogCache = {}; // provider -> { ts, data }

async function fetchCatalog(provider) {
  const cached = catalogCache[provider];
  if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data;

  let data = [];
  if (provider === "openrouter") {
    const j = await (await fetch("https://openrouter.ai/api/v1/models")).json();
    data = (j.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length || null,
      free: m.id.endsWith(":free") ||
        (m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0"),
    }));
  } else if (provider === "huggingface") {
    const j = await (await fetch("https://router.huggingface.co/v1/models")).json();
    data = (j.data || j || []).map((m) => ({
      id: m.id,
      name: m.id,
      contextLength: null,
      free: Array.isArray(m.providers) ? m.providers.some((p) => p.is_free) : false,
    }));
  }
  // Free models first, then alphabetical.
  data.sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
  catalogCache[provider] = { ts: Date.now(), data };
  return data;
}

// Query OpenRouter for the account tier behind a key. Returns null if no key or
// the call fails. freeDailyLimit: 50/day on free tier, 1000/day once >=10 credits
// bought (per key, SHARED across all :free models).
async function fetchOpenRouterTier(key) {
  key = key || getKeysFor("OPENROUTER_API_KEYS")[0];
  if (!key) return null;
  try {
    const j = await (await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    })).json();
    const d = j.data || {};
    return {
      isFreeTier: d.is_free_tier,
      usageDaily: d.usage_daily,
      usage: d.usage,
      limit: d.limit,
      limitRemaining: d.limit_remaining,
      freeDailyLimit: d.is_free_tier ? 50 : 1000,
    };
  } catch {
    return null;
  }
}

app.get("/admin/credits", async (_req, res) => {
  const tier = await fetchOpenRouterTier();
  res.json(tier ? { available: true, ...tier } : { available: false, reason: "no OpenRouter key or fetch failed" });
});

app.get("/admin/catalog", async (req, res) => {
  const provider = req.query.provider;
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `unknown provider "${provider}"` });
  }
  try {
    res.json({ provider, models: await fetchCatalog(provider) });
  } catch (err) {
    res.status(502).json({ error: `failed to fetch ${provider} catalog: ${err.message}` });
  }
});

// --- Admin: add / remove models via the dashboard (writes config.yaml, hot-reloads) ---

app.post("/admin/models", async (req, res) => {
  const { id, provider, model, apiKeys, dailyLimit, rpm } = req.body || {};
  if (!id || !provider || !model || !apiKeys) {
    return res.status(400).json({ error: "id, provider, model and apiKeys are required" });
  }
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` });
  }
  const raw = readRaw();
  raw.chain = raw.chain || [];
  if (raw.chain.some((m) => m.id === id)) {
    return res.status(409).json({ error: `a model with id "${id}" already exists` });
  }

  const entry = { id, provider, model, apiKeys };
  if (dailyLimit !== "" && dailyLimit != null) entry.dailyLimit = Number(dailyLimit);
  if (rpm !== "" && rpm != null) entry.rpm = Number(rpm);

  // Auto-set dailyLimit for an ACTIVE free OpenRouter model when left blank:
  // pull the real free cap (50/1000) from the account tier.
  let autoLimit = null;
  const isActiveFree = provider === "openrouter" && /:free$/.test(model) && resolveKeys(entry).length > 0;
  if (entry.dailyLimit == null && isActiveFree) {
    const tier = await fetchOpenRouterTier(resolveKeys(entry)[0]);
    if (tier?.freeDailyLimit) entry.dailyLimit = autoLimit = tier.freeDailyLimit;
  }
  raw.chain.push(entry);

  try {
    writeRaw(raw);
    reload();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // If the env var behind apiKeys is empty, the model is valid but inactive.
  const active = cfg.chain.some((m) => m.id === id);
  res.json({
    ok: true,
    active,
    autoDailyLimit: autoLimit, // set from OpenRouter tier when left blank, else null
    warning: active ? undefined : `Added, but inactive: "${apiKeys}" resolved to no keys (set it in .env).`,
  });
});

// Fire a tiny real request through one model (first key) and report the result.
// Diagnostic only — not counted toward usage.
async function runModelTest(model) {
  const body = { messages: [{ role: "user", content: "ping" }], max_tokens: 5 };
  const start = Date.now();
  try {
    const up = await callUpstream(model, model.keys[0], body, undefined, "/chat/completions");
    const text = await up.text();
    let sample;
    try { sample = JSON.parse(text)?.choices?.[0]?.message?.content; } catch { /* non-JSON */ }
    return {
      id: model.id,
      ok: up.ok,
      status: up.status,
      latencyMs: Date.now() - start,
      sample: up.ok ? (sample || "").slice(0, 80) : undefined,
      error: up.ok ? undefined : text.slice(0, 160),
    };
  } catch (err) {
    return { id: model.id, ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

app.post("/admin/models/:id/test", async (req, res) => {
  const model = cfg.chain.find((m) => m.id === req.params.id);
  if (!model) return res.status(404).json({ ok: false, error: "unknown or inactive model (needs a key)" });
  res.json(await runModelTest(model));
});

// Test every active model at once (in parallel) and flag the dead ones.
app.post("/admin/test-all", async (_req, res) => {
  const results = await Promise.all(cfg.chain.map(runModelTest));
  res.json({ results, healthy: results.filter((r) => r.ok).length, total: results.length });
});

// Edit a model's rpm / dailyLimit in place (empty value clears the limit).
app.patch("/admin/models/:id", (req, res) => {
  const raw = readRaw();
  const m = (raw.chain || []).find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: `no model with id "${req.params.id}"` });
  const { dailyLimit, rpm } = req.body || {};
  if (dailyLimit === "" || dailyLimit == null) delete m.dailyLimit;
  else m.dailyLimit = Number(dailyLimit);
  if (rpm === "" || rpm == null) delete m.rpm;
  else m.rpm = Number(rpm);
  try {
    writeRaw(raw);
    reload();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
});

// Reorder the chain (priority = position). Body: { order: [id, id, ...] }.
// Listed ids are slotted into their original positions in the given order;
// any unlisted entries (e.g. inactive, key-less models) keep their slots.
app.put("/admin/models/order", (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array of ids" });

  const raw = readRaw();
  const chain = raw.chain || [];
  const byId = new Map(chain.map((m) => [m.id, m]));
  if (new Set(order).size !== order.length) return res.status(400).json({ error: "duplicate ids in order" });
  if (order.some((id) => !byId.has(id))) return res.status(400).json({ error: "order contains unknown id" });

  const listed = new Set(order);
  let oi = 0;
  raw.chain = chain.map((entry) => (listed.has(entry.id) ? byId.get(order[oi++]) : entry));

  try {
    writeRaw(raw);
    reload();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true, chain: cfg.chain.map((m) => m.id) });
});

// --- Admin: manage API-key pools (env vars) from the dashboard ---

// Which env vars hold keys: the two defaults plus anything referenced in config.
function referencedEnvVars() {
  const set = new Set(["OPENROUTER_API_KEYS", "HF_API_KEYS"]);
  for (const m of readRaw().chain || []) {
    const ref = Array.isArray(m.apiKeys) ? m.apiKeys.join(",") : String(m.apiKeys ?? m.apiKey ?? "");
    for (const t of ref.match(/\$\{([A-Z0-9_]+)\}/g) || []) set.add(t.slice(2, -1));
  }
  return [...set];
}

app.get("/admin/keys", (_req, res) => {
  res.json(referencedEnvVars().map((envVar) => ({
    envVar,
    keys: getKeysFor(envVar).map(maskKey),
  })));
});

app.post("/admin/keys", (req, res) => {
  const { envVar, key } = req.body || {};
  if (!envVar || !key) return res.status(400).json({ error: "envVar and key are required" });
  if (!/^[A-Z0-9_]+$/.test(envVar)) return res.status(400).json({ error: "invalid env var name" });
  try {
    const r = addKey(envVar, key);
    reload(); // a model that was inactive for lack of keys may now go live
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/keys", (req, res) => {
  const { envVar, index } = req.body || {};
  if (!envVar || index == null) return res.status(400).json({ error: "envVar and index are required" });
  try {
    const r = removeKey(envVar, Number(index));
    if (!r.removed) return res.status(404).json({ error: "no key at that index" });
    reload();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/models/:id", (req, res) => {
  const raw = readRaw();
  const before = (raw.chain || []).length;
  raw.chain = (raw.chain || []).filter((m) => m.id !== req.params.id);
  if (raw.chain.length === before) {
    return res.status(404).json({ error: `no model with id "${req.params.id}"` });
  }
  try {
    writeRaw(raw);
    reload();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
});

const server = app.listen(cfg.port, () => {
  console.log(`auto-modal listening on http://localhost:${cfg.port}`);
  console.log(`  dashboard: http://localhost:${cfg.port}/`);
  console.log(`  chain: ${cfg.chain.map((m) => m.id).join(" -> ")}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${cfg.port} is already in use — another router is running.`);
    console.error(`  Run "npm run restart" to stop it and start fresh.`);
    process.exit(1);
  }
  throw err;
});
