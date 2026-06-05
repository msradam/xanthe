import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, fromPromise, assign } from "xstate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Engine } from "../src/engine.js";
import { FileLedgerStore, MemoryLedgerStore, verifyChain } from "../src/ledger.js";
import { validateMachine } from "../src/validator.js";
import { buildServer } from "../src/server.js";
import { runPrimer } from "../src/primer.js";
import { incident } from "../examples/incident.js";
import { coffee } from "../examples/coffee.js";

function tempStore(): FileLedgerStore {
  return new FileLedgerStore(mkdtempSync(join(tmpdir(), "xanthe-test-")));
}

describe("incident: refuse, record, verify, tamper, fork", () => {
  it("drives the full definition-of-done loop", async () => {
    const store = tempStore();
    const engine = new Engine(incident, { store, ledgerKey: null });

    const a = await engine.start();
    expect(a.state().value).toBe("triaged");

    expect((await a.step("page_oncall")).outcome).toBe("allowed");
    expect(a.state().value).toBe("engaged");

    // Canonical refusal: close_incident needs `verified` first.
    const refused = await a.step("close_incident");
    expect(refused.outcome).toBe("refused");
    expect(refused.refused).toBe(true);
    expect(refused.to).toBeNull();
    expect(refused.legal).toEqual(["verify"]); // refusal names the legal next moves
    expect(a.state().value).toBe("engaged"); // did not advance

    // The refusal is in the ledger, in the same chain.
    const refusalEntry = a.history().find((e) => e.action === "close_incident" && e.outcome === "refused");
    expect(refusalEntry).toBeDefined();
    expect(refusalEntry!.to).toBeNull();
    expect(refusalEntry!.reason).toContain("verify");

    // The agent supplies the result: payload validated into context.
    const verified = await a.step("verify", { rootCause: "bad deploy", signal: "pagerduty" });
    expect(verified.outcome).toBe("allowed");
    expect(a.state().context).toMatchObject({ rootCause: "bad deploy", verifiedBy: "pagerduty" });

    // verify passes on the on-disk chain.
    expect(verifyChain(a.history(), a.id).ok).toBe(true);

    // Tamper one entry on disk -> verify FAILS at that seq.
    const file = store.locate(engine.machineId, a.id);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const victim = JSON.parse(lines[1]!);
    victim.to = "closed"; // lie about the page_oncall target, leave the hash untouched
    lines[1] = JSON.stringify(victim);
    writeFileSync(file, lines.join("\n") + "\n");

    const broken = verifyChain(store.read(engine.machineId, a.id), a.id);
    expect(broken.ok).toBe(false);
    expect(broken.brokenSeq).toBe(1);
  });

  it("forks at a seq into a new session that verifies independently", async () => {
    const store = tempStore();
    const engine = new Engine(incident, { store, ledgerKey: null });

    const a = await engine.start();
    await a.step("page_oncall"); // seq 1 -> engaged
    await a.step("verify", { rootCause: "x", signal: "y" }); // seq 2 -> verified
    await a.step("resolve", { resolution: "rollback" }); // seq 3 -> resolved
    expect(verifyChain(a.history(), a.id).ok).toBe(true);

    // Branch from the `engaged` beat (seq 1).
    const b = await engine.fork(a.id, 1);
    expect(b.id).not.toBe(a.id);
    expect(b.state().value).toBe("engaged");
    expect(b.state().legal).toEqual(["verify"]);

    // The branch is a working, independent session.
    expect((await b.step("close_incident")).outcome).toBe("refused"); // still gated at engaged
    expect((await b.step("verify", { rootCause: "other", signal: "manual" })).outcome).toBe("allowed");
    expect(b.state().value).toBe("verified");
    expect(b.state().context).toMatchObject({ rootCause: "other" });

    // Each session is its own chain, each verifies on its own.
    expect(verifyChain(a.history(), a.id).ok).toBe(true);
    expect(verifyChain(b.history(), b.id).ok).toBe(true);
    expect(b.history()[0]!.session_id).toBe(b.id);

    // A's chain does not validate under B's identity (cross-session copy caught).
    expect(verifyChain(a.history(), b.id).ok).toBe(false);
  });

  it("fork_from_past branches a different past session", async () => {
    const store = tempStore();
    const engine = new Engine(incident, { store, ledgerKey: null });

    const past = await engine.start();
    await past.step("page_oncall");
    await past.step("verify", { rootCause: "root", signal: "sig" });
    const pastId = past.id;

    // A fresh, unrelated session is "current"; we branch from the past one by id.
    const current = await engine.start();
    expect(current.id).not.toBe(pastId);

    const branch = await engine.fork(pastId, 2); // the `verified` beat of the past session
    expect(branch.state().value).toBe("verified");
    expect(branch.state().context).toMatchObject({ rootCause: "root", verifiedBy: "sig" });
    expect(verifyChain(branch.history(), branch.id).ok).toBe(true);
  });
});

