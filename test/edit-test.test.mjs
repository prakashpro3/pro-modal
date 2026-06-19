// Integration test: proves PATCH /admin/models/:id edits rpm/dailyLimit (and
// clears them when blank), and POST /admin/models/:id/test fires one real
// request through that model and reports ok/latency.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9941;
const ROUTER_PORT = 9793;

const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-edit-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(cfgPath, `port: ${ROUTER_PORT}
chain:
  - id: m1
    provider: openrouter
    model: vendor/m1
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: "\${TESTKEY}"
    rpm: 20
    dailyLimit: 50
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); mock.close(); rmSync(dir, { recursive: true, force: true }); }
const api = (p, o) => fetch(`http://localhost:${ROUTER_PORT}${p}`, o);
const modelById = async (id) => (await (await api("/status")).json()).chain.find((m) => m.id === id);

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json"), TESTKEY: "k" }, stdio: "ignore",
  });
  await sleep(800);

  // Edit: change rpm 20 -> 5, clear dailyLimit.
  let r = await api("/admin/models/m1", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rpm: 5, dailyLimit: "" }),
  });
  if (!r.ok) fail(`patch failed: ${r.status}`);
  let m = await modelById("m1");
  if (m.rpm !== 5) fail(`expected rpm 5, got ${m.rpm}`);
  if (m.dailyLimit !== null) fail(`expected dailyLimit cleared, got ${m.dailyLimit}`);
  console.log(`PASS  edit limits: rpm 20->5, dailyLimit cleared (hot-reloaded)`);

  // Patch missing model -> 404.
  r = await api("/admin/models/ghost", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rpm: 1 }),
  });
  if (r.status !== 404) fail(`expected 404 patching missing, got ${r.status}`);
  console.log("PASS  patch missing model (404)");

  // Test endpoint -> hits mock, returns ok + latency + sample.
  r = await api("/admin/models/m1/test", { method: "POST" });
  let j = await r.json();
  if (!j.ok || j.status !== 200 || typeof j.latencyMs !== "number") fail(`test failed: ${JSON.stringify(j)}`);
  if (!String(j.sample).includes("pong")) fail(`expected sample "pong", got ${JSON.stringify(j.sample)}`);
  console.log(`PASS  test model: ok in ${j.latencyMs}ms, sample="${j.sample}"`);

  // Test unknown model -> 404.
  r = await api("/admin/models/ghost/test", { method: "POST" });
  if (r.status !== 404) fail(`expected 404 testing missing, got ${r.status}`);
  console.log("PASS  test missing model (404)");

  // Test-all -> every model tested, healthy/total reported.
  r = await api("/admin/test-all", { method: "POST" });
  j = await r.json();
  if (j.total !== 1 || j.healthy !== 1 || j.results[0].id !== "m1") fail(`test-all wrong: ${JSON.stringify(j)}`);
  console.log(`PASS  test-all: ${j.healthy}/${j.total} healthy`);

  console.log("\nAll edit/test tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
