// SPDX-License-Identifier: MIT
// Adapted from @statelyai/agent (https://github.com/statelyai/agent),
// MIT License, Copyright (c) 2025 Stately Software, Inc. See NOTICE.
import { assign, setup } from "xstate";

/**
 * The wolf/goat/cabbage river-crossing puzzle, adapted faithfully from
 * @statelyai/agent's examples/river-crossing.ts (https://github.com/statelyai/agent).
 * The machine logic is unchanged. In the original a Stately `createExpert` +
 * shortest-path policy drives it; Xanthe mounts the same machine over MCP so an
 * external model drives it on rails. Goal: move all three items to the right bank.
 *
 * Note (faithful to the original): the move guards only enforce that the farmer is
 * present with the item, not the "don't leave wolf with goat" safety rule. The
 * machine is also one-way (items are only carried left->right; only the farmer
 * returns, via returnEmpty), so the classic *safe* solution is not reachable here:
 * the goal is simply to get all three items across (rightBank.length === 3). Moves
 * that aren't possible from the current bank are refused.
 */

type Item = "wolf" | "goat" | "cabbage";

interface RiverContext {
  leftBank: Item[];
  rightBank: Item[];
  farmerPosition: "left" | "right";
}

type RiverEvent = { type: "takeWolf" } | { type: "takeGoat" } | { type: "takeCabbage" } | { type: "returnEmpty" };

function carry(item: Item) {
  return assign(({ context }: { context: RiverContext }) => ({
    leftBank: context.leftBank.filter((i) => i !== item),
    rightBank: [...context.rightBank, item],
    farmerPosition: "right" as const,
  }));
}

export const riverCrossing = setup({
  types: {} as { context: RiverContext; events: RiverEvent },
}).createMachine({
  id: "riverCrossing",
  initial: "solving",
  context: { leftBank: ["wolf", "goat", "cabbage"], rightBank: [], farmerPosition: "left" },
  states: {
    solving: {
      always: { guard: ({ context }) => context.rightBank.length === 3, target: "success" },
      on: {
        takeWolf: {
          guard: ({ context }) => context.leftBank.includes("wolf") && context.farmerPosition === "left",
          actions: carry("wolf"),
        },
        takeGoat: {
          guard: ({ context }) => context.leftBank.includes("goat") && context.farmerPosition === "left",
          actions: carry("goat"),
        },
        takeCabbage: {
          guard: ({ context }) => context.leftBank.includes("cabbage") && context.farmerPosition === "left",
          actions: carry("cabbage"),
        },
        returnEmpty: {
          actions: assign(({ context }) => ({
            farmerPosition: context.farmerPosition === "left" ? ("right" as const) : ("left" as const),
          })),
        },
      },
    },
    success: { type: "final" },
  },
});

export default riverCrossing;
