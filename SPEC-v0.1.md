# pi-sand v0.1 — Pi-native Grok Bot 0.18 Compatibility Specification

Status: **Draft**

This document defines the first release target for `pi-sand`.

The current `main` branch is a **pre-v0.1 foundation**. It already proves durable Agent/Turn identity, SQLite persistence, Pi execution, Desktop reconnect, explicit failure/interruption semantics, canonical workspace safety, and concurrent work across independent workspaces.

That foundation is necessary, but it is not yet the product target.

The v0.1 product target is:

> **Build a Linux-first, Pi-native reimplementation of the user-visible Grok Bot 0.18 experience.**

The reference is the public `b-nnett/grok-bot-0.18-reconstructed` project and, through it, the checksum-pinned publicly shipped Grok Bot 0.18.0 application artifacts. The reconstruction is used as a behavioral/evidence oracle, not as an architecture template and not as source to copy.

The first published/tagged `v0.1.0` should mean: **the first version that feels recognizably like Grok Bot for the core Agent conversation journey, while using Pi as the intelligence/runtime underneath.**

---

## 1. Reference Basis and Provenance

### Primary reference

The primary reference repository is:

`b-nnett/grok-bot-0.18-reconstructed`

Its `PROVENANCE.md` identifies the upstream product as Grok Bot 0.18.0 (`com.anysphere.sand`) and records checksum-pinned macOS and Windows release artifacts.

The repository explicitly states that it is **not Anysphere's original monorepo**. The distributed renderer contained optimized production bundles rather than authored frontend source or original source maps. Its readable `frontend/` tree is therefore a partial evidence-backed reconstruction.

The reference project's own rule is useful for pi-sand as well:

> The immutable release is the product specification; recovered source may only express behavior supported by inspectable artifact evidence.

For pi-sand, this becomes:

> **Desktop-observable Grok Bot behavior is the compatibility authority. Reconstructed code and internal contracts are evidence supporting that behavior, not architecture requirements.**

### Evidence classes

Every Grok-derived compatibility claim should be classified as one of:

- **Observed** — repeatably visible in the shipped application or preserved artifact.
- **Evidence-backed** — supported by shipped strings/assets/CSS/DOM signatures, emitted code, source-path markers, IPC/RPC contracts, or a high-confidence reconstruction anchor.
- **Inferred** — plausible from evidence but not sufficiently verified to be a strict compatibility requirement.
- **Unknown** — evidence is currently insufficient.
- **Extension** — intentional pi-sand behavior that is useful but is not claimed as Grok Bot 0.18 compatibility.

Only **Observed** and sufficiently strong **Evidence-backed** behaviors should become strict v0.1 compatibility requirements.

Inferred or Unknown behavior must not be invented merely to make the implementation look complete.

### Reference repository extensions are not upstream requirements

The reconstruction repository also contains experiments added by its author, including an inference router, routed Claude/Codex/OpenRouter support, local usage tracking, and an optional local Docker sandbox.

Those are **not automatically Grok Bot 0.18 compatibility requirements** for pi-sand.

The reference must always be read with provenance in mind: distinguish preserved/reconstructed upstream behavior from later project extensions.

### Independent implementation rule

pi-sand must not copy reconstructed implementation code, proprietary assets, or recovered source organization into the product.

Reference evidence may produce:

- a behavioral requirement;
- a reference note;
- a screenshot/DOM/state record;
- an externally observable test.

Reference evidence must not, by itself, produce an internal `Coordinator`, `Host`, `Supervisor`, `LocalExec`, provider router, or any other component merely because such a name exists in the reconstruction.

Detailed artifact anchors belong in a dedicated reference/evidence document and focused tests. This specification defines product behavior and invariants.

---

## 2. Product Goal

The goal is not "make the current Pi demo more operational."

The goal is:

> **Open pi-sand and feel like you opened Grok Bot — with Pi underneath.**

A normal v0.1 journey should be:

```text
launch pi-sand
      ↓
see a Grok-style Agent/chat shell
      ↓
select or create a persistent Agent
      ↓
see the Agent identity + conversation workspace
      ↓
type a normal request in the composer
      ↓
send
      ↓
Agent visibly enters a working state
      ↓
assistant output/activity updates in the conversation
      ↓
switch to another Agent while the first continues
      ↓
optionally start independent work there
      ↓
close the Desktop
      ↓
work continues under the Local Agent Service
      ↓
reopen
      ↓
return to authoritative Agent state and durable result
```

