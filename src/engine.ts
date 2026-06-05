import {
  createActor,
  waitFor,
  __unsafe_getAllOwnEventDescriptors,
  type AnyStateMachine,
  type AnyActor,
  type AnyMachineSnapshot,
} from "xstate";
import { hashEntry } from "./canonical.js";
import type { LedgerStore } from "./ledger.js";
import { FileLedgerStore } from "./ledger.js";
import { validateMachine, MachineValidationError } from "./validator.js";
import type { CanonicalState, LedgerEntry, StateView, StepResult } from "./types.js";

const SETTLE_TIMEOUT_MS = 30_000;

export interface EngineOptions {
  store?: LedgerStore;
  /** Injectable clock; the primer uses a deterministic one. */
  now?: () => number;
  /** Injectable session-id generator; the primer uses a deterministic one. */
  genId?: () => string;
  /**
   * HMAC key sealing the ledger. A string forces keyed mode; `null` forces unkeyed
   * (ignoring the environment); omitted falls back to XANTHE_LEDGER_KEY.
   */
  ledgerKey?: string | null;
  /** Run the mount-time validator at construction (default true). The circuit
   * guarantee must not be bypassable by constructing an Engine directly. */
  validate?: boolean;
}

let randomCounter = 0;
function defaultGenId(): string {
  // Random-ish but dependency-free; real sessions just need uniqueness on disk.
  randomCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}-${randomCounter.toString(36)}`;
}

/**
 * A settled snapshot has reached a decision state: either it is done/error, or it
 * is active with no invoked child actor still running. The validator guarantees at
 * most one such invoke per beat, so waiting for it collapses the beat to one step.
 */
function isSettled(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== "active") return true;
  const children = snapshot.children as Record<string, AnyActor | undefined>;
  for (const child of Object.values(children)) {
    if (child?.getSnapshot?.().status === "active") return false;
  }
  return true;
}

async function settle(actor: AnyActor): Promise<void> {
  if (isSettled(actor.getSnapshot())) return;
  await waitFor(actor, (snapshot) => isSettled(snapshot as AnyMachineSnapshot), { timeout: SETTLE_TIMEOUT_MS });
}

export class Engine {
  readonly machineId: string;
  readonly store: LedgerStore;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly vocabulary: string[];
  private readonly ledgerKey: string | undefined;

  constructor(
    private readonly machine: AnyStateMachine,
    options: EngineOptions = {},
  ) {
    if (options.validate !== false) {
      const result = validateMachine(machine);
      if (!result.ok) throw new MachineValidationError(result.errors);
    }
    this.machineId = machine.id;
    this.store = options.store ?? new FileLedgerStore();
    this.now = options.now ?? Date.now;
    this.genId = options.genId ?? defaultGenId;
    this.vocabulary = (machine.events as string[]).filter((e) => e !== "" && !e.startsWith("xstate."));
    this.ledgerKey = options.ledgerKey === null ? undefined : (options.ledgerKey ?? process.env.XANTHE_LEDGER_KEY);
  }

  /** The machine's full author-defined event vocabulary. */
  get events(): readonly string[] {
    return this.vocabulary;
  }

  /**
   * The moves takeable from the current state. Starts from the events the active
   * state nodes handle, then keeps those a bare event can actually take, so context
   * guards are respected (a move blocked by the current context does not appear).
   * A guard that needs event data and throws on the bare event is kept rather than
   * hidden, so a payload-only move still surfaces. The specific validity of a move
   * (right payload) is enforced when it is stepped.
   */
  legalMoves(snapshot: AnyMachineSnapshot): string[] {
    let handled: string[];
    try {
      handled = __unsafe_getAllOwnEventDescriptors(snapshot) as string[];
    } catch {
      handled = [...this.vocabulary];
    }
    return handled.filter((type) => {
      if (type === "" || type === "*" || type.startsWith("xstate.")) return false;
      try {
        return snapshot.can({ type });
      } catch {
        return true; // guard reads event data; surface the move rather than hide it
      }
    });
  }

  terminalStates(): string[] {
    const prefix = `${this.machineId}.`;
    const finals: string[] = [];
    const walk = (node: any) => {
      if (node.type === "final") finals.push(node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id);
      for (const child of Object.values(node.states ?? {})) walk(child);
    };
    walk(this.machine.root);
    return finals;
  }

  /** A fresh session at the machine's initial state. */
  async start(): Promise<Session> {
    const actor = createActor(this.machine).start();
    await settle(actor);
    const snapshot = actor.getSnapshot();
    const session = new Session(this, this.genId(), actor);
    session.genesis({
      action: "init",
      to: snapshot.value,
      reason: `session initialized at '${stringifyValue(snapshot.value)}'`,
      state: canonicalOf(snapshot),
    });
    return session;
  }

  /**
   * Branch a new session from a recorded beat of any session. The new actor is
   * reconstructed FROM Xanthe's canonical state (value + context), not from an
   * XState snapshot blob. The branch is independent and verifies on its own.
   */
  async fork(sourceSessionId: string, seq: number): Promise<Session> {
    const history = this.store.read(this.machineId, sourceSessionId);
    if (history.length === 0) throw new Error(`no session '${sourceSessionId}' to fork from`);
    const source = history.find((e) => e.seq === seq);
    if (!source) throw new Error(`session '${sourceSessionId}' has no seq ${seq} (range 0..${history.length - 1})`);

    const canonical = structuredClone(source.state);
    const restored = this.machine.resolveState({ value: canonical.value as any, context: canonical.context });
    const actor = createActor(this.machine, { snapshot: restored }).start();
    await settle(actor);

    const session = new Session(this, this.genId(), actor);
    session.genesis({
      action: "fork",
      to: canonical.value,
      reason: `forked from ${sourceSessionId}#${seq}`,
      state: canonical,
    });
    return session;
  }

  // Used by Session to write through the same hashing path.
  recordEntry(
    sessionId: string,
    prevHash: string,
    seq: number,
    fields: Omit<LedgerEntry, "ts" | "seq" | "session_id" | "prev_hash" | "hash">,
  ): LedgerEntry {
    const payload = {
      ...fields,
      ts: this.now(),
      seq,
      session_id: sessionId,
      prev_hash: prevHash,
    };
    const hash = hashEntry(payload, prevHash, this.ledgerKey ? { key: this.ledgerKey } : {});
    const entry: LedgerEntry = { ...payload, hash };
    this.store.append(this.machineId, sessionId, entry);
    return entry;
  }
}

