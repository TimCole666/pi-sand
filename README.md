# pi-sand

`pi-sand` is a Pi package with a TypeScript Extension. The foreground product path remains **v0.2: load pi-sand into the installed Pi 0.84.4 host and start Pi**. The v0.3 tracer bullet adds a Linux-only, independently-lived read-only runtime inspection path. Pi's normal CLI/TUI remains the interactive product host; RPC is an automation and test seam.

```text
Pi CLI / TUI
    ↓
pi-sand Extension
    ├── /pi-sand status command
    ├── small host-status surface
    └── future pi-sand runtime state
```

## v0.2 product path

The exact verified v0.2 host baseline is **Pi 0.84.4**. This repository does not claim generic compatibility with other Pi versions. Verify the host before relying on a different version.

Install from a local checkout for development:

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

The package manifest exposes the TypeScript Extension through `pi.extensions`; Pi resolves that entry point for local and Git package sources. A project-local installation may be loaded with Pi's documented local-package option after the project is trusted. No repository build step is required for the TypeScript Extension loader.

Once Pi is running, invoke:

```text
/pi-sand
```

The command reports a small non-sensitive status proving the Extension is active. Its status includes the current Pi `mode`, working directory (`cwd`), Pi session identifier, and pi-sand activity (`idle`, `running`, or `waiting_for_user`). It does not expose prompts, system context, credentials, provider secrets, or the full transcript.

Normal v0.2 use does **not** require Chromium, a localhost endpoint, manual port management, the legacy Local Agent Service, or `npm run launch`. Do not start a second Pi process for an ordinary prompt: Pi owns the foreground conversation and execution.

## v0.3 persistent runtime tracer

On Linux, `/tasks` is an Extension client command for the independent `pi-sandd` runtime. When the owner-only Unix socket is absent, the client starts the package's detached `pi-sandd` entrypoint and reconnects to it. The socket is `$XDG_RUNTIME_DIR/pi-sand/pi-sand.sock`, or an owner-specific temporary runtime directory containing the numeric UID when `XDG_RUNTIME_DIR` is unavailable. The protocol is version 1 newline-delimited JSON and currently exposes only `runtime.status` and the empty/read-only `task.list` operation. The daemon owns its separate runtime database and remains alive after the Pi client exits.

This tracer bullet deliberately does not create Tasks, launch workers, stop or retry work, schedule execution, persist conversations, or add an HTTP/TCP server. The v0.2 foreground ownership boundary remains unchanged.

## Ownership boundary

Pi owns the foreground:

- Session identity and session navigation;
- the conversation transcript;
- model context and compaction;
- ordinary user input and execution;
- providers, tools, Skills, retries, and the autonomous work loop.

The Extension observes and presents a small host-status projection. It does not create a parallel foreground Agent/Turn/transcript database, replay the transcript into model context, add a planner or scheduler, or route ordinary prompts through the v0.1 service.

Future pi-sand **runtime state** is a separate concern from Pi conversation state. This v0.2 host migration does not implement Fresh Executors, durable `Task`/`Attempt` state, a scheduler, `Mission`, or self-hosting. Completion wake, scheduling, and worker orchestration are also not implemented. Those are later primitives with their own contracts, not names for the current Pi conversation.

## Test seams

The v0.2 host contract has two durable seams, as defined by GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22):

1. **Real Pi Extension Host Acceptance** — `test/v0.2-host.acceptance.test.js` loads the repository package in a real Pi process, proves `/pi-sand` registration and RPC dispatch on Pi 0.84.4, checks the non-sensitive status, and does so without an LLM call. Run it with:

   ```sh
   node --test test/v0.2-host.acceptance.test.js
   ```

2. **Deterministic Extension Lifecycle Integration** — `test/v0.2-activity.integration.test.js` and `test/v0.2-extension.integration.test.js` exercise the public Extension event/registration/UI boundary with deterministic host events, including session start, agent start, user-prompt waiting, `agent_settled`, reload/session replacement, and shutdown. It is intentionally distinct from the real-host acceptance seam; the current implementation is only a host-status projection, does not intercept ordinary prompts, and does not add a parallel runtime.

