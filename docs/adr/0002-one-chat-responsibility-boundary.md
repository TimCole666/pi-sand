# ADR-0002: One-Chat Responsibility Boundary

- **Status:** Proposed from source review + responsibility-zero + prototype #65
- **Date:** 2026-09-02
- **Scope:** v0.5 product/authority boundary only
- **Precedence:** ADR-0001 remains the reuse-first policy. Issue #48 / PR #62 remain v0.4 evidence. This ADR supersedes the unmerged architecture candidate in PR #64; do not merge #64 as v0.5 architecture.

## Context

pi-sand started from a product idea close to a simpler Grok Bot: one place where a user can hand work to an AI and leave.

The project then repeatedly discovered that the surrounding mechanics are already better owned elsewhere:

```text
computer / browser / terminal
agent loop
memory / skills
channels
background execution
multi-agent delegation
GitHub transport
```

The reuse-first conclusion is stronger than "use Pi where convenient":

> **Do not build another Agent host.**

The product thesis is:

> **The user gives responsibility, not workflow.**

> **One Chat Box != One Agent != One Runtime. It is one responsibility interface.**

The only remaining candidate for pi-sand-specific value is the responsibility boundary that decides which current execution may still act or declare success for what the system owes the user.

## Decision

v0.5 is a deliberately narrow correctness release.

```text
Telegram private 1:1
        |
        v
OpenClaw
        |
        +-- durable ingress / session authority generation
        +-- canonical Codex lifecycle identity
        +-- protected GitHub publisher
        +-- authoritative Telegram delivery
        |
        +--------------------+
        |                    |
        v                    v
official Codex          pi-sand
app-server              responsibility semantics
```

OpenClaw is the v0.5 correctness/enforcement testbed, not the permanent product host. Codex is the v0.5 coding executor, not the product identity.

v0.5 assumes exactly one active Goal/Obligation in one protected Telegram 1:1 conversation. Multi-Goal behavior is undefined and out of scope.

## pi-sand owns only responsibility semantics

### Obligation

```text
id
current_revision
status
```

An Obligation is:

> **Something the system has accepted and now owes the user.**

### InputDecision

Every durably accepted Telegram input is classified idempotently as one of:

```text
initial_goal
correction
ordinary_question_or_status
```

Minimal durable fields:

```text
input_id
obligation_id
classification
resulting_revision?
```

`revision` is a scalar responsibility epoch, not a separate aggregate/table.

A correction advances `current_revision`. A status/question does not.

pi-sand does not persist a second transcript or copy the exact user message text when the host already owns it durably.

## Host authority generation is distinct from revision

OpenClaw owns:

```text
accepted_generation
admitted_generation
```

Derived state:

```text
input_pending := accepted_generation != admitted_generation
```

Generation answers:

> Has a newer durably accepted user input entered this protected conversation that responsibility admission has not completed?

Revision answers:

> Did the accepted responsibility itself change?

A status question may advance generation while leaving revision unchanged.

## Required Session Authority Owner

A protected session records an explicit required dependency:

```text
required_authority_owner = "pi-sand"
required_authority_contract = <pinned v0.5 contract>
```

This is not a generic policy framework.

For protected sessions, missing/incompatible/unavailable authority owner, storage failure, or required-authority timeout fails closed. The host must never silently downgrade to ordinary fail-open plugin behavior.

The required owner participates only at the responsibility boundaries that need semantic authority:

1. durable input admission;
2. protected GitHub mutation authorization;
3. authoritative final dispatch.

## Durable Telegram acceptance is an authority boundary

The guarantee begins when OpenClaw durably accepts the Telegram update, not when the user taps Send.

For the protected conversation, the host must linearize:

```text
persist/dedupe durable Telegram ingress
+
accepted_generation := accepted_generation + 1
```

before the message is considered durably accepted for the product.

After this point, new protected GitHub mutation and authoritative completion delivery are closed until admission catches up.

An ordinary post-enqueue plugin callback is too late because a crash can occur between durable transport custody and pi-sand observation.

## Corrections retire authority before execution control

Required ordering:

