import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ROUTER_CONFIG || join(__dirname, "..", "config.yaml");

// Both OpenRouter and HuggingFace expose an OpenAI-compatible
// /v1/chat/completions endpoint, so a provider just maps to a base URL.
const PROVIDER_BASE = {
  openrouter: "https://openrouter.ai/api/v1",
  huggingface: "https://router.huggingface.co/v1",
};

// Replace ${VAR} with process.env.VAR.
function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
}

// Build a model's key pool. Accepts (in priority order):
//   apiKeys: [ ${A}, ${B} ]          -> a YAML list
//   apiKeys: ${KEYS}                 -> one env var holding comma-separated keys
//   apiKey:  ${A}                    -> single key (back-compat)
// Returns a de-duplicated, non-empty array of resolved key strings.
export function resolveKeys(m) {
  let keys = [];
  if (Array.isArray(m.apiKeys)) {
    keys = m.apiKeys.map(expandEnv);
  } else if (typeof m.apiKeys === "string") {
    keys = expandEnv(m.apiKeys).split(",");
  } else if (m.apiKey != null) {
    keys = [expandEnv(m.apiKey)];
  }
  keys = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  return keys;
}

// Known providers (used to validate dashboard input).
export const PROVIDERS = Object.keys(PROVIDER_BASE);

// Read the raw YAML as a plain object (keeps ${ENV} references as-is — we never
// persist resolved secrets back to disk).
export function readRaw() {
  return YAML.parse(readFileSync(CONFIG_PATH, "utf8")) ?? {};
}

// Write the raw object back to config.yaml. NOTE: this normalizes formatting and
// drops inline comments — expected once you manage models via the dashboard.
export function writeRaw(raw) {
  writeFileSync(CONFIG_PATH, YAML.stringify(raw));
}

// Resolve a raw object into the runtime config (secrets expanded, slots built).
export function buildConfig(raw) {
  const cfg = {
    port: raw.port ?? 8787,
    cooldownMs: raw.cooldownMs ?? 3_600_000,
    transientRetries: raw.transientRetries ?? 2,
    chain: [],
  };

  for (const m of raw.chain ?? []) {
    const provider = m.provider;
    if (!PROVIDER_BASE[provider]) {
      throw new Error(`Unknown provider "${provider}" for model "${m.id}"`);
    }
    const keys = resolveKeys(m);
    // A model with no usable keys (e.g. its env var isn't set) is simply
    // skipped, not fatal — so you can leave HF/OpenRouter slots in the config
    // and just fill the keys you actually have.
    if (keys.length === 0) {
      console.warn(`config: skipping model "${m.id}" — no API keys set`);
      continue;
    }
    cfg.chain.push({
      id: m.id,
      provider,
      model: m.model,
      // Per-model `baseUrl` override wins (self-hosted / proxy / testing);
      // otherwise use the provider default.
      baseUrl: expandEnv(m.baseUrl) || PROVIDER_BASE[provider],
      keys, // pool of API keys; the router rotates through them on limit errors
      dailyLimit: m.dailyLimit ?? Infinity, // applied per key
      rpm: m.rpm ?? Infinity, // requests-per-minute token bucket, per key
    });
  }

  if (cfg.chain.length === 0) {
    // Not fatal: the server still boots and serves the dashboard so you can add
    // keys/models. Requests just 503 until at least one slot is usable.
    console.warn("config: no usable models yet — add an API key or model from the dashboard");
  }
  return cfg;
}

// Read + build in one step (used at startup and on hot-reload).
export function loadConfig() {
  return buildConfig(readRaw());
}
