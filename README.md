# pi-sand

`pi-sand` is a Pi package with a TypeScript Extension. The integrated product milestone is **v0.3**: Pi remains the foreground Manager, while pi-sand owns one durable Task Runtime and can start at most one isolated Fresh Executor.

```text
Pi 0.84.4 Manager
    ↓ /task
pi-sand durable Task Runtime
    ↓ one bounded Task Packet
one Fresh Executor (Pi 0.84.4, extension-free)
    ↓
isolated task worktree / task branch
```

This is a Linux product path for a **trusted, clean Git worktree** with an installed **Pi 0.84.4** executable. The clean-Git preflight is part of `/task`: the source worktree, including untracked files, must be clean; the Task records the exact source `HEAD` and creates its worktree from that commit. Source changes made after launch are not synchronized into the worker base.

## v0.3 product path

Load the package into the normal Pi host:

```sh
pi install /absolute/path/to/pi-sand
pi
```

A Git-source installation uses the same package shape:

```sh
pi install git:github.com/TimCole666/pi-sand
pi
```

For a fast, non-persistent local extension load while developing:

```sh
pi -e /absolute/path/to/pi-sand
```

The package manifest exposes the TypeScript Extension through `pi.extensions`; Pi resolves that entry point for local and Git package sources. No repository build step is required for the TypeScript Extension loader.

In the foreground Pi Manager, the five durable Task commands are:

- **`/task <goal>`** starts immediately. It requires a trusted project, a clean Git worktree, a selected model/thinking level, and Pi 0.84.4. It persists a `Task` and first `Attempt`, creates an isolated `pi-sand/task-...` branch/worktree from the preflight commit, and sends one bounded Task Packet to a fresh extension-free Pi process. There is one active worker and no queue: a second concurrent Task is refused.
- **`/tasks`** lists the durable Tasks and their Attempts for inspection. It does not wake the Manager or dispatch work.
- **`/task-show <task-id>`** shows one Task, its durable result/detail, branch/worktree/checkpoint metadata, and Attempt states. Completion is observed by polling or inspection.
- **`/task-stop <task-id>`** explicitly stops the active Attempt. A successful stop records terminal `stopped` state and retains the task worktree and its filesystem progress.
- **`/task-retry <task-id>`** explicitly starts a new Attempt for a failed, stopped, or interrupted Task. The new Attempt uses a fresh Pi conversational context and process; it does not replay a prior transcript. It reuses the existing durable task branch/worktree, including filesystem changes left by earlier Attempts, and snapshots the newly selected model settings. Completed and blocked Tasks are not retried.

A Task that settles successfully stores a bounded final result and checkpoints any worker changes in the task branch. The Task branch is the durable code artifact. pi-sand never auto-merges it into the Manager's source branch; integrating it into the source branch is an explicit manual Git operation. The Manager source worktree remains unchanged by Task execution.

### Terminal outcomes

The product distinguishes these outcomes:

- **`completed`** — the Fresh Executor reached `agent_settled`; the bounded result and task-branch checkpoint are durable.
- **`failed`** — the Attempt reached a settled error, rejected its packet, closed unexpectedly, or could not complete its Git checkpoint.
- **`stopped`** — the user explicitly stopped the active Task; the worktree is retained for a later explicit retry.
- **`interrupted`** — graceful Pi session shutdown/reload/replacement, or a restart with a provably gone prior worker, ended the Attempt. No worker is adopted or replayed.
- **`blocked` / `orphaned`** — Linux identity or termination evidence was insufficient to prove that a prior worker is safe to signal or that executor capacity is free. The Attempt is recorded as `orphaned`, its Task is `blocked`, and the worktree is retained fail-closed.

The v0.3 boundary intentionally does **not** include completion wake, automatic retry, a verifier or judge, a scheduler, a multi-worker pool, `Mission` semantics, or self-hosting. There is no automatic dispatch or worker adoption. Ordinary foreground prompts stay in Pi's foreground conversation and do not route through the Task Runtime or implicitly spawn a Fresh Executor. pi-sand does not persist a duplicate foreground/worker transcript; the worker receives only its bounded Task Packet and inspects the current task filesystem.

## v0.3 proof seams

Issue [#36](https://github.com/TimCole666/pi-sand/issues/36) integrates the v0.3 lifecycle proof. The deterministic Task Runtime Integration covers:

- clean Git preflight, durable Task/Attempt creation, exact base commit, and isolated task branch/worktree;
- one bounded, transcript-free Task Packet and a running Attempt;
- settled completion, bounded result persistence, task-branch checkpointing, and an unchanged Manager source worktree;
- refusal of a second concurrent Task rather than queueing;
- explicit Stop followed by fresh Retry with a new Attempt/process and preserved worktree filesystem state;
- graceful shutdown, reload, and session replacement as durable `interrupted` outcomes with no packet replay;
- abnormal restart reconciliation, including safe `interrupted` resolution and fail-closed `blocked`/`orphaned` resolution.

The opt-in real acceptance seam starts a real Pi 0.84.4 Manager, submits one Task to a real extension-free Fresh Executor, and verifies the isolated file and checkpoint:

```sh
PI_SAND_REAL_FRESH_EXECUTOR=1 npm run test:real-fresh-executor
```

The repository currently exposes the same check through the direct test command when the environment is configured:

```sh
PI_SAND_REAL_FRESH_EXECUTOR=1 node --test test/v0.3-real-pi.acceptance.test.js
```

The real test requires Linux, Pi 0.84.4, and a configured model. It is opt-in and is skipped when the environment variable is absent; the default deterministic suite never requires model credentials.

## v0.2 host foundation and authority

v0.2 remains the host foundation and its authority is preserved. The exact verified v0.2 host baseline is **Pi 0.84.4**: load pi-sand into the installed Pi host and start Pi. Pi's normal CLI/TUI remains the interactive product host. v0.3 adds the separate durable Task Runtime/Fresh Executor seams above; it does not rewrite or weaken the completed v0.2 host contract.

The existing **`/pi-sand`** command reports a small non-sensitive host status with Pi mode, working directory, session identifier, and pi-sand activity (`idle`, `running`, or `waiting_for_user`). It does not expose prompts, system context, credentials, provider secrets, or a full transcript. Ordinary v0.2 host use does not require Chromium, a localhost endpoint, manual port management, the legacy Local Agent Service, or `npm run launch`.

The v0.2 host contract has two durable seams, as defined by GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22):