The v0.1 release is not complete merely because the backend can perform this journey. The **Desktop interaction model and visible states** are part of the product contract.

---

## 3. Architecture and Ownership

pi-sand keeps the smallest Pi-native architecture that can reproduce the required behavior:

```text
Desktop Client
      ↓
Local Agent Service
   ├── SQLite
   └── Pi process(es)
        ↓
    Workspace(s)
```

The following principles remain authoritative:

1. **Agent identity outlives Pi process/session identity.**
2. **Agent ≠ Pi process/session.**
3. **Agent ≠ Turn.**
4. **Agent ≠ Desktop window/tab.**
5. **Transcript ≠ Pi model context.**
6. **Desktop lifetime ≠ Local Agent Service lifetime.**
7. **Pi owns reasoning, planning, tool selection, skills, model context, retries inside its autonomous loop, and the autonomous inner work loop.**
8. **pi-sand owns durable Agent identity, durable Turn/product state, transcript, workspace association, routing, presentation, reconnect, and Pi process ownership.**
9. **Persistent identity does not require infinite model context.**
10. **External filesystem/Git/test state is ground truth when it conflicts with stale model context.**

Pi is the brain/worker. pi-sand is the persistent product shell and control boundary.

The reconstructed Grok Bot topology may contain Electron main, host, coordinator, local-exec, protocol, renderer, remote-box, or other boundaries. pi-sand does not reproduce those boundaries unless a user-visible requirement independently makes them necessary.

---

## 4. v0.1 Compatibility Surface

v0.1 intentionally targets the **core Grok Bot Agent conversation experience**, not every recovered feature in the reference application.

### 4.1 Desktop application shell — Required

**Compatibility target: Observed / Evidence-backed**

The product must present a dedicated desktop application surface or equivalent installed-app window. The implementation may use web technology internally; Electron is not required simply because Grok Bot used Electron.

The shell must provide two persistent conceptual areas:

```text
Agent/chat roster | selected conversation workspace
```

A plain developer page with a `<select>` dropdown and transcript is not sufficient for v0.1 compatibility.

The roster/shell must support:

- seeing saved Agents/chats;
- selecting an Agent;
- keeping selection stable while the Agent state updates;
- a useful empty state;
- a connecting/loading state;
- an unreachable/error state that communicates that saved Agents have not disappeared;
- explicit retry/reconnect behavior;
- reconnect feedback while the product is attempting to regain the local service.

The reconstructed roster contains evidence-backed states corresponding to "Connecting to your computer…", "No saved agents yet.", "Can’t reach your computer", retry, and reconnecting. pi-sand should preserve the semantics; exact wording may be adapted for a local Linux service when literal upstream copy would be misleading.

### 4.2 Agent identity and conversation header — Required

**Compatibility target: Evidence-backed**

Opening an Agent must establish a clear selected-Agent identity rather than exposing only raw workspace metadata.

The core header should present:

- Agent identity/name;
- an avatar or equivalent identity marker;
- an explicit visible working state while the Agent is active;
- space for Agent/conversation controls whose inclusion is separately evidence-backed.

The reconstructed `chat-header.tsx` directly projects Agent identity and shows the copy `Working` when `isRunning` is true. It also contains evidence for Agent settings/details and a Computer control. The identity + working semantics are v0.1 requirements; richer settings/Computer behavior is separately scoped below.

### 4.3 Conversation transcript — Required

**Compatibility target: Observed / Evidence-backed, implemented independently**

The selected Agent must expose a durable, readable conversation workspace rather than a process log.

The transcript must:

- distinguish user and assistant messages clearly;
- stream visible assistant output during active work when Pi emits usable output;
- preserve canonical message order;
- preserve stable message identity across reconnect;
- avoid duplicate transcript content after reconnect or snapshot replacement;
- keep completed, failed, and interrupted conversation history available after reopening;
- remain separate from Pi private reasoning, exact model context, and raw RPC/event logs.

Activity/tool presentation may be interleaved visually with the conversation only when it is user-visible product information. It must not turn the canonical transcript into a replayable execution journal.

### 4.4 Composer — Required core, staged fidelity

**Compatibility target: Evidence-backed**

