# Pi integration spike (ticket #1)

This repository uses the installed Pi CLI as the first production runtime. The spike deliberately probes Pi's documented JSONL interfaces instead of scraping its terminal UI or inventing a provider abstraction.

## Reproduce

Requirements: Linux, Node.js, and `pi` on `PATH` (or set `PI_BIN` to an executable path). The probe creates a temporary workspace containing `fixture.txt`; pass `--cwd` to use another controlled workspace.

```sh
node spikes/pi-contract.mjs self-test
node spikes/pi-contract.mjs run
node spikes/pi-contract.mjs interrupt --after-ms 1000
node spikes/pi-contract.mjs crash --after-ms 1000
```

`run` uses `pi --mode json` and sends one read-only prompt. `interrupt` and `crash` use `pi --mode rpc`, submit the prompt over stdin, and then either send the documented `abort` command or send `SIGKILL`. Each mode prints a JSON summary; `--output FILE` also saves it. `crash` exits successfully when the expected `SIGKILL` is observed because the abnormal exit is the behavior under test.

The probe uses these safety/reproducibility flags:

- `--no-session`: prevents the probe from changing Pi's session history.
- `--no-extensions --no-skills`: excludes ambient project/global resources from the experiment.
- `--approve`: makes non-interactive project trust deterministic.
- `--tools read,write,bash`: enables only Pi's built-in workspace tools.

## Observed contract

The observations below were made with Pi `0.84.2`, Node `v26.7.0`, on Linux (`x86_64`). The exact model/provider is environment configuration and is not a product contract.

### Start, stream, and completion (`--mode json`)

- Pi writes one JSON object per line to stdout. `stderr` was empty for successful runs.
- The first object is a session header such as `{"type":"session","version":3,"id":"<uuid>","cwd":"<workspace>"}`.
- A normal run emits lifecycle events in this shape: `agent_start`, `turn_start`, user `message_start`/`message_end`, assistant `message_start`, zero or more `message_update`, `message_end`, `turn_end`, `agent_end`, and `agent_settled`.
- `message_update.assistantMessageEvent.type === "text_delta"` provides incremental assistant text. Deltas are not cumulative; the service must assemble them for live display.
- `message_end` contains the authoritative completed assistant message. It includes a `stopReason` such as `stop` or `toolUse`.
- Tool use is observable without parsing terminal output: `tool_execution_start` contains `toolCallId`, `toolName`, and parsed `args`; optional `tool_execution_update` contains partial results; `tool_execution_end` contains the result and `isError`.
- A task can emit multiple assistant `message_end` records when Pi performs tool calls. The product transcript should select the user-visible final assistant result rather than treating every internal turn response as a final product message.

### RPC prompting and interrupt

`pi --mode rpc` accepts strict JSONL commands on stdin and writes responses/events on stdout.

- A prompt command is `{"id":"...","type":"prompt","message":"..."}`. Its response only acknowledges acceptance (`success: true`); execution events arrive asynchronously.
- The same RPC process accepts subsequent `prompt` commands after `agent_settled`; Pi's in-memory session context is carried into those ordinary follow-up prompts. This is the supported v0.1 continuity boundary. A new process has no continuity guarantee when `--no-session` is used.
- `get_state` returns a response containing `sessionId`, `isStreaming`, `sessionFile`, and message counts. In the probe, RPC did not emit the JSON-mode session header, so the service should use `get_state` (or its own Agent identity) when it needs the runtime identifier.
- `abort` returns an acknowledgement and causes the active assistant message to end with `stopReason: "aborted"`. In the observed run, Pi then emitted `turn_end`, `agent_end`, and `agent_settled`; the process itself remained available for more RPC commands until terminated by the probe.
- An interrupt request is therefore asynchronous: the service must wait for the terminal event and make the product Turn terminal once, rather than assuming the acknowledgement itself means work has stopped.

### Abnormal process exit

The `crash` probe starts an RPC run and sends `SIGKILL` while the model request is active. The observed child result is:

- process close event: `signal === "SIGKILL"` (no normal exit code)
- events received up to the kill: startup/lifecycle and message-start records
- no `agent_end`, `agent_settled`, or failed product event is emitted by Pi before an uncatchable kill

The Local Agent Service must classify this child-process close as a failed Turn when no successful terminal event has already won the race. Pi does not autonomously retry the task or expose a resumable partial execution through this probe.

## Identity and continuation findings

- Pi exposes a runtime/session UUID in the JSON-mode `session` header and via RPC `get_state.sessionId`.
- Session files are an execution context owned by Pi, not a stable `pi-sand` Agent identity. The product should persist its own Agent and Turn IDs and keep any Pi session ID as optional runtime metadata.
- Pi supports selecting/continuing sessions (`--session`, `--continue`, `--resume`, and RPC session options are documented), but this spike did not establish safe continuation of a process killed during filesystem mutation. No automatic resume or replay is part of the v0.1 adapter.
- Tool-call IDs are present and useful for correlating one live tool execution. They are runtime IDs, not durable product message IDs. Assistant messages do not expose a general stable product message ID in the JSON event stream; the Local Agent Service must assign its own IDs when persisting transcript records.
- The documented event set includes tool lifecycle events, but their payload schema is the runtime's event schema and should only be translated into product activity where needed. Private reasoning and every tool event do not belong in the canonical transcript by default.

## Adapter boundary for the next ticket

The smallest proven subprocess seam is:

1. spawn `pi --mode rpc` in the Agent workspace;
2. keep that RPC process for the lifetime of the live Agent context and send one `prompt` command per product Turn;
3. translate `message_update` text deltas and selected tool lifecycle events to service updates;
4. treat `agent_end` as non-terminal and wait for `agent_settled` plus the final assistant message before normal or interrupted completion;
5. send `abort` for an interrupt and wait for the resulting `stopReason: "aborted"`;
6. classify a child close with no terminal event as failure.

This is a concrete Pi CLI contract, not a generic `AgentRuntime` interface. Native in-process follow-up prompts are covered by the production two-Turn smoke. Session continuation after process/service replacement, crash recovery, provider substitution, retry loops, planning, and a pi-sand-owned context manager remain outside this spike.

## Evidence classification

- **Observed:** JSONL framing, session header in JSON mode, RPC prompt/get_state/abort commands, streamed text deltas, tool execution lifecycle, `agent_end` followed by authoritative `agent_settled` completion lifecycle, aborted stop reason, and SIGKILL child-close behavior.
- **Evidence-backed:** Pi documentation explicitly defines these event and command shapes in its installed `docs/json.md`, `docs/rpc.md`, and `docs/sdk.md`.
- **Inferred:** A service can own a Pi subprocess independently of a desktop process; the service can classify abnormal child close as failed when no terminal event exists.
- **Unknown:** Safe continuation after process/service crash, whether all providers emit identical tool payload details, and which activity records users ultimately need.
- **Extension:** Persisting application-owned Agent/Turn/transcript IDs and translating this runtime stream into a semantic local service API.
