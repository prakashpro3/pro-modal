// Integration test: proves /v1/messages (Anthropic API for Claude Code) translates
// request -> OpenAI, routes through the chain, and translates the response back —
// for non-streaming, streaming (SSE), and tool calls.
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MOCK_PORT = 9971;
const ROUTER_PORT = 9796;

// Mock OpenAI upstream: echoes whether it saw a system msg + tools, and can
// stream. Returns a tool_call when the request includes tools.
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = JSON.parse(body || "{}");
    const hasTools = Array.isArray(r.tools) && r.tools.length > 0;
    if (r.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { role: "assistant", content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ];
      for (const c of chunks) res.write("data: " + JSON.stringify(c) + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const message = hasTools
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }
      : { role: "assistant", content: "Hello there" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "cmpl_1", choices: [{ message, finish_reason: hasTools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
});

const dir = mkdtempSync(join(tmpdir(), "router-msg-"));
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
const msg = (b) => fetch(`http://localhost:${ROUTER_PORT}/v1/messages`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
});

mock.listen(MOCK_PORT, async () => {
  router = spawn("node", ["src/server.js"], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTER_USAGE: join(dir, "usage.json"), TESTKEY: "k" }, stdio: "ignore",
  });
  await sleep(800);

  // 1. Non-streaming: Anthropic request -> Anthropic response shape.
  let r = await msg({ model: "claude-x", max_tokens: 50, system: "be brief", messages: [{ role: "user", content: "hi" }] });
  let j = await r.json();
  if (j.type !== "message" || j.role !== "assistant") fail(`bad message shape: ${JSON.stringify(j)}`);
  if (j.content?.[0]?.type !== "text" || j.content[0].text !== "Hello there") fail(`bad content: ${JSON.stringify(j.content)}`);
  if (j.stop_reason !== "end_turn") fail(`bad stop_reason: ${j.stop_reason}`);
  if (j.usage?.input_tokens !== 5 || j.usage?.output_tokens !== 3) fail(`bad usage: ${JSON.stringify(j.usage)}`);
  console.log("PASS  non-streaming: OpenAI response -> Anthropic message shape");

  // 2. Tools: Anthropic tools -> OpenAI -> tool_use block back.
  r = await msg({ model: "claude-x", max_tokens: 50,
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: "weather in Paris?" }] });
  j = await r.json();
  const tu = j.content?.find((b) => b.type === "tool_use");
  if (!tu || tu.name !== "get_weather" || tu.input?.city !== "Paris") fail(`bad tool_use: ${JSON.stringify(j.content)}`);
  if (j.stop_reason !== "tool_use") fail(`expected stop_reason tool_use, got ${j.stop_reason}`);
  console.log("PASS  tools: tool_calls -> Anthropic tool_use block");

  // 3. Streaming: Anthropic SSE event sequence.
  r = await msg({ model: "claude-x", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await r.text();
  const events = text.split("\n").filter((l) => l.startsWith("event:")).map((l) => l.slice(6).trim());
  for (const ev of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
    if (!events.includes(ev)) fail(`stream missing event "${ev}". got: ${events.join(",")}`);
  }
  if (!text.includes('"text_delta"') || !text.includes("Hel")) fail("stream missing text deltas");
  console.log("PASS  streaming: full Anthropic SSE event sequence with text deltas");

  console.log("\nAll messages tests passed ✅");
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
