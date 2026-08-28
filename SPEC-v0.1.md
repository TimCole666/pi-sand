# pi-sand v0.1 Productization Specification

Status: **Draft**

This document defines the first release target for `pi-sand`.

The current `main` branch is a **pre-v0.1 foundation**: it has already proven the Pi-native lifetime, persistence, reconnect, failure, interruption, and safe multi-Agent concurrency model, but it is still developer-operated software rather than a product that is comfortable to use every day.

The first published/tagged `v0.1.0` should therefore mean **the first dogfood-ready product**, not merely the first successful architectural vertical slice.

Where older milestone wording in `SPEC.md` calls the current foundation “v0.1”, treat that as historical implementation-stage language. The stable architectural principles remain valid; this document defines the actual release boundary.

---

## 1. Problem Statement

The core architecture is already real:

```text
Desktop Client
      ↓
Local Agent Service
   ├── SQLite
   └── Pi
        ↓
    Workspace
```

The current implementation proves durable Agents, Turns, transcript history, Desktop reconnect, explicit interruption/failure semantics, and concurrent work for independent canonical workspaces.

What is missing is **product operability**.

A normal user still has to understand details such as:

- repository directories;
- `npm start`;
- environment variables;
- ports;
- Pi executable paths;
- service/process lifetime;
- low-level failures such as `spawn ... ENOENT`.

That means the architecture is useful, but the product is still a half-finished development surface.

The v0.1 goal is **not more agent intelligence**. Pi already owns intelligence. The goal is to make the existing Pi-native architecture feel like one coherent local desktop product.

### v0.1 core promise

> On a normal Linux laptop, the user can open pi-sand without keeping a terminal alive, open a persistent Agent, give it a natural-language task, switch away or close the Desktop, and later return to an accurate status and durable result. Independent Agents in independent workspaces may work concurrently, and common setup/runtime failures are presented as actionable product states rather than process-level accidents.

The normal journey should feel like:

```text
open pi-sand
    ↓
choose Agent
    ↓
send task
    ↓
Pi works in background
    ↓
switch Agent / close UI / leave
    ↓
notification or later reopen
    ↓
correct durable result
```

---

## 2. Stable Architecture and Ownership

v0.1 keeps the architecture intentionally small:

```text
Desktop Client
      ↓
Local Agent Service
   ├── SQLite
   ├── local product configuration
   └── Pi process(es)
          ↓
      Workspace(s)
```

The following principles remain authoritative:

1. **Agent identity outlives Pi process/session identity.**
2. **Agent ≠ Turn.**
3. **Agent ≠ Desktop window/tab.**
4. **Transcript ≠ Pi model context.**
5. **Desktop lifetime ≠ Local Agent Service lifetime.**
6. **Pi owns reasoning, planning, retries inside its autonomous loop, tool selection, skills, and model context.**
7. **pi-sand owns durable Agent identity, durable Turn state, transcript, workspace association, routing, presentation, and Pi process ownership.**
8. **Persistent identity does not require infinite model context.**
9. **Desktop-observable behavior is compatibility authority; internal contracts support it, not define it.**
10. **Compatibility evidence may create a behavioral test, but must not by itself create an internal component.**

`pi-sand` must not introduce a second planner, workflow engine, scheduler, or generic agent-runtime platform around Pi.

---

## 3. Product Shape

v0.1 is **Linux-first, local-first, and single-user**.

The Desktop Client may remain a browser-served local UI. Native Electron/Tauri packaging is not required for v0.1.

The product requirement is instead that opening and using pi-sand no longer requires keeping a development terminal attached to the Local Agent Service.

The Local Agent Service is a long-lived per-user process. On Linux, `systemd --user` is the reference service-manager path.

The service remains loopback-only by default. Remote access is a later concern.

---

## 4. User Stories

### Setup and launch

1. As a user, I want to install/start pi-sand without root so that it fits a normal Linux workstation.
2. As a user, I want the Local Agent Service to run independently of my terminal so that closing a shell does not stop active work.
3. As a user, I want pi-sand to remember its normal local configuration so that I do not have to export `PI_BIN`, `PI_SAND_DB`, or `PORT` every time.
4. As a user, I want opening pi-sand to connect to or start the local service so that process supervision is not part of normal use.
5. As a user, I want a clear setup state when Pi is unavailable or incompatible so that I know what to fix.

### Agents and workspaces

