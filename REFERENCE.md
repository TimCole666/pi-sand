# pi-sand Grok Bot 0.18 Reference Map

Status: **Working evidence map for v0.1**

This document is the detailed evidence companion to `SPEC-v0.1.md`.

Its purpose is to answer a narrower question than the product spec:

> What user-visible Grok Bot 0.18 behavior do we actually have evidence for, and how should that behavior constrain pi-sand?

The target is not to reconstruct Grok Bot's source architecture. The target is to reproduce the useful observable desktop behavior with the existing Pi-native pi-sand architecture.

---

## 1. Reference authority

Primary reference repository:

`b-nnett/grok-bot-0.18-reconstructed`

Primary upstream artifact represented by that repository:

- Product: Grok Bot
- Version: 0.18.0
- macOS bundle id: `com.anysphere.sand`
- pinned macOS DMG SHA-256: `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb`
- pinned original `app.asar` SHA-256: `6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58`

Source: `b-nnett/grok-bot-0.18-reconstructed/PROVENANCE.md`.

The reconstructed repository explicitly states that the shipped renderer contained optimized production bundles, not the authored frontend source or source maps. Its readable `frontend/` tree is therefore evidence-backed reconstruction, not original source.

For pi-sand the governing rule is:

> **Desktop-observable behavior is compatibility authority; reconstructed implementation structure is not.**

The evidence hierarchy used here is:

- **Observed** — repeatably visible in the shipped product/artifact.
- **Evidence-backed** — supported by shipped strings, CSS, DOM signatures, emitted code, contracts, or explicit reconstruction anchors.
- **Inferred** — plausible but not strong enough to become a strict compatibility requirement.
- **Unknown** — not yet mapped.
- **Extension** — intentional pi-sand behavior, not claimed as Grok Bot parity.

If evidence is missing, the correct action is to leave the behavior unmapped rather than invent it.

---

## 2. Core v0.1 visual model

The core experience is a persistent two-pane desktop shell:

```text
┌───────────────────────────────┬──────────────────────────────────────────────┐
│ Agent / chat roster           │ Selected Agent conversation                 │
│                               │                                              │
│ New / Search                  │ avatar  Agent name  Working                 │
│                               ├──────────────────────────────────────────────┤
│ Agent A                       │                                              │
│   preview / draft / status    │ transcript                                  │
│ Agent B                       │                                              │
│   preview / draft / status    │                                              │
│ ...                           │                                              │
│                               ├──────────────────────────────────────────────┤
│                               │ composer                                     │
└───────────────────────────────┴──────────────────────────────────────────────┘
```

This is directly reflected in the reconstructed production renderer: the root lays out a sidebar column next to a `minmax(0, 1fr)` conversation column and mounts `ConversationSidebar` as the roster owner.

Evidence:

- `frontend/src/production/ProductionRenderer.tsx`
- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
- `frontend/src/recovered/features/conversation/workspace/view.css`

Useful geometry from the evidence-backed CSS:

- roster header: 50 px high;
- conversation header: minimum 51 px high;
- Agent rows: minimum 58 px in expanded mode;
- transcript content is centered around an approximately 690 px reading width;
- composer surface is a rounded input shell with a 16 px radius;
- sidebar may collapse to a narrow avatar rail.

These numbers are reference geometry, not a requirement to copy every CSS token or pixel. v0.1 should preserve the recognizable hierarchy and density before chasing exact styling.

---

## 3. Root shell states

### 3.1 Loading / setup

**Classification: Evidence-backed**

The reconstructed root shell has a dedicated setup/loading state rather than displaying an empty broken app while initialization is incomplete.

Evidence:

- `frontend/src/recovered/features/window-chrome/root-shell-state.tsx`
- artifact anchors include `index-UbX-y3il.js#L131944`, `#L132101-L132102`, and `#L132985`.

Reference behavior:

- root-level loading is visually distinct from an empty roster;
- the shell does not imply that saved Agents are gone while initialization is pending.

pi-sand mapping:

- Local Agent Service connection / first snapshot loading should have an explicit shell state.

### 3.2 Empty workspace

**Classification: Evidence-backed**

The root shell has a specific no-chat state rather than fabricating a selected conversation.

Evidence:

