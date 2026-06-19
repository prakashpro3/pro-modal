// Integration test: proves /v1/completions (autocomplete/FIM) forwards to the
// upstream /completions path, returns choices[].text, and rotates past a slot
// that doesn't support the endpoint (404).
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9931;
const ROUTER_PORT = 9789;

// Mock upstream:
//   /v1/completions for model-nofim -> 404 (no completions support)
//   /v1/completions for model-fim   -> 200 with choices[].text
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const model = JSON.parse(body || "{}").model;
    if (!req.url.endsWith("/completions") || req.url.endsWith("/chat/completions")) {
      res.writeHead(400).end("wrong path");
      return;
    }
    if (model === "model-nofim") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no completions endpoint" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "text_completion", choices: [{ text: ` world (${model})` }] }));
    }
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-fim-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(
  cfgPath,
  `port: ${ROUTER_PORT}
cooldownMs: 60000
transientRetries: 0
chain:
  - id: nofim
    provider: openrouter
    model: model-nofim
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKey: k
  - id: fim
    provider: huggingface
    model: model-fim
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

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json") },
    stdio: "ignore",
  });
  await sleep(800);

  const r = await fetch(`http://localhost:${ROUTER_PORT}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "auto", prompt: "hello" }),
  });
  const json = await r.json();
  if (r.status !== 200) fail(`expected 200, got ${r.status} ${JSON.stringify(json)}`);
  // nofim 404'd -> router rotated to fim, which returned text.
  if (r.headers.get("X-Router-Model") !== "fim") fail(`expected fim, got ${r.headers.get("X-Router-Model")}`);
  if (!json.choices?.[0]?.text?.includes("model-fim")) fail(`bad completion: ${JSON.stringify(json)}`);
  console.log(`PASS  /v1/completions: 404 slot skipped, served by "fim" -> text="${json.choices[0].text}"`);

  console.log("\nAll completions tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