The reconstructed Grok Bot composer is substantially richer than a basic textarea. Evidence in `composer.tsx`, `desktop.ts`, `draft-state.ts`, and `conversation-evidence.json` supports a structured composer with persistent draft semantics, attachments, reply context, rich-text input, send controls, drag/drop/paste behavior, and voice-input UI.

v0.1 requires the following **core composer parity**:

- natural-language input without choosing a workflow or skill;
- a visually distinct bottom composer integrated with the conversation workspace;
- Enter/submit behavior appropriate for a chat composer;
- explicit send action;
- per-Agent draft preservation when switching away and back;
- file attachment through a picker;
- drag/drop attachment;
- pasted-file attachment when supported by the Desktop platform;
- visible attachment chips/previews with removal;
- actionable attachment failure/limit feedback;
- reply context when replying to an existing message is exposed by the surrounding conversation UI.

The upstream-style placeholder semantics include "Ask anything, or drop a file." Exact copy is not required, but the input must communicate both ordinary prompting and attachment support.

**Evidence-backed but deferred from the v0.1 release gate:**

- voice recording/dictation;
- complete rich mention/provider behavior;
- every attachment media specialization;
- exact animation/glyph transitions.

These are real reference surfaces, but they are not allowed to delay the first core Grok-compatible release unless later reference testing shows they are essential to the primary journey.

### 4.5 Working state and activity — Required

**Compatibility target: Observed / Evidence-backed behavior; Pi-native implementation**

A running Agent must look visibly alive.

`Pi is working…` as a single static line is an acceptable fallback but is not the final v0.1 target when stable Pi events provide better information.

The Desktop should expose coarse user-visible activity derived from Pi's actual observable contract, for example:

- working/running;
- tool use or command activity where Pi exposes a stable event;
- waiting for user input when that state exists;
- completion;
- failure;
- interruption.

Rules:

- never expose private chain-of-thought;
- do not invent a plan Pi did not emit;
- do not build a second reasoning timeline around Pi;
- do not dump raw Pi RPC JSON into the normal UI;
- activity records are not automatically durable transcript messages;
- uncertain Pi events should be omitted rather than assigned speculative product semantics.

The reconstructed header model carries `isRunning`, `isComposingMessage`, `awaitingUserResponse`, and `currentActivity`, which is evidence that the upstream visible experience distinguishes more than a terminal completed/not-completed state. pi-sand should reproduce the useful observable semantics that Pi can support reliably.

### 4.6 Stop / interrupt — Required

**Compatibility + existing pi-sand behavior**

The user must be able to stop the selected Agent's active work.

Stopping one Agent must not affect another independent active Agent.

Already-persisted transcript content remains available after interruption, and the final interrupted state remains durable after Desktop reopen.

The product control should be expressed as a normal chat/working control, not as a process-management operation.

### 4.7 Agent switching and background work — Required

**Compatibility target + pi-sand foundation**

Switching the selected conversation must not stop work in the conversation being left.

The user should be able to:

```text
Agent A working
   ↓ switch
Agent B conversation
   ↓
Agent A still working
   ↓ switch back
Agent A current state/result
```

Desktop selection is presentation state. It is not Agent/process ownership.

### 4.8 Desktop close/reopen — Required

**Compatibility target + existing pi-sand foundation**

Closing the Desktop application must not cancel an active Turn merely because the UI disappeared.

Reopening must:

- reconnect to the Local Agent Service;
- restore the last useful selected-Agent state when possible;
- retrieve authoritative Agent/transcript/Turn state;
- subscribe to subsequent updates;
- avoid duplicate or reordered visible content;
- show either the same running Turn or its durable terminal result.

This requirement justifies the Desktop/Local Agent Service lifetime boundary. It does not justify copying Grok Bot's internal process topology.

### 4.9 Multiple Agents and workspace safety — Required pi-sand extension

**Extension**

Independent Agents in independent canonical workspaces may run concurrently.

The current safety invariant remains:

- one Agent has at most one running Turn;
- one canonical workspace has at most one running Turn;
- different Agents in different canonical workspaces may run concurrently;
- different Agents pointing to the same canonical workspace may not mutate it concurrently.

Workspace creation expands `~`, resolves relative/normalized paths, follows realpath/symlink aliases, verifies the directory exists, and persists the canonical path.

This behavior is a deliberate Linux/Pi-native safety extension. It must fit the Grok-like shell without becoming a scheduler, task queue, worker pool, or second orchestration system.