```text
Telegram correction durable
-> accepted_generation advances
-> protected effect/final closed
-> InputDecision commits correction
-> current_revision N -> N+1
-> old canonical turn loses protected authority permanently
-> old execution is retired/settled enough for the authoritative workspace
-> a canonical fresh turn is established on the same Codex thread
-> that exact turn is bound to revision N+1
-> admitted_generation catches up
-> protected authority may reopen
```

Durable user control precedes executor steering/interrupt/restart mechanics.

## Same-turn `turn/steer` is not an authority boundary

Current Codex tool execution does not carry immutable provenance proving which `turn/steer` input causally precedes a tool call when several steers share one turn.

Therefore in v0.5:

> **`turn/steer` may improve behavior, but it never re-grants protected authority after a responsibility revision changes.**

A correction that changes revision uses a fresh canonical native turn on the same thread before protected authority can return.

Authority binds to the canonical native turn identity observed from the lifecycle, not merely the thread, process, OpenClaw run label, or a provisional submission ID.

Every event from a retired turn remains stale forever regardless of arrival order.

## Closed-world protected writer surface

Prototype #65 proved two different facts:

1. OpenClaw keyed routing can keep stale T1 protocol/tool/final traffic from impersonating T2.
2. An arbitrary OpenClaw dynamic-tool handler can ignore cancellation and continue mutating the shared workspace after T2 completes.

A later architecture review found one additional containment requirement: #65 proved Codex-owned background-terminal cleanup, but did not prove that every descendant spawned through a Codex-native shell is necessarily represented by that inventory. "Codex-native" alone is therefore too broad to define a physically closed writer class.

v0.5 does **not** answer either fact by building a generic mutation framework.

Instead the protected profile is closed-world and pinned to a verified process-containment shape.

### Allowed authoritative workspace writers

Only writer classes explicitly verified by the pinned host/runtime contract may exist.

For v0.5:

1. **Codex-native workspace/file/shell execution only under a pinned process-containment profile** whose teardown mechanically proves that no descendant process retaining workspace write capability can survive T1 retirement. The verification must cover descendants, not only Codex's named background-terminal inventory. A profile such as unrestricted `danger-full-access` is incompatible unless an equivalent descendant-containment guarantee is independently proved.
2. **The dedicated Gateway GitHub publication path**, whose local/remote mutation steps are separately authority-fenced or isolated from the authoritative working tree.

The exact containment mechanism is host/runtime-owned. A Linux PID-namespace/process-lifetime sandbox may satisfy the contract if the pinned implementation proves descendant containment and teardown; pi-sand does not prescribe or implement a general sandbox.

### Forbidden in protected mode

```text
uncontained Codex shell/file execution profiles
unknown/third-party dynamic tools with direct workspace write capability
arbitrary host callbacks that can mutate the authoritative workspace
unverified app/MCP/plugin write paths
```

An unknown or uncontained writer is a startup/configuration incompatibility, not something pi-sand attempts to supervise.

Before a fresh turn can gain authority over the same authoritative workspace, the host must establish quiescence for every allowed prior-turn writer capability, including:

```text
Codex process descendants
Codex-owned background terminals
pending publication/recovery state capable of later local workspace mutation
```

If quiescence/containment cannot be proven, protected authority remains closed or the old execution/publication placement must be isolated/retired by host mechanics.

This rule is intentionally narrower than a universal generation-checked filesystem.

## GitHub capability fencing

v0.5 protects one consequential external effect family: GitHub publication.

Codex must not possess an independent GitHub write path:

```text
no GH_TOKEN / GITHUB_TOKEN
no authenticated gh profile
no usable Git credential helper
no SSH private key / SSH_AUTH_SOCK
no write-capable GitHub MCP/App/connector
no mounted operator credential store
```

Use a sandbox/dedicated execution identity/placement so the stale executor physically lacks the credential.

The only protected path is:

```text
Codex
-> OpenClaw github_publish request
-> Gateway authority ordering
-> credential-bearing publisher
-> GitHub
```

The Codex-facing `github_publish` tool is only a Gateway request boundary; it must not grant the model a reusable bearer capability.

