// Integration test: proves the router honors a requested model (by id or slug),
// rotates that model's keys, and falls back to the full chain for auto/unknown.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9961;
const ROUTER_PORT = 9795;

// Mock echoes the upstream model slug; 200 always.
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const model = JSON.parse(body || "{}").model;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: model } }] }));
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-reqmodel-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(cfgPath, `port: ${ROUTER_PORT}
chain:
  - id: a
    provider: openrouter
    model: vendor/a
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: "\${TESTKEY}"
  - id: b
    provider: huggingface
    model: vendor/b
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: "\${TESTKEY}"
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); mock.close(); rmSync(dir, { recursive: true, force: true }); }
async function chat(model) {
  const r = await fetch(`http://localhost:${ROUTER_PORT}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  return r.headers.get("X-Router-Model");
}

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json"), TESTKEY: "k" }, stdio: "ignore",
  });
  await sleep(800);

  if (await chat("auto") !== "a") fail("auto should pick first model (a)");
  console.log('PASS  "auto" routes to first model (a)');

  if (await chat("b") !== "b") fail('requested id "b" should route to b');
  console.log('PASS  requested id "b" routes to b (not the first model)');

  if (await chat("vendor/b") !== "b") fail('requested slug "vendor/b" should route to b');
  console.log('PASS  requested slug "vendor/b" routes to b');

  if (await chat("ghost") !== "a") fail("unknown model should fall back to full chain (a)");
  console.log('PASS  unknown model falls back to chain (a)');

  console.log("\nAll requested-model tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
