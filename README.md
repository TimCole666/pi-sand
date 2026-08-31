# pi-sand

`pi-sand` is a Pi package with a TypeScript Extension. The integrated release milestone is **v0.3.0**: Pi remains the foreground Manager and conversational host, while `pi-sandd` owns one durable local Task Runtime. This is the persistent local Agent Runtime foundation of the longer-term **pi-sand — Personal Agent OS** direction; it is not the whole Agent OS.

```text
Pi Manager (foreground conversation)
    ↓ /task, /tasks, /task-show, /task-stop, /task-retry
pi-sand Extension (first-party client)
    ↓ protocol-v1 Unix-domain IPC
pi-sandd (durable Task Runtime)
    ↓ owns Task/Attempt and one Fresh Executor
Fresh Pi 0.84.4 Executor (fresh process/context)
    ↓
isolated durable Git task worktree / task branch
```

## v0.3 product baseline

The v0.3 Task Runtime is a Linux-only release path requiring:

- Linux;
- an installed **Pi 0.84.4** executable;
- a trusted Pi project whose source Git worktree is clean, including no untracked files; and
- capacity for one active Fresh Executor globally. There is no queue.

`/task` resolves the canonical source repository, records its exact committed `HEAD`, and creates one isolated task worktree and `pi-sand/task-...` branch from that commit. Edits made later in the Manager source worktree are not implicitly copied into the Task worktree. The Task branch is never auto-merged into the source branch.

Install the package into the normal Pi host:

```sh
pi install /absolute/path/to/pi-sand
pi
```

A Git-source installation has the same package shape:

```sh
pi install git:github.com/TimCole666/pi-sand
pi
```

For a fast, non-persistent local extension load while developing:

```sh
pi -e /absolute/path/to/pi-sand
```

The package manifest exposes `./extensions/pi-sand.ts` through `pi.extensions`; Pi resolves that entry point for local and Git package sources. No repository build step is required for the TypeScript Extension loader.

## Ownership and lifetime

The two release invariants are:

1. **Conversation state belongs to the Manager surface; durable execution state belongs to pi-sand.**
2. **Client lifetime must never define Task lifetime.**

Pi/Manager owns the foreground Session, transcript, model context and compaction, normal prompts, tools, Skills, provider/model selection, ordinary retries, and session navigation. The Extension is a client of the runtime. It does not open the v0.3 Task database, own a Fresh Executor, copy the Manager transcript into a Task Packet, or turn the daemon into a conversation server.

`pi-sandd` owns the v0.3 Task database, durable Task and Attempt state, Fresh Executor process lifecycle, Git task worktree/branch, bounded result and checkpoint, explicit Stop/Retry, and Linux crash reconciliation. A Task and its Attempts are distinct from both the Manager Conversation and the disposable Fresh Executor process.

Quitting Pi, reloading the Extension, `/new`, `/resume`, `/fork`, replacing a Session, closing the TUI, or losing an IPC connection does **not** stop, fail, interrupt, retry, or otherwise transition an accepted Task. `/task-stop <task-id>` is the explicit user operation that stops an active Task. A daemon shutdown is a different lifecycle boundary: `pi-sandd` safely handles its owned worker before recording the appropriate interrupted or blocked outcome.

The daemon never stores ordinary foreground transcript, a Pi Session tree, or custom conversation context. It receives a bounded Task Packet containing durable Task facts and execution rules. A retry starts a new Pi process and fresh Pi conversational context; it does not replay a prior Manager or worker transcript. It does reuse the durable Task worktree and filesystem progress left by earlier Attempts.

## Runtime and commands

The first Task command automatically starts the matching detached `pi-sandd` package entrypoint when the socket is absent or unreachable, then waits for a protocol-v1 status response. The daemon is independent of the Pi client process: it remains alive with zero connected clients, and a later Pi Manager reconnects to the same runtime and database. Concurrent autostart attempts converge on one owner.

The owner-only Unix socket is:

```text
$XDG_RUNTIME_DIR/pi-sand/pi-sand.sock
```