- `frontend/src/recovered/features/window-chrome/root-shell-state.tsx`

pi-sand mapping:

- zero Agents should show an intentional empty state with a clear create/new action.

### 3.3 Fatal renderer error

**Classification: Evidence-backed, deferred fidelity**

The reference has a root error boundary with recovery affordances.

Evidence:

- `frontend/src/recovered/features/window-chrome/root-shell-state.tsx`

v0.1 requirement:

- catastrophic Desktop render failure should not silently present stale or blank state.

Exact error copy and developer diagnostics are not compatibility blockers.

---

## 4. Agent roster

### 4.1 Core roster controls

**Classification: Evidence-backed**

The roster includes explicit new-chat and search controls.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
- artifact anchors include `index-UbX-y3il.js#byteOffset=2601270` for the collapsed new-chat control and `#byteOffset=2605212` for search.

v0.1 requirement:

- a persistent Agent list;
- a clear create/new action;
- a clear Agent selection affordance;
- search may be implemented after the basic roster if needed, but the shell should reserve a normal product location for it rather than treating Agent choice as a developer dropdown.

### 4.2 Agent row information hierarchy

**Classification: Evidence-backed**

An Agent row is not just a name. The reconstructed row model can project:

- avatar / identity marker;
- Agent name;
- recent activity / message preview;
- draft preview;
- waiting-for-user state;
- working state;
- unread / attention marker;
- recency;
- pinned/collapsed variants.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`
- `frontend/src/recovered/features/conversation/workspace/model.ts`

The reconstructed row gives draft text priority over waiting reason, and waiting reason priority over the last-message preview. That is useful behavioral evidence for information hierarchy even if pi-sand initially renders a simpler row.

### 4.3 Status precedence

**Classification: Evidence-backed**

The reconstructed status projection distinguishes at least:

```text
needs attention
unread activity
working
```

with waiting/attention taking precedence over ordinary running presentation.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`
- Mac anchors around `index-UbX-y3il.js#byteOffset=1131225` and `#byteOffset=1131705`
- matching Windows anchors are recorded in the same file.

pi-sand mapping:

```text
Turn running                    -> working
stable Pi user-response state  -> needs attention / waiting
new unseen terminal/output     -> unread activity, if/when unread semantics are added
```

Do not infer a waiting state from private reasoning or heuristics. Only expose it when a stable Pi/product event supports it.

### 4.4 Roster connectivity states

**Classification: Evidence-backed**

The reference has distinct roster states for loading, empty, unreachable/error, and reconnecting, with explicit retry behavior.

Evidence:

- `frontend/src/recovered/features/roster/status.tsx`
- `frontend/src/recovered/features/roster/reconnect-notice.tsx`
- `frontend/src/recovered/features/root-resilience/connection-state.tsx`
- anchors include `index-UbX-y3il.js#byteOffset=2550111` and `#byteOffset=2553043`.

Important semantic rule:

> Temporary transport failure must not visually imply that durable Agents were deleted.

pi-sand should adapt the wording to a local Linux service, but preserve the state distinction.

---

## 5. Agent selection

### 5.1 Persistent last selection

**Classification: Evidence-backed**

The reconstructed client owns a persistent last-selected-Agent slice and restores it across client lifecycle.

Evidence:

- `frontend/src/recovered/features/roster/selection-state.ts`
- artifact anchors around `index-UbX-y3il.js#byteOffset=777400` and `#byteOffset=819190`.

Reference semantics:

- selected Agent id is client-persisted;
- selection has a pending/load phase;
- if the stored Agent no longer exists once the roster is complete, selection falls back to an available Agent;
- selection persistence is presentation/client state, not worker ownership.

pi-sand mapping:

- reopening should return to the last useful Agent when possible;
- changing selection must never stop that Agent's Turn;
- if the saved Agent no longer exists, fall back predictably.

### 5.2 Keyboard navigation

**Classification: Evidence-backed, deferred**

The root shell includes keyboard navigation for previous/next Agent and direct indexed Agent selection.

Evidence:

- `frontend/src/recovered/features/window-chrome/root-shell-state.tsx`

This is useful parity work, but not a first implementation blocker.

---

## 6. Conversation header

### 6.1 Identity projection

