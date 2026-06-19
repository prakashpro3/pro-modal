// Integration test: proves served requests are recorded into per-slot history
// and surfaced in /status for the sparklines.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9951;
const ROUTER_PORT = 9794;

const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-hist-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(cfgPath, `port: ${ROUTER_PORT}
chain:
  - id: m1
    provider: openrouter
    model: vendor/m1
    baseUrl: http://localhost:${MOCK_PORT}/v1
    apiKeys: "\${TESTKEY}"
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let router;
function fail(msg) { console.error("FAIL:", msg); cleanup(); process.exit(1); }
function cleanup() { router?.kill(); mock.close(); rmSync(dir, { recursive: true, force: true }); }
const api = (p, o) => fetch(`http://localhost:${ROUTER_PORT}${p}`, o);
const chat = () => api("/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
});

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, TESTKEY: "k" }, stdio: "ignore",
  });
  await sleep(800);

  // Before traffic: history exists, all zeros, fixed length.
  let s = await (await api("/status")).json();
  let h = s.chain[0].slots[0].history;
  if (!Array.isArray(h) || h.length !== 30) fail(`expected 30-length history, got ${h && h.length}`);
  if (h.reduce((a, b) => a + b, 0) !== 0) fail("history should start at 0");
  console.log("PASS  history present, length 30, starts empty");

  // Serve 3 requests.
  await chat(); await chat(); await chat();

  s = await (await api("/status")).json();
  h = s.chain[0].slots[0].history;
  const total = h.reduce((a, b) => a + b, 0);
  if (total !== 3) fail(`expected history total 3, got ${total}`);
  if (h[h.length - 1] !== 3) fail(`expected newest bucket = 3, got ${h[h.length - 1]}`);
  console.log(`PASS  3 served requests recorded into newest bucket (total ${total})`);

  console.log("\nAll history tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
