#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MACHINES="$ROOT/playground/machines.json"
export XANTHE_HOME="$ROOT/.xanthe-playground"

spec_for() {
  node -e "const m=require('$MACHINES'); const s=m['$1']; if(!s)process.exit(2); process.stdout.write(s)"
}

require_build() {
  [ -f "$ROOT/dist/cli.js" ] || { echo "dist/ not built. Run: (cd '$ROOT' && npm install && npm run build)"; exit 1; }
}

cmd="${1:-help}"
case "$cmd" in
  list)
    echo "Playground machines (ledgers under $XANTHE_HOME):"
    node -e "const m=require('$MACHINES'); for(const [k,v] of Object.entries(m)) console.log('  '+k.padEnd(16)+' '+v)"
    ;;
  inspect)
    require_build
    name="${2:-}"; [ -n "$name" ] || { echo "usage: $0 inspect <machine>   (see: $0 list)"; exit 1; }
    spec="$(spec_for "$name")" || { echo "unknown machine '$name' (try: $0 list)"; exit 1; }
    echo "Launching MCP Inspector for '$name' ($spec)."
    echo "A browser UI opens; call state / step / reset / fork_at / fork_from_past on the machine."
    exec npx @modelcontextprotocol/inspector node "$ROOT/dist/cli.js" serve "$ROOT/${spec%#*}#${spec#*#}"
    ;;
  serve)
    require_build
    name="${2:-}"; [ -n "$name" ] || { echo "usage: $0 serve <machine>"; exit 1; }
    spec="$(spec_for "$name")" || { echo "unknown machine '$name'"; exit 1; }
    exec node "$ROOT/dist/cli.js" serve "$ROOT/${spec%#*}#${spec#*#}"
    ;;
  verify)
    require_build
    exec node "$ROOT/dist/cli.js" verify "${2:-}"
    ;;
  primer)
    require_build
    exec node "$ROOT/dist/cli.js" primer
    ;;
  install)
    require_build
    exec node "$ROOT/playground/gen-config.mjs"
    ;;
  *)
    cat <<EOF
xanthe-playground: drive Stately's own machines (and Xanthe's) over MCP.

  $0 list                 list the available machines
  $0 inspect <machine>    open the MCP Inspector GUI on a machine (easiest, no client setup)
  $0 serve <machine>      run the MCP server on stdio (for an MCP client)
  $0 verify [machine-id]  verify the playground ledgers
  $0 primer               run the offline 30-second demo
  $0 install              (re)write .mcp.json for Claude Code + print the Claude Desktop config

First run:  (cd '$ROOT' && npm install && npm run build)
EOF
    ;;
esac