export class Session {
  private nextSeq = 0;
  private prevHash = "";
  private current: CanonicalState;

  constructor(
    private readonly engine: Engine,
    readonly id: string,
    private readonly actor: AnyActor,
  ) {
    this.current = canonicalOf(actor.getSnapshot() as AnyMachineSnapshot);
  }

  /** Write the session's seq-0 entry. Called once at creation by the engine. */
  genesis(fields: { action: string; to: unknown; reason: string; state: CanonicalState }): void {
    this.current = fields.state;
    const entry = this.engine.recordEntry(this.id, this.prevHash, this.nextSeq, {
      action: fields.action,
      from: null,
      to: fields.to,
      reason: fields.reason,
      outcome: "allowed",
      state: fields.state,
    });
    this.advance(entry);
  }

  private advance(entry: LedgerEntry): void {
    this.prevHash = entry.hash;
    this.nextSeq = entry.seq + 1;
  }

  private snapshot(): AnyMachineSnapshot {
    return this.actor.getSnapshot() as AnyMachineSnapshot;
  }

  /** Fire a trigger. Gated by the machine; outcome recorded either way. */
  async step(eventType: string, payload?: Record<string, unknown>): Promise<StepResult> {
    const before = this.snapshot();
    const fromValue = before.value;
    const event = { type: eventType, ...(payload ?? {}) };

    let allowed = false;
    try {
      allowed = before.can(event);
    } catch {
      allowed = false;
    }

    if (!allowed) {
      const legal = this.engine.legalMoves(before);
      const reason = `event '${eventType}' is not legal from state '${stringifyValue(fromValue)}'. Legal moves: ${legal.length ? legal.join(", ") : "(none, terminal state)"}.`;
      const entry = this.engine.recordEntry(this.id, this.prevHash, this.nextSeq, {
        action: eventType,
        from: fromValue,
        to: null,
        reason,
        outcome: "refused",
        state: this.current,
      });
      this.advance(entry);
      return {
        outcome: "refused",
        refused: true,
        attempted: eventType,
        from: fromValue,
        to: null,
        reason,
        legal,
        state: this.current,
        seq: entry.seq,
        session_id: this.id,
      };
    }

    this.actor.send(event);
    await settle(this.actor);
    const after = this.snapshot();
    this.current = canonicalOf(after);
    const legal = this.engine.legalMoves(after);
    const entry = this.engine.recordEntry(this.id, this.prevHash, this.nextSeq, {
      action: eventType,
      from: fromValue,
      to: after.value,
      reason: `stepped '${eventType}': '${stringifyValue(fromValue)}' -> '${stringifyValue(after.value)}'`,
      outcome: "allowed",
      state: this.current,
    });
    this.advance(entry);
    return {
      outcome: "allowed",
      attempted: eventType,
      from: fromValue,
      to: after.value,
      reason: entry.reason,
      legal,
      state: this.current,
      seq: entry.seq,
      session_id: this.id,
    };
  }

  state(): StateView {
    const snapshot = this.snapshot();
    return {
      session_id: this.id,
      value: this.current.value,
      context: this.current.context,
      legal: this.engine.legalMoves(snapshot),
      terminal: snapshot.status !== "active",
    };
  }

  history(): LedgerEntry[] {
    return this.engine.store.read(this.engine.machineId, this.id);
  }
}

function canonicalOf(snapshot: AnyMachineSnapshot): CanonicalState {
  // Round-trip through JSON so the recorded context holds only serializable data,
  // matching exactly what the ledger persists and what verify recomputes.
  return {
    value: structuredClone(snapshot.value),
    context: JSON.parse(JSON.stringify(snapshot.context ?? {})) as Record<string, unknown>,
  };
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