6. As a user, I want to create an Agent with `~`, relative, normalized, absolute, or symlinked workspace paths and have pi-sand store one canonical real directory.
7. As a user, I want invalid, missing, or non-directory workspaces rejected before a Turn starts.
8. As a user, I want the Agent list to show which Agents are currently working so that background work is visible without opening every conversation.
9. As a user, I want Agents in different canonical workspaces to run concurrently.
10. As a user, I want one Agent and one canonical workspace to have at most one running Turn so that overlapping mutation stays safe.
11. As a user, I want switching Agents to have no effect on their active Pi work.

### Turn experience

12. As a user, I want to submit an ordinary natural-language request without selecting a workflow or skill.
13. As a user, I want a running Turn to show meaningful progress rather than only a frozen transcript.
14. As a user, I want progress presentation to come from Pi's observable events rather than invented reasoning or a second orchestration layer.
15. As a user, I want to interrupt the active Turn for one Agent without affecting other Agents.
16. As a user, I want completion, failure, and interruption to remain durable and understandable after reopening the UI.

### Background work

17. As a user, I want closing the Desktop Client to leave active work running under the Local Agent Service.
18. As a user, I want reopening to recover authoritative state without duplicate or reordered transcript content.
19. As a user, I want a local notification when unattended work reaches a useful terminal state so that I do not have to poll the UI.
20. As a user, I want notification failure to never change the Turn result.

### Failures

21. As a user, I want missing Pi, unsupported Pi, invalid workspace, workspace contention, prompt rejection, and unexpected Pi exit to produce distinct actionable product errors.
22. As a user, I want a service restart to restore durable state and explicitly classify every previously running Turn without replay or adoption.
23. As a user, I want one Agent's failure to leave other independent running Agents untouched.

---

## 5. Product Requirements

### 5.1 Background Local Agent Service

Normal use must not depend on an attached `npm start` terminal.

The reference Linux integration is a per-user systemd service:

- no root requirement;
- runs with the user's permissions;
- may start automatically for the user or on demand through a small launcher/install path;
- closing the Desktop Client or terminal does not stop the service;
- stopping/restarting the service is explicit;
- only one Local Agent Service instance may own a given pi-sand SQLite database at a time.

The exact unit-file layout is an implementation detail. The user-visible invariant is that pi-sand behaves like a persistent desktop service, not a terminal child process.

### 5.2 Product configuration

Normal operation must not require repeated shell environment setup.

pi-sand should persist user-level configuration under normal XDG locations.

At minimum, the product needs durable configuration for values that cannot be discovered reliably, such as an explicitly selected Pi executable path when necessary.

Environment variables such as `PI_BIN`, `PI_SAND_DB`, and `PORT` may remain development/override mechanisms, but they are not the primary v0.1 UX.

### 5.3 Pi health and preflight

The Local Agent Service must remain usable enough to show product state even when Pi is unavailable.

Before starting work, pi-sand must validate the concrete Pi integration requirements it depends on:

- the Pi executable can be resolved and executed;
- the Pi version supports the required RPC lifecycle contract;
- the selected Agent workspace still exists and is a directory.

The current compatibility baseline is Pi 0.84.2 or newer unless later contract research demonstrates a different minimum.

Pi authentication, model, and provider configuration remain Pi's responsibility. pi-sand should surface failures from that configuration clearly, but must not build a duplicate provider/model configuration platform.

The normal UI must not expose raw `spawn ... ENOENT` as the primary explanation when pi-sand can identify a more useful cause.

### 5.4 Workspace trust and canonicalization

Agent creation is an explicit trust decision: the user selects a local directory in which Pi may use its normal tools, extensions, skills, shell commands, and filesystem access under the user's OS privileges.

pi-sand does not provide a sandbox in v0.1.

Workspace identity is the canonical real filesystem path. Creation must:

1. expand supported home notation such as `~` and `~/...`;
2. resolve relative and normalized paths;
3. follow filesystem aliases with realpath semantics;
4. verify the result exists and is a directory;
5. persist the canonical path.

Equivalent paths must collide for workspace exclusion.

### 5.5 Agent overview

The Desktop must provide an Agent overview useful for background work.

For each Agent, the user should be able to see at least:

- Agent name;
- workspace identity in a human-readable form;
- whether a Turn is currently running;
- the most recent terminal Turn outcome when useful;
- enough recency information to distinguish current from stale work.

Agent state must not incorrectly treat `completed`, `failed`, or `interrupted` as the long-lived Agent's identity. Those remain Turn outcomes.

### 5.6 Conversation and Turn controls