**Classification: Evidence-backed**

The selected conversation has a real identity header with:

- Agent avatar / identity marker;
- Agent name;
- visible working state;
- room/settings/computer controls when those surfaces are available.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/chat-header.tsx`
- artifact anchor `index-UbX-y3il.js#byteOffset=4886695`.

The normal-Agent header explicitly renders a working label when `isRunning` is true.

v0.1 requirement:

- avatar/identity marker + Agent name + running state are required;
- richer Agent settings and Computer controls are deferred until separately mapped.

---

## 7. Conversation transcript

### 7.1 Transcript is a product surface, not a process log

**Classification: Evidence-backed**

The reference transcript is a structured conversation surface with user/assistant messages and additional card/event types. It is not raw coordinator output.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/transcript.tsx`
- `frontend/src/recovered/features/conversation/workspace/model.ts`
- `frontend/src/production/model.ts`

The transcript model supports stable message ids, user/assistant roles, timestamps, attachments, delivery state, reply relation, rich text, and streaming state.

pi-sand v0.1 core requires:

- durable user + assistant messages;
- visible streaming assistant output;
- stable ordering and identity across reconnect;
- completed/failed/interrupted history after reopen;
- no duplicate messages after snapshot/reconnect replacement.

### 7.2 Message actions / reply

**Classification: Evidence-backed, staged**

The reference exposes message-level actions including reply and copy, with reply state feeding back into the composer.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/transcript.tsx`
- `frontend/src/recovered/features/conversation/workspace/conversation-workspace-controller.ts`

v0.1 recommendation:

- reply is useful core parity if inexpensive;
- reactions, threads, and the full message-action surface may follow later.

### 7.3 Delivery/offline presentation

**Classification: Evidence-backed, not automatically applicable**

The reference has queued, failed-send, resend/delete, and offline-send presentation.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/transcript.tsx`

This should not be copied mechanically into pi-sand. The local Pi RPC/service semantics differ from the reference network model. Only add these states if the pi-sand transport actually has equivalent durable meaning.

---

## 8. Composer

### 8.1 Core shape

**Classification: Evidence-backed**

The reference composer is a persistent bottom input dock, not a plain standalone textarea.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/composer.tsx`
- `frontend/src/recovered/features/conversation/workspace/view.css`
- `frontend/src/production/ProductionRenderer.tsx`

The production renderer mounts the composer under the transcript in a dedicated input dock and scopes it to the active Agent.

v0.1 required core:

- integrated bottom composer;
- normal natural-language input;
- explicit send action;
- sensible keyboard submission;
- disabled/busy state when sending is unavailable;
- per-Agent scope.

### 8.2 Per-Agent draft persistence

**Classification: Evidence-backed**

Draft state is explicitly client-persisted and keyed by Agent.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/draft-state.ts`
- artifact anchors around `index-UbX-y3il.js#byteOffset=4769359`, `#byteOffset=4771060`, and `#byteOffset=4773604`.

Reference semantics:

- switching away from an Agent need not destroy its unsent draft;
- draft and recovery state are separate concepts;
- an accepted send clears only the matching/current draft.

v0.1 requirement:

> Type in Agent A, switch to B, return to A, and the unsent A draft is still there.

### 8.3 Attachments

**Classification: Evidence-backed**

The reconstructed composer supports:

- file picker;
- drag/drop;
- pasted files;
- visible attachment list/chips;
- removal;
- attachment limits;
- user-visible staging errors.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/composer.tsx`
- `frontend/src/recovered/features/conversation/workspace/desktop.ts`
- `frontend/src/recovered/features/conversation/workspace/model.ts`

The reconstructed model defines a six-attachment composer limit. That is reference behavior, but pi-sand should confirm whether carrying over the exact numeric limit is useful before making it a product invariant.

### 8.4 Rich text and voice

**Classification: Evidence-backed, deferred from v0.1 gate**

The reference includes a rich-text editor and voice/dictation states.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/composer.tsx`
- voice artifact anchors recorded in that file.

These are real surfaces, but they should not delay the first Pi-native core conversation release.

---

## 9. Working and activity state

### 9.1 Reference model

**Classification: Evidence-backed**

The renderer model contains separate fields for:

- `isRunning`;
- `isComposingMessage`;
- `awaitingUserResponse`;
- `currentActivity`;
- `waitingReason`;
- `draftPrompt`;
- `lastEntry` / last-message preview.

Evidence:

- `frontend/src/recovered/features/conversation/workspace/model.ts`
- `frontend/src/production/model.ts`
- `frontend/src/recovered/features/conversation/workspace/chat-header.tsx`
- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`

This is strong evidence that the visible product differentiates more than idle/running/finished.

### 9.2 Pi-native translation

pi-sand must not synthesize those fields by inventing a second orchestration layer.

Use this translation rule:

| Grok-visible concept | pi-sand source |
| --- | --- |
| running | persisted Turn state + live Pi execution |
| assistant streaming | Pi message delta events |
| current activity | only stable, user-visible Pi events we can classify safely |
| waiting for user | only a stable Pi/product request-for-user-input signal |
| last preview | durable transcript summary |
| draft preview | Desktop-owned per-Agent draft |

Never use private chain-of-thought as activity content.

If Pi exposes no reliable richer activity for a moment, a simple working state is correct.

---

## 10. Background switching and reconnect

### 10.1 Reference-backed client behavior

The reference clearly treats Agent selection and connection state as client/UI state. Selection can be restored independently, and reconnecting/unreachable states are modeled without deleting the roster.

Evidence:

- `frontend/src/recovered/features/roster/selection-state.ts`
- `frontend/src/recovered/features/root-resilience/connection-state.tsx`
- `frontend/src/recovered/features/roster/status.tsx`
- `frontend/src/recovered/features/roster/reconnect-notice.tsx`

### 10.2 pi-sand extension

**Classification: Extension**

The stronger pi-sand guarantee remains:

```text
Desktop selection/lifetime != Agent execution lifetime
```

Therefore:

- switching A -> B does not stop A;
- closing the Desktop does not stop A;
- reopening obtains authoritative state from the Local Agent Service;
- independent Agents in independent canonical workspaces may continue concurrently.

This is a deliberate Pi-native local architecture guarantee. Do not claim that the reference repository alone proves the exact same local process semantics.

---

## 11. v0.1 compatibility matrix

| Surface | Classification | v0.1 |
| --- | --- | --- |
| Two-pane shell | Evidence-backed | Required |
| Agent roster | Evidence-backed | Required |
| New Agent/chat action | Evidence-backed | Required |
| Search | Evidence-backed | Recommended, may follow first shell |
| Persist last selected Agent | Evidence-backed | Required |
| Agent avatar/name header | Evidence-backed | Required |
| Visible Working state | Evidence-backed | Required |
| Durable transcript | Evidence-backed + pi-sand foundation | Required |
| Streaming assistant text | Evidence-backed + Pi contract | Required |
| Per-Agent draft | Evidence-backed | Required |
| File attachment picker | Evidence-backed | Required |
| Drag/drop/paste attachment | Evidence-backed | Required for parity slice |
| Reply context | Evidence-backed | Recommended |
| Rich text | Evidence-backed | Deferred |
| Voice/dictation | Evidence-backed | Deferred |
| Reactions/threads | Evidence-backed | Deferred |
| Pinned Agents/sections | Evidence-backed | Deferred |
| Hidden chats | Evidence-backed | Deferred |
| Shared rooms/groups | Evidence-backed | Deferred |
| Computer surface | Evidence-backed | Deferred |
| Full Agent settings | Evidence-backed | Deferred |
| Reconnecting/unreachable states | Evidence-backed | Required |
| Desktop close does not stop Turn | pi-sand Extension | Required |
| Multi-Agent independent concurrency | pi-sand Extension | Required |
| Canonical workspace lock | pi-sand Extension | Required |
| Exact upstream stop-button placement | Unknown in this evidence pass | Do not guess |
| Exact notification behavior | Unknown in this evidence pass | Do not claim parity |

---

## 12. First implementation slice derived from this map

The first UI implementation should deliberately be smaller than the full recovered feature tree.

Build this first:

```text
Window shell
  ├── roster
  │    ├── New
  │    ├── Agent rows
  │    │    ├── avatar/name
  │    │    ├── preview/draft/waiting detail
  │    │    └── working/attention state
  │    └── loading / empty / reconnect / error states
  │
  └── selected conversation
       ├── header: avatar + name + Working
       ├── durable transcript + streaming assistant text
       └── composer
            ├── per-Agent draft
            ├── send
            └── file attachments
