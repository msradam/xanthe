// SPDX-License-Identifier: MIT
// Adapted from @statelyai/agent (https://github.com/statelyai/agent),
// MIT License, Copyright (c) 2025 Stately Software, Inc. See NOTICE.
import { assign, setup, assertEvent } from "xstate";

/**
 * Tic-tac-toe, adapted faithfully from @statelyai/agent's examples/ticTacToe.ts
 * (https://github.com/statelyai/agent). The state machine is unchanged except the
 * in-process LLM pieces are removed: the `gameReporter` text-stream actor and the
 * board-printing side effect (which would corrupt the stdio MCP stream). In the
 * original, a Stately agent observes the actor and sends 'agent.x.play' /
 * 'agent.o.play'; Xanthe mounts the same machine over MCP so an external model
 * sends those moves on rails. A win/draw is a guarded `always` that settles into
 * `gameOver`; an out-of-turn move is not handled and is refused.
 */

type Player = "x" | "o";

interface TicTacToeContext {
  board: Array<Player | null>;
  moves: number;
  player: Player;
}

type TicTacToeEvent =
  | { type: "agent.x.play"; index: number }
  | { type: "agent.o.play"; index: number }
  | { type: "reset" };

const initialContext: TicTacToeContext = {
  board: Array(9).fill(null),
  moves: 0,
  player: "x",
};

function getWinner(board: Array<Player | null>): Player | null {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ] as const;
  for (const [a, b, c] of lines) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a]!;
  }
  return null;
}

export const ticTacToe = setup({
  types: {} as { context: TicTacToeContext; events: TicTacToeEvent },
  actions: {
    updateBoard: assign({
      board: ({ context, event }) => {
        assertEvent(event, ["agent.x.play", "agent.o.play"]);
        const board = [...context.board];
        board[event.index] = context.player;
        return board;
      },
      moves: ({ context }) => context.moves + 1,
      player: ({ context }) => (context.player === "x" ? "o" : "x"),
    }),
    resetGame: assign(initialContext),
  },
  guards: {
    checkWin: ({ context }) => !!getWinner(context.board),
    checkDraw: ({ context }) => context.moves === 9,
    isValidMove: ({ context, event }) => {
      try {
        assertEvent(event, ["agent.o.play", "agent.x.play"]);
      } catch {
        return false;
      }
      return context.board[event.index] === null;
    },
  },
}).createMachine({
  id: "ticTacToe",
  initial: "playing",
  context: initialContext,
  states: {
    playing: {
      always: [
        { target: "gameOver.winner", guard: "checkWin" },
        { target: "gameOver.draw", guard: "checkDraw" },
      ],
      initial: "x",
      states: {
        x: {
          on: {
            "agent.x.play": [
              { target: "o", guard: "isValidMove", actions: "updateBoard" },
              { target: "x", reenter: true },
            ],
          },
        },
        o: {
          on: {
            "agent.o.play": [
              { target: "x", guard: "isValidMove", actions: "updateBoard" },
              { target: "o", reenter: true },
            ],
          },
        },
      },
    },
    gameOver: {
      initial: "winner",
      states: {
        winner: { tags: "winner" },
        draw: { tags: "draw" },
      },
      on: {
        reset: { target: "playing", actions: "resetGame" },
      },
    },
  },
});

export default ticTacToe;
