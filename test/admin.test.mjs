// Integration test: proves the dashboard admin API adds/removes models, writes
// them to config.yaml, and hot-reloads the running chain — no restart.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROUTER_PORT = 9790;
const dir = mkdtempSync(join(tmpdir(), "router-admin-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(
  cfgPath,
  `port: ${ROUTER_PORT}
chain:
  - id: first
    provider: openrouter
    model: vendor/first:free
    apiKeys: "\${TESTKEY}"
`
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); rmSync(dir, { recursive: true, force: true }); }
const api = (path, opts) => fetch(`http://localhost:${ROUTER_PORT}${path}`, opts);
const status = async () => (await api("/status")).json();

(async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json"), TESTKEY: "k-real" },
    stdio: "ignore",
  });
  await sleep(800);

  // Start: 1 model.
  let s = await status();
  if (s.chain.length !== 1) fail(`expected 1 model at start, got ${s.chain.length}`);

  // Add a second (active — TESTKEY is set).
  let r = await api("/admin/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "second", provider: "huggingface", model: "vendor/second", apiKeys: "${TESTKEY}", rpm: 15 }),
  });
  let j = await r.json();
  if (!r.ok || !j.active) fail(`add failed: ${JSON.stringify(j)}`);
  s = await status();
  if (s.chain.length !== 2) fail(`expected 2 models after add, got ${s.chain.length}`);
  if (!readFileSync(cfgPath, "utf8").includes("second")) fail("config.yaml not updated on disk");
  console.log("PASS  add model: hot-reloaded to 2 models, persisted to config.yaml");

  // Duplicate id rejected.
  r = await api("/admin/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "second", provider: "openrouter", model: "x", apiKeys: "${TESTKEY}" }),
  });
  if (r.status !== 409) fail(`expected 409 on duplicate, got ${r.status}`);
  console.log("PASS  duplicate id rejected (409)");

  // Add with an UNSET env var -> accepted but inactive (skipped from live chain).
  r = await api("/admin/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "keyless", provider: "openrouter", model: "vendor/x:free", apiKeys: "${NOPE_UNSET}" }),
  });
  j = await r.json();
  if (!r.ok || j.active) fail(`expected inactive add, got ${JSON.stringify(j)}`);
  s = await status();
  if (s.chain.some((m) => m.id === "keyless")) fail("keyless model should be skipped from live chain");
  console.log(`PASS  keyless model added but inactive: "${j.warning?.slice(0, 40)}..."`);

  // Delete the second model.
  r = await api("/admin/models/second", { method: "DELETE" });
  if (!r.ok) fail(`delete failed: ${r.status}`);
  s = await status();
  if (s.chain.some((m) => m.id === "second")) fail("second still present after delete");
  console.log("PASS  delete model: hot-reloaded, removed from chain");

  // Delete missing -> 404.
  r = await api("/admin/models/ghost", { method: "DELETE" });
  if (r.status !== 404) fail(`expected 404 deleting missing, got ${r.status}`);
  console.log("PASS  delete missing id (404)");

  console.log("\nAll admin tests passed ✅");
  cleanup();
  process.exit(0);
})();

setTimeout(() => fail("timeout"), 8000);
