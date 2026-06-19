// Integration test: proves the router (1) switches models on 429, (2) rotates
// API keys on 429, and (3) tracks usage per (model, key). Uses a mock upstream.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9911;
const ROUTER_PORT = 9787;

// Mock upstream rules:
//   model-a + any key  -> 429 (always limited)         => forces model switch
//   model-b + key "k1" -> 429 (that key is limited)    => forces key rotation
//   model-b + key "k2" -> 200 (good)
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const model = JSON.parse(body || "{}").model;
    const key = (req.headers.authorization || "").replace("Bearer ", "");
    const limited = model === "model-a" || (model === "model-b" && key === "k1");
    if (limited) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limit" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `ok ${model}/${key}` } }] }));
    }
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-test-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(
  cfgPath,
  `port: ${ROUTER_PORT}
cooldownMs: 60000
transientRetries: 0
chain:
  - id: a
    provider: openrouter
    model: model-a
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: [k1, k2]
    dailyLimit: 100
  - id: b
    provider: huggingface
    model: model-b
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: [k1, k2]
    dailyLimit: 100
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
  return {
    status: r.status,
    model: r.headers.get("X-Router-Model"),
    key: r.headers.get("X-Router-Key"),
    json: await r.json(),
  };
}

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json") },
    stdio: "ignore",
  });
  await sleep(800);

  // model-a both keys 429 -> switch to model-b; model-b key0(k1) 429 -> rotate
  // to model-b key1(k2) which succeeds. Final answer: model b, key1.
  const r1 = await chat();
  if (r1.status !== 200) fail(`expected 200, got ${r1.status} ${JSON.stringify(r1.json)}`);
  if (r1.model !== "b" || r1.key !== "key1") fail(`expected b/key1, got ${r1.model}/${r1.key}`);
  console.log(`PASS  model switch + key rotation: answered by ${r1.model}/${r1.key}`);

  // Everything else is now in cooldown except b/key1 -> still served by it.
  const r2 = await chat();
  if (r2.model !== "b" || r2.key !== "key1") fail(`expected b/key1 again, got ${r2.model}/${r2.key}`);
  console.log(`PASS  cooldown skip: exhausted slots skipped, answered by ${r2.model}/${r2.key}`);

  // Usage shows the limited slots cooled down and the working slot counted.
  const u = await (await fetch(`http://localhost:${ROUTER_PORT}/usage`)).json();
  const cooled = ["a#0", "a#1", "b#0"].every((s) => u[s]?.cooldownRemainingMs > 0);
  if (!cooled) fail(`expected a#0,a#1,b#0 in cooldown, got ${JSON.stringify(u)}`);
  if ((u["b#1"]?.count ?? 0) < 2) fail(`expected b#1.count>=2, got ${JSON.stringify(u["b#1"])}`);
  console.log(`PASS  per-(model,key) usage: b#1.count=${u["b#1"].count}, 3 slots cooled down`);

  console.log("\nAll tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
