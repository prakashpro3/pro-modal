// Self-contained dashboard page. No build step, no deps — vanilla JS that polls
// /status every 2s and renders one card per model with a row per (model, key) slot.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Auto Model Router — Status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
         background: #0d1117; color: #e6edf3; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #7d8590; font-size: 13px; margin-bottom: 20px; }
  #freepool { margin-top:-12px; }
  #freepool b { color:#3fb950; font-size:15px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .ok { background:#3fb950; } .warn { background:#d29922; } .bad { background:#f85149; }
  .grid { display:grid; gap:16px; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); }
  .card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px; cursor:grab; }
  .card.dragging { opacity:.4; cursor:grabbing; }
  .prio { display:inline-block; min-width:22px; text-align:center; background:#21262d; color:#7d8590;
          border-radius:6px; padding:0 6px; font-size:12px; margin-right:6px; }
  .cardbtns { display:inline-flex; align-items:center; gap:7px; }
  .tbtn, .ebtn { background:transparent; border:1px solid #30363d; color:#7d8590; font-size:11px; padding:2px 8px; border-radius:6px; }
  .tbtn:hover { color:#58a6ff; border-color:#58a6ff; } .ebtn:hover { color:#d29922; border-color:#d29922; }
  .ghostbtn { background:transparent; border:1px solid #30363d; color:#58a6ff; font-size:12px; padding:2px 10px; border-radius:6px; }
  .ghostbtn:hover { border-color:#58a6ff; }
  .spark { vertical-align:middle; }
  .histn { color:#7d8590; font-size:11px; margin-left:6px; }
  .testres { font-size:12px; margin:8px 0 0; min-height:0; }
  .testres.ok { color:#3fb950; } .testres.bad { color:#f85149; } .testres.run { color:#7d8590; }
  .editor { display:flex; gap:10px; align-items:end; margin-top:10px; flex-wrap:wrap; }
  .editor[hidden] { display:none; }
  .editor input { width:80px; }
  .save-edit { background:#238636; color:#fff; } .cancel-edit { background:#30363d; color:#e6edf3; }
  .card h2 { font-size:15px; margin:0 0 2px; display:flex; align-items:center; justify-content:space-between; }
  .muted { color:#7d8590; font-size:12px; }
  .model-id { color:#58a6ff; font-family: ui-monospace, monospace; font-size:12px; word-break:break-all; }
  .remain { font-size:13px; margin-top:8px; }
  .remain b { color:#e6edf3; font-size:15px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th { text-align:left; color:#7d8590; font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding:4px 6px; }
  td { padding:6px; border-top:1px solid #21262d; font-variant-numeric: tabular-nums; }
  .bar { position:relative; height:6px; border-radius:3px; background:#21262d; overflow:hidden; margin-top:3px; }
  .bar > span { position:absolute; inset:0 auto 0 0; border-radius:3px; }
  .fill-ok > span { background:#3fb950; } .fill-warn > span { background:#d29922; } .fill-bad > span { background:#f85149; }
  .badge { font-size:11px; padding:1px 7px; border-radius:20px; }
  .b-ok { background:#1a3326; color:#3fb950; } .b-warn { background:#332a14; color:#d29922; } .b-bad { background:#3d1a1a; color:#f85149; }
  .err { background:#3d1a1a; color:#f85149; border:1px solid #f85149; padding:12px; border-radius:8px; }
  .foot { color:#7d8590; font-size:12px; margin-top:18px; }
  code { background:#21262d; padding:1px 5px; border-radius:4px; font-size:12px; }
  details { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:0 16px; margin-bottom:20px; }
  summary { cursor:pointer; padding:14px 0; font-weight:600; }
  form { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap:12px; padding-bottom:16px; }
  label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:#7d8590; }
  input, select { background:#0d1117; border:1px solid #30363d; color:#e6edf3; border-radius:6px; padding:7px 9px; font:inherit; }
  button { cursor:pointer; border:0; border-radius:6px; padding:8px 14px; font:inherit; font-weight:600; }
  .add-btn { background:#238636; color:#fff; align-self:end; }
  .add-btn:hover { background:#2ea043; }
  .del { background:transparent; color:#7d8590; border:1px solid #30363d; font-size:11px; padding:2px 8px; border-radius:6px; }
  .del:hover { color:#f85149; border-color:#f85149; }
  .formmsg { grid-column:1/-1; font-size:13px; }
  .formmsg.ok { color:#3fb950; } .formmsg.bad { color:#f85149; } .formmsg.warn { color:#d29922; }
  .pickrow { display:flex; gap:10px; align-items:center; margin-bottom:6px; }
  .pickrow > input { flex:1; }
  .inline { flex-direction:row; align-items:center; gap:5px; color:#e6edf3; white-space:nowrap; }
  .inline input { width:auto; }
  select option { background:#0d1117; }
  .keyvar { padding:10px 0; border-top:1px solid #21262d; }
  .keyvar:first-child { border-top:0; }
  .keylist { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; }
  .keychip { display:inline-flex; align-items:center; gap:6px; background:#0d1117; border:1px solid #30363d;
             border-radius:20px; padding:3px 6px 3px 12px; font-family:ui-monospace,monospace; font-size:12px; }
  .keydel { background:transparent; color:#7d8590; border:0; cursor:pointer; font-size:13px; padding:0 4px; }
  .keydel:hover { color:#f85149; }
</style>
</head>
<body>
  <h1><span id="health" class="dot bad"></span>Auto Model Router</h1>
  <div class="sub"><span id="meta">connecting…</span>
    &nbsp;·&nbsp; <button id="testall" class="ghostbtn">Test all</button>
    <span id="testallmsg" class="muted"></span>
    <span id="credits" class="muted"></span></div>
  <div class="sub" id="freepool"></div>

  <details>
    <summary>+ Add a model</summary>
    <form id="addform">
      <label>Provider<select name="provider" id="provider"></select></label>
      <label style="grid-column:1/-1">Model
        <div class="pickrow">
          <input id="modelfilter" placeholder="search models…">
          <label class="inline"><input type="checkbox" id="freeonly" checked> free only</label>
        </div>
        <select name="model" id="modelsel" required></select>
      </label>
      <label>ID (unique label)<input name="id" placeholder="auto from model" required></label>
      <label>API keys (env ref)<input name="apiKeys" value="\${OPENROUTER_API_KEYS}" required></label>
      <label>Daily limit (optional)<input name="dailyLimit" type="number" placeholder="auto for free"></label>
      <label>RPM (optional)<input name="rpm" type="number" placeholder="20"></label>
      <button type="submit" class="add-btn">Add model</button>
      <div class="formmsg" id="formmsg"></div>
    </form>
  </details>

  <details>
    <summary>🔑 API keys</summary>
    <div id="keyspanel"></div>
    <form id="keyform">
      <label>Key pool<select name="envVar" id="keyenv"></select></label>
      <label style="flex:2; min-width:240px">New API key<input name="key" placeholder="sk-or-… or hf_…" required></label>
      <button type="submit" class="add-btn">Add key</button>
      <div class="formmsg" id="keymsg"></div>
    </form>
  </details>

  <div id="root" class="grid"></div>
  <div id="error"></div>
  <div class="foot">Auto-refreshes every 2s · raw JSON at <code>/status</code> · <code>/usage</code></div>

<script>
const fmtMs = (ms) => {
  if (!ms) return "";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
};

function slotState(s) {
  if (s.cooldownRemainingMs > 0) return "bad";
  if (s.dailyLimit && s.count >= s.dailyLimit) return "bad";
  if (s.dailyLimit && s.count >= s.dailyLimit * 0.8) return "warn";
  return "ok";
}

const KEY_ENV = { openrouter: "\${OPENROUTER_API_KEYS}", huggingface: "\${HF_API_KEYS}" };
const catalog = {};   // provider -> [{id,name,contextLength,free}]
let dragging = false; // pause auto-refresh re-render while reordering cards
let editing = false;  // pause auto-refresh while an inline editor is open
let creditsInfo = null; // OpenRouter account info incl. derived free daily cap
const lastTest = {};  // id -> last test result, re-applied after each re-render

// Inline SVG sparkline from an oldest..newest array of counts.
function spark(values) {
  if (!values || !values.length) return "";
  const w = 88, h = 22, n = values.length;
  const max = Math.max(1, ...values);
  const step = n > 1 ? w / (n - 1) : w;
  const pts = values.map((v, i) =>
    (i * step).toFixed(1) + "," + (h - 3 - (v / max) * (h - 6)).toFixed(1)).join(" ");
  const stroke = values[n - 1] > 0 ? "#3fb950" : "#58a6ff"; // green if active right now
  return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
    '" preserveAspectRatio="none"><polyline points="' + pts +
    '" fill="none" stroke="' + stroke + '" stroke-width="1.5" stroke-linejoin="round"/></svg>';
}

function paintTest(out, res) {
  if (!out || !res) return;
  if (res.running) { out.className = "testres run"; out.textContent = "Testing…"; return; }
  if (res.ok) {
    out.className = "testres ok";
    out.textContent = "✓ OK · " + res.latencyMs + "ms" + (res.sample ? ' · "' + res.sample + '"' : "");
  } else {
    out.className = "testres bad";
    out.textContent = "✗ " + (res.status ? "HTTP " + res.status + " · " : "") + (res.error || "failed");
  }
}

let providersLoaded = false;
function loadProviders(providers) {
  if (providersLoaded || !providers) return;
  const sel = document.getElementById("provider");
  sel.innerHTML = providers.map(p => '<option value="' + p + '">' + p + '</option>').join("");
  sel.addEventListener("change", onProviderChange);
  document.getElementById("modelfilter").addEventListener("input", refreshModelOptions);
  document.getElementById("freeonly").addEventListener("change", refreshModelOptions);
  document.getElementById("modelsel").addEventListener("change", autofillId);
  const idField = document.querySelector('[name=id]');
  idField.addEventListener("input", () => { idField.dataset.touched = idField.value ? "1" : ""; });
  providersLoaded = true;
  onProviderChange(); // initial catalog load for the first provider
}

async function onProviderChange() {
  const provider = document.getElementById("provider").value;
  document.querySelector('[name=apiKeys]').value = KEY_ENV[provider] || "";
  await refreshModelOptions();
}

async function refreshModelOptions() {
  const provider = document.getElementById("provider").value;
  const sel = document.getElementById("modelsel");
  if (!catalog[provider]) {
    sel.innerHTML = '<option value="">loading catalog…</option>';
    try {
      const r = await fetch("/admin/catalog?provider=" + provider);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      catalog[provider] = j.models || [];
    } catch (e) {
      sel.innerHTML = '<option value="">⚠ ' + e.message + '</option>';
      return;
    }
  }
  const q = document.getElementById("modelfilter").value.toLowerCase();
  const freeOnly = document.getElementById("freeonly").checked;
  const list = catalog[provider]
    .filter(m => (!freeOnly || m.free) &&
      (!q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0)) // largest context first
    .slice(0, 400);
  sel.innerHTML = list.length
    ? list.map(m => {
        const ctx = m.contextLength ? " · " + Math.round(m.contextLength / 1000) + "k ctx" : "";
        return '<option value="' + m.id + '">' + m.id + (m.free ? "  (free)" : "") + ctx + "</option>";
      }).join("")
    : '<option value="">' +
        (freeOnly ? '(none flagged free — uncheck “free only”)' : '(no matches)') +
      '</option>';
  autofillId();
}

// Suggest an ID from the chosen model slug, e.g. "vendor/llama-3.3:free" -> "llama-3.3-free".
function autofillId() {
  const idField = document.querySelector('[name=id]');
  if (idField.dataset.touched) return;
  const slug = document.getElementById("modelsel").value;
  if (!slug) return;
  idField.value = slug.split("/").pop().replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
}

function render(data) {
  if (dragging || editing) return; // don't clobber the cards mid-drag/edit
  document.getElementById("health").className = "dot ok";
  loadProviders(data.providers);
  document.getElementById("meta").textContent =
    data.chain.length + " model(s) · " +
    data.chain.reduce((n, m) => n + m.slots.length, 0) + " key-slot(s) · port " + data.port;

  const root = document.getElementById("root");
  root.innerHTML = data.chain.map((m, idx) => {
    const rows = m.slots.map(s => {
      const st = slotState(s);
      const badge = st === "ok" ? "Ready" : st === "warn" ? "Near cap" : (s.cooldownRemainingMs > 0 ? "Cooldown" : "Capped");
      const dailyPct = s.dailyLimit ? Math.min(100, (s.count / s.dailyLimit) * 100) : 0;
      const tok = s.tokensThisMinute == null ? (m.rpm ?? "∞") : s.tokensThisMinute;
      const tokPct = m.rpm ? Math.min(100, ((s.tokensThisMinute == null ? m.rpm : s.tokensThisMinute) / m.rpm) * 100) : 100;
      const hist = s.history || [];
      const histTotal = hist.reduce((a, b) => a + b, 0);
      return \`<tr>
        <td>key\${s.keyIdx}</td>
        <td><span class="badge b-\${st}">\${badge}</span>\${s.cooldownRemainingMs>0?' '+fmtMs(s.cooldownRemainingMs):''}</td>
        <td>\${s.count}\${s.dailyLimit?' / '+s.dailyLimit:''}
            <div class="bar fill-\${dailyPct>=100?'bad':dailyPct>=80?'warn':'ok'}"><span style="width:\${dailyPct}%"></span></div></td>
        <td>\${tok}\${m.rpm?' / '+m.rpm:''}
            <div class="bar fill-\${tokPct<=10?'bad':tokPct<=33?'warn':'ok'}"><span style="width:\${tokPct}%"></span></div></td>
        <td title="\${histTotal} request(s) in the last 30 min">\${spark(hist)}<span class="histn">\${histTotal}</span></td>
      </tr>\`;
    }).join("");
    return \`<div class="card" draggable="true" data-id="\${m.id}">
      <h2><span><span class="prio" title="Priority \${idx + 1} — drag to reorder">#\${idx + 1}</span> \${m.id}</span>
          <span class="cardbtns"><span class="muted">\${m.provider}</span>
          <button class="tbtn" title="Test this model">Test</button>
          <button class="ebtn" title="Edit limits">✎</button>
          <button class="del" data-id="\${m.id}" title="Remove model">✕</button></span></h2>
      <div class="model-id">\${m.model}</div>
      \${(() => {
        const keys = m.slots.length;
        const used = m.slots.reduce((a, s) => a + s.count, 0);
        if (!m.dailyLimit) return '<div class="remain muted">Today: ' + used + ' used · no daily cap</div>';
        const total = m.dailyLimit * keys;
        const left = Math.max(0, total - used);
        const pct = total ? (used / total) * 100 : 0;
        const cls = left === 0 ? "bad" : pct >= 80 ? "warn" : "ok";
        return '<div class="remain" title="Resets at UTC midnight · ' + m.dailyLimit + '/day × ' + keys + ' key(s)">' +
          'Today: <b>' + left + '</b> of ' + total + ' left <span class="muted">(' + used + ' used)</span>' +
          '<div class="bar fill-' + cls + '"><span style="width:' + pct + '%"></span></div></div>';
      })()}
      <div class="testres"></div>
      <div class="editor" hidden>
        <label class="inline">RPM <input type="number" class="ed-rpm" placeholder="∞" value="\${m.rpm ?? ""}"></label>
        <label class="inline">Daily <input type="number" class="ed-daily" placeholder="∞" value="\${m.dailyLimit ?? ""}"></label>
        <button class="save-edit">Save</button>
        <button class="cancel-edit">Cancel</button>
      </div>
      <table>
        <thead><tr><th>Key</th><th>Status</th><th>Today</th><th>Tokens/min</th><th>Traffic · 30m</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    </div>\`;
  }).join("");
  // Re-apply persisted test results so the 2s refresh doesn't wipe them.
  data.chain.forEach(m => {
    if (lastTest[m.id]) paintTest(document.querySelector('.card[data-id="' + CSS.escape(m.id) + '"] .testres'), lastTest[m.id]);
  });
  renderFreePool(data);
  document.getElementById("error").innerHTML = "";
}

// Accurate OpenRouter free-tier remaining: the cap is per key and SHARED across
// all :free models, so we sum today's requests over every free OpenRouter slot.
function renderFreePool(data) {
  const el = document.getElementById("freepool");
  if (!creditsInfo || !creditsInfo.available || !creditsInfo.freeDailyLimit) { el.textContent = ""; return; }
  const free = data.chain.filter(m => m.provider === "openrouter" && /:free$/.test(m.model));
  if (!free.length) { el.textContent = ""; return; }
  const keys = Math.max(...free.map(m => m.slots.length));      // key pool size
  const used = free.reduce((a, m) => a + m.slots.reduce((b, s) => b + s.count, 0), 0);
  const cap = creditsInfo.freeDailyLimit * keys;
  const left = Math.max(0, cap - used);
  el.innerHTML = "OpenRouter free pool: <b>" + left + "</b> of " + cap + " left today " +
    '<span class="muted">(' + used + " used · " + creditsInfo.freeDailyLimit + "/day × " + keys +
    " key" + (keys === 1 ? "" : "s") + ", shared across all free models, resets 00:00 UTC)</span>";
}

async function renderKeys() {
  let rows;
  try { rows = await (await fetch("/admin/keys")).json(); } catch { return; }
  document.getElementById("keyspanel").innerHTML = rows.map(r => \`
    <div class="keyvar"><b>\${r.envVar}</b> <span class="muted">(\${r.keys.length} key\${r.keys.length === 1 ? "" : "s"})</span>
      <div class="keylist">\${
        r.keys.map((k, i) => '<span class="keychip">' + k +
          '<button class="keydel" data-env="' + r.envVar + '" data-i="' + i + '" title="Remove key">✕</button></span>').join("")
        || '<span class="muted">none yet — add one below</span>'
      }</div>
    </div>\`).join("");
  const sel = document.getElementById("keyenv");
  const cur = sel.value;
  sel.innerHTML = rows.map(r => '<option>' + r.envVar + '</option>').join("");
  if (cur) sel.value = cur;
}

async function tick() {
  try {
    const r = await fetch("/status");
    if (!r.ok) throw new Error("HTTP " + r.status);
    render(await r.json());
    renderKeys();
  } catch (e) {
    document.getElementById("health").className = "dot bad";
    document.getElementById("error").innerHTML =
      '<div class="err">Cannot reach router: ' + e.message + '. Is <code>npm start</code> running?</div>';
  }
}
// Add a model.
document.getElementById("addform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("formmsg");
  const f = e.target;
  const body = {
    id: f.id.value.trim(),
    provider: f.provider.value,
    model: f.model.value.trim(),
    apiKeys: f.apiKeys.value.trim(),
    dailyLimit: f.dailyLimit.value,
    rpm: f.rpm.value,
  };
  msg.className = "formmsg"; msg.textContent = "Adding…";
  try {
    const r = await fetch("/admin/models", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { msg.className = "formmsg bad"; msg.textContent = j.error || ("HTTP " + r.status); return; }
    if (j.warning) { msg.className = "formmsg warn"; msg.textContent = j.warning; }
    else {
      msg.className = "formmsg ok";
      msg.textContent = "Added \\"" + body.id + "\\" — live now." +
        (j.autoDailyLimit ? " Daily limit auto-set to " + j.autoDailyLimit + "/day (OpenRouter free tier)." : "");
    }
    f.id.dataset.touched = "";
    f.reset();
    onProviderChange();
    tick();
  } catch (err) { msg.className = "formmsg bad"; msg.textContent = err.message; }
});

// Drag-to-reorder model priority (HTML5 DnD on the cards container).
const rootEl = document.getElementById("root");

function cardAfterPointer(x, y) {
  const cards = [...rootEl.querySelectorAll(".card:not(.dragging)")];
  return cards.find((c) => {
    const b = c.getBoundingClientRect();
    const cy = b.top + b.height / 2, cx = b.left + b.width / 2;
    return y < cy - 1 || (Math.abs(cy - y) <= b.height / 2 && x < cx); // reading order
  }) || null;
}

rootEl.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  dragging = true;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
});

rootEl.addEventListener("dragover", (e) => {
  if (!dragging) return;
  e.preventDefault();
  const dragged = rootEl.querySelector(".card.dragging");
  if (!dragged) return;
  const after = cardAfterPointer(e.clientX, e.clientY);
  if (after == null) rootEl.appendChild(dragged);
  else if (after !== dragged) rootEl.insertBefore(dragged, after);
});

rootEl.addEventListener("dragend", async (e) => {
  e.target.closest(".card")?.classList.remove("dragging");
  if (!dragging) return;
  dragging = false;
  const order = [...rootEl.querySelectorAll(".card")].map((c) => c.dataset.id);
  try {
    await fetch("/admin/models/order", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order }),
    });
  } catch (err) { /* next tick re-syncs from server */ }
  tick();
});

// Card buttons: delete / test / edit (event delegation on the cards container).
rootEl.addEventListener("click", async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;

  // Delete
  if (e.target.closest(".del")) {
    if (!confirm('Remove model "' + id + '" from the chain?')) return;
    try {
      const r = await fetch("/admin/models/" + encodeURIComponent(id), { method: "DELETE" });
      if (!r.ok) { const j = await r.json(); alert(j.error || ("HTTP " + r.status)); return; }
      tick();
    } catch (err) { alert(err.message); }
    return;
  }

  // Test — fire one real request through this model only.
  if (e.target.classList.contains("tbtn")) {
    const out = card.querySelector(".testres");
    lastTest[id] = { running: true }; paintTest(out, lastTest[id]);
    try {
      lastTest[id] = await (await fetch("/admin/models/" + encodeURIComponent(id) + "/test", { method: "POST" })).json();
    } catch (err) { lastTest[id] = { ok: false, error: err.message }; }
    paintTest(out, lastTest[id]);
    return;
  }

  // Open inline editor
  if (e.target.classList.contains("ebtn")) {
    editing = true;
    card.draggable = false;
    card.querySelector(".editor").hidden = false;
    return;
  }

  // Cancel edit
  if (e.target.classList.contains("cancel-edit")) {
    editing = false; tick();
    return;
  }

  // Save edit (rpm / dailyLimit)
  if (e.target.classList.contains("save-edit")) {
    const body = {
      rpm: card.querySelector(".ed-rpm").value,
      dailyLimit: card.querySelector(".ed-daily").value,
    };
    try {
      const r = await fetch("/admin/models/" + encodeURIComponent(id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) { const j = await r.json(); alert(j.error || ("HTTP " + r.status)); return; }
    } catch (err) { alert(err.message); return; }
    editing = false; tick();
    return;
  }
});

// Add an API key to a pool.
document.getElementById("keyform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("keymsg");
  const f = e.target;
  const body = { envVar: f.envVar.value, key: f.key.value.trim() };
  if (!body.key) return;
  msg.className = "formmsg"; msg.textContent = "Adding…";
  try {
    const r = await fetch("/admin/keys", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { msg.className = "formmsg bad"; msg.textContent = j.error || ("HTTP " + r.status); return; }
    msg.className = "formmsg ok";
    msg.textContent = j.added ? (body.envVar + " now has " + j.count + " key(s).") : "Key already present.";
    f.key.value = "";
    renderKeys(); tick();
  } catch (err) { msg.className = "formmsg bad"; msg.textContent = err.message; }
});

// Delete a key (event delegation on the panel).
document.getElementById("keyspanel").addEventListener("click", async (e) => {
  const btn = e.target.closest(".keydel");
  if (!btn) return;
  if (!confirm("Remove this key from " + btn.dataset.env + "?")) return;
  try {
    const r = await fetch("/admin/keys", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVar: btn.dataset.env, index: Number(btn.dataset.i) }),
    });
    if (!r.ok) { const j = await r.json(); alert(j.error || ("HTTP " + r.status)); return; }
    renderKeys(); tick();
  } catch (err) { alert(err.message); }
});

// Test all models at once.
document.getElementById("testall").addEventListener("click", async () => {
  const msg = document.getElementById("testallmsg");
  document.querySelectorAll(".card").forEach(c => {
    const id = c.dataset.id;
    lastTest[id] = { running: true };
    paintTest(c.querySelector(".testres"), lastTest[id]);
  });
  msg.textContent = " testing…";
  try {
    const j = await (await fetch("/admin/test-all", { method: "POST" })).json();
    for (const res of j.results) {
      lastTest[res.id] = res;
      paintTest(document.querySelector('.card[data-id="' + CSS.escape(res.id) + '"] .testres'), res);
    }
    const dead = j.results.filter(r => !r.ok).map(r => r.id);
    msg.textContent = " " + j.healthy + "/" + j.total + " healthy" + (dead.length ? " · dead: " + dead.join(", ") : "");
  } catch (e) { msg.textContent = " failed: " + e.message; }
});

// OpenRouter account credits (fetched once on load + every 60s; the upstream
// call is rate-limited, so we don't poll it on the 2s status tick).
async function loadCredits() {
  try {
    const c = await (await fetch("/admin/credits")).json();
    creditsInfo = c;
    const el = document.getElementById("credits");
    if (!c.available) { el.textContent = ""; return; }
    const tier = c.isFreeTier ? "free tier" : "paid";
    const used = "$" + Number(c.usageDaily || 0).toFixed(3) + " today";
    const rem = c.limitRemaining != null ? " · $" + Number(c.limitRemaining).toFixed(2) + " credit left" : "";
    el.textContent = " ·  OpenRouter: " + tier + " · " + used + rem;
  } catch { /* ignore */ }
}
loadCredits();
setInterval(loadCredits, 60000);

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
