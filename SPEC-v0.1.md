# pi-sand v0.1 — Pi-native Grok Bot 0.18 Compatibility Specification

Status: **Draft for second independent review**

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
3. As a user, I want each Agent row to show a stable identity marker and name plus useful recent context when available, such as a draft or recent message preview.
4. As a user, I want selecting an Agent to open that Agent's conversation without affecting whether another Agent is working.
5. As a user, I want the last selected Agent to be restored after reopening when that Agent still exists, with a sensible fallback when it does not.
6. As a user, I want the selected conversation header to show the Agent identity and a visible Working state while that Agent is active.
7. As a user, I want user and assistant messages to appear as a readable conversation rather than a process log.
8. As a user, I want visible assistant output to stream into the conversation when Pi emits usable streaming output.
9. As a user, I want transcript ordering and message identity to remain stable across reconnect so content is not duplicated or reordered.
10. As a user, I want a bottom conversation composer with ordinary natural-language input and an explicit send action without choosing a workflow or skill.
11. As a user, I want an unsent draft to be preserved independently per Agent while I switch between Agents.
12. As a user, I want an unsent per-Agent draft to survive Desktop close/reopen and be reconciled with the restored Agent roster.
13. As a user, I want the composer to make starting another Turn unavailable while the selected Agent already has a running Turn rather than letting me submit an operation the service will reject.
14. As a user, I want to attach files through a picker, drag/drop, or pasted file input where the Desktop platform supports it.
15. As a user, I want selected attachments to appear in the composer with removal controls and understandable failure/limit feedback.
16. As a user, I want a sent attachment to remain associated with the durable user message after reopen and to be available to Pi for the submitted request.
17. As a user, I want a running Agent to look visibly alive through a clear working state and stable Pi-derived activity when such activity has a reliable product meaning.
18. As a user, I want the shell to preserve my Agents during transient connectivity failure and communicate reconnect/error state without implying that durable Agents disappeared.

### B. pi-sand Extensions — Required

19. As a user, I want launching pi-sand to establish the local product service without requiring me to start a server, choose a port, or keep a terminal open.
20. As a user, I want closing the Desktop window to leave the Local Agent Service and active Pi work running.
21. As a user, I want reopening pi-sand to reconnect to authoritative Agent, Turn, transcript, workspace, and execution state without replaying work or duplicating transcript content.
22. As a user, I want to stop the selected Agent's active Turn without affecting another independent running Agent.
23. As a user, I want completed, failed, and interrupted Turn outcomes to remain durable and understandable after reopen.
24. As a user, I want two Agents in different canonical workspaces to be able to work concurrently.
25. As a user, I want the product to reject overlapping work when the same Agent already has a running Turn or when another Agent is already running in the same canonical workspace.
26. As a user, I want equivalent workspace paths such as `~`, normalized absolute paths, and symlink/realpath aliases to resolve to one canonical workspace identity.
27. As a user, I want invalid, missing, or non-directory workspaces rejected before work starts.
28. As a user, I want common failures to appear as product-level states rather than raw process/RPC/database accidents.
29. As a user, I want service restart to classify every previously persisted running Turn explicitly instead of replaying it, adopting an old worker, or pretending it is still running.
30. As a user, I want ordinary follow-up requests within an Agent to use Pi-native conversational context while pi-sand keeps durable transcript state separate from Pi model context.

### C. Conditional or deferred behavior — Not v0.1 release gates unless promoted by later evidence

- **Needs-attention / awaiting-user-response semantics:** the visual concept is evidence-backed, but v0.1 does not require a waiting-for-user interaction contract unless a stable Pi request-for-user-input seam is proven and specified.
- **Unread activity transitions:** the presentation concept is evidence-backed, but exact unread transition semantics are not a v0.1 gate.
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

### Product state ownership

The Local Agent Service is authoritative for durable Agent identity, Turns, transcript, workspace association, and execution state.

Desktop-owned presentation state such as selected Agent and unsent per-Agent drafts is persisted on the Desktop and reconciled against authoritative service state after reconnect.

The product must not move client-only state into the service merely for convenience unless a concrete cross-Desktop requirement appears later.

### Local Agent Service bootstrap and lifetime

Normal product use must not depend on `npm start`, an attached shell, or a user-selected port.

Launching the product must establish or start the Local Agent Service. Failure to do so becomes the same connecting/retry/error product experience used for other local connectivity failures.

The implementation may use a native launcher, per-user service manager, or another Linux-appropriate mechanism. v0.1 specifies behavior, not the service-manager technology.

Only one Local Agent Service process may own a given pi-sand SQLite database at a time.

### Conversation and Pi context

