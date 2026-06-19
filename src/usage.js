import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = join(__dirname, "..", "usage.json");

// Per (model, key-index) state persisted across restarts. The "slot" is the
// unit of availability — switching a key is just moving to a different slot:
//   { "deepseek-free#0": { day, count, cooldownUntil }, "deepseek-free#1": {...} }
let state = {};

function load() {
  if (existsSync(USAGE_PATH)) {
    try {
      state = JSON.parse(readFileSync(USAGE_PATH, "utf8"));
    } catch {
      state = {};
    }
  }
}
load();

function persist() {
  try {
    writeFileSync(USAGE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("usage: failed to persist", err.message);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

const slotId = (modelId, keyIdx) => `${modelId}#${keyIdx}`;

// Per-slot token buckets for per-minute rate limiting. Kept in memory only —
// a per-minute window has no meaning across restarts, so it resets full on boot.
//   { "deepseek-free#0": { tokens: 4.2, lastRefill: 1718800000000 } }
const buckets = {};

// Refill + try to consume one token. Returns false if the slot is over its
// requests-per-minute budget right now (caller should rotate to another slot).
export function tryConsumeToken(model, keyIdx) {
  const rpm = model.rpm;
  if (!Number.isFinite(rpm) || rpm <= 0) return true; // unlimited
  const id = slotId(model.id, keyIdx);
  const now = Date.now();
  let b = buckets[id];
  if (!b) b = buckets[id] = { tokens: rpm, lastRefill: now };
  // Continuous refill at rpm tokens per 60s, capped at capacity (rpm).
  const elapsedSec = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(rpm, b.tokens + elapsedSec * (rpm / 60));
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

function bucketTokens(id) {
  return buckets[id] ? Math.floor(buckets[id].tokens) : null;
}

// Per-slot request history for sparklines: counts bucketed into 1-minute slots,
// keeping the last HISTORY_BUCKETS minutes. In memory only (resets on restart).
const BUCKET_MS = 60_000;
const HISTORY_BUCKETS = 30;
const history = {}; // slotId -> { [absoluteMinuteIndex]: count }

function bumpHistory(id) {
  const idx = Math.floor(Date.now() / BUCKET_MS);
  const h = history[id] || (history[id] = {});
  h[idx] = (h[idx] || 0) + 1;
  const cutoff = idx - HISTORY_BUCKETS + 1;
  for (const k of Object.keys(h)) if (Number(k) < cutoff) delete h[k]; // prune old
}

// Oldest..newest array of length HISTORY_BUCKETS (zero-filled gaps).
export function historyFor(id) {
  const idx = Math.floor(Date.now() / BUCKET_MS);
  const h = history[id] || {};
  const out = [];
  for (let i = idx - HISTORY_BUCKETS + 1; i <= idx; i++) out.push(h[i] || 0);
  return out;
}

// Roll the daily counter over at UTC midnight.
function entry(modelId, keyIdx) {
  const id = slotId(modelId, keyIdx);
  const day = today();
  if (!state[id] || state[id].day !== day) {
    state[id] = { day, count: 0, cooldownUntil: 0 };
  }
  return state[id];
}

export function recordSuccess(modelId, keyIdx) {
  entry(modelId, keyIdx).count += 1;
  bumpHistory(slotId(modelId, keyIdx));
  persist();
}

// Put a single (model, key) slot in cooldown after a limit error.
export function tripCooldown(modelId, keyIdx, cooldownMs) {
  entry(modelId, keyIdx).cooldownUntil = Date.now() + cooldownMs;
  persist();
}

// Is this specific key for this model usable right now?
export function isAvailable(model, keyIdx) {
  const e = entry(model.id, keyIdx);
  if (e.cooldownUntil > Date.now()) return false;
  if (e.count >= model.dailyLimit) return false;
  return true;
}

export function snapshot() {
  const out = {};
  for (const [id, e] of Object.entries(state)) {
    out[id] = {
      day: e.day,
      count: e.count,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - Date.now()),
      tokensThisMinute: bucketTokens(id),
    };
  }
  return out;
}