describe("legal moves: the menu of takeable moves", () => {
  it("respects context guards (hides currently-blocked moves), and lists payload moves", async () => {
    const m = setup({
      types: {} as { context: { open: boolean }; events: { type: "toggle" } | { type: "enter" } },
    }).createMachine({
      id: "ctx",
      initial: "a",
      context: { open: false },
      states: {
        a: {
          on: {
            toggle: { actions: assign({ open: ({ context }) => !context.open }) },
            enter: { guard: ({ context }) => context.open, target: "b" },
          },
        },
        b: { type: "final" },
      },
    });
    const e = await new Engine(m, { store: new MemoryLedgerStore(), ledgerKey: null }).start();
    // `enter` is gated by a context guard that is currently false, so it is hidden.
    expect(e.state().legal).toEqual(["toggle"]);
    await e.step("toggle"); // open = true
    expect([...e.state().legal].sort()).toEqual(["enter", "toggle"]);
  });
});

describe("coffee: a single invoke is recorded as one beat", () => {
  it("settles through the computeChange actor in one step", async () => {
    const engine = new Engine(coffee, { store: new MemoryLedgerStore(), ledgerKey: null });
    const s = await engine.start();
    await s.step("order");
    const paid = await s.step("pay", { amount: 10 });

    // One step crossed `settling` (invoke) and landed on the terminal decision state.
    expect(paid.outcome).toBe("allowed");
    expect(paid.to).toBe("done");
    expect(s.state().context).toMatchObject({ change: 5 });
    expect(s.state().terminal).toBe(true);

    // The invoke is one entry, not two: init, order, pay.
    expect(s.history().map((e) => e.action)).toEqual(["init", "order", "pay"]);
    expect(verifyChain(s.history(), s.id).ok).toBe(true);
  });
});

describe("ledger hardening: HMAC, truncation, attestation", () => {
  it("seals with HMAC and verifies only with the right key", async () => {
    const store = tempStore();
    const engine = new Engine(incident, { store, ledgerKey: "s3cret" });
    const a = await engine.start();
    await a.step("page_oncall");
    const entries = a.history();

    expect(entries[0]!.hash.startsWith("hmac-sha256:")).toBe(true);
    expect(verifyChain(entries, a.id, { key: "s3cret" }).ok).toBe(true);

    const noKey = verifyChain(entries, a.id);
    expect(noKey.ok).toBe(false);
    expect(noKey.reason).toContain("XANTHE_LEDGER_KEY");
    expect(noKey.keyed).toBe(true);

    expect(verifyChain(entries, a.id, { key: "wrong" }).ok).toBe(false);
  });

  it("rejects an unkeyed chain when a key is supplied (downgrade)", async () => {
    const store = tempStore();
    const a = await new Engine(incident, { store, ledgerKey: null }).start();
    await a.step("page_oncall");
    const downgrade = verifyChain(a.history(), a.id, { key: "s3cret" });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.reason).toContain("downgrade");
  });

  it("detects truncation and exposes a head hash for attestation", async () => {
    const store = tempStore();
    const a = await new Engine(incident, { store, ledgerKey: null }).start();
    await a.step("page_oncall");
    await a.step("verify", { rootCause: "x", signal: "y" });
    const full = a.history();

    const receipt = verifyChain(full, a.id);
    expect(receipt.ok).toBe(true);
    expect(receipt.headHash).toBe(full.at(-1)!.hash);

    const truncated = verifyChain(full.slice(0, -1), a.id, { minEntries: full.length });
    expect(truncated.ok).toBe(false);
    expect(truncated.reason).toContain("truncated");
  });
});

