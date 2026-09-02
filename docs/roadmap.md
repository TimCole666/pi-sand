# Roadmap: reuse-first path to v1

- **Status:** Future-facing planning document
- **Current release authority:** Issue #48 is the v0.4 architecture/spec authority; current source/tests and PR #62 are authoritative for current implementation facts
- **Proposed next release:** PR #73 / `docs/specs/v0.5-one-chat-responsibility.md`

The product target is no longer a plan to build another full Agent runtime or a simpler clone of Grok Bot.

It is:

> **One chat box that accepts responsibility while reusing existing Agent/Computer/host mechanics.**

The primary product metric remains how often the user must re-enter the loop before the requested outcome is actually complete.

## v0.4 — Leave-and-return Coding Commitment

Treat v0.4 as correctness/implementation evidence, not automatic architectural inheritance.

Issue #48 and PR #62 explored a broad failure-semantics design: Commitment, Completion Contract, Evidence, Wait/RemoteEffect/ResultDelivery, repair and recovery. Those semantics remain useful evidence, but later versions must re-justify each concept rather than preserve it by sunk cost.

## v0.5 — One-Chat Responsibility Boundary

**Product capability:** through one Telegram private chat, a user can hand over one coding outcome, correct it while work is live, leave and return, and trust that stale execution cannot newly publish to GitHub or authoritatively say the old request is complete.

The v0.5 correctness stack is intentionally specific:

```text
Telegram 1:1
-> OpenClaw protected host contract
-> official Codex app-server under a pinned descendant-containing execution profile
-> one protected GitHub publication path
-> Telegram authoritative final delivery
```

OpenClaw is a correctness/enforcement testbed, not the permanent product host. Codex is an executor, not the product identity.

pi-sand should own only the irreducible responsibility semantics proven necessary by the release:

```text
Obligation
current_revision
InputDecision
```

The host should own durable ingress generation, current canonical turn identity, writer containment/quiescence, GitHub capability/reconciliation, and final delivery.

A responsibility-changing correction uses a fresh canonical Codex turn because same-turn steer does not currently provide sufficient descendant provenance for protected authority.

The protected workspace writer surface is closed-world. Codex-native shell/file execution is allowed only under a pinned process-containment profile whose teardown proves that no descendant workspace writer survives old-turn retirement. Uncontained profiles fail closed. Unknown workspace-mutating dynamic tools are incompatible with protected mode.

GitHub publication is the only protected consequential-effect family in v0.5. Local publication-side Git mutations, remote push, and PR creation must be current-authority fenced at their actual mutation boundary or isolated from the current authoritative workspace. Pending recovery state capable of later mutation counts as a live writer capability.

Completion stays thin: reuse existing facilities to observe explicit required facts (for example CI pass), and gate only whether the current completion candidate may authoritatively represent the current responsibility. Actual Telegram final dispatch is host-gated under current authority.

Do not add/revive:

```text
scheduler / DAG / worker pool
multi-Goal queue
generic multi-agent runtime
generic Effect/Evidence/Result frameworks
Supervisor daemon
generic filesystem/process-containment runtime
second transcript/context system
GitHub transport/credential stack
host portability framework
```

## After v0.5 — evidence-driven, not capability-ladder driven

Do not precommit pi-sand to building Browser, Computer, Memory, Skills, multi-agent orchestration, scheduler, knowledge platform, or channel SDK releases merely because those capabilities might be useful in an Agent product.

Those capabilities already exist in hosts such as OpenClaw, Hermes, Grok Bot and other Agent/Computer systems. Prefer using them.

For every future proposal, ask in this order:

1. What user responsibility invariant is missing from existing hosts/executors?
2. Can the host/runtime own the required mechanic instead?
3. Can pi-sand own only the semantic decision and delete everything else?
4. What evidence would prove pi-sand itself is no longer necessary?

A future host may be OpenClaw, Hermes, Grok Bot, or something else. Host selection is an independent axis from the responsibility semantics and executor choice. Do not design a Universal Host Interface before a second concrete host proves a real shared seam.

## Long-term product shape

The desired experience remains extremely small:

```text
User: 帮我把这个修好，CI 过了告诉我。
System: 好。

User: 不要改 schema。
System: 收到。

... user leaves ...

System: 已完成。
```

The user should not have to understand:

```text
Agent identity
dataflow/workflow
runtime
worker topology
computer placement
model routing
scheduler
```

If a future host natively provides durable responsibility admission, correction/current-authority semantics, stale capability fencing and truthful completion behind this one-chat UX, pi-sand should shrink further or disappear.

## Persistent non-goals

Unless concrete release evidence proves otherwise, do not build:

- another general Agent Engine;
- a custom browser/computer platform;
- a container/VM/process-containment runtime;
- a generic workflow engine or scheduler;
- a broad provider/router abstraction;
- a broad plugin/channel SDK;
- a custom Skills loader;
- a vector-first memory platform;
- open-ended multi-agent societies;
- a rich internal tracker/workboard;
- generic Effect/Evidence/Result/Reviewer frameworks;
- a desktop shell merely to own the product surface.