Ordinary follow-up requests within one Agent must use Pi-native conversational context/session behavior sufficient to preserve normal conversational continuity.

pi-sand must not manufacture model context by replaying, summarizing, or independently managing the durable transcript as a second context system.

Pi process/session identity remains replaceable and never becomes Agent identity.

If the concrete Pi integration cannot provide safe cross-Turn continuity without violating these ownership rules, that is a release-blocking product gap to resolve at the Pi integration boundary rather than by adding a pi-sand memory/orchestration layer.

### Attachment ownership and durability

Attachment bytes must be staged into Local Agent Service-owned local storage before send.

A successful send commits stable attachment metadata with the durable user message and gives Pi a stable local representation it can access for that request.

After send/reopen, the transcript must still identify the attachment as part of the durable user message even if the Desktop process that originally selected the file is gone.

Staged-but-unsent files are temporary product state and may be garbage-collected after the owning draft is cleared or after a bounded cleanup policy. Exact on-disk layout and cleanup timing are implementation details.

### Workspace semantics and trust

Workspace association defines Pi's canonical working directory and an explicit user-intent trust context.

Workspace creation must expand supported home notation, resolve relative/normalized paths, follow realpath/symlink aliases, verify the path exists and is a directory, and persist the canonical path.

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

### Turn lifecycle and restart policy

Pi prompt acceptance is not equivalent to successful completion. pi-sand continues to follow the concrete Pi lifecycle through settlement.

Unexpected Pi exit before settlement produces an explicit failed Turn.

If the Local Agent Service restarts with persisted running Turns, every such Turn becomes explicitly terminal according to the established interruption/restart rule. v0.1 does not replay requests, adopt old workers, or perform automatic recovery/resume.

### Product-level failure set

v0.1 must provide understandable product states for this finite set:

- Local Agent Service unavailable / reconnecting;
- invalid or unavailable workspace;
- workspace or Agent already active;
- Pi executable unavailable or incompatible with the required lifecycle contract;
- prompt rejection;
- Pi-reported terminal failure;
- unexpected Pi exit;
- restart-interrupted work.

Raw implementation details may be available for diagnostics, but they are not the primary user explanation when pi-sand can identify one of these causes.

### Version semantics

The existing `0.1.0` package/README labeling on `main` is provisional foundation metadata. Before the dogfood-ready product release is tagged, repository metadata and README language must be reconciled so `v0.1.0` unambiguously names this release boundary.

## Testing Decisions

v0.1 keeps three durable testing seams, plus targeted pure unit tests where useful.

### 1. Actual Desktop E2E — compatibility authority

This seam renders the actual Desktop UI/runtime, crosses the real Local Agent Service boundary, and uses deterministic Pi behavior.

Keep it small and product-journey oriented. The critical journeys are:

1. open/create/select → draft → switch → return → send → visible streaming/Working;
2. Agent A runs while the user switches to Agent B and optionally starts independent B work; roster/header state remains isolated and correct;
3. disconnect or Desktop close → reconnect/reopen → selection/draft reconciliation plus authoritative transcript/Turn restoration without duplication, including error/Retry shell states;
4. attachment staging through supported Desktop inputs → send → durable attachment restoration after reopen.

A test that exercises HTTP/SSE without rendering the actual Desktop is **not** Desktop E2E.

### 2. Local Agent Service integration

This seam drives the public semantic Local Agent Service boundary with deterministic Pi behavior.

It carries lifecycle permutations, prompt rejection, settlement, unexpected Pi exit, interruption, persistence, service restart, canonical workspace handling, same-Agent/same-workspace exclusion, independent multi-Agent concurrency, attachment staging/commit semantics, and product-level failure classification.

HTTP/SSE-only transport tests may live here when they prove transport behavior, but they should not duplicate Desktop compatibility journeys.

### 3. Real-Pi smoke

Keep one or very few tests through the production Pi adapter and Local Agent Service with externally verifiable workspace outcomes.

This layer proves that the concrete Pi contract still works. It does not duplicate the deterministic lifecycle matrix.

### Unit tests

Targeted pure unit tests are appropriate for rule-heavy logic such as canonicalization or small state projections. They are not another architectural compatibility seam.

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
launch pi-sand
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
close the Desktop while work is active
      ↓
reopen later
      ↓
selection/draft presentation state reconciles
      ↓
authoritative Agent/Turn/transcript/result state is correct and unduplicated
```

All stable ownership, concurrency, failure, restart, and security/trust statements in this spec must hold throughout that journey.

## Further Notes

Known reference gaps are tracked in `REFERENCE.md`. Unknown behavior does not become a parity requirement by intuition.

The core architectural rule remains:

> **Desktop-observable behavior is compatibility authority; internal contracts support it, not define it.**
