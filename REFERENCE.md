# pi-sand Grok Bot 0.18 Reference Map

Status: **Non-normative evidence ledger**

This document is the evidence companion to `SPEC-v0.1.md`.

Its job is to record what user-visible Grok Bot 0.18 behavior is actually supported by inspectable evidence, what remains uncertain, and where that evidence lives.

It does **not** define v0.1 release scope. `SPEC-v0.1.md` is the normative product specification.

A reference behavior being real does not automatically make it a v0.1 requirement. Likewise, a recovered source file or internal name does not justify copying Grok Bot's architecture.

## Evidence policy

Primary reference repository:

`b-nnett/grok-bot-0.18-reconstructed`

Reference repository commit:

`a9f633e09d49a85829b8236331b9e21f7e612634`

All reconstruction file paths and source anchors in this ledger resolve against that pinned commit unless explicitly stated otherwise.

Primary upstream release represented by that repository:

- Product: Grok Bot
- Version: 0.18.0
- macOS bundle id: `com.anysphere.sand`
- pinned macOS DMG SHA-256: `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb`
- pinned original `app.asar` SHA-256: `6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58`

Source: `b-nnett/grok-bot-0.18-reconstructed/PROVENANCE.md` at the pinned reference commit.

The reference repository explicitly states that the shipped renderer contained optimized production bundles rather than the authored frontend source or original source maps. Its readable `frontend/` tree is therefore a partial evidence-backed reconstruction, not Anysphere's original source.

Evidence classes used here:

- **Observed** — repeatably visible in the shipped product/artifact.
- **Evidence-backed** — supported by shipped strings, CSS, DOM signatures, emitted code, contracts, or explicit reconstruction anchors.
- **Inferred** — plausible but not strong enough to constrain parity.
- **Unknown** — not sufficiently mapped.
- **Extension** — intentional pi-sand behavior rather than an upstream Grok claim.

The governing rule is:

> **Desktop-observable behavior is compatibility authority; reconstructed implementation structure is not.**

## Core shell evidence

### Two-pane Agent roster + conversation workspace

**Evidence strength:** Evidence-backed

The reconstructed production renderer lays out a persistent sidebar column next to a conversation column and mounts `ConversationSidebar` as the roster owner.

Useful anchors:

- `frontend/src/production/ProductionRenderer.tsx`
- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
- `frontend/src/recovered/features/conversation/workspace/view.css`

Evidence-backed geometry includes roughly:

- roster header: 50 px high;
- conversation header: minimum 51 px high;
- expanded Agent row: minimum 58 px high;
- transcript reading width centered around approximately 690 px;
- composer shell: rounded standalone input surface with 16 px radius.

These geometry observations are implementation/reference notes, not mandatory pixel values for pi-sand.

### Roster states

**Evidence strength:** Evidence-backed

The recovered roster explicitly contains states corresponding to:

- `Connecting to your computer…`
- `No saved agents yet.`
- `Can’t reach your computer`
- Retry / Retrying
- `Reconnecting to your computer…`

Anchors:

- `frontend/src/recovered/features/roster/status.tsx`
- `frontend/src/recovered/features/roster/reconnect-notice.tsx`
- `frontend/src/recovered/features/root-resilience/connection-state.tsx`

The semantic point is stronger than the exact copy: temporary reachability failure is presented as a connection problem, not as loss of saved Agents.

## Agent roster evidence

### Agent row identity and preview

**Evidence strength:** Evidence-backed

Agent rows carry identity and recent-conversation information rather than only workspace metadata.

Recovered projections include:

- Agent name;
- avatar/identity marker;
- draft preview when a draft exists;
- waiting reason when present;
- otherwise recent message/entry preview;
- updated recency;
- running/attention/unread visual state.

Anchors:

- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx`
- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`
- `frontend/src/production/model.ts`

The row-detail priority in the reconstructed sidebar is effectively draft → waiting reason → recent message.

### Working / Needs attention / Unread activity presentation

**Evidence strength:** Evidence-backed for visual states; semantics partially unknown