Opening an Agent shows its durable transcript and authoritative current Turn state.

While a Turn is running:

- the UI shows that Pi is working;
- sending another Turn to the same Agent is rejected or disabled clearly;
- interruption is available;
- switching to another Agent does not affect it.

Terminal Turn details remain durable so a reopened Desktop can explain failure or interruption without depending on transient logs.

### 5.7 Activity visibility

v0.1 adds **minimal useful activity presentation**, not an exhaustive execution debugger.

The Desktop should present coarse current/recent activity derived from stable observable Pi events, such as tool execution or another user-visible work phase when the concrete Pi RPC contract exposes it reliably.

Rules:

- do not expose private chain-of-thought or reasoning;
- do not invent a plan that Pi did not emit;
- do not dump raw RPC JSON into the normal UI;
- do not require every activity event to become part of the durable transcript;
- transcript messages remain distinct from activity/progress records;
- if an event is not stable enough to present reliably, omit it rather than create speculative product semantics.

A simple `Pi is working…` fallback remains valid when richer stable activity is unavailable.

### 5.8 Local notifications

When a Turn reaches a terminal outcome while the user is not actively observing that Agent, pi-sand should emit a best-effort local desktop notification.

At minimum, notifications should distinguish:

- completed;
- failed;
- interrupted when the interruption was not initiated from the currently visible UI.

Notification delivery is presentation only. Failure to notify must never mutate a Turn, retry work, or change transcript state.

The notification mechanism should be replaceable/fakeable in deterministic tests rather than coupled directly to orchestration logic.

### 5.9 Service restart and crash semantics

v0.1 preserves the conservative reliability rule already proven by the foundation.

If Pi exits unexpectedly before settlement:

```text
running → failed
```

If the Local Agent Service restarts with persisted `running` Turns:

- every such Turn becomes explicitly terminal according to the established product rule;
- the old request is not replayed;
- the old Pi process is not adopted;
- automatic recovery/resume is not attempted.

One Turn's terminal handling must remain scoped to that Turn and must not close or mutate another Agent's Pi execution.

### 5.10 Host sleep

v0.1 guarantees background execution only while the Linux user session/machine is actually running.

System suspend pauses local execution and may disrupt network/model calls. Automatic sleep inhibition is not required for v0.1.

If the product later adds sleep inhibition, it must be explicit and battery-conscious rather than silently changing host power policy.

### 5.11 Security boundary

v0.1 remains local and single-user:

- Local Agent Service binds to loopback by default;
- no public remote API is required;
- no root privileges are required;
- Pi, tools, and extensions run with the current user's privileges;
- workspace selection is the primary product trust grant;
- pi-sand does not claim sandbox isolation.

---

## 6. Persistence and Process Ownership

SQLite remains the canonical local product store.

It stores durable product state such as:

- Agents;
- canonical workspace association;
- Turns and terminal detail;
- transcript messages;
- user-visible metadata required for restore.

The product does not need to persist Pi private reasoning, exact model context, every tool event, or a replayable execution journal.

A database belongs to one Local Agent Service owner at a time. Multi-process shared-database execution is outside the v0.1 runtime model.

---

## 7. Testing Decisions

The existing hierarchy remains:

1. a small number of Desktop E2E product tests;
2. substantial Local Agent Service integration tests with deterministic Pi/notifier fakes;
3. targeted unit tests for rule-heavy logic;
4. a very small real-Pi smoke suite.

### Required v0.1 behavioral coverage

Deterministic coverage should prove at least:

1. **Product opens while Pi is unavailable** and shows an actionable unavailable/setup state rather than crashing the Local Agent Service.
2. **Workspace validation/canonicalization** handles `~`, relative paths, normalized aliases, and symlinks and rejects missing/non-directory paths.
3. **Two independent Agents remain running concurrently** in different canonical workspaces.
4. **Same-Agent and same-canonical-workspace overlap is rejected.**
5. **Completing, failing, or interrupting A leaves B running.**
6. **Desktop switching/disconnect/reconnect remains independent per Agent.**
7. **Background terminal outcome can trigger a notifier** without notification failure affecting Turn state.
8. **Service restart explicitly terminalizes all persisted running Turns without replay/adoption.**
9. **Agent overview reflects active/idle and recent terminal outcomes from authoritative service state.**
10. **No normal failure path requires raw Pi RPC/process errors to be interpreted by the user when a product-level explanation is available.**

