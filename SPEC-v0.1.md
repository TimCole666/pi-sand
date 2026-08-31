# pi-sand v0.1 — Pi-native Grok Bot 0.18 Compatibility Specification

Status: **Normative v0.1 product specification**

This document is the sole normative authority for the retained v0.1.0 product boundary. [`REFERENCE.md`](REFERENCE.md) is the companion non-normative evidence ledger; [`SPEC.md`](SPEC.md) is historical and superseded. It does not define the current v0.2 host: that contract is GitHub issue [#22](https://github.com/TimCole666/pi-sand/issues/22), which makes Pi 0.84.4 with the pi-sand Extension the current product path.

## Problem Statement

`pi-sand` v0.1 exists to give a Linux user a durable local Agent conversation: choose an Agent and workspace, ask for work in ordinary language, see the Agent work, switch elsewhere or close the Desktop, and return to the same durable product state without managing Pi processes, sessions, ports, databases, or service lifetime.

The compatibility target is the evidence-backed core user-visible Grok Bot 0.18 Agent conversation experience. Grok Bot defines reference product behavior where evidence is strong; Pi remains the reasoning and execution runtime.

The current `main` branch is an implementation starting point, not the definition of the product problem. It already proves important persistence, lifecycle, reconnect, workspace-safety, and multi-Agent concurrency foundations, but v0.1 succeeds only when those foundations are presented and operated as a coherent desktop Agent product.

The target is not a generic local agent shell, workflow runner, scheduler, or developer wrapper around Pi.

The product promise is:

> **Open pi-sand, choose a durable Agent, ask for work, see it working, leave, and come back to the same Agent with the correct conversation and result.**

## Solution

Build the smallest Linux-first pi-sand product that reproduces the evidence-backed core Grok Bot 0.18 conversation experience while preserving the existing Pi-native ownership model.

The product shape remains intentionally small:

```text
Desktop Client
      ↓
Local Agent Service
   ├── SQLite
   └── Pi process(es)
        ↓
    Workspace(s)
```

Product launch must establish access to the Local Agent Service without requiring terminal or port management. Normal Desktop-window closure must not stop the Local Agent Service or cancel active work. Packaging and service-management technology remain implementation choices.

Pi owns reasoning, planning, tool selection, skills, model context, retries inside its autonomous loop, and the autonomous inner work loop.

pi-sand owns durable Agent identity, durable Turn/product state, transcript, workspace association, routing, presentation, reconnect, and Pi process ownership.

The reconstructed Grok Bot repository is a behavioral/evidence oracle. Its internal component topology is not an architecture template and its reconstructed source is not code to copy.

## Requirement provenance

`REFERENCE.md` is the **non-normative evidence ledger**. `SPEC-v0.1.md` is the **normative source for v0.1 scope**.

A Grok-derived behavior may be a strict v0.1 compatibility requirement only when the reference evidence is **Observed** or sufficiently strong **Evidence-backed** evidence. **Inferred** and **Unknown** behavior never gates v0.1. Intentional pi-sand behavior is identified here as an **Extension**.

Evidence can justify a behavioral requirement or test. Evidence alone must not create an internal component.

## User Stories

### A. Evidence-backed Grok product behavior — Required

1. As a user, I want a persistent two-pane desktop shell with an Agent/chat roster and a selected conversation workspace so that pi-sand feels like a coherent Agent product rather than a developer page.
2. As a user, I want the roster to provide New-chat creation, saved Agent rows, a useful empty state, loading/connecting state, reconnect feedback, an unreachable/error state, and Retry.
3. As a user, I want each Agent row to show a stable identity marker and name plus deterministic recent context: a nonempty draft preview first, otherwise the latest durable user/assistant preview when available.
4. As a user, I want selecting an Agent to open that Agent's conversation without changing that Agent's execution ownership.
5. As a user, I want the last selected Agent to be restored after reopening when that Agent still exists, with a sensible fallback when it does not.
6. As a user, I want the selected conversation header to show the Agent identity and a visible `Working` state while that Agent is active.
7. As a user, I want user and assistant messages to appear as a readable conversation rather than a process log.
8. As a user, I want visible assistant output to stream into the conversation when Pi emits usable streaming output.
9. As a user, I want a bottom conversation composer with ordinary natural-language input and an explicit send action without choosing a workflow or skill.
10. As a user, I want an unsent draft to be preserved independently per Agent while I switch between Agents.
11. As a user, I want an unsent per-Agent draft to survive Desktop close/reopen and be reconciled with the restored Agent roster.
12. As a user, I want to attach files through a picker, drag/drop, or pasted-file input where the supported Desktop platform permits it.
13. As a user, I want selected attachments to appear in the composer with removal controls and understandable failure/limit feedback.
14. As a user, I want a running Agent to have a clear visible `Working` state.
15. As a user, I want the shell to preserve my saved Agents during transient connectivity failure and communicate reconnect/error state without implying that durable Agents disappeared.

### B. pi-sand Extensions — Required

16. As a user, I want launching pi-sand to establish the local product service without requiring me to start a server, choose a port, or keep a terminal open.
17. As a user, I want closing the Desktop window or process to leave the Local Agent Service and active Pi work running.
18. As a user, I want reopening pi-sand to reconnect to authoritative Agent, Turn, transcript, workspace, and execution state without replaying work or duplicating/reordering transcript content.
19. As a user, I want the composer to make starting another Turn unavailable while the selected Agent already has a running Turn rather than letting me submit an operation the service will reject.
20. As a user, I want to stop the selected Agent's active Turn without affecting another independent running Agent.
21. As a user, I want completed, failed, and interrupted Turn outcomes to remain durable and understandable after reopen.
22. As a user, I want two Agents in different canonical workspaces to be able to work concurrently.
23. As a user, I want the product to reject overlapping work when the same Agent already has a running Turn or when another Agent is already running in the same canonical workspace.
24. As a user, I want workspace inputs using absolute paths or `~` / `~/...` home notation to resolve to one canonical real filesystem identity, including symlink/realpath aliases.
25. As a user, I want unsupported relative paths, missing paths, and non-directory paths rejected before work starts.
26. As a user, I want common failures to appear as product-level states rather than raw process/RPC/database accidents.
27. As a user, I want service restart to produce one explicit durable `interrupted` outcome for every previously persisted running Turn, without replaying it, adopting an old worker, or pretending it is still running.
28. As a user, I want ordinary follow-up requests within an Agent to use Pi-native conversational context while pi-sand keeps durable transcript state separate from Pi model context.
29. As a user, I want a sent attachment to remain associated with the durable user message after reopen and to be available to Pi for the submitted request.
30. As a user, I want a persisted unsent draft that references staged attachments to remain sendable after Desktop close/reopen without silently restoring dead file references.

### C. Conditional or deferred behavior — Not v0.1 release gates unless promoted by later evidence

- **Needs-attention / awaiting-user-response semantics:** the visual concept is evidence-backed, but v0.1 does not require a waiting-for-user interaction contract unless a stable Pi request-for-user-input seam is proven and specified.
- **Unread activity transitions:** the presentation concept is evidence-backed, but exact unread transition semantics are not a v0.1 gate.
- **Richer Pi-derived activity:** `Working` is required; tool/activity detail is deferred until a concrete stable Pi-event → product-state mapping is specified.
- **Reply-to-message context:** evidence supports reply UI, but reply behavior is deferred unless separately promoted after the Pi conversational-context contract is proven sufficient.
- **Voice input/dictation:** evidence-backed but deferred.
- **Complete rich mention/provider behavior:** deferred.
- **Exact animations, glyph transitions, and micro-interactions:** deferred.

## Implementation Decisions

### Stable ownership invariants

The following remain authoritative:

- Agent ≠ Pi process/session.
- Agent ≠ Turn.
- Agent ≠ Desktop window/tab.
- Transcript ≠ Pi model context.
- Desktop lifetime ≠ Local Agent Service lifetime.
- Persistent identity does not require infinite model context.
- Pi is the brain/worker; pi-sand is the persistent product shell and control boundary.

pi-sand must not add a second planner, workflow engine, scheduler, queue, worker pool, or generic runtime platform around Pi.

### Domain mapping

The Grok-style `New chat` affordance creates a new durable pi-sand **Agent**. v0.1 does not introduce a separate durable Chat domain object.

A Turn remains one submitted unit of work inside an Agent conversation.

### Product state ownership

The Local Agent Service is authoritative for durable Agent identity, Turns, transcript, workspace association, attachment commit metadata, and execution state.

Desktop-owned presentation state such as selected Agent and unsent per-Agent drafts is persisted on the Desktop and reconciled against authoritative service state after reconnect.

For unsent attachments, the Desktop owns the draft reference while the Local Agent Service owns the staged bytes. A draft reference must remain valid for as long as that attachment remains part of the persisted draft.

The product must not move client-only state into the service merely for convenience unless a concrete cross-Desktop requirement appears later.

### Local Agent Service bootstrap and lifetime

Normal product use must not depend on `npm start`, an attached shell, or a user-selected port.

Launching the product must establish or start the Local Agent Service. Failure to do so becomes the same connecting/retry/error product experience used for other local connectivity failures.

Normal Desktop-window/process closure must not stop the Local Agent Service or active Pi work.

The implementation may use a native launcher, per-user service manager, or another Linux-appropriate mechanism. v0.1 specifies behavior, not the service-manager technology.

Only one Local Agent Service process may own a given pi-sand SQLite database at a time.

### Local control-plane access boundary

The Local Agent Service is a privileged local control plane: it can create Agents, stage files, start Pi, submit prompts, and interrupt work under the user's normal OS privileges.

Its mutation/control surface must not be exposed on non-local network interfaces.

If browser-reachable HTTP or another browser-accessible transport is used, an arbitrary webpage or browser origin must not be able to create Agents, submit prompts, interrupt Turns, or stage/commit attachments merely because it can reach the local endpoint.

The concrete transport, origin-checking, local capability, authentication, or equivalent protection mechanism is an implementation choice. The user-visible/security invariant is local single-user control, not LAN or arbitrary-origin control.

### Conversation and Pi context

Ordinary follow-up requests within one Agent must use Pi-native conversational context/session behavior sufficient to preserve normal conversational continuity.

pi-sand must not manufacture model context by replaying, summarizing, or independently managing the durable transcript as a second context system.

Pi process/session identity remains replaceable and never becomes Agent identity.

If the concrete Pi integration cannot provide safe cross-Turn continuity without violating these ownership rules, that is a release-blocking product gap to resolve at the Pi integration boundary rather than by adding a pi-sand memory/orchestration layer.

### Attachment ownership, durability, and draft lifetime

Attachment bytes must be staged into Local Agent Service-owned local storage before send.

A successful send commits stable attachment metadata with the durable user message and gives Pi a stable local representation it can access for that request.

After send/reopen, the transcript must still identify the attachment as part of the durable user message even if the Desktop process that originally selected the file is gone.

For an unsent persisted draft, staged bytes referenced by that draft must remain valid until one of these events occurs:

- the attachment is removed from the draft;
- the draft is successfully sent and the attachment is committed;
- the draft is explicitly cleared/replaced so the reference is no longer live.

Bounded garbage collection applies only to orphaned/unreferenced staging data. v0.1 must not silently restore a persisted draft whose live attachment references were garbage-collected.

Exact on-disk layout and orphan-cleanup timing are implementation details.

### Workspace semantics and trust

Workspace association defines Pi's canonical working directory and an explicit user-intent trust context.

The supported v0.1 text-path contract accepts:

- absolute filesystem paths;
- `~` and `~/...` home notation.

Other relative paths are rejected in v0.1 rather than being resolved against an arbitrary process working directory.

Accepted input is normalized, resolved through realpath/symlink aliases, verified as an existing directory, and persisted as the canonical real path.

v0.1 does **not** claim OS-level filesystem confinement to that workspace. Pi, its tools, extensions, and shell commands execute with the user's normal OS privileges unless Pi itself provides a stronger boundary.

### Concurrency and isolation

The runtime invariant is:

```text
one Agent <= one running Turn
one canonical workspace <= one running Turn
independent Agents + independent workspaces => may run concurrently
```

Completing, failing, or interrupting one Turn must not mutate or terminate another independent running Turn.

No scheduler, queue, priorities, or same-workspace concurrent mutation is added.

### Turn lifecycle, Stop, and restart policy

Pi prompt acceptance is not equivalent to successful completion. pi-sand continues to follow the concrete Pi lifecycle through settlement.

For a normal user Stop:

1. pi-sand requests cancellation/interruption from the owning Pi execution;
2. already-durable partial transcript content remains durable;
3. successful Pi settlement after that Stop request produces the durable Turn outcome `interrupted`;
4. Pi failure or process exit before successful settlement produces `failed`, not `interrupted`.

Unexpected Pi exit before settlement therefore produces an explicit failed Turn.

If the Local Agent Service starts and finds persisted `running` Turns from a previous service lifetime:

- each such Turn is terminalized exactly once as `interrupted` with a restart/not-resumed explanation;
- the request is not replayed;
- the previous worker is not adopted;
- automatic recovery/resume is not attempted.

A prior-service Pi worker must not remain able to mutate its workspace after that workspace is made available for new work. The service/worker lifetime design must therefore ensure that prior-service workers are terminated or otherwise proven unable to execute before the corresponding Agent/workspace lock is released. If that cannot be established safely, the Agent/workspace remains unavailable for new work rather than risking concurrent mutation.

This liveness/cleanup requirement is not worker adoption: pi-sand does not resume or continue the prior Turn.

### Product-level failure set

v0.1 must provide understandable product states for this finite set:

- Local Agent Service unavailable / reconnecting;
- invalid or unavailable workspace;
- workspace or Agent already active;
- Pi executable unavailable or incompatible with the required lifecycle contract;
- prompt rejection;
- Pi-reported terminal failure;
- unexpected Pi exit;
- restart-interrupted work;
- local control-plane access/bootstrap failure when the product cannot establish a safe local connection.

Raw implementation details may be available for diagnostics, but they are not the primary user explanation when pi-sand can identify one of these causes.

### Version semantics

The existing `0.1.0` package/README labeling on `main` is provisional foundation metadata. Before the dogfood-ready product release is tagged, repository metadata and README language must be reconciled so `v0.1.0` unambiguously names this release boundary.

## Testing Decisions

v0.1 keeps three durable testing seams, plus targeted pure unit tests where useful.

### 1. Actual Desktop E2E — compatibility authority

This seam renders and drives the actual supported Desktop client/runtime, crosses the real Local Agent Service boundary, and uses deterministic Pi behavior.

Keep it small and product-journey oriented. The required journeys are:

1. **Core conversation:** cold/open product → create/select Agent → draft → switch → return → send → visible streaming/`Working`.
2. **Parallel isolation:** Agent A runs while the user switches to Agent B and optionally starts independent B work; roster/header state remains isolated and correct.
3. **Cold bootstrap + background lifetime:** begin with no Local Agent Service running → launch the actual product and prove it establishes the service → start deterministic work → close the actual Desktop window/process without stopping the service/work → relaunch → reconcile selection/draft and restore authoritative transcript/Turn state without duplication/reordering, including reconnect/error/Retry shell behavior.
4. **Stop:** start active work through the actual Desktop → invoke the actual Stop control → observe the selected Turn become `interrupted` while independent Agent work remains unaffected.
5. **Attachment journey:** stage through supported Desktop inputs → preserve draft attachment across Desktop close/reopen → send → reopen → durable user-message attachment remains present.
6. **Representative classified failure:** one execution failure reaches the actual Desktop as a product-level state without requiring the user to interpret raw RPC/process errors.

A test that exercises HTTP/SSE without rendering/driving the actual supported Desktop client is **not** Desktop E2E.

### 2. Local Agent Service integration

This seam drives the public semantic Local Agent Service boundary with deterministic Pi behavior.

It carries:

- prompt acceptance/rejection and settlement permutations;
- explicit Stop semantics (`interrupted` only after successful post-Stop settlement; failure/exit before settlement → `failed`);
- unexpected Pi exit;
- persistence and startup reconciliation;
- restart terminalization plus prior-worker/workspace safety;
- canonical workspace handling and unsupported-relative-path rejection;
- same-Agent/same-workspace exclusion;
- independent multi-Agent concurrency and lifecycle isolation;
- single-database-owner acquisition/competing startup behavior;
- attachment staging, persisted-draft reference lifetime, commit, and orphan cleanup semantics;
- local control-plane protection against non-local/arbitrary-origin mutation;
- finite product-level failure classification.

HTTP/SSE-only transport tests may live here when they prove transport behavior, but they should not duplicate Desktop compatibility journeys.

### 3. Real-Pi smoke

Keep this layer very small, but it must prove the release-critical production Pi adapter contracts that deterministic fakes cannot prove.

Required production smoke cases:

1. **Basic execution:** a normal request produces an externally verifiable workspace outcome.
2. **Two-Turn conversational continuity:** Turn 1 establishes information only through Pi-native conversational context; Turn 2 must use that context to produce an externally verifiable outcome without pi-sand replaying/summarizing the durable transcript into model context.
3. **Attachment consumption:** a sent attachment is actually readable/usable by the production Pi integration and affects an externally verifiable workspace outcome.

These tests prove the concrete Pi integration boundary. They do not duplicate the deterministic lifecycle matrix.

### Unit tests

Targeted pure unit tests are appropriate for rule-heavy logic such as canonicalization, origin/access checks, or small state projections. They are not another architectural compatibility seam.

Hand-written fake DOM/EventSource harnesses should not become a separate long-lived compatibility layer when the same behavior can be exercised through the actual Desktop or Local Agent Service integration boundary.

## Out of Scope for v0.1

v0.1 does not require:

- scheduler, task queue, priorities, or worker pool;
- multiple simultaneous Turns inside one Agent;
- concurrent mutation of one canonical workspace;
- automatic Git worktree creation or management;
- a generic runtime/provider abstraction;
- a second planning/orchestration loop around Pi;
- automatic replay/recovery of interrupted work;
- worker adoption after service restart;
- execution checkpoint/replay semantics;
- custom model-context management or custom memory framework;
- remote, Telegram, or mobile frontend;
- public/versioned remote protocol;
- LAN-accessible or multi-user control plane;
- distributed or multi-machine workers;
- multi-user SaaS;
- full parity with reference-internal component topology/boundaries;
- full Agent settings/details parity;
- Computer/screen surface beyond what later evidence may promote;
- hidden-chat management;
- shared rooms, groups, org-chart, or collaboration parity;
- automations;
- complete plugin/MCP presentation parity;
- reactions;
- voice input/dictation;
- full onboarding/account/team/cloud-access flows;
- remote-box semantics;
- deep links or feedback/reporting UI;
- exact keyboard-shortcut/command-palette coverage;
- exact animation timing or pixel-perfect parity;
- OS-level sandbox confinement;
- automatic host sleep inhibition.

## Definition of Done

v0.1 is ready for release when a normal Linux user can perform this journey without operating pi-sand as a development process:

```text
launch pi-sand with no service pre-started
      ↓
local product service becomes available without terminal/port management
      ↓
select/create a persistent Agent bound to a valid canonical workspace
      ↓
type an ordinary request, optionally with an attachment
      ↓
send
      ↓
Agent visibly works and streams usable output
      ↓
switch to another Agent without stopping the first
      ↓
close the actual Desktop while work is active
      ↓
reopen later
      ↓
selection/draft presentation state reconciles
      ↓
authoritative Agent/Turn/transcript/result state is correct and unduplicated
```

The release also requires the production Pi smoke proofs for cross-Turn conversational continuity and attachment consumption.

All stable ownership, concurrency, lifecycle, control-plane access, failure, restart-worker, and workspace-trust statements in this spec must hold throughout that journey.

## Further Notes

Known reference gaps are tracked in `REFERENCE.md`. Unknown behavior does not become a parity requirement by intuition.

The core architectural rule remains:

> **Desktop-observable behavior is compatibility authority; internal contracts support it, not define it.**