```

Then prove this behavioral journey before adding more surfaces:

```text
create/open Agent A
      ↓
type a draft
      ↓
switch to Agent B
      ↓
return to A; draft survives
      ↓
send A; A shows Working
      ↓
switch to B while A continues
      ↓
A remains visibly working in roster
      ↓
return to A; streaming/result is current
      ↓
disconnect/reconnect Desktop
      ↓
selection + transcript + Turn state restore correctly
```

---

## 13. Behavioral tests to derive

Compatibility evidence should create observable tests, not reconstructed internal components.

The first reference-derived tests should prove:

1. Root shell distinguishes loading, empty, ready, reconnecting, and unreachable states.
2. Roster is visible while a conversation is selected; Agent selection is not a `<select>`-only developer surface.
3. Selected Agent header shows identity and Working when the Agent is running.
4. An Agent row reflects running state without requiring that Agent to be currently selected.
5. Per-Agent drafts survive Agent switching.
6. Transcript state does not duplicate or reorder after reconnect/snapshot replacement.
7. Streaming assistant output is visible before Turn settlement.
8. File attachment picker and drag/drop/paste feed the same composer attachment state.
9. Switching Agents does not affect another Agent's running Turn.
10. Transport loss preserves the visible concept that Agents are durable and allows retry/reconnect.

Tests should assert user-observable state and product contracts. They should not assert reconstructed Grok internal module names.

---

## 14. Evidence gaps to investigate before claiming parity

The following need a dedicated evidence pass rather than guesswork:

- exact stop/interrupt control placement and state transitions in the shipped UI;
- exact Agent creation flow and workspace-selection presentation;
- exact upstream semantics for background work when the Desktop window closes;
- exact notification behavior for completed unattended work;
- which activity/tool events are visible in the ordinary conversation versus only in Computer/tool surfaces;
- precise unread-state transition rules;
- initial onboarding/setup screens relevant to a local Pi-native build;
- whether attachment limits and failure copy should be matched exactly or adapted to Pi/local constraints;
- exact visual treatment of an interrupted versus failed Turn.

Until mapped, these remain **Unknown** or pi-sand **Extension** behavior.

---

## 15. Reference file index

Core evidence used in this pass:

```text
PROVENANCE.md

frontend/src/production/ProductionRenderer.tsx
frontend/src/production/model.ts

frontend/src/recovered/features/window-chrome/root-shell-state.tsx
frontend/src/recovered/features/root-resilience/connection-state.tsx
frontend/src/recovered/features/roster/status.tsx
frontend/src/recovered/features/roster/reconnect-notice.tsx
frontend/src/recovered/features/roster/selection-state.ts

frontend/src/recovered/features/conversation/workspace/sidebar.tsx
frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts
frontend/src/recovered/features/conversation/workspace/chat-header.tsx
frontend/src/recovered/features/conversation/workspace/transcript.tsx
frontend/src/recovered/features/conversation/workspace/conversation-workspace-controller.ts
frontend/src/recovered/features/conversation/workspace/model.ts
frontend/src/recovered/features/conversation/workspace/composer.tsx
frontend/src/recovered/features/conversation/workspace/draft-state.ts
frontend/src/recovered/features/conversation/workspace/desktop.ts
frontend/src/recovered/features/conversation/workspace/view.css
```

This list is intentionally narrower than the reconstructed repository's feature tree. It is the evidence base for the first core Agent conversation journey, not an inventory of everything Grok Bot 0.18 contains.

---

## 16. Translation rule for future research

For every new Grok-derived feature, record:

```text
User-visible behavior
      ↓
Evidence class
      ↓
Artifact/reconstruction anchor
      ↓
What pi-sand must reproduce
      ↓
What is implementation-specific and must NOT be copied
      ↓
Observable compatibility test
```

That keeps the direction stable:

> **Grok Bot 0.18 defines the visible product language. Pi defines the intelligence. pi-sand owns persistence, routing, presentation, and process boundaries.**
