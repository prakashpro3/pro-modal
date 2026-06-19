// Translation between the Anthropic Messages API (what Claude Code speaks) and
// the OpenAI Chat Completions API (what the router forwards to OpenRouter/HF).

let _seq = 0;
const rid = () => (++_seq).toString(36) + Date.now().toString(36);

const STOP_MAP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
const mapStop = (r) => STOP_MAP[r] || "end_turn";

// ---- Request: Anthropic /v1/messages  ->  OpenAI /v1/chat/completions ----

function convertContentBlocks(content) {
  // Returns { text: [openai content parts], toolCalls: [...], toolResults: [...] }
  const parts = [], toolCalls = [], toolResults = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image") {
      const s = b.source || {};
      const url = s.type === "base64" ? `data:${s.media_type};base64,${s.data}` : s.url;
      parts.push({ type: "image_url", image_url: { url } });
    } else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    } else if (b.type === "tool_result") {
      const c = b.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text || "").join("\n") : "";
      toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
    }
  }
  return { parts, toolCalls, toolResults };
}

function convertMessage(m) {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
  const { parts, toolCalls, toolResults } = convertContentBlocks(m.content || []);
  const out = [];

  if (m.role === "assistant") {
    const msg = { role: "assistant" };
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    msg.content = text || null;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
  } else {
    // user: tool_result blocks become standalone "tool" messages (must precede
    // any new user text per OpenAI's ordering), then the remaining text/images.
    for (const tr of toolResults) out.push(tr);
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      out.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("") : parts });
    }
  }
  return out;
}

export function anthropicToOpenAI(a) {
  const messages = [];
  if (a.system) {
    const sys = typeof a.system === "string" ? a.system : a.system.map((b) => b.text || "").join("\n");
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const m of a.messages || []) messages.push(...convertMessage(m));

  const o = { model: a.model, messages, max_tokens: a.max_tokens, stream: a.stream === true };
  if (a.temperature != null) o.temperature = a.temperature;
  if (a.top_p != null) o.top_p = a.top_p;
  if (a.stop_sequences) o.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    o.tools = a.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } },
    }));
    if (a.tool_choice) {
      const tc = a.tool_choice;
      o.tool_choice = tc.type === "tool" ? { type: "function", function: { name: tc.name } }
        : tc.type === "any" ? "required" : tc.type === "auto" ? "auto" : "auto";
    }
  }
  return o;
}

// ---- Response (non-streaming): OpenAI  ->  Anthropic ----

export function openAIToAnthropic(o, model) {
  const choice = o.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* leave {} */ }
    content.push({ type: "tool_use", id: tc.id || "toolu_" + rid(), name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: o.id || "msg_" + rid(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStop(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: o.usage?.prompt_tokens || 0, output_tokens: o.usage?.completion_tokens || 0 },
  };
}

// ---- Response (streaming): OpenAI SSE  ->  Anthropic SSE ----
// Writes the Anthropic event sequence to `res` and ends it.
export async function streamAnthropic(upstream, res, model) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const msgId = "msg_" + rid();
  let started = false, idx = -1, textOpen = false;
  const tools = {}; // openai tool index -> { index (anthropic block), id, name }
  let stopReason = "end_turn", inTokens = 0, outTokens = 0;

  const ensureStart = () => {
    if (started) return;
    started = true;
    send("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 0 } },
    });
  };
  const closeText = () => { if (textOpen) { send("content_block_stop", { type: "content_block_stop", index: idx }); textOpen = false; } };

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.usage) {
        inTokens = chunk.usage.prompt_tokens || inTokens;
        outTokens = chunk.usage.completion_tokens || outTokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      ensureStart();

      if (delta.content) {
        if (!textOpen) {
          idx++; textOpen = true;
          send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
        }
        send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: delta.content } });
      }

      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!tools[k]) {
          closeText();
          idx++;
          tools[k] = { index: idx, id: tc.id || "toolu_" + rid(), name: tc.function?.name || "" };
          send("content_block_start", { type: "content_block_start", index: idx,
            content_block: { type: "tool_use", id: tools[k].id, name: tools[k].name, input: {} } });
        }
        const args = tc.function?.arguments;
        if (args) send("content_block_delta", { type: "content_block_delta", index: tools[k].index, delta: { type: "input_json_delta", partial_json: args } });
      }

      if (choice.finish_reason) stopReason = mapStop(choice.finish_reason);
    }
  }

  ensureStart();
  closeText();
  for (const k of Object.keys(tools)) send("content_block_stop", { type: "content_block_stop", index: tools[k].index });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTokens } });
  send("message_stop", { type: "message_stop" });
  res.end();
}
