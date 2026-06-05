import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate a ready-to-use MCP config that mounts every playground machine as a
 * Xanthe server. Writes <root>/.mcp.json (auto-discovered by Claude Code) and
 * prints the same config for Claude Desktop plus the MCP Inspector commands.
 * Uses absolute paths so it works regardless of the client's working directory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const machines = JSON.parse(readFileSync(join(here, "machines.json"), "utf8"));
const home = join(root, ".xanthe-playground");
const cli = join(root, "dist", "cli.js");

const servers = {};
for (const [name, spec] of Object.entries(machines)) {
  const hash = spec.lastIndexOf("#");
  const file = join(root, spec.slice(0, hash));
  const exportName = spec.slice(hash + 1);
  servers[`xanthe-${name}`] = {
    command: "node",
    args: [cli, "serve", `${file}#${exportName}`],
    env: { XANTHE_HOME: home },
  };
}

const config = { mcpServers: servers };
const target = join(root, ".mcp.json");
writeFileSync(target, JSON.stringify(config, null, 2) + "\n");

console.log(`Wrote ${target} with ${Object.keys(servers).length} servers:`);
for (const name of Object.keys(servers)) console.log(`  - ${name}`);
console.log("\nClaude Code: re-open the project (you'll be asked to approve these servers).");
console.log("\n--- Claude Desktop: merge into claude_desktop_config.json ---");
console.log(JSON.stringify(config, null, 2));
console.log("\n--- Or the interactive GUI, no client setup: ---");
console.log(`  ./playground/xanthe-playground.sh inspect ${Object.keys(machines)[0]}`);
