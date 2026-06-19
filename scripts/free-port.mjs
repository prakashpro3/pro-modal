// Kill any stale process already listening on the router's port, so `npm start`
// never ends up with two instances fighting over the port + usage state.
// Runs automatically as `prestart` / `predev` (and via `npm run restart`).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.ROUTER_CONFIG || join(__dirname, "..", "config.yaml");

let port = 8787;
try { port = YAML.parse(readFileSync(cfgPath, "utf8"))?.port || 8787; } catch { /* default */ }

try {
  // lsof exits non-zero when nothing is listening — that throws and we no-op.
  const pids = execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] })
    .toString().trim().split("\n").filter(Boolean);
  if (pids.length) {
    execSync(`kill -9 ${pids.join(" ")}`);
    console.log(`free-port: stopped ${pids.length} stale instance(s) on :${port} (${pids.join(", ")})`);
  }
} catch {
  // Nothing on the port (or lsof unavailable) — nothing to do.
}