When `XDG_RUNTIME_DIR` is unavailable, pi-sand uses an owner-specific temporary runtime directory containing the numeric user id. The runtime directory is mode `0700` and the socket is mode `0600`; the runtime database is separate from historical v0.1 Agent/Turn SQLite and is owner-only. IPC is newline-delimited JSON with request ids and protocol version `1`, not HTTP/TCP.

The public runtime method set is exactly `runtime.status`, `task.create`, `task.list`, `task.get`, `task.stop`, and `task.retry`. Mutating requests are not automatically replayed after an ambiguous disconnect. The client reports that the outcome is unknown and directs the user to inspect durable state before trying again. Protocol mismatches fail clearly rather than silently downgrading.

In the foreground Manager, the Extension commands are:

- **`/task <goal>`** — validates the trusted project and configured selected model, performs clean-Git and Pi 0.84.4 preflight, accepts a durable Task, creates its first Attempt, and launches one fresh extension-free Pi process in the isolated worktree. A second active or unresolved worker is rejected rather than queued. Credentials are not serialized into Task records or IPC.
- **`/tasks`** — lists durable Tasks and their Attempt state. It is inspection only; it does not wake the Manager or dispatch work.
- **`/task-show <task-id>`** — shows one Task, Attempt history, bounded result/terminal detail, and Git worktree/branch metadata. It can be used from a later reconnecting Manager without being in the Task source repository.
- **`/task-stop <task-id>`** — explicitly terminates the owned active worker group when its Linux identity can be proven, then records `stopped` while retaining the Task worktree and filesystem progress.
- **`/task-retry <task-id>`** — explicitly starts a new Attempt only for a retryable `failed`, `stopped`, or `interrupted` Task whose prior worker is safe. The reconnecting trusted Manager must resolve to the same canonical source repository recorded on the Task. The new Attempt snapshots that Manager's selected model/thinking settings, uses a new Pi process/context, and reuses the existing Task worktree. Completed and blocked Tasks are not retried.

The Fresh Executor uses the acknowledged startup sequence `set_model` → `set_thinking_level` → `get_state` exact verification → Task prompt acceptance. Setup failure, mismatch, timeout, close, or prompt rejection fails before Task inference and never records false applied model metadata. Successful completion requires a healthy assistant outcome followed by `agent_settled`; `agent_end` alone is not terminal. Successful dirty changes are checkpointed with deterministic local Git identity, existing worker commits are preserved, no-change success creates no empty checkpoint, and the source branch is never changed.

Terminal states retain the Task artifact for inspection:

- `completed`: settled result and final task-branch head are durable;
- `failed`: execution, setup, prompt, settled outcome, or finalization failed;
- `stopped`: the explicit Stop operation completed;
- `interrupted`: daemon lifecycle or a proven prior-boot/gone worker ended the Attempt without replay or adoption; and
- `blocked` / `orphaned`: worker identity or termination evidence was insufficient, so capacity remains fenced fail-closed and the worktree is retained.

A local daemon cannot execute while the whole machine is powered off. Continuing work across a powered-off laptop requires future remote/cloud infrastructure and is not a v0.3 claim.

## Proof and verification

The release proof uses public seams, not internal class call sequences:

- `test/v0.3-task-completion.integration.test.js` proves a real daemon and real Unix-socket clients can accept a clean-Git Task, run a deterministic worker through the verified handshake, survive the submitting client process disappearing, settle with zero clients, checkpoint an artifact, and let a later client inspect the same result while the source worktree remains unchanged.
- `test/v0.3-task-runtime-process.integration.test.js` proves the process boundary, bounded transcript-free packets, capacity refusal, trust/auth preflight, and that every Pi client lifecycle (`quit`, reload, new, resume, fork) is a no-op for daemon-owned Task control.
- `test/v0.3-runtime.integration.test.js` proves detached autostart/reconnect, owner-only IPC, singleton/stale-socket behavior, explicit protocol errors, and ambiguous mutating disconnect without automatic replay.
- `test/fresh-executor.test.js`, the Task completion tests, Stop/Retry tests, and daemon recovery tests cover the acknowledged handshake, settled completion, checkpointing, explicit Stop, fresh Retry, process identity, shutdown, crash recovery, and fail-closed orphan handling.

The default suite is deterministic and credential-free:

```sh
npm test
npm run spike:self-test
```