1. **Real Pi Extension Host Acceptance** — `test/v0.2-host.acceptance.test.js` loads the repository package in a real Pi process, proves `/pi-sand` registration and RPC dispatch on Pi 0.84.4, checks the non-sensitive status, and does so **without an LLM call**:

   ```sh
   node --test test/v0.2-host.acceptance.test.js
   ```

2. **Deterministic Extension Lifecycle Integration** — `test/v0.2-activity.integration.test.js` and `test/v0.2-extension.integration.test.js` exercise the public Extension event/registration/UI boundary with deterministic host events, including session start, agent start, user-prompt waiting, `agent_settled`, reload/session replacement, and shutdown. The host-status projection remains separate from the v0.3 Task Runtime.

Pi owns the foreground session, transcript, model context, compaction, ordinary user input, providers, tools, Skills, retries, and autonomous work loop. The Extension observes and presents a small host-status projection; it does not create a parallel foreground transcript database, replay the foreground transcript into a worker, or route ordinary prompts through the old service.

## Verification

The default deterministic repository suite and historical host evidence require no model credentials:

```sh
npm test
npm run spike:self-test
node --test test/v0.2-host.acceptance.test.js
node --test test/v0.3-task-runtime.integration.test.js test/v0.3-task-runtime-recovery.integration.test.js
```

The v0.3 real Fresh Executor check is opt-in as described above. `npm run test:real-pi` and `test/real-pi.acceptance.test.js` remain the historical v0.1 Local Agent Service Real-Pi smoke and require a configured model; they are not the v0.2 host acceptance seam or the v0.3 Fresh Executor proof.

## Historical v0.1 implementation and evidence

The v0.1 Web/Desktop product path remains in the repository as proven historical implementation and test evidence. It is not the normal v0.3 product path and its browser/service architecture must not be inferred as the current host contract:

```text
Desktop Client → Local Agent Service → pi --mode rpc → Agent workspace
```

The retained v0.1 implementation covers durable product Agents, Turns, transcript and attachment state, canonical workspaces, service-owned Pi process lifetime, Desktop reconnect, interruption, failure, and same-workspace safety. Its SQLite conversations, Chromium/Desktop presentation, and process-safety tests remain historical evidence and are intentionally preserved.

Historical v0.1 test classifications remain useful but are not v0.2 or v0.3 compatibility authority:

- **Actual Desktop E2E:** `test/desktop-actual-e2e.test.js`, `test/desktop-attachment-e2e.test.js`, `test/desktop-chromium-e2e.test.js`, `test/desktop-process-e2e.test.js`, and relevant parts of `test/product-boundary.test.js`.
- **Local Agent Service integration:** `test/service.test.js`, `test/attachments.test.js`, `test/orphan-worker.test.js`, `test/stop-isolation.test.js`, and `test/service-http-e2e.test.js`.
- **v0.1 Real-Pi smoke:** `test/real-pi.acceptance.test.js`, which tests the historical subprocess adapter with a configured model.
- **Historical client harness support:** `test/desktop-client-harness.test.js` and `test/desktop-client-harness-http.test.js`; these are not Actual Desktop E2E and are not v0.2/v0.3 host tests.

`SPEC-v0.1.md` is the normative v0.1 release specification. `REFERENCE.md` and `docs/v0.1-lifecycle-evidence.md` are non-normative v0.1 evidence records. `SPEC.md` is superseded historical material. None of these documents override the current v0.2 host foundation or this integrated v0.3 guidance.

## Documentation authorities and next step

- **Integrated v0.3 product guidance:** this README and the package manifest's `pi.extensions` declaration, with lifecycle proof in the v0.3 deterministic and opt-in acceptance tests.
- **v0.3 architecture authority:** GitHub issue [#29](https://github.com/TimCole666/pi-sand/issues/29), with the integrated release proof in [#36](https://github.com/TimCole666/pi-sand/issues/36).
- **v0.2 host authority:** GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22), with the package/command tracer bullet delivered by [#23](https://github.com/TimCole666/pi-sand/issues/23).
- **Normative v0.1 authority:** [`SPEC-v0.1.md`](SPEC-v0.1.md), for the retained v0.1 implementation only.
- **Non-normative v0.1 evidence:** [`REFERENCE.md`](REFERENCE.md) and [`docs/v0.1-lifecycle-evidence.md`](docs/v0.1-lifecycle-evidence.md).

The next architectural step is **Completion Wake + deterministic verification/accept semantics**: later work may add an explicit completion notification and verification/accept milestone on top of this durable lifecycle, without adding automatic retry, hidden transcript replay, or implicit foreground orchestration.
