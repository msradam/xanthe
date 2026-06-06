# Xanthe

Mount a plain [XState v5](https://stately.ai/docs/xstate) state machine as an [MCP](https://modelcontextprotocol.io) server and drive any model on rails. The agent may only take steps the machine allows; every step taken and every step refused goes into a hash-chained ledger. Sessions can be reset and forked.

![Xanthe validating a machine and running the offline primer](docs/demo.gif)

Xanthe is the TypeScript sibling of [Theodosia](https://github.com/msradam/theodosia), which does the same thing over Burr in Python. Xanthe is to XState as Theodosia is to Burr: the concepts (gate, refuse, record, fork, verify) are the same, and the surface speaks XState's own vocabulary, events, `value`, `context`, and the moves you can `send`.

## What it is

You write an ordinary XState v5 machine and export it. `xanthe serve` validates it, mounts it over stdio as an MCP server, and exposes five tools: `step`, `state`, `reset`, `fork_at`, `fork_from_past`. From any state, only the events the machine permits are takeable. A refused step returns the legal next moves so a weak or unfamiliar model can self-correct, and the refusal is recorded just like a taken step.

There is no DSL. Authors write plain `setup().createMachine(...)`. A mount-time validator enforces the one premise Xanthe relies on: that one `step` settles in exactly one decision state. It rejects machines that auto-advance (see [The validator](#the-validator)).

The durable ledger is over Xanthe's own canonical state, the `{ value, context }` it tracks per step, not over XState's internal persisted-snapshot blob. The hash chain hashes that canonical state, so `xanthe verify` does not depend on any XState internals.

## Install

From source (the `prepare` script builds `dist/` on install):

```sh
git clone https://github.com/msradam/xanthe
cd xanthe
npm install
```

Or as a dependency (not yet on npm):

```sh
npm install github:msradam/xanthe
```

Pinned to `xstate@5.32.0` and `@modelcontextprotocol/sdk@1.29.0`.

## Quickstart

### 1. See the loop close in 30 seconds

```sh
npm run primer
```

Runs a tiny coffee-order machine offline and deterministically: it drives `step`, a refusal, and a `fork` itself, then verifies the chains. No API key, no external client. The output is identical every run.

### 2. Point at a machine and serve it

```sh
# dev (no build step, runs the .ts directly):
npm run dev -- serve examples/incident.ts#incident

# or after `npm run build`:
node dist/cli.js serve examples/incident.ts#incident
```

The spec is `<file>#<export>`. On startup Xanthe prints the machine id, the event vocabulary, the terminal states, and the ledger path to stderr (stdout is the MCP channel), then listens on stdio.

### 3. Drive it from an MCP client

Point any MCP client at the command. For example, a `claude_desktop_config.json` / generic MCP `mcpServers` entry:

```json
{
  "mcpServers": {
    "incident": {
      "command": "node",
      "args": ["/abs/path/to/xanthe/dist/cli.js", "serve", "examples/incident.ts#incident"]
    }
  }
}
```

Then `state()` to see where you are, `step({ event })` to act. The canonical refusal:

```jsonc
// step({ event: "close_incident" }) from the `engaged` state:
{
  "outcome": "refused",
  "refused": true,
  "attempted": "close_incident",
  "to": null,
  "legal": ["verify"],
  "reason": "event 'close_incident' is not legal from state 'engaged'. Legal moves: verify.",
}
```

`verify` must happen first; the attempt is recorded and the state does not advance.

### 4. Verify the ledger

```sh
node dist/cli.js verify                        # every session under the ledger root
node dist/cli.js verify incident               # every session of one machine
node dist/cli.js verify incident/<session-id>  # one session
node dist/cli.js verify incident --json         # attestation receipts (machine-readable, with head_hash)
node dist/cli.js verify incident --min 5        # also fail if a chain has fewer than 5 entries (truncation)
```

`verify` walks the chain and reports `intact` or the first broken seq.

### Validate without serving

`xanthe doctor <file>#<export>` runs the same mount-time validator and exits 0 (valid) or 1 (rejected, naming the offending state). It does not start a server, so it drops straight into CI.

```sh
node dist/cli.js doctor examples/incident.ts#incident
```

## Writing a machine

Plain XState v5. Export the machine; Xanthe loads it as-is.

```ts
import { setup, assign } from "xstate";

export const incident = setup({
  types: {} as {
    context: { rootCause: string | null };
    events: { type: "page_oncall" } | { type: "verify"; rootCause: string } | { type: "close_incident" };
  },
}).createMachine({
  id: "incident",
  initial: "triaged",
  context: { rootCause: null },
  states: {
    triaged: { on: { page_oncall: "engaged" } },
    engaged: {
      on: {
        verify: { target: "verified", actions: assign({ rootCause: ({ event }) => event.rootCause }) },
      },
    },
    verified: { on: { close_incident: "closed" } },
    closed: { type: "final" },
  },
});
```

Two patterns the engine records as a single beat:

- The node does work: a state with one invoked actor (`invoke: { src, onDone }`) that resolves into the next decision state. See `examples/coffee.ts`, where `computeChange` runs as one recorded step.
- The agent supplies the result: a `step` payload validated into context via `assign`. See `verify` above.

## Examples

- `examples/incident.ts`, `examples/coffee.ts`: Xanthe's own machines (an incident runbook and a coffee order).
- `examples/stately/`: three machines adapted from [`@statelyai/agent`](https://github.com/statelyai/agent)'s own examples, the Die Hard water-jug puzzle, tic-tac-toe, and the wolf/goat/cabbage river crossing. In the originals an in-process LLM picks each event; here the same machine is mounted over MCP and driven by any external model. See `NOTICE` for attribution.

## The validator

Xanthe's contribution is mount + gating + ledger + a validator, nothing reinvented. The validator keeps `step` / `reset` / `fork` and the ledger coherent by enforcing that one `step` settles in exactly one decision state, through at most one transient hop.

Rejected, with a message naming the offending state:

- `after` (delayed) transitions anywhere. They auto-advance on a timer.
- `always` cascades. An eventless transition into a state that itself auto-advances.
- invoke chains. An invoke whose result lands in a state that auto-advances again.
- a state that both waits for an event and auto-advances.

Allowed:

- states that wait for an author event, with or without guards,
- a single invoked actor resolving into the next decision state (one recorded beat),
- a single guarded `always` resolving into the next decision state.

Legality itself comes from XState: from the current state, the legal next moves are the machine's event vocabulary filtered through `snapshot.can({ type })`.

## MCP tools

| tool             | input                 | effect                                                                                                                                       |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`           | `{ event, payload? }` | Fire a trigger. Gated. Records `allowed` or `refused`. On refusal returns `{ refused: true, attempted, legal: [...] }` and does not advance. |
| `state`          | none                  | Current state value, context, and legal next moves.                                                                                          |
| `reset`          | none                  | New session at the machine's initial state.                                                                                                  |
| `fork_at`        | `{ seq }`             | Branch a new session from a beat in the current session's history.                                                                           |
| `fork_from_past` | `{ session_id, seq }` | Branch from a beat in a different past session.                                                                                              |

## Ledger

JSONL at `~/.xanthe/<machine-id>/<session-id>/ledger.jsonl` (override the root with `XANTHE_HOME`). Each entry:

```jsonc
{ "ts", "seq", "action", "from", "to", "reason", "outcome",
  "state": { "value", "context" }, "session_id", "prev_hash", "hash" }
```

`hash = ALGO:H(canonical(entry-without-hash) + prev_hash)`. The `session_id` is inside the hashed payload, so `verify` catches edits, reorders, gaps, and cross-session copies. Refusals are recorded in the same chain with `outcome: "refused"` and `to: null`. Forking reconstructs an actor from the canonical state recorded at a seq and starts a fresh, independently verifiable chain.

Hashes are algorithm-tagged (`sha256:` by default). Set `XANTHE_LEDGER_KEY` to seal entries with `hmac-sha256:` instead, which defends against whole-cloth forgery by anyone with write access; `verify` then requires the same key and rejects an HMAC-to-SHA-256 downgrade. `verify --json` emits a `head_hash` you can commit externally, and `--min <n>` fails a chain that has been truncated below an expected length.

## Library use

```ts
import { Engine, MemoryLedgerStore, validateMachine, verifyChain } from "xanthe";

const engine = new Engine(machine, { store: new MemoryLedgerStore() });
const session = await engine.start();
const result = await session.step("page_oncall");
verifyChain(session.history(), session.id); // { ok: true, count }
```

## Development

```sh
npm run typecheck
npm test
```

This package was built with LLM assistance.

## License

Apache-2.0. The three machines under `examples/stately/` are adapted from
`@statelyai/agent` (MIT); see `NOTICE`.
