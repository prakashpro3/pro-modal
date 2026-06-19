// Integration test: proves PUT /admin/models/order reorders the chain priority,
// persists to config.yaml, hot-reloads, and keeps unlisted (inactive) entries
// in their original slots.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

const ROUTER_PORT = 9792;
const dir = mkdtempSync(join(tmpdir(), "router-order-"));
const cfgPath = join(dir, "config.yaml");
// a, b, c active (TESTKEY set); x is key-less -> inactive, sits between b and c.
writeFileSync(cfgPath, `port: ${ROUTER_PORT}
chain:
  - { id: a, provider: openrouter, model: v/a, apiKeys: "\${TESTKEY}" }
  - { id: b, provider: openrouter, model: v/b, apiKeys: "\${TESTKEY}" }
  - { id: x, provider: openrouter, model: v/x, apiKeys: "\${UNSET_X}" }
  - { id: c, provider: openrouter, model: v/c, apiKeys: "\${TESTKEY}" }
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); rmSync(dir, { recursive: true, force: true }); }
const api = (p, o) => fetch(`http://localhost:${ROUTER_PORT}${p}`, o);
const ids = async () => (await (await api("/status")).json()).chain.map((m) => m.id);

(async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json"), TESTKEY: "k", UNSET_X: "" },
    stdio: "ignore",
  });
  await sleep(800);

  if ((await ids()).join(",") !== "a,b,c") fail(`expected a,b,c initially, got ${await ids()}`);

  // Reorder active models: c first, then a, then b.
  const r = await api("/admin/models/order", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: ["c", "a", "b"] }),
  });
  const j = await r.json();
  if (!r.ok) fail(`reorder failed: ${JSON.stringify(j)}`);
  if ((await ids()).join(",") !== "c,a,b") fail(`expected c,a,b after reorder, got ${await ids()}`);
  console.log("PASS  reorder active models: c,a,b hot-reloaded");

  // Inactive "x" kept its original slot (was index 2, between the listed ones).
  const disk = YAML.parse(readFileSync(cfgPath, "utf8")).chain.map((m) => m.id);
  if (disk.join(",") !== "c,a,x,b") fail(`expected c,a,x,b on disk (x slot preserved), got ${disk}`);
  console.log(`PASS  unlisted entry keeps its slot on disk: ${disk.join(",")}`);

  // Unknown id rejected.
  const bad = await api("/admin/models/order", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: ["c", "ghost"] }),
  });
  if (bad.status !== 400) fail(`expected 400 for unknown id, got ${bad.status}`);
  console.log("PASS  unknown id rejected (400)");

  console.log("\nAll reorder tests passed ✅");
  cleanup();
  process.exit(0);
})();

setTimeout(() => fail("timeout"), 8000);