## Publication mutation linearization

Creating a durable publication request is not blanket authorization for all later mutations.

Each actual protected mutation step must re-enter current host authority immediately before the step becomes irrevocable. This includes publication-side **local Git mutations** that can alter the authoritative working state, not only remote push/PR creation.

A durable pending publication/recovery record that can later finish a local ref/index/worktree mutation is itself a live writer capability for quiescence purposes; "no publisher process is currently running" is not sufficient.

Conceptually:

```text
claim one-shot mutation authority for
  accepted/admitted generation G
  canonical turn T
  current responsibility revision R
  logical effect key K
  concrete mutation step S
```

If a newer Telegram admission wins first, the claim fails. If the mutation claim wins first, that mutation may occur and later user input cannot retroactively revoke it.

Recovery uses OpenClaw/GitHub durable publication state and remote readback; pi-sand does not build an Effect journal or GitHub reconciliation engine.

`effect_key` remains only the logical/idempotency identity of the same Gateway publication operation across ambiguous recovery. It is not additional pi-sand durable state.

## Completion is a thin semantic gate

Codex saying `done` is a completion candidate, not authoritative completion.

pi-sand only decides whether the candidate may currently represent the responsibility. The gate checks facts such as:

```text
candidate is from the current canonical turn/current revision
no unadmitted Telegram input exists
explicitly required protected GitHub effect is resolved
explicitly requested blocking fact (for example CI pass) is satisfied
```

Existing host/GitHub/Codex facilities provide the operational facts.

Do not build a generic Reviewer, Evidence Framework, Completion DSL, Result aggregate, or ResultDelivery subsystem for v0.5.

The host still takes a one-shot authority claim at the actual authoritative Telegram final-dispatch boundary. A newer durable input that wins first blocks the old final.

## Restart and version posture

A protected session remains protected after restart.

If the required authority owner or pinned host/runtime contract is absent/incompatible:

```text
protected mode refuses to operate
```

Never silently fall back to ordinary hooks or ordinary Codex execution.

v0.5 pins one verified OpenClaw + Codex app-server combination **and one verified process-containment profile** for protected workspace execution. Portability is not promised.

Prototype #65 tested:

```text
OpenClaw ff63da7237e5f99e9fc03a86daf56e3c3e8f5356
Codex    a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67
codex-cli 0.151.0
```

These are evidence coordinates, not a permanent compatibility promise. The release implementation may pin newer revisions, but the authority and containment contract must be re-proved.

## Prototype #65 consequence

#65 returned **REVISE**, not FALSIFIED.

It proved:

- retired T1 traffic can be kept out of the T2 keyed route;
- distinct canonical T2 can be established on the same thread;
- Codex-owned background-terminal cleanup works in the tested path;
- an abort-ignoring arbitrary dynamic-tool callback can still write the workspace late;
- cancellation/route release alone is therefore not a universal side-effect fence.

The follow-up architecture review narrowed the remaining hole further: Codex background-terminal inventory is useful evidence but cannot, by itself, define the whole shell writer class. Protected mode must pin a descendant-containing execution profile and fail closed on uncontained profiles.

The architecture revision remains deliberately bounded:

> **Protected mode uses a pinned contained Codex execution profile plus a verified closed writer surface, and requires host-proven quiescence/isolation before fresh-turn authority admission. pi-sand does not become a runtime supervisor.**

## Explicit non-goals

v0.5 does not add:

```text
scheduler
DAG/workflow engine
multi-Goal queue
worker pool
generic multi-agent runtime
provider router
standalone pi-sand daemon as a required boundary
generic capability broker
generic process-containment runtime
generic dynamic-tool mutation framework
generic Effect framework
generic Evidence/Reviewer framework
memory system
Skills loader
second transcript store
host portability framework
GitHub transport/reconciliation
```

## Null hypothesis

pi-sand should continue to exist only while the host/runtime does not natively provide the responsibility semantics above.

If a host eventually provides durable responsibility admission, revision/current-authority semantics, stale capability fencing, and truthful final acceptance as native concepts, delete pi-sand rather than preserving it for project identity.
