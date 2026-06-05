import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { MemoryLedgerStore, verifyChain } from "./ledger.js";
import { loadMachineFromFile } from "./loader.js";
import type { LedgerEntry, StepResult } from "./types.js";

/**
 * The "works in 30 seconds" demo. Mounts the coffee machine OFFLINE with a
 * deterministic clock and session ids, then drives step / refuse / fork itself.
 * Prints identical output every run: no API key, no external client, no disk.
 */
export async function runPrimer(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Promise<void> {
  const coffeePath = fileURLToPath(new URL("../examples/coffee.ts", import.meta.url));
  const { machine } = await loadMachineFromFile(coffeePath, "coffee");

  let clock = 1_700_000_000_000;
  let seqId = 0;
  const engine = new Engine(machine, {
    store: new MemoryLedgerStore(),
    ledgerKey: null, // hermetic: ignore any ambient XANTHE_LEDGER_KEY so output stays identical
    now: () => {
      const value = clock;
      clock += 1000;
      return value;
    },
    genId: () => `s${seqId++}`,
  });

  write("xanthe primer: coffee machine (offline, deterministic)");
  write("");
  write(`machine: ${engine.machineId}   terminal: ${engine.terminalStates().join(", ")}`);
  write("");

  const a = await engine.start();
  write(`session ${a.id} (fresh)`);
  line(write, a.state().value, a.state().legal);

  printStep(write, await a.step("pay", { amount: 10 }));
  printStep(write, await a.step("order"));
  printStep(write, await a.step("pay", { amount: 10 }));
  write("");

  write(`fork ${a.id}#2 (the 'ordered' beat) into a new session`);
  const b = await engine.fork(a.id, 2);
  write(`session ${b.id} (forked from ${a.id}#2)`);
  line(write, b.state().value, b.state().legal);
  printStep(write, await b.step("pay", { amount: 7 }));
  write("");

  write("ledger");
  dumpLedger(write, a.id, a.history());
  dumpLedger(write, b.id, b.history());
  write("");

  write("verify");
  report(write, a.id, verifyChain(a.history(), a.id));
  report(write, b.id, verifyChain(b.history(), b.id));
  write("");

  write("next: mount your own plain XState machine:");
  write("  xanthe doctor examples/incident.ts#incident   (validate the circuit, CI-friendly)");
  write("  xanthe serve  examples/incident.ts#incident   (mount it over MCP and drive it)");
}

function line(write: (l: string) => void, value: unknown, legal: string[]): void {
  write(`  state: ${fmt(value)}   legal: ${legal.length ? legal.join(", ") : "(none)"}`);
}

function printStep(write: (l: string) => void, result: StepResult): void {
  if (result.outcome === "refused") {
    write(`  step ${pad(result.attempted)} REFUSED  legal: ${result.legal.join(", ") || "(none)"}`);
  } else {
    write(`  step ${pad(result.attempted)} ok       ${fmt(result.from)} -> ${fmt(result.to)}`);
  }
}

function dumpLedger(write: (l: string) => void, sessionId: string, entries: LedgerEntry[]): void {
  for (const e of entries) {
    const arrow = e.to === null ? `${fmt(e.from)} -x` : `${fmt(e.from)} -> ${fmt(e.to)}`;
    const digest = e.hash.split(":").pop() ?? e.hash;
    write(
      `  ${sessionId} #${e.seq} ${pad(e.action)} ${e.outcome.padEnd(8)} ${arrow.padEnd(22)} ${digest.slice(0, 12)}`,
    );
  }
}

function report(write: (l: string) => void, sessionId: string, result: ReturnType<typeof verifyChain>): void {
  if (result.ok) {
    write(`  ${sessionId}: intact (${result.count} entries)`);
  } else {
    write(`  ${sessionId}: BROKEN at seq ${result.brokenSeq}: ${result.reason}`);
  }
}

function fmt(value: unknown): string {
  return typeof value === "string" ? value : value === null ? "·" : JSON.stringify(value);
}

function pad(text: string): string {
  return text.padEnd(7);
}