The real-Pi smoke suite continues to prove the concrete production adapter against an externally verifiable workspace outcome.

A Linux service-manager smoke test should prove that the Local Agent Service can run independently of the invoking terminal and continue an active Turn after the Desktop connection closes.

---

## 8. Explicitly Out of Scope for v0.1

v0.1 does **not** add:

- a scheduler;
- a task queue;
- priorities;
- a worker pool;
- multiple simultaneous Turns inside one Agent;
- concurrent mutation of one canonical workspace;
- automatic Git worktree creation or management;
- a generic runtime/provider abstraction;
- a second planning/orchestration loop around Pi;
- automatic replay/recovery of interrupted work;
- worker adoption after service restart;
- execution checkpoint/replay semantics;
- custom model-context management;
- custom memory framework;
- remote/Telegram/mobile frontend;
- public/versioned remote protocol;
- distributed or multi-machine workers;
- multi-user SaaS;
- macOS/Windows support;
- Docker/VM sandbox as a product requirement;
- native Electron/Tauri packaging as a requirement;
- automatic host sleep inhibition;
- exhaustive tool/debug UI;
- pixel-perfect Grok parity.

These may be considered only after v0.1 becomes a useful local daily-driver and real dogfooding identifies a concrete need.

---

## 9. v0.1 Definition of Done

v0.1 is complete when a normal Linux user can perform this journey without operating pi-sand as a development process:

```text
start/open pi-sand
      ↓
Local Agent Service is available without an attached terminal
      ↓
Pi readiness is clear
      ↓
create/open Agent with a valid local workspace
      ↓
send a normal natural-language task
      ↓
see useful working/activity state
      ↓
switch to another Agent or close the Desktop
      ↓
background work continues
      ↓
receive a local terminal notification when appropriate
      ↓
reopen later
      ↓
see the correct durable transcript and terminal/running state
```

Additionally:

- configuration required for normal use survives restart;
- no repeated `PI_BIN=... npm start` ceremony is required;
- two Agents in different workspaces can work concurrently;
- shared-workspace overlap remains blocked;
- interrupt/failure/reconnect remain per-Agent/per-Turn isolated;
- common Pi/workspace setup failures are actionable product states;
- service restart never silently replays or adopts unfinished work;
- Pi remains the sole reasoning/tool/skill/autonomous-work engine;
- deterministic tests and real-Pi smoke coverage pass.

The release is dogfood-ready when the user can use pi-sand for real project work for days without routinely opening a terminal to supervise the product itself.

Only then should the repository create the first public/tagged release:

```text
v0.1.0
```

Until then, package metadata should use a development prerelease such as `0.1.0-dev`.

---

## 10. Recommended Implementation Progression

### Slice 1 — Product bootstrap and background service

Make Local Agent Service operation independent of an attached terminal. Add user-level configuration and the smallest launch/install/status path needed on Linux.

Prove:

- service starts/connects predictably;
- service keeps running after launcher/Desktop exits;
- only one service owns one DB;
- normal use does not require repeated environment-variable setup.

### Slice 2 — Pi/workspace health and actionable errors

Add concrete Pi executable/version readiness and product-level workspace/setup errors.

Prove common launch failures no longer appear primarily as ambiguous `ENOENT` or process errors.

### Slice 3 — Agent overview for parallel background work

Make the Agent list a useful control surface:

- active state;
- recent outcome;
- workspace identity;
- switching without affecting work.

### Slice 4 — Minimal activity and notifications

Expose only stable Pi-derived progress worth showing and add best-effort local terminal notifications.

Do not turn this into an execution debugger or event-sourcing project.

### Slice 5 — Real dogfood gate

Only after the above slices are integrated should sustained dogfooding become a release gate.

The target behavior is:

> Give Agent A work, give Agent B work, close the UI, leave the laptop running, and later return to two trustworthy independent results without caring about pi-sand process management.

---

## 11. Questions Deliberately Left Open

These questions should be answered by implementation evidence rather than speculative architecture:

- Which exact Pi RPC activity events are stable and useful enough for normal UI presentation?
- Should local notification happen for every completion or only when the Agent/Desktop is not currently visible?
- Should the Linux launcher start the service on demand, rely on login autostart, or support both?
- What is the smallest persistent config format/location that follows XDG conventions without creating a configuration subsystem?
- After real v0.1 failure data exists, is any automatic in-flight recovery actually worth adding in a later release?

None of these questions justify adding a scheduler, worker system, workflow engine, or custom agent intelligence to v0.1.
