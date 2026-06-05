#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_ROOT, FileLedgerStore, MemoryLedgerStore, verifyChain, type VerifyResult } from "./ledger.js";
import { loadMachineFromSpec } from "./loader.js";
import { validateMachine, type ValidationError } from "./validator.js";
import { Engine } from "./engine.js";
import { buildServer } from "./server.js";
import { runPrimer } from "./primer.js";

const err = (line = "") => process.stderr.write(line + "\n");
const out = (line = "") => process.stdout.write(line + "\n");

function resolveRoot(): string {
  return process.env.XANTHE_HOME ?? DEFAULT_ROOT;
}

function printValidationFailure(file: string, exportName: string, errors: ValidationError[]): void {
  err(`xanthe: machine '${exportName}' from ${file} was REJECTED by the validator:`);
  for (const e of errors) err(`  - ${e.message}`);
  err("");
  err("Authors write plain XState v5; Xanthe only enforces a step-gated circuit:");
  err("no 'after' timers, no 'always' cascades, no multi-state invoke chains.");
}

const USAGE = `xanthe: mount a plain XState v5 machine as an MCP server, on rails.

Usage:
  xanthe serve <file>#<export>   Validate and mount the machine over stdio (MCP).
  xanthe doctor <file>#<export>  Validate the machine's circuit shape and exit 0/1 (CI-friendly).
  xanthe verify [target] [opts]  Verify a ledger chain. target: <machine-id> or <machine-id>/<session-id>.
                                 With no target, verify every session under the ledger root.
                                 --json          emit attestation receipts (with head_hash).
                                 --min <n>       fail if a chain has fewer than n entries (truncation).
  xanthe primer                  Run the offline coffee-machine demo (deterministic, no API key).

Ledger root: ${resolveRoot()} (override with XANTHE_HOME).
Set XANTHE_LEDGER_KEY to seal/verify ledgers with HMAC-SHA256.`;

async function serve(spec: string | undefined): Promise<void> {
  if (!spec) {
    err("error: serve requires <file>#<export>, e.g. xanthe serve examples/incident.ts#incident");
    process.exitCode = 1;
    return;
  }

  const { machine, file, exportName } = await loadMachineFromSpec(spec);

  const validation = validateMachine(machine);
  if (!validation.ok) {
    printValidationFailure(file, exportName, validation.errors);
    process.exitCode = 1;
    return;
  }

  const store = new FileLedgerStore(resolveRoot());
  const { server, engine, sessionId } = await buildServer(machine, { store });

  err(`xanthe serve: ${engine.machineId}`);
  err(`  machine-id:  ${engine.machineId}`);
  err(`  events (${engine.events.length}):  ${engine.events.join(", ")}`);
  err(`  terminal:    ${engine.terminalStates().join(", ") || "(none)"}`);
  err(`  ledger:      ${store.locate(engine.machineId, sessionId)}`);
  err(`  source:      ${file}#${exportName}`);
  err("  listening on stdio (MCP). tools: step, state, reset, fork_at, fork_from_past");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise(() => {
    /* run until the transport closes */
  });
}

async function doctor(spec: string | undefined): Promise<void> {
  if (!spec) {
    err("error: doctor requires <file>#<export>, e.g. xanthe doctor examples/incident.ts#incident");
    process.exitCode = 1;
    return;
  }
  const { machine, file, exportName } = await loadMachineFromSpec(spec);
  const validation = validateMachine(machine);
  if (!validation.ok) {
    printValidationFailure(file, exportName, validation.errors);
    process.exitCode = 1;
    return;
  }
  const engine = new Engine(machine, { store: new MemoryLedgerStore(), validate: false });
  out(`ok  '${engine.machineId}' is a valid step-gated circuit`);
  out(`  events (${engine.events.length}):  ${engine.events.join(", ")}`);
  out(`  terminal:    ${engine.terminalStates().join(", ") || "(none)"}`);
  out(`  source:      ${file}#${exportName}`);
}

interface VerifyArgs {
  target?: string;
  json: boolean;
  minEntries?: number;
}

function parseVerifyArgs(rest: string[]): VerifyArgs {
  const args: VerifyArgs = { json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--min") args.minEntries = Number(rest[++i]);
    else if (!arg.startsWith("--") && args.target === undefined) args.target = arg;
  }
  return args;
}

function receiptOf(
  store: FileLedgerStore,
  machineId: string,
  sessionId: string,
  options: { key?: string; minEntries?: number },
): VerifyResult & { machineId: string } {
  const result = verifyChain(store.read(machineId, sessionId), sessionId, options);
  return { ...result, machineId };
}

async function verify(rest: string[]): Promise<void> {
  const { target, json, minEntries } = parseVerifyArgs(rest);
  const store = new FileLedgerStore(resolveRoot());
  const key = process.env.XANTHE_LEDGER_KEY;

  const pairs: Array<[string, string]> = [];
  if (!target) {
    for (const machineId of store.listMachines())
      for (const s of store.listSessions(machineId)) pairs.push([machineId, s]);
  } else if (target.includes("/")) {
    const slash = target.indexOf("/");
    pairs.push([target.slice(0, slash), target.slice(slash + 1)]);
  } else {
    for (const s of store.listSessions(target)) pairs.push([target, s]);
  }

  if (pairs.length === 0) {
    err(`no ledgers found under ${resolveRoot()}${target ? ` for '${target}'` : ""}`);
    process.exitCode = 1;
    return;
  }

  const results = pairs.map(([m, s]) => receiptOf(store, m, s, { key, minEntries }));
  const allOk = results.every((r) => r.ok);

  if (json) {
    out(
      JSON.stringify(
        results.map((r) => ({
          machine_id: r.machineId,
          session_id: r.sessionId,
          ok: r.ok,
          count: r.count,
          keyed: r.keyed,
          head_hash: r.headHash,
          broken_seq: r.brokenSeq,
          reason: r.reason,
        })),
        null,
        2,
      ),
    );
  } else {
    for (const r of results) {
      if (r.ok) out(`  ok    ${r.machineId}/${r.sessionId}  (${r.count} entries${r.keyed ? ", keyed" : ""})`);
      else
        out(
          `  FAIL  ${r.machineId}/${r.sessionId}  ${r.brokenSeq !== undefined ? `broken at seq ${r.brokenSeq}: ` : ""}${r.reason}`,
        );
    }
    out(allOk ? `\nall ${results.length} session(s) intact` : `\nverification FAILED`);
  }
  if (!allOk) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve":
      await serve(rest[0]);
      break;
    case "doctor":
      await doctor(rest[0]);
      break;
    case "verify":
      await verify(rest);
      break;
    case "primer":
      await runPrimer();
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      out(USAGE);
      break;
    default:
      err(`unknown command '${command}'\n`);
      err(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  err(`xanthe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