The recovered sidebar status projection distinguishes:

- `Working`
- `Needs attention`
- `Unread activity`

and gives attention/unread precedence over ordinary running presentation in some layouts.

Anchor:

- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`

**Important gap:** exact unread transition rules are not sufficiently mapped for pi-sand parity. Likewise, a stable Pi request-for-user-input/waiting seam has not yet been established. These visuals are real reference evidence, but their complete runtime semantics remain non-normative until independently proven.

## Selection evidence

### Last selected Agent persistence

**Evidence strength:** Evidence-backed

The recovered client persists the last selected Agent and restores/reconciles it against the complete roster, including fallback when the previous Agent is no longer available.

Anchor:

- `frontend/src/recovered/features/roster/selection-state.ts`

The recovered state is explicitly client-persisted. This is evidence that selection is presentation state, separate from Agent execution ownership.

## Conversation header evidence

### Agent identity + Working

**Evidence strength:** Evidence-backed

The recovered header directly projects:

- Agent avatar;
- Agent name;
- `Working` when `isRunning` is true.

Anchor:

- `frontend/src/recovered/features/conversation/workspace/chat-header.tsx`

The header also contains evidence for settings/details and a Computer control, but those surfaces are not automatically core parity requirements.

## Transcript evidence

### Conversation entries

**Evidence strength:** Evidence-backed

The recovered conversation workspace is a structured transcript rather than a raw process log. The model and transcript view support ordinary user/assistant messages plus richer entry types.

Anchors:

- `frontend/src/recovered/features/conversation/workspace/model.ts`
- `frontend/src/recovered/features/conversation/workspace/transcript.tsx`
- `frontend/src/production/model.ts`

Evidence includes stable entry/message IDs, streaming message state, delivery state, attachments, reply metadata, tool-call representations, and multiple richer card types.

For pi-sand, the important evidence is that product transcript and execution/activity presentation are distinct concepts. It does not imply that every Grok entry type must be reproduced.

### Reply UI

**Evidence strength:** Evidence-backed

The recovered workspace contains reply selection, reply previews, navigation, and submission projection.

Anchor:

- `frontend/src/recovered/features/conversation/workspace/conversation-workspace-controller.ts`

**Gap:** the evidence supports the UI/product concept, but pi-sand's exact Pi-context semantics for a reply are not yet proven. Reply parity therefore remains a candidate surface rather than a release requirement unless promoted in `SPEC-v0.1.md`.

## Composer evidence

### Structured composer

**Evidence strength:** Evidence-backed

The recovered composer is substantially richer than a plain textarea. Evidence supports:

- ordinary text prompting;
- explicit send action;
- file picker;
- drag/drop files;
- pasted files;
- attachment chips and removal;
- reply pill/context;
- rich-text editor;
- voice/dictation UI;
- attachment failure notices;
- maximum composer attachment count of 6 in the recovered model.

Anchors:

- `frontend/src/recovered/features/conversation/workspace/composer.tsx`
- `frontend/src/recovered/features/conversation/workspace/model.ts`
- `frontend/src/recovered/features/conversation/workspace/desktop.ts`
- `frontend/manifests/conversation-evidence.json`

The reconstructed default placeholder includes `Ask anything, or drop a file.`; exact wording is not itself an architectural requirement.

### Per-Agent draft persistence

**Evidence strength:** Evidence-backed

The recovered draft store is explicitly client-persisted and keyed per Agent, including draft/recovery state and restoration across client lifecycle. Attachment references are part of the persisted draft object.

Anchor:

- `frontend/src/recovered/features/conversation/workspace/draft-state.ts`

This evidence supports keeping unsent drafts as Desktop-owned presentation state rather than treating them as authoritative service execution state.

### Attachment staging

**Evidence strength:** Evidence-backed for upstream product flow

The recovered Desktop bridge stages selected file bytes and later commits staged attachments.

Anchor:

- `frontend/src/recovered/features/conversation/workspace/desktop.ts`

The upstream flow supports the existence of a staged → committed lifecycle, but pi-sand's storage layout, staged-byte lifetime, and Pi handoff are independent product design choices governed by `SPEC-v0.1.md`.

## Working/activity evidence

**Evidence strength:** Evidence-backed at the product-state level; exact Pi mapping is independent

Recovered Agent models expose fields such as:

- `isRunning`
- `isComposingMessage`
- `awaitingUserResponse`
- `currentActivity`

Anchors:

- `frontend/src/recovered/features/conversation/workspace/chat-header.tsx`
- `frontend/src/production/model.ts`
- `frontend/src/recovered/features/conversation/workspace/sidebar-agent-status.ts`

This is good evidence that Grok Bot's visible experience distinguishes more than a simple terminal completed/not-completed bit.

It is **not** evidence that pi-sand should invent activity semantics that Pi does not expose reliably. Exact Pi-event → product-activity translation remains a pi-sand integration decision.

## Root shell / navigation evidence

**Evidence strength:** Evidence-backed

The recovered root shell includes explicit empty/loading/fatal-error states and keyboard/selection navigation helpers.

Anchor:

- `frontend/src/recovered/features/window-chrome/root-shell-state.tsx`

Examples include `No chats yet`, a setup/loading state, previous/next Agent navigation, indexed Agent selection, and history-like back/forward selection navigation.

These are real surfaces; exact shortcut parity is not automatically part of v0.1.

## Larger recovered surfaces

**Evidence strength:** Evidence-backed existence, not automatically v0.1 scope

The recovered frontend feature tree contains many additional areas, including:

- Agent info/settings;
- automations;
- Computer;
- hidden chats;
- onboarding;
- org chart;
- permissions;
- plugins;
- account/access;
- deep links;
- feedback;
- shared rooms/groups;
- command palette and more.

Their existence is useful mapping evidence. None becomes a v0.1 requirement unless `SPEC-v0.1.md` explicitly promotes it.

## Reference-repository extensions that are not upstream parity evidence

The reconstruction project also adds its own experiments, including an inference router, routed Claude/Codex/OpenRouter support, local usage tracking, and optional local Docker sandboxing.

These are reconstruction-project extensions, not Grok Bot 0.18 parity requirements for pi-sand.

## Intentional pi-sand Extensions

The following important product behaviors come from pi-sand's own product/architecture goals rather than a strict Grok parity claim:

- Desktop close does not cancel active work while the Local Agent Service remains alive;
- reconnect reconciliation preserves authoritative transcript identity/order without duplication;
- one Agent has at most one running Turn;
- one canonical workspace has at most one running Turn;
- independent Agents in independent canonical workspaces may run concurrently;
- workspace identity uses canonical real filesystem paths;
- service restart explicitly terminalizes persisted running Turns without replay/adoption;
- attachment durability and Pi handoff use a pi-sand-owned product contract;
- Pi remains the reasoning/runtime owner while pi-sand owns durable product state.

Whether any of these resembles upstream behavior is secondary; their release status comes from `SPEC-v0.1.md`, not this evidence ledger.

## Known evidence gaps

These remain **Unknown** or insufficiently mapped and must not become Grok parity requirements by intuition:

- exact upstream Desktop-close/background-execution semantics;
- exact Agent creation + workspace-selection presentation;
- exact stop/interrupt control placement and copy;
- exact unread transition rules;
- exact awaiting-user-response interaction and response path;
- exact failed-vs-interrupted visual treatment;
- exact activity/tool-event placement inside or around the transcript;
- completion/terminal desktop-notification behavior;
- which reference behaviors depend on remote/cloud infrastructure unavailable to a local Pi-native implementation.

If one of these matters to a future ticket, first gather evidence and update this ledger. Then decide release scope in the spec.

## Clean-room rule

Reference evidence may create:

- a behavioral requirement in the spec;
- a compatibility test;
- a screenshot/state record;
- a research note.

Reference evidence must not, by itself, create an internal pi-sand component or justify copying reconstructed implementation code, proprietary assets, or recovered source organization.

The immutable user-facing behavior is what matters.