### 4.10 Connectivity and recoverable shell states — Required

**Compatibility target: Evidence-backed semantics**

The reference roster explicitly models loading, reconnecting, unreachable/error, empty, and hidden-only states.

For the v0.1 core shell, pi-sand must at least implement:

- connecting/loading;
- ready;
- empty;
- temporarily disconnected/reconnecting;
- unreachable/error with Retry;
- Agent data preserved across transient Desktop/service connectivity loss.

A connectivity error must not visually imply that durable Agents were deleted.

The exact transport is not part of compatibility. HTTP/SSE, local IPC, WebSocket, or another local mechanism may be used if the observable behavior is correct.

### 4.11 Failures — Required

**Compatibility behavior + Pi-native extension details**

Common failure modes must appear as product states, not raw implementation accidents.

At minimum:

- invalid/missing workspace;
- workspace already active elsewhere;
- Pi executable unavailable;
- Pi prompt rejection;
- Pi-reported terminal error;
- unexpected Pi process exit;
- Local Agent Service unavailable/reconnecting.

A user should not have to interpret `spawn ... ENOENT`, SQLite errors, or raw RPC envelopes when pi-sand can provide a more useful explanation.

If Pi exits unexpectedly before settlement:

```text
running → failed
```

If the Local Agent Service restarts with persisted `running` Turns, every such Turn is explicitly terminalized according to the established rule. v0.1 does not replay the request, adopt the old worker, or silently pretend the work is still active.

---

## 5. Reference-Supported Surfaces Deferred from the v0.1 Gate

The reconstructed renderer exposes a much larger product surface than the core conversation journey. The feature tree includes areas such as account/access, Agent info, automations, Computer, hidden chats, onboarding, org chart, permissions, plugins, settings, shared-room/group behavior, feedback, deep links, and more.

These are not denied as real Grok Bot surfaces. They are simply not all release blockers for the first Pi-native compatibility slice.

### Deferred until independently mapped and prioritized

- full Agent settings/details parity;
- Computer/screen surface beyond the minimum activity experience;
- hidden-chat management;
- shared rooms/groups/org-chart behavior;
- automations;
- complete plugin/MCP presentation parity;
- reactions;
- voice input/dictation;
- full onboarding flow;
- account/team/cloud-access flows;
- remote-box semantics;
- deep links;
- feedback/reporting UI;
- exact keyboard shortcut/command-palette coverage;
- all menus/context menus;
- exact animation timing and micro-interactions.

When one of these surfaces is implemented, its behavior must first be mapped to explicit evidence rather than guessed from a recovered file or feature name.

---

## 6. Product Operability Exists to Support Compatibility

Operational work is necessary, but it is not the product direction.

v0.1 needs enough product operability that the Grok-style journey is real:

- the Local Agent Service survives Desktop closure;
- normal launch does not require supervising `npm start` in a terminal;
- the Desktop can find/connect to the local service;
- Pi availability is checked early enough to show an actionable state;
- normal local configuration does not require retyping environment variables on every launch;
- workspace validation happens before execution starts.

The specific Linux service manager, launcher implementation, config file format, and packaging technology are implementation decisions unless they affect observable behavior.

`systemd --user` is a reasonable Linux implementation option, not a defining Grok Bot feature and not an architecture goal by itself.

---

## 7. Visual Fidelity Policy

The v0.1 core shell should be **recognizably Grok Bot-inspired at first glance**, not merely functionally equivalent.

For the required compatibility surface, implementation should intentionally study and reproduce evidence-backed aspects such as:

- two-area roster + conversation composition;
- information hierarchy;
- conversation header structure;
- composer placement and control grouping;
- working/status visibility;
- empty/loading/error/reconnect state placement;
- message density and conversation rhythm;
- attachment/reply presentation where implemented.

However:

- do not redistribute proprietary assets without rights to do so;
- do not fabricate missing measurements or controls;
- do not copy reconstructed CSS/component source;
- do not make exact pixel identity a blocker where the evidence is incomplete or platform typography differs;
- do not reproduce macOS-only chrome merely for architectural mimicry on Linux.

The rule is **high fidelity for verified core behavior and composition, conservative treatment of unknown details**.

---

## 8. Persistence and Context

SQLite remains the canonical local product store for pi-sand.

It stores product state such as:

- Agent identity and user-visible metadata;
- canonical workspace association;
- Turns and terminal detail;
- canonical transcript messages;
- draft/composer state when required for visible compatibility;
- other durable UI/product metadata needed to restore the observed experience.

It does not need to store:

- Pi private reasoning;
- exact model context;
- every tool event;
- an execution replay journal;
- a second custom memory representation of the Agent.

The concepts remain distinct:

```text
product history       = durable pi-sand state
Pi working context    = Pi-owned reasoning/session context
external ground truth = filesystem / Git / commands / tests
```

Context is temporary. Product state is durable.

---

## 9. Testing and Compatibility Evidence

### Desktop E2E is the compatibility authority

The final question is not "does an internal API look like Grok?"

It is:

> **Does the user-observable Desktop behavior match the verified Grok Bot behavior closely enough for the targeted surface?**

The test hierarchy remains:

1. a small number of Desktop E2E compatibility tests;
2. substantial Local Agent Service integration tests with a deterministic Pi fake;
3. focused UI/component tests for evidence-backed state/interaction rules;
4. targeted unit tests for genuinely rule-heavy logic;
5. a very small real-Pi smoke suite.

### Reference record required for compatibility UI work

Before implementing a non-trivial Grok-derived UI behavior, record:

- reference feature/surface;
- source artifact or reconstruction path;
- evidence anchor/confidence where available;
- initial visible state;
- user action;
- visible result;
- classification: Observed / Evidence-backed / Inferred / Unknown / Extension.

Passing unit tests or typecheck is not evidence that a reconstructed behavior is correct.

### Mandatory v0.1 behavioral scenarios

The release gate must cover at least:

1. **Launch → roster shell**: Desktop reaches loading/ready/empty or recoverable error states without exposing developer infrastructure.
2. **Create/open Agent**: an Agent becomes a stable selectable identity with a conversation workspace.
3. **Composer draft switching**: text/attachment draft state remains associated with the correct Agent when switching away and back.
4. **Attachment journey**: picker plus drag/drop (and paste where platform-supported) stages a visible attachment or gives an actionable failure state.
5. **Send → working → stream → terminal result**: the selected Agent visibly enters work, emits user-visible updates, and reaches one durable terminal Turn.
6. **Switch during work**: leaving Agent A for Agent B does not stop A.
7. **Independent parallel Agents**: A/workspace A and B/workspace B can remain active simultaneously.
8. **Shared-workspace exclusion**: another Agent cannot bypass the canonical workspace lock through `~`, normalized paths, or symlink aliases.
9. **Interrupt isolation**: stopping A does not affect B.
10. **Desktop close/reopen**: active work continues and reconnect restores authoritative state without duplicate/reordered transcript content.
11. **Connectivity loss/retry**: the shell shows a recoverable reconnect/unreachable state without implying durable Agents disappeared.
12. **Pi failure**: prompt rejection, terminal error, and unexpected exit become understandable durable product outcomes.
13. **Service restart**: every persisted running Turn is explicitly classified without replay/adoption.
14. **Real Pi smoke**: one controlled real workspace task produces an externally verifiable result through the same product path.

### What not to test as compatibility

Do not make compatibility depend on:

- reconstructed class/module names;
- exact process count;
- recovered React component names;
- internal RPC method names;
- provider/router topology;
- exact Pi session identity;
- hidden model prompts;
- private reasoning traces.

---

## 10. Explicitly Out of Scope for v0.1

v0.1 does **not** require:

- reproducing Grok Bot's Electron/main/host/coordinator/local-exec topology;
- the reconstruction project's added inference router;
- Claude Code/Codex/OpenRouter provider routing as a pi-sand feature;
- the reconstruction project's local usage tracker;
- the reconstruction project's local Docker sandbox;
- a generic runtime/provider abstraction;
- a scheduler;
- a task queue;
- priorities;
- a worker pool;
- multiple simultaneous Turns inside one Agent;
- concurrent mutation of one canonical workspace;
- automatic Git worktree management;
- a second planning/orchestration loop around Pi;
- automatic task replay/recovery after service crash;
- worker adoption;
- execution checkpoint/replay semantics;
- a custom model-context framework;
- a custom memory framework;
- distributed/multi-machine workers;
- remote/Telegram/mobile frontend;
- multi-user SaaS;
- macOS/Windows support;
- mandatory Docker/VM sandboxing;
- exact parity for every reference settings/account/team surface;
- voice input as a release blocker;
- shared rooms/groups/automations as a release blocker;
- complete pixel-perfect parity across the entire application;
- copying proprietary Grok Bot assets or reconstructed source.

