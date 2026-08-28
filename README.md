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
# Only with a configured real `pi` CLI and an intentionally available model:
npm run test:real-pi
```

The deterministic service tests use a deliberately narrow fake matching the Pi RPC event seam. The public Desktop client tests cover create/open → send → stream → complete, completed transcript reopening, close during active work → reconnect, interrupt, and unexpected Pi exit; lower-level tests cover persistence, transcript identity/order, and restart reconciliation without asserting model wording. `test:real-pi` creates an isolated temporary workspace and asks the installed Pi CLI to write one exact fixture file; it is skipped by normal test runs so development and CI do not require model credentials.

## v0.1 boundary

The Local Agent Service owns Agents, Turns, transcript messages, and the Pi child process. The Desktop client only uses HTTP/SSE semantic operations; closing its window or losing its SSE connection does not cancel active work. Reopening the Desktop takes an authoritative Agent snapshot and subscribes to subsequent updates, replacing its rendered transcript from that snapshot so reconnects cannot duplicate or reorder visible messages. The Desktop renders the latest durable terminal Turn state; failed and interrupted Turns retain their explanatory detail after reopen. An active Turn can be interrupted from the Desktop: the service forwards Pi's concrete RPC abort request and records exactly one `interrupted` terminal outcome when Pi settles, while retaining already durable transcript content. An unexpected Pi exit becomes one durable `failed` terminal outcome. On Local Agent Service startup, every persisted `running` Turn is durably classified as `interrupted` with an explanation that it was not resumed: pi-sand never adopts the former Pi process or replays its request. Terminal Turns, Agent metadata, workspace association, and transcript messages restore unchanged, and a later new Turn may be submitted normally. v0.1 permits one active workflow globally, preventing concurrent workspace mutation until the later concurrency design is implemented. Pi runs with its normal installed tools, extensions, and skills; the restrictive flags in the isolated integration spike are not product behavior. v0.1 does not add a planning loop, task retry, provider abstraction, automatic replay, custom context/memory system, or direct client database access.

The canonical transcript contains user-visible user and assistant messages. Pi runtime/session IDs are optional metadata and do not replace the durable application Agent/Turn IDs. `docs/v0.1-lifecycle-evidence.md` records the implemented lifecycle behaviors as Observed, Evidence-backed, Inferred, Unknown, or Extension and lists the explicit v0.1 guarantees and deferrals.
