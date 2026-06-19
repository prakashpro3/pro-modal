// Integration test: proves the dashboard key API adds/removes keys in .env,
// updates the live process, and hot-reloads so an inactive model goes live.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROUTER_PORT = 9791;
const dir = mkdtempSync(join(tmpdir(), "router-keys-"));
const cfgPath = join(dir, "config.yaml");
const envPath = join(dir, ".env");
// Model references OPENROUTER_API_KEYS, which starts EMPTY -> model inactive.
writeFileSync(cfgPath, `port: ${ROUTER_PORT}
chain:
  - id: m1
    provider: openrouter
    model: vendor/m1:free
    apiKeys: "\${OPENROUTER_API_KEYS}"
`);
writeFileSync(envPath, "OPENROUTER_API_KEYS=\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); rmSync(dir, { recursive: true, force: true }); }
const api = (p, o) => fetch(`http://localhost:${ROUTER_PORT}${p}`, o);
const json = (p) => api(p).then((r) => r.json());

(async () => {
  router = spawn("node", ["src/server.js"], {
    // ROUTER_ENV points the .env manager at our temp file; clear inherited key.
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_ENV: envPath, ROUTER_USAGE: join(dir, "usage.json"), OPENROUTER_API_KEYS: "" },
    stdio: "ignore",
  });
  await sleep(800);

  // Model is inactive (no keys) -> not in live chain.
  let s = await json("/status");
  if (s.chain.some((m) => m.id === "m1")) fail("m1 should be inactive with no keys");
  console.log("PASS  model with empty key pool is inactive");

  // Keys endpoint lists the pool with 0 keys.
  let keys = await json("/admin/keys");
  const pool = keys.find((k) => k.envVar === "OPENROUTER_API_KEYS");
  if (!pool || pool.keys.length !== 0) fail(`expected empty OPENROUTER_API_KEYS, got ${JSON.stringify(pool)}`);

  // Add a key -> file updated, masked, model goes LIVE via hot-reload.
  let r = await api("/admin/keys", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envVar: "OPENROUTER_API_KEYS", key: "sk-or-v1-abcdef1234567890" }),
  });
  let j = await r.json();
  if (!r.ok || j.count !== 1) fail(`add key failed: ${JSON.stringify(j)}`);
  if (!readFileSync(envPath, "utf8").includes("sk-or-v1-abcdef1234567890")) fail(".env not updated");
  keys = await json("/admin/keys");
  const masked = keys.find((k) => k.envVar === "OPENROUTER_API_KEYS").keys[0];
  if (masked.includes("abcdef1234567890")) fail(`key not masked: ${masked}`);
  s = await json("/status");
  if (!s.chain.some((m) => m.id === "m1")) fail("m1 should be LIVE after adding a key");
  console.log(`PASS  add key: masked "${masked}", .env written, m1 hot-reloaded LIVE`);

  // Duplicate key is a no-op.
  r = await api("/admin/keys", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envVar: "OPENROUTER_API_KEYS", key: "sk-or-v1-abcdef1234567890" }),
  });
  j = await r.json();
  if (j.added !== false) fail("duplicate key should be a no-op");
  console.log("PASS  duplicate key is a no-op");

  // Delete the key -> model goes inactive again.
  r = await api("/admin/keys", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envVar: "OPENROUTER_API_KEYS", index: 0 }),
  });
  if (!r.ok) fail(`delete key failed: ${r.status}`);
  s = await json("/status");
  if (s.chain.some((m) => m.id === "m1")) fail("m1 should be inactive after key removed");
  console.log("PASS  delete key: hot-reloaded, m1 inactive again");

  console.log("\nAll key tests passed ✅");
  cleanup();
  process.exit(0);
})();

setTimeout(() => fail("timeout"), 8000);
