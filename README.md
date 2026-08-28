# pi-sand

A Linux-first desktop client and local service around the installed Pi CLI. The v0.1 slice keeps product state separate from Pi's process and context:

```text
Desktop browser client → Local Agent Service → pi --mode rpc → Agent workspace
```

## Run

Requires Node.js 22.5+ (the service uses the built-in `node:sqlite` module) and `pi` on `PATH`.

```sh
npm start
# open http://127.0.0.1:4317
```

Set `PI_SAND_DB` to choose the SQLite file, `PORT` to choose the local HTTP port, or `PI_BIN` to choose the Pi executable. The service creates the database on first start. Create an Agent with a workspace directory, then submit ordinary natural-language requests.

## Test

```sh
npm test
npm run spike:self-test
```

The deterministic service tests use a deliberately narrow fake matching the Pi RPC event seam. They check durable IDs, transcript persistence, streaming updates, and completed-state restoration without asserting model wording.

## v0.1 boundary

The Local Agent Service owns Agents, Turns, transcript messages, and the Pi child process. The Desktop client only uses HTTP/SSE semantic operations; closing its window or losing its SSE connection does not cancel active work. Reopening the Desktop takes an authoritative Agent snapshot and subscribes to subsequent updates, replacing its rendered transcript from that snapshot so reconnects cannot duplicate or reorder visible messages. Interrupt, unexpected-exit handling, and restart reconciliation are subsequent tickets. v0.1 does not add a planning loop, task retry, provider abstraction, automatic replay, custom context/memory system, or direct client database access.

The canonical transcript contains user-visible user and assistant messages. Pi runtime/session IDs are optional metadata and do not replace the durable application Agent/Turn IDs.