The v0.2 completion authority is Pi's settled lifecycle, not a low-level `agent_end` event. Lifecycle work must preserve Pi's ownership and must not introduce a reload manager, parallel runtime, Fresh Executor, durable Task/Attempt state, scheduler, Mission, or self-hosting implementation into this host migration.

Run the repository's deterministic checks with:

```sh
npm test
npm run spike:self-test
```

The opt-in `npm run test:real-pi` suite is historical v0.1 Local Agent Service smoke coverage and requires a configured model. It is not the v0.2 Extension Host Acceptance seam.

## Historical v0.1 implementation and evidence

The v0.1 Web/Desktop product path remains in the repository as proven historical implementation and test evidence. It is not the normal v0.2 product path and its browser/service architecture must not be inferred as the current host contract:

```text
Desktop Client → Local Agent Service → pi --mode rpc → Agent workspace
```

The retained v0.1 implementation covers durable product Agents, Turns, transcript and attachment state, canonical workspaces, service-owned Pi process lifetime, Desktop reconnect, interruption, failure, and same-workspace safety. It also contains the historical Chromium/Desktop presentation and Local Agent Service tests. Do not delete, migrate, or clean up that source or its SQLite conversations as part of v0.2 host documentation.

Historical v0.1 test classifications remain useful but are not v0.2 compatibility authority:

- **Actual Desktop E2E:** `test/desktop-actual-e2e.test.js`, `test/desktop-attachment-e2e.test.js`, `test/desktop-chromium-e2e.test.js`, `test/desktop-process-e2e.test.js`, and the relevant parts of `test/product-boundary.test.js`.
- **Local Agent Service integration:** `test/service.test.js`, `test/attachments.test.js`, `test/orphan-worker.test.js`, `test/stop-isolation.test.js`, and transport coverage in `test/service-http-e2e.test.js`.
- **v0.1 Real-Pi smoke:** `test/real-pi.acceptance.test.js`, which tests the historical subprocess adapter with a configured model.
- **Historical client harness support:** `test/desktop-client-harness.test.js` and `test/desktop-client-harness-http.test.js`; these are not Actual Desktop E2E and are not v0.2 host tests.

The v0.1 evidence remains accurate in its own boundary: `SPEC-v0.1.md` is the normative v0.1 release specification, `REFERENCE.md` is the non-normative Grok Bot 0.18 evidence ledger, and `docs/v0.1-lifecycle-evidence.md` records v0.1 evidence classifications and intentional extensions.

## Documentation authorities

- **Current v0.2 host contract:** GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22), with the package/command tracer bullet delivered by [#23](https://github.com/TimCole666/pi-sand/issues/23).
- **Current v0.2 repository guidance:** this README and the package manifest's `pi.extensions` declaration.
- **Normative v0.1 contract:** [`SPEC-v0.1.md`](SPEC-v0.1.md), for the retained v0.1 implementation only.
- **Non-normative v0.1 evidence:** [`REFERENCE.md`](REFERENCE.md) and [`docs/v0.1-lifecycle-evidence.md`](docs/v0.1-lifecycle-evidence.md).
- [`SPEC.md`](SPEC.md) is superseded historical v0.1 material and is not a competing authority.
- The older unmerged [`spec/v0.2-productization`](https://github.com/TimCole666/pi-sand/tree/spec/v0.2-productization) direction is **superseded** by issue #22. It must not be used to reintroduce browser productization, Chromium launch requirements, localhost/service requirements, or a competing v0.2 architecture.

The v0.2 boundary is intentionally a host migration, not Web/Desktop cleanup or the later runtime platform. Preserve accurate v0.1 evidence while keeping the current Pi Extension path unambiguous.
