import { setup, assign, fromPromise } from "xstate";

/**
 * A tiny coffee-order machine, used by `xanthe primer`.
 *
 * Plain XState v5. The circuit is step-gated: every transition waits for an
 * explicit event, except `settling`, which runs ONE invoked actor (computeChange)
 * that resolves into the next decision state. Xanthe records that whole invoke as
 * a single beat: the "node does work" pattern.
 *
 *   menu --order--> ordered --pay--> settling --(computeChange)--> done
 */

interface CoffeeContext {
  drink: string;
  price: number;
  paid: number;
  change: number;
}

type CoffeeEvent = { type: "order" } | { type: "pay"; amount: number };

const computeChange = fromPromise(
  async ({ input }: { input: { price: number; paid: number } }) => input.paid - input.price,
);

export const coffee = setup({
  types: {} as { context: CoffeeContext; events: CoffeeEvent },
  actors: { computeChange },
}).createMachine({
  id: "coffee",
  initial: "menu",
  context: { drink: "", price: 0, paid: 0, change: 0 },
  states: {
    menu: {
      on: {
        order: {
          target: "ordered",
          actions: assign({ drink: "latte", price: 5 }),
        },
      },
    },
    ordered: {
      on: {
        pay: {
          target: "settling",
          actions: assign({ paid: ({ event }) => event.amount }),
        },
      },
    },
    settling: {
      invoke: {
        src: "computeChange",
        input: ({ context }) => ({ price: context.price, paid: context.paid }),
        onDone: {
          target: "done",
          actions: assign({ change: ({ event }) => event.output }),
        },
      },
    },
    done: { type: "final" },
  },
});

export default coffee;
