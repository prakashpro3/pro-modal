// Minimal .env reader/writer for managing API-key pools from the dashboard.
// Keys are stored comma-separated in env vars like OPENROUTER_API_KEYS.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.ROUTER_ENV || join(__dirname, "..", ".env");

const readLines = () =>
  existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
const writeLines = (lines) => writeFileSync(ENV_PATH, lines.join("\n"));

// Current keys for a var, from the live process env (kept in sync with the file).
export function getKeysFor(varName) {
  return (process.env[varName] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Upsert VAR=value in the .env file, preserving other lines and comments.
function setVarInFile(varName, value) {
  const lines = readLines();
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === varName) {
      lines[i] = `${varName}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${varName}=${value}`);
  writeLines(lines);
}

export function addKey(varName, key) {
  key = key.trim();
  const keys = getKeysFor(varName);
  if (keys.includes(key)) return { added: false, count: keys.length };
  keys.push(key);
  const value = keys.join(",");
  process.env[varName] = value; // live, so the next reload() resolves it
  setVarInFile(varName, value);
  return { added: true, count: keys.length };
}

export function removeKey(varName, index) {
  const keys = getKeysFor(varName);
  if (index < 0 || index >= keys.length) return { removed: false };
  keys.splice(index, 1);
  const value = keys.join(",");
  process.env[varName] = value;
  setVarInFile(varName, value);
  return { removed: true, count: keys.length };
}

// Show enough to recognize a key without exposing it.
export function maskKey(k) {
  if (k.length <= 10) return "••••";
  return k.slice(0, 6) + "…" + k.slice(-4);
}
