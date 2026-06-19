#!/usr/bin/env node
// Global CLI for Auto Modal (the auto model router).
//   automodal [start]        start the router (default)
//   automodal claude [...]   launch Claude Code through the router
//   automodal init           create ~/.auto-modal and show where to add keys
//   automodal where          print the config/.env/usage paths
//   automodal --help
//
// Config, keys and usage live in ~/.auto-modal (override with AUTOMODAL_HOME), so
// a global install never writes inside the package dir.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const HOME_ENV = process.env.AUTOMODAL_HOME;
const GLOBAL_HOME = HOME_ENV || join(homedir(), ".auto-modal");
const URL = process.env.ROUTER_URL || "http://localhost:8787";

// Walk up from `cwd` looking for a project-local `.auto-modal/` dir.
function findProjectHome(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".auto-modal");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

// Config home resolution (highest priority first):
//   1. AUTOMODAL_HOME env var
//   2. a project-local ./.auto-modal found by walking up from cwd  (per-project)
//   3. ~/.auto-modal                                               (global)
function resolveHome() {
  if (HOME_ENV) return { home: HOME_ENV, scope: "env" };
  const proj = findProjectHome(process.cwd());
  if (proj) return { home: proj, scope: "project" };
  return { home: GLOBAL_HOME, scope: "global" };
}

function ensureHome(home) {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const cfg = join(home, "config.yaml");
  if (!existsSync(cfg)) {
    // Ship config.default.yaml; fall back to config.yaml when running from source.
    const tmpl = existsSync(join(PKG, "config.default.yaml"))
      ? join(PKG, "config.default.yaml") : join(PKG, "config.yaml");
    copyFileSync(tmpl, cfg);
  }
  const env = join(home, ".env");
  if (!existsSync(env)) {
    const example = join(PKG, ".env.example");
    if (existsSync(example)) copyFileSync(example, env);
    else writeFileSync(env, "OPENROUTER_API_KEYS=\nHF_API_KEYS=\n");
  }
  // Point the server modules at this home (unless already overridden).
  process.env.ROUTER_CONFIG ||= cfg;
  process.env.ROUTER_ENV ||= env;
  process.env.ROUTER_USAGE ||= join(home, "usage.json");
  return { cfg, env };
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`auto-modal — auto model router (key/model switching proxy)

Usage:
  automodal [start]        Start the router         (default; http://localhost:8787)
  automodal claude [args]  Launch Claude Code through the router
  automodal init           Create global config (~/.auto-modal) + show where to add keys
  automodal init --local   Create project-local config (./.auto-modal) for this project
  automodal where          Print which config / .env / usage is in effect
  automodal --help

Config resolution (highest first):  AUTOMODAL_HOME env  >  nearest ./.auto-modal  >  ~/.auto-modal
Install:  npm install -g auto-modal   (global)   |   npm install auto-modal + npx automodal   (per-project)`);
  process.exit(0);
}

if (cmd === "init") {
  const local = rest.includes("--local") || rest.includes("--project");
  const home = local ? join(process.cwd(), ".auto-modal") : GLOBAL_HOME;
  const { cfg, env } = ensureHome(home);
  console.log(`Initialized ${local ? "project-local" : "global"} config at ${home}`);
  console.log(`  config: ${cfg}`);
  console.log(`  keys:   ${env}   ← add OPENROUTER_API_KEYS / HF_API_KEYS here`);
  if (local) console.log(`  tip: add ".auto-modal/" to .gitignore (it holds your keys)`);
  console.log(`Then run:  automodal`);
  process.exit(0);
}

const { home, scope } = resolveHome();
const { cfg, env } = ensureHome(home);

if (cmd === "where") {
  console.log(`scope:  ${scope}  (${home})`);
  console.log(`config: ${process.env.ROUTER_CONFIG}`);
  console.log(`env:    ${process.env.ROUTER_ENV}`);
  console.log(`usage:  ${process.env.ROUTER_USAGE}`);
  process.exit(0);
}

if (cmd === "claude") {
  // Launch Claude Code pointed at the router (router must be running).
  try {
    const r = await fetch(`${URL}/health`);
    if (!r.ok) throw new Error("bad status");
  } catch {
    console.error(`✗ Router not reachable at ${URL} — start it first:  automodal start`);
    process.exit(1);
  }
  console.log(`→ Claude Code via Auto Modal (${URL})`);
  const child = spawn("claude", rest, {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: URL,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "auto",
      ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL || "auto",
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (!cmd || cmd === "start") {
  // Free a stale instance on the port, then start the server.
  console.log(`config: ${scope} (${home})`);
  await import(join(PKG, "scripts", "free-port.mjs"));
  await import(join(PKG, "src", "server.js"));
} else {
  console.error(`Unknown command: ${cmd}\nTry:  automodal --help`);
  process.exit(1);
}
