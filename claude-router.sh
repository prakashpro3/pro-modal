#!/usr/bin/env bash
# Launch Claude Code against the Auto Model Router instead of the real Anthropic API.
# Env vars are set for THIS invocation only — your normal `claude` is unaffected.
#
# Usage:  ./claude-router.sh            (interactive)
#         ./claude-router.sh -p "..."   (headless, args pass through)
#
# The router must be running first:  npm start   (http://localhost:8787)

ROUTER_URL="${ROUTER_URL:-http://localhost:8787}"

# Fail early with a clear message if the router isn't up.
if ! curl -s -o /dev/null "${ROUTER_URL}/health"; then
  echo "✗ Router not reachable at ${ROUTER_URL} — start it with: npm start" >&2
  exit 1
fi

# ANTHROPIC_AUTH_TOKEN -> sets 'Authorization: Bearer' (the router ignores it; it
# holds the real provider keys). Pin a specific chain model with ANTHROPIC_MODEL,
# or leave it for the router's auto chain + key rotation.
export ANTHROPIC_BASE_URL="${ROUTER_URL}"
export ANTHROPIC_AUTH_TOKEN="dummy"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-auto}"
# Use a free model for the small/fast (background) calls too.
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-auto}"

echo "→ Claude Code via Auto Model Router (${ROUTER_URL}), model=${ANTHROPIC_MODEL}"
exec claude "$@"
