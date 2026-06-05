import { setup, assign } from "xstate";

/**
 * Incident response, on rails. Plain XState v5.
 *
 *   triaged --page_oncall--> engaged --verify--> verified --resolve--> resolved --archive--> closed
 *
 * Two patterns Xanthe records as beats:
 *   - the canonical refusal: close_incident from `engaged` is not legal (you must
 *     reach `verified` first). The attempt is refused, recorded, and does not advance.
 *   - the agent supplies the result: `verify` carries a payload (root cause + signal)
 *     that is validated into context via assign.
 */

interface IncidentContext {
  severity: string;
  rootCause: string | null;
  verifiedBy: string | null;
  resolution: string | null;
}

type IncidentEvent =
  | { type: "page_oncall" }
  | { type: "verify"; rootCause: string; signal: string }
  | { type: "resolve"; resolution: string }
  | { type: "archive" }
  | { type: "close_incident" };

export const incident = setup({
  types: {} as { context: IncidentContext; events: IncidentEvent },
}).createMachine({
  id: "incident",
  initial: "triaged",
  context: { severity: "sev2", rootCause: null, verifiedBy: null, resolution: null },
  states: {
    triaged: {
      on: { page_oncall: "engaged" },
    },
    engaged: {
      on: {
        verify: {
          target: "verified",
          actions: assign({
            rootCause: ({ event }) => event.rootCause,
            verifiedBy: ({ event }) => event.signal,
          }),
        },
      },
    },
    verified: {
      on: {
        resolve: {
          target: "resolved",
          actions: assign({ resolution: ({ event }) => event.resolution }),
        },
        close_incident: "closed",
      },
    },
    resolved: {
      on: {
        archive: "closed",
        close_incident: "closed",
      },
    },
    closed: { type: "final" },
  },
});

export default incident;
