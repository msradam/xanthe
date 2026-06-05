# Xanthe Playground

Mounts a set of plain XState machines as Xanthe MCP servers so you can drive them
on rails yourself. The puzzle/game machines are adapted faithfully from Stately's
own [`@statelyai/agent`](https://github.com/statelyai/agent) examples; in the
originals an in-process LLM picks the next event, here an external model (or you)
drives the same machine over MCP, with every step and refusal in a verifiable ledger.

## Machines

| name             | what it is                                                      | source                                      |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `tic-tac-toe`    | play tic-tac-toe; turn-gated, win settles into `gameOver`       | @statelyai/agent examples/ticTacToe.ts      |
| `water-jugs`     | the Die Hard puzzle: get 4 gallons into the 5-gallon jug        | @statelyai/agent examples/jugs.ts           |
| `river-crossing` | wolf/goat/cabbage, get all three across                         | @statelyai/agent examples/river-crossing.ts |
| `incident`       | incident response flow; `close_incident` is gated on `verified` | Xanthe                                      |
| `coffee`         | tiny coffee order with one invoked actor                        | Xanthe                                      |

## Setup

```sh
cd ..            # repo root
npm install
npm run build
```

## Try it (three ways)

### 1. MCP Inspector (easiest, interactive GUI, no client setup)

```sh
./xanthe-playground.sh inspect tic-tac-toe
```

Opens a browser UI. Call `state` to see the board/context and the legal moves,
then `step` with `{ "event": "agent.x.play", "payload": { "index": 4 } }`. Try an
out-of-turn move and watch it get refused with the legal moves listed. `reset` and
`fork_at` are there too.

### 2. Claude Code

```sh
./xanthe-playground.sh install   # writes ../.mcp.json
```

Re-open the project in Claude Code and approve the `xanthe-*` servers. Then just ask:
"play tic-tac-toe", "solve the water jugs puzzle", "drive the incident machine and try
to close it early". Claude uses the mounted `step` / `state` / `reset` / `fork_at`
tools, and is held to the legal moves.

### 3. Claude Desktop

```sh
./xanthe-playground.sh install   # also prints the Claude Desktop config
```

Merge the printed `mcpServers` block into `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS), restart Claude Desktop, and drive
the machines from the app.

## Inspect the ledger

Every server writes to `../.xanthe-playground/<machine-id>/<session-id>/ledger.jsonl`.

```sh
./xanthe-playground.sh verify              # verify every playground session
./xanthe-playground.sh verify ticTacToe    # one machine
```

## Other commands

```sh
./xanthe-playground.sh list      # list machines
./xanthe-playground.sh serve tic-tac-toe   # run a server on stdio directly
./xanthe-playground.sh primer    # offline 30-second demo
```