The real v0.3 acceptance is opt-in and intentionally uses configured credentials/model selection. It requires Linux, Pi 0.84.4, and a usable provider configuration:

```sh
npm run test:real-runtime
```

That acceptance starts a real Pi Manager A, submits through the real Extension to the independent daemon and a real extension-free Fresh Executor, fully exits Manager A before completion, then starts Manager B and inspects the same completed Task/artifact. It is not part of `npm test`.

The existing v0.2 host acceptance remains a hermetic, no-LLM check of package loading and `/pi-sand` dispatch on Pi 0.84.4:

```sh
node --test test/v0.2-host.acceptance.test.js
```

## Explicit v0.3 boundaries and next step

v0.3 does **not** include Mission or Goal-graph orchestration, a DAG, planner/replanner, decomposition, queueing, scheduling, automatic retry/backoff, more than one worker, worker adoption, completion wake, Attention Queue, notifications or push subscriptions, verifier/judge agents, deterministic verification/accept, auto-merge/rebase/cherry-pick/PR creation, Web/mobile/Telegram/Slack UI, HTTP/TCP/gRPC APIs, cloud/remote execution, cross-user authorization, systemd/launchd packaging, a generic executor-provider abstraction, non-Linux Fresh Executors, persistent pi-sand-owned foreground context, or Task worktree garbage collection.

The likely next architecture step is **Completion Wake + Attention Queue + deterministic verification/accept**. That work can build on the independently-lived local runtime without adding a scheduler or multi-worker pool first. Completion remains explicit inspection in v0.3.

## v0.2 host foundation

v0.2 established the foreground ownership correction that v0.3 preserves. The `/pi-sand` command reports non-sensitive host status: Pi mode, working directory, session id, and activity (`idle`, `running`, or `waiting_for_user`). It does not expose prompts, system context, credentials, provider secrets, or the full transcript. Normal v0.2 host use does not require Chromium, a localhost endpoint, manual port management, the legacy Local Agent Service, or `npm run launch`.

The v0.2 host contract has two durable seams, defined by GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22): the real Pi Extension Host Acceptance (`test/v0.2-host.acceptance.test.js`) and deterministic Extension lifecycle integration (`test/v0.2-activity.integration.test.js`, `test/v0.2-extension.integration.test.js`). These remain semantically unchanged and are independent of v0.3 inference.

## Historical v0.1 implementation and evidence

The v0.1 Web/Desktop product path remains in the repository as proven historical implementation and test evidence. It is not the current v0.3 product path, and its browser/service architecture must not be inferred as the current host or runtime contract:

```text
Desktop Client → Local Agent Service → pi --mode rpc → Agent workspace
```

The retained v0.1 implementation covers durable product Agents, Turns, transcript and attachment state, canonical workspaces, service-owned Pi process lifetime, Desktop reconnect, interruption, failure, and same-workspace safety. Its SQLite conversations, Chromium/Desktop presentation, and Local Agent Service tests remain historical evidence. They are not being migrated into `pi-sandd`, and ordinary v0.3 foreground conversation does not route through that service.

The normative v0.1 specification is [`SPEC-v0.1.md`](SPEC-v0.1.md). [`REFERENCE.md`](REFERENCE.md) and [`docs/v0.1-lifecycle-evidence.md`](docs/v0.1-lifecycle-evidence.md) are non-normative evidence records. [`SPEC.md`](SPEC.md) is superseded historical material. Historical deterministic/process-safety tests and the opt-in `npm run test:real-pi` Local Agent Service smoke remain green without redefining the v0.3 architecture.

## Authorities

- **v0.3 architecture:** GitHub issue [#38](https://github.com/TimCole666/pi-sand/issues/38), including its pinned ownership, lifetime, protocol, trust, freshness, recovery, and out-of-scope facts.
- **Integrated release proof:** this README, `package.json` version `0.3.0`/scripts, and the deterministic and opt-in v0.3 tests listed above.
- **v0.2 host foundation:** GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22).
- **v0.1 historical contract/evidence:** [`SPEC-v0.1.md`](SPEC-v0.1.md), [`REFERENCE.md`](REFERENCE.md), and [`docs/v0.1-lifecycle-evidence.md`](docs/v0.1-lifecycle-evidence.md).
