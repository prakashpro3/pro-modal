// Integration test: proves the per-minute token bucket rotates to another slot
// once a model exhausts its rpm budget — WITHOUT the upstream ever returning 429.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9921;
const ROUTER_PORT = 9788;

// Both models always succeed — the only limiter here is the router's own rpm.
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const model = JSON.parse(body || "{}").model;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `ok ${model}` } }] }));
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-rpm-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(
  cfgPath,
  `port: ${ROUTER_PORT}
cooldownMs: 60000
transientRetries: 0
chain:
  - id: fast
    provider: openrouter
    model: model-fast
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKey: k
    rpm: 2
  - id: slow
    provider: huggingface
    model: model-slow
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKey: k
`
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) {
  console.error("FAIL:", msg);
  cleanup();
  process.exit(1);
}
function cleanup() {
  router?.kill();
  mock.close();
  rmSync(dir, { recursive: true, force: true });
}

async function chat() {
  const r = await fetch(`http://localhost:${ROUTER_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, model: r.headers.get("X-Router-Model") };
}

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json") },
    stdio: "ignore",
  });
  await sleep(800);

  // "fast" has rpm:2 -> first two requests use it, the third is over budget
  // this minute and must rotate to "slow".
  const r1 = await chat();
  const r2 = await chat();
  const r3 = await chat();
  if (r1.model !== "fast") fail(`req1 expected fast, got ${r1.model}`);
  if (r2.model !== "fast") fail(`req2 expected fast, got ${r2.model}`);
  if (r3.model !== "slow") fail(`req3 expected rotation to slow, got ${r3.model}`);
  console.log(`PASS  rpm bucket: fast served 2/min, 3rd rotated to ${r3.model}`);

  const u = await (await fetch(`http://localhost:${ROUTER_PORT}/usage`)).json();
  if (u["fast#0"].tokensThisMinute !== 0) fail(`expected fast tokens 0, got ${u["fast#0"].tokensThisMinute}`);
  console.log(`PASS  bucket reporting: fast#0 tokensThisMinute=${u["fast#0"].tokensThisMinute}`);

  console.log("\nAll rpm tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