These may be added only when either verified Grok compatibility priority or real pi-sand usage justifies them.

---

## 11. v0.1 Definition of Done

v0.1 is complete when the primary product journey no longer feels like operating a Pi RPC demo and instead feels recognizably like a Pi-native Grok Bot:

```text
launch dedicated pi-sand Desktop
        ↓
see persistent Agent/chat roster
        ↓
select/create Agent
        ↓
see Grok-style conversation header + workspace
        ↓
compose ordinary natural-language request
        ↓
optionally attach local files
        ↓
send
        ↓
Agent visibly enters Working/activity state
        ↓
assistant conversation updates stream
        ↓
switch to another Agent without stopping the first
        ↓
independent Agent may work concurrently
        ↓
close Desktop
        ↓
Local Agent Service + Pi continue while host is awake
        ↓
reopen
        ↓
correct Agent, transcript, active/terminal state are restored
```

Additionally:

- the core shell has evidence-backed roster, header, conversation, composer, and reconnect states;
- per-Agent draft state works correctly;
- basic attachments work through the product composer;
- active work can be interrupted from the normal conversation UI;
- failures are durable and understandable;
- common connectivity problems have retry/reconnect presentation;
- one Agent's lifecycle never mutates another independent Agent;
- canonical shared-workspace exclusion remains enforced;
- service restart does not silently replay or adopt unfinished work;
- normal use does not require interpreting raw process/RPC failures;
- Pi remains the sole intelligence/tool/skill/autonomous-work engine;
- no reference-derived internal component exists without an independent pi-sand need;
- required Desktop compatibility E2E, service integration tests, and real-Pi smoke tests pass.

The final subjective gate is also intentional:

> **When the core conversation screen is open, a user familiar with Grok Bot 0.18 should recognize the interaction model without being told that pi-sand was built from a different internal architecture.**

---

## 12. Recommended Implementation Progression

### Slice 0 — Reference map for the core shell

Before more product code, create a small evidence map for:

- app/roster shell;
- roster loading/empty/error/reconnect states;
- Agent row/selection behavior;
- conversation header;
- transcript/message composition;
- composer;
- working/activity state;
- stop/interrupt interaction.

Do not reverse-engineer the entire application. Capture only the behavior needed for the next slice.

### Slice 1 — Grok-style shell and Agent roster

Replace the developer-oriented Agent dropdown page with the real product shell.

Prove selection, identity, empty/loading/error/reconnect states, and correct per-Agent state projection.

### Slice 2 — Grok-style conversation workspace and composer

Implement the evidence-backed conversation layout, header, composer, per-Agent drafts, basic attachments, and send interaction.

Keep the existing durable service as the authority underneath it.

### Slice 3 — Working/activity experience

Map stable Pi events onto the smallest useful Grok-like visible working states.

Add no planner, workflow engine, or private reasoning display.

### Slice 4 — Background/switch/reconnect product journey

Integrate the already-proven service lifecycle and multi-Agent behavior into the new shell so switching/closing/reopening feels native rather than like an API demo.

### Slice 5 — Minimum operability required by that journey

Only now add the launch/service discovery, Pi preflight, persistent local configuration, packaging, and failure presentation needed so the Grok-like Desktop journey does not require terminal babysitting.

These are supporting capabilities, not the organizing principle of the product.

### Slice 6 — Compatibility dogfood gate

Dogfood the product as Grok Bot, not as a backend test harness.

The target behavior is:

> Open the app, give Agent A real work, move to Agent B, leave the UI, return later, and trust both the conversation experience and the results without thinking about Pi processes, ports, SQLite, RPC, or terminal supervision.

---

## 13. Stable Design Rule

When deciding what to build next, ask in this order:

1. **What does Grok Bot 0.18 visibly do here?**
2. **What evidence supports that behavior?**
3. **Is it part of the v0.1 core compatibility journey?**
4. **What is the smallest Pi-native implementation that reproduces it?**
5. **Can Pi already own the intelligence/runtime part instead of pi-sand recreating it?**

Do not start with reconstructed internal components and work outward.

Start with verified user behavior and work inward.