describe("validator: enforces the step-gated circuit", () => {
  it("accepts the shipped examples", () => {
    expect(validateMachine(incident).ok).toBe(true);
    expect(validateMachine(coffee).ok).toBe(true);
  });

  it("the Engine refuses to construct over an auto-advancing machine", () => {
    const bad = setup({}).createMachine({
      id: "bad",
      initial: "a",
      states: { a: { after: { 1000: "b" } }, b: { type: "final" } },
    });
    expect(() => new Engine(bad, { store: new MemoryLedgerStore() })).toThrow(/after/);
  });

  it("rejects `after` timers", () => {
    const m = setup({}).createMachine({
      id: "t",
      initial: "a",
      states: { a: { after: { 1000: "b" } }, b: { type: "final" } },
    });
    const r = validateMachine(m);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("after");
  });

  it("rejects `always` cascades but allows a single hop", () => {
    const cascade = setup({}).createMachine({
      id: "c",
      initial: "a",
      states: { a: { on: { go: "b" } }, b: { always: "c" }, c: { always: "d" }, d: { type: "final" } },
    });
    expect(validateMachine(cascade).ok).toBe(false);

    const single = setup({}).createMachine({
      id: "s",
      initial: "a",
      states: { a: { on: { go: "b" } }, b: { always: "c" }, c: { on: { x: "d" } }, d: { type: "final" } },
    });
    expect(validateMachine(single).ok).toBe(true);
  });

  it("rejects invoke chains", () => {
    const chain = setup({ actors: { f: fromPromise(async () => 1) } }).createMachine({
      id: "ic",
      initial: "a",
      states: {
        a: { on: { go: "b" } },
        b: { invoke: { src: "f", onDone: "c" } },
        c: { invoke: { src: "f", onDone: "d" } },
        d: { type: "final" },
      },
    });
    expect(validateMachine(chain).ok).toBe(false);
  });

  it("accepts a guarded `always` alongside `on` (check-after-move), rejects an unguarded one", () => {
    // The tic-tac-toe / water-jug shape: a move is one event, then a guarded hop
    // settles into the next decision state.
    const guarded = setup({}).createMachine({
      id: "g",
      initial: "play",
      states: {
        play: { always: { guard: () => false, target: "done" }, on: { move: { target: "play", reenter: true } } },
        done: { type: "final" },
      },
    });
    expect(validateMachine(guarded).ok).toBe(true);

    const unguarded = setup({}).createMachine({
      id: "u",
      initial: "play",
      states: {
        play: { always: { target: "done" }, on: { move: "play" } },
        done: { type: "final" },
      },
    });
    expect(validateMachine(unguarded).ok).toBe(false);
  });

  it("rejects an invoke alongside `on` (the actor may never settle)", () => {
    const m = setup({ actors: { ticker: fromPromise(async () => 1) } }).createMachine({
      id: "iv",
      initial: "a",
      states: {
        a: { invoke: { src: "ticker", onDone: "done" }, on: { poke: "a" } },
        done: { type: "final" },
      },
    });
    expect(validateMachine(m).ok).toBe(false);
  });
});

describe("mcp server: drive over an in-process transport", () => {
  it("exposes the tools and gates a step through the protocol", async () => {
    const { server } = await buildServer(incident, { store: new MemoryLedgerStore() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fork_at", "fork_from_past", "reset", "state", "step"]);

    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    expect((await call("state")).value).toBe("triaged");
    expect((await call("step", { event: "page_oncall" })).to).toBe("engaged");

    const refused = await call("step", { event: "close_incident" });
    expect(refused.refused).toBe(true);
    expect(refused.legal).toEqual(["verify"]);
    expect((await call("state")).value).toBe("engaged"); // did not advance

    await client.close();
  });
});

describe("primer: offline and deterministic", () => {
  it("prints identical output every run", async () => {
    const run = async () => {
      const lines: string[] = [];
      await runPrimer((l) => lines.push(l));
      return lines.join("\n");
    };
    const first = await run();
    const second = await run();
    expect(first).toBe(second);
    expect(first).toContain("REFUSED");
    expect(first).toContain("intact");
  });
});
