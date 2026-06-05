import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AnyStateMachine } from "xstate";
import { Engine, type Session } from "./engine.js";
import type { LedgerStore } from "./ledger.js";

export interface ServeOptions {
  store?: LedgerStore;
  version?: string;
}

const jsonResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

/**
 * Mount a validated machine as an MCP server over stdio. Holds one active session;
 * step/state act on it, reset replaces it, the forks branch a new session and make
 * it active. The banner goes to stderr so it never corrupts the stdout MCP stream.
 */
export async function buildServer(
  machine: AnyStateMachine,
  options: ServeOptions = {},
): Promise<{ server: McpServer; engine: Engine; sessionId: string }> {
  const engine = new Engine(machine, { store: options.store });
  let current: Session = await engine.start();
  const initialSessionId = current.id;

  const server = new McpServer(
    { name: "xanthe", version: options.version ?? "0.1.0" },
    {
      instructions:
        `Drive the '${engine.machineId}' state machine on rails. From any state, only the moves in 'legal' are takeable. ` +
        `step(event) fires a trigger; if it is not legal the step is REFUSED (no state change) and the refusal names the legal moves so you can self-correct. ` +
        `Every step taken and every step refused is recorded in a hash-chained ledger. Use state() to see where you are.`,
    },
  );

  server.registerTool(
    "step",
    {
      description:
        "Fire a trigger event against the machine. Gated: if the event is not legal from the current state the step is refused, nothing advances, and the result is { refused: true, attempted, legal: [...] }. Pass payload for events that carry data (validated into context).",
      inputSchema: {
        event: z.string().describe("the event type to fire"),
        payload: z.record(z.unknown()).optional().describe("optional event data"),
      },
    },
    async ({ event, payload }) => jsonResult(await current.step(event, payload)),
  );

  server.registerTool(
    "state",
    {
      description: "Return the current state value, context, and the legal next moves from here.",
      inputSchema: {},
    },
    async () => jsonResult(current.state()),
  );

  server.registerTool(
    "reset",
    {
      description: "Start a brand-new session at the machine's initial state. Returns the new session id and state.",
      inputSchema: {},
    },
    async () => {
      current = await engine.start();
      return jsonResult(current.state());
    },
  );

  server.registerTool(
    "fork_at",
    {
      description:
        "Branch a new session from a beat (seq) in the CURRENT session's history. The branch becomes active and verifies independently.",
      inputSchema: { seq: z.number().int().nonnegative().describe("seq from the current session to branch at") },
    },
    async ({ seq }) => {
      try {
        current = await engine.fork(current.id, seq);
        return jsonResult(current.state());
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "fork_from_past",
    {
      description:
        "Branch a new session from a beat (seq) in a DIFFERENT past session, by session id. The branch becomes active and verifies independently.",
      inputSchema: {
        session_id: z.string().describe("id of a past session to branch from"),
        seq: z.number().int().nonnegative().describe("seq within that session to branch at"),
      },
    },
    async ({ session_id, seq }) => {
      try {
        current = await engine.fork(session_id, seq);
        return jsonResult(current.state());
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  return { server, engine, sessionId: initialSessionId };
}

export async function serveStdio(machine: AnyStateMachine, options: ServeOptions = {}): Promise<void> {
  const { server } = await buildServer(machine, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return new Promise(() => {
    /* run until the transport closes */
  });
}
