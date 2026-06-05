// SPDX-License-Identifier: MIT
// Adapted from @statelyai/agent (https://github.com/statelyai/agent),
// MIT License, Copyright (c) 2025 Stately Software, Inc. See NOTICE.
import { assign, setup } from "xstate";

/**
 * The "Die Hard" water-jug puzzle, adapted faithfully from @statelyai/agent's
 * examples/jugs.ts (https://github.com/statelyai/agent). The machine logic is
 * unchanged. In the original, a Stately `createExpert` + shortest-path policy
 * drives it in-process; Xanthe instead mounts the same machine over MCP so an
 * external model drives it on rails. Goal: get exactly 4 gallons into the 5-gallon
 * jug. The win is a guarded `always` (jug5 === 4) that settles into `success`.
 */

type JugEvent =
  | { type: "fill3" }
  | { type: "fill5" }
  | { type: "empty3" }
  | { type: "empty5" }
  | { type: "pour3to5" }
  | { type: "pour5to3" };

export const waterJugs = setup({
  types: {} as { context: { jug3: number; jug5: number }; events: JugEvent },
}).createMachine({
  id: "waterJugs",
  initial: "solving",
  context: { jug3: 0, jug5: 0 },
  states: {
    solving: {
      always: { guard: ({ context }) => context.jug5 === 4, target: "success" },
      on: {
        fill3: { actions: assign({ jug3: 3 }) },
        fill5: { actions: assign({ jug5: 5 }) },
        empty3: { actions: assign({ jug3: 0 }) },
        empty5: { actions: assign({ jug5: 0 }) },
        pour3to5: {
          actions: assign(({ context }) => {
            const total = context.jug3 + context.jug5;
            const jug5 = Math.min(5, total);
            return { jug5, jug3: total - jug5 };
          }),
        },
        pour5to3: {
          actions: assign(({ context }) => {
            const total = context.jug3 + context.jug5;
            const jug3 = Math.min(3, total);
            return { jug3, jug5: total - jug3 };
          }),
        },
      },
    },
    success: { type: "final" },
  },
});

export default waterJugs;
