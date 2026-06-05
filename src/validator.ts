import type { AnyStateMachine, StateNode } from "xstate";

/**
 * The step-gated circuit premise: one `step` (one author event) must settle in
 * exactly one decision state, passing through at most ONE transient hop (a single
 * invoked actor, or a single guarded `always`). This validator enforces that shape
 * instead of a DSL: authors write plain XState v5, and machines that auto-advance
 * are rejected at mount so step / reset / fork and the ledger stay coherent.
 *
 * Rejected:
 *   - `after` (delayed) transitions anywhere, which auto-advance on a timer.
 *   - `always` cascades: an eventless transition into a state that itself auto-advances.
 *   - invoke chains: an invoke whose result lands in a state that auto-advances again.
 *   - a state that both waits for an event and auto-advances (ambiguous beat).
 *   - a state with both `always` and `invoke` (two auto-advance mechanisms in one beat).
 *
 * Allowed:
 *   - states that wait for an author event (with or without guards),
 *   - a single invoked actor resolving into the next decision state (one recorded beat),
 *   - a single `always` (optionally guarded) resolving into the next decision state.
 */
export interface ValidationError {
  state: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

type Node = StateNode<any, any>;

function isAuthorEvent(eventType: string): boolean {
  return eventType !== "" && !eventType.startsWith("xstate.");
}

function authorEventTypes(node: Node): string[] {
  return [...node.transitions.keys()].filter(isAuthorEvent);
}

function alwaysTransitions(node: Node) {
  return node.always ?? [];
}

function invokeResolutionTargets(node: Node): Node[] {
  const targets: Node[] = [];
  for (const [eventType, transitions] of node.transitions) {
    if (eventType.startsWith("xstate.done.actor.") || eventType.startsWith("xstate.error.actor.")) {
      for (const t of transitions) for (const target of t.target ?? []) targets.push(target as Node);
    }
  }
  return targets;
}

function hasAfter(node: Node): boolean {
  return (node.after?.length ?? 0) > 0;
}

function autoAdvances(node: Node): boolean {
  return alwaysTransitions(node).length > 0 || (node.invoke?.length ?? 0) > 0 || hasAfter(node);
}

/** Follow `initial` into compound states until reaching an atomic / final / parallel leaf. */
function entryLeaf(node: Node): Node {
  let current = node;
  const seen = new Set<Node>();
  while (current.type === "compound" && !seen.has(current)) {
    seen.add(current);
    const target = current.initial?.target?.[0] as Node | undefined;
    if (!target) break;
    current = target;
  }
  return current;
}

function alwaysTargets(node: Node): Node[] {
  return alwaysTransitions(node).flatMap((t) => (t.target ?? []) as Node[]);
}

export function validateMachine(machine: AnyStateMachine): ValidationResult {
  const errors: ValidationError[] = [];
  const nodes: Node[] = [];

  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of Object.values(node.states ?? {})) collect(child as Node);
  };
  collect(machine.root as Node);

  const id = (node: Node) => node.id;

  for (const node of nodes) {
    if (hasAfter(node)) {
      errors.push({
        state: id(node),
        message: `state '${id(node)}' uses an 'after' (delayed) transition, which auto-advances on a timer. Every Xanthe beat must be driven by an explicit event.`,
      });
    }

    const hasAlways = alwaysTransitions(node).length > 0;
    const invokes = node.invoke ?? [];
    const events = authorEventTypes(node);

    if (hasAlways && invokes.length > 0) {
      errors.push({
        state: id(node),
        message: `state '${id(node)}' combines an 'always' transition and an 'invoke'. A single beat allows at most one auto-advance mechanism.`,
      });
    }

    // An invoked state cannot also rest on events: the actor may never settle, and
    // the beat would be ambiguous (wait for the actor, or for an event first?).
    if (invokes.length > 0 && events.length > 0) {
      errors.push({
        state: id(node),
        message: `state '${id(node)}' invokes an actor and also waits for events (${events.join(", ")}). An invoked beat must resolve into the next state, not rest on events. A long-running actor would never settle.`,
      });
    }

    // A guarded `always` alongside `on` is fine: it is the idiomatic "check the
    // win condition after each move" shape, where the move is one event and a single
    // guarded hop settles into the next decision state. Only an UNGUARDED `always`
    // is a problem, because the state always auto-advances and the handlers are dead.
    const unguardedAlways = alwaysTransitions(node).some((t) => t.guard === undefined);
    if (hasAlways && unguardedAlways && events.length > 0) {
      errors.push({
        state: id(node),
        message: `state '${id(node)}' has an unguarded 'always' transition and also waits for events (${events.join(", ")}); those handlers are unreachable because it always auto-advances. Guard the 'always' so the state can rest on an event.`,
      });
    }

    // Cascade / invoke-chain detection: a transient state's landing must rest.
    const landings = [...alwaysTargets(node), ...invokeResolutionTargets(node)].map(entryLeaf);
    for (const landing of landings) {
      if (autoAdvances(landing)) {
        const how = invokes.length > 0 ? "invoke result" : "'always' transition";
        errors.push({
          state: id(node),
          message: `state '${id(node)}' auto-advances via its ${how} into '${id(landing)}', which itself auto-advances. That moves through more than one state per step (a cascade); insert an event-gated decision state between them.`,
        });
      }
    }
  }

  // Dedupe identical (state, message) pairs produced by symmetric checks.
  const seen = new Set<string>();
  const unique = errors.filter((e) => {
    const k = `${e.state}::${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: unique.length === 0, errors: unique };
}

export class MachineValidationError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`machine rejected by validator:\n` + errors.map((e) => `  - ${e.message}`).join("\n"));
    this.name = "MachineValidationError";
  }
}
