# Roadmap: reuse-first path to v1

- **Status:** Future-facing planning document
- **Written against:** `main` at `7358e6e50dfc01acbb4f90b1c83a90bfc61281f2` while v0.4 is in progress
- **Architecture:** ADR-0001 (reuse-first boundary) + ADR-0002 (Thin Responsibility Kernel)
- **Current release authority:** Issue #48 is the v0.4 architecture/spec authority; current source/tests and PR #62 are authoritative for current implementation facts
- **Next release spec:** `docs/specs/v0.5-conversation-to-commitment.md`

This roadmap describes desired product capabilities and the pi-sand-specific semantic surface. Infrastructure candidates are intentionally non-authoritative and must be revalidated when each version is specified.

The product target is:

> **One Chat Box Autonomous Agent Runtime**

Normal user-facing primitives should trend toward:

```text
Message
Question
Approval
Result
Artifact
```

The primary product metric is how often the user must re-enter the loop before the requested outcome is actually complete.

The governing architecture boundary is:

```text
Pi                         = Agent Engine
Pi ecosystem + mature OSS = live mechanics and infrastructure
pi-sand                    = durable autonomous responsibility semantics
```

And:

> **Pi executes. Skills describe procedure. Trackers may organize planning. Models may propose. pi-sand owns durable responsibility and authority.**

## v0.4 — Leave-and-return Coding Commitment

Finish the current architecture without using this roadmap or ADR-0002 to reopen it.

The release should preserve the v0.3 lifetime/process/Git/IPC invariants while establishing the v0.4 responsibility kernel required by Issue #48: Commitment, Completion Contract, exact candidate verification, Evidence, external wait/wake, bounded continuation/repair, and durable Result delivery.

No post-v0.4 dependency, framework, schema, or architecture migration is a v0.4 release requirement.

## Post-v0.4 bridge — isolate mechanics without relocating semantics

Before large new capabilities, prefer small refactors that make reuse safe while preserving authoritative database and correctness transaction ownership.

Candidate work:

- isolate GitHub transport behind a narrow observation adapter, after a small `gh api` vs Octokit spike;
- split growing runtime-store code by semantic/integration boundary without changing critical transaction ownership;
- add explicit database doctor/integrity/migration discipline;
- introduce execution/environment interfaces only when the next concrete strategy requires them.

These are sequencing candidates, not v0.4 or automatic v0.5 requirements.

## v0.5 — Conversation → Commitment + Authority Fencing

**Product capability:** normal conversation can safely create and change durable responsibility while autonomous coding execution is already in flight.

The primary release spec is `docs/specs/v0.5-conversation-to-commitment.md`.

The release should prove one vertical coding journey:

```text
“修好 issue #27，测试过告诉我”
-> admitted Commitment + skeletal Completion Contract

“不要修改数据库 schema”
-> durable control before execution steer
-> affected work explicitly revalidated/invalidated
-> stale incompatible output cannot cross authority boundary

“reconnect 也测一下”
-> proof contract elaborates without silent scope expansion
-> compatible work survives

crash/restart
-> current responsibility survives
-> stale AttemptRun cannot regain mutation/effect authority

exact merge candidate abc123
-> HumanGate(candidate=abc123)

“可以”
-> approval applies only to the exact current candidate

current applicable Evidence
-> immutable Result snapshot

failed/ambiguous return delivery
-> same Result
-> fresh delivery generation
-> no implementation re-execution
```

v0.5 should own only the minimum semantics required to prove:

- proposal-only conversation interpretation and admission/control boundary;
- user-grounded outcome/constraints/authority;
- skeletal and progressively elaborated Completion Contract;
- durable control-before-steer semantics;
- explicit affected-work retain/revalidate/invalidate behavior;
- ingress authority-release barrier for RemoteEffect transmission and Result sealing;
- exact AttemptRun ownership/recovery fencing;
- exact HumanGate/candidate applicability;
- stale producer provenance without stale mutation authority;
- accepted current Evidence;
- immutable snapshot-based Result sealing;
- Result/ResultDelivery separation;
- explicit non-success Commitment closure.

Reuse Pi AgentSession/history/context/compaction/steer/follow-up/Skills/tool-loop mechanics. Do not build a second context manager, conversation database, Skills loader, or orchestration agent framework.

The first implementation may support zero/one active Commitment plus one exact HumanGate. Sophisticated multi-Commitment pronoun routing is not a v0.5 release criterion.

## v0.6 — Environment + Browser + Download + Artifact

**Product capability:** apply the already-proven responsibility/control kernel to the first supported non-coding execution environment.

pi-sand should own only:

- durable Environment identity/generation/lifecycle/reconciliation required by the supported journey;
- browser/profile ownership semantics;
- Artifact identity, hash, provenance, media type, retention, and delivery semantics where v0.5/v0.4 do not already provide them;
- Evidence binding to exact browser/environment work;
- concrete human takeover/credential Gates required by the supported flow;
- exact external-effect reconciliation where browser/environment work creates effects;
- a minimal deterministic ExecutionStrategy choice once more than one strategy actually exists.

Current infrastructure candidates include Playwright for browser mechanics and host/container/VM backends for Environment mechanics. The v0.6 spec must choose the smallest operationally credible combination; this roadmap does not lock Docker, Gondolin, or any other backend as mandatory.

Do not re-solve Conversation → Commitment in this release. Do not build a custom browser driver, browser platform, container runtime, generic plugin system, generic ResourceLease taxonomy, or large execution router.

## v0.7 — Minimal Dynamic WorkRef Ledger

**Product capability:** one accepted Commitment can dynamically expand into bounded dependent admitted work without exposing a workflow system to the user.

The minimum proof is:

```text
A accepted
-> B runnable

B discovers prerequisite C
-> proposal
-> admit C
-> B explicitly blocked

C accepted
-> B runnable

B accepted
-> current Commitment proof satisfied
-> Result
```

Start with:

```text
max_parallel = 1
```

pi-sand should own only the execution-semantic shadow required for correctness:

- minimal WorkRef/admitted-work identity;
- immutable/admitted work-spec reference or digest;
- admitted blocker binding;
- current validity basis/generation;
- exact current Attempt ownership relation;
- accepted Result/Evidence refs;
- dynamic work proposal/admission;
- cancel/supersede/revalidation;
- restart recovery.

The ready set should be a deterministic predicate over admitted blockers, Wait/HumanGate/control holds, budget/concrete resource availability, validity, and current Attempt ownership. Do not ask an LLM whether a WorkRef is mechanically ready.

External trackers may own planning narrative, criteria authoring, dependency editing, comments, subissues, visualization, and planning UI. Tracker state must be admitted before controlling execution. Do not duplicate a rich tracker/workboard inside pi-sand.

A deterministic timed/external wake path may be added when a concrete v0.7 journey needs it, but recurrence grammar or a general scheduler is not a release criterion for the minimal WorkRef proof.

Do not introduce a generic workflow engine, TaskRequirement framework, JoinSpec subsystem, AgentMessage bus, or generic ResourceLease abstraction unless the minimal journey proves the smaller semantics insufficient.

## v0.8 — Experience + Knowledge + Search

**Product capability:** verified outcomes can inform later work through inspectable, provenance-bearing knowledge rather than opaque transcript replay.

Prefer existing primary sources:

```text
specs
tickets
ADRs
research Artifacts
Evidence
Results
```

pi-sand should own only:

- Experience/Knowledge semantics that concrete retrieval use cases require;
- claim/provenance/confidence/supersession when needed;
- scope and retention policy;
- retrieval policy and evaluation;
- feedback from verified outcomes.

Prefer authoritative rows/documents plus rebuildable derived indexes. Current candidates are SQLite FTS5/trigram first, with vector indexing only if measured retrieval failures justify it.

Do not build an "AI memory platform" or make a derived vector index the sole source of truth.

## v0.9 — Gated Skill Promotion

**Product capability:** repeated verified experience can become a reusable procedure without silently granting a model authority to mutate its active operating rules.

Pi remains the canonical Skill representation/discovery/loading layer.

pi-sand should own only the promotion authority required by the concrete journey:

```text
verified outcome / Experience
-> candidate Skill change
-> versioned evaluation / evidence
-> risk/policy gate
-> versioned promotion
-> rollback / disable
```

An Attempt that depends on a Skill must be able to identify/freeze the relevant Skill version/capability basis strongly enough for recovery/reproducibility.

Do not create a parallel Skills runtime or allow unconstrained self-modification of active Skills.

## v0.10 — Bounded Multi-worker + Computer maturation + optional channel

**Product capability:** raise bounded concurrency only after the single-owner WorkRef semantics are proven.

Reuse Pi/subagent/subprocess mechanics for bounded worker execution where they fit.

Prove concrete cases for:

- multiple simultaneous WorkRef claims;
- bounded fan-out;
- concrete resource/worktree/Environment conflicts;
- targeted cancellation;
- independent verification where required;
- crash/restart recovery with more than one live execution owner;
- retained Computer/Environment/manual takeover only where product journeys justify it;
- at most one optional additional communication surface if demonstrated demand justifies it.

Multi-agent is a scheduling consequence, not an architecture mode. Do not require persistent named supervisor bots, a general AgentMessage subsystem, partial-join engine, learned topology, or open-ended agent societies without concrete proof.

## v1 — One Chat Box outcome UX and hardening

Focus on the product promise rather than another infrastructure layer:

- high-quality default admission;
- reliable leave-and-return execution;
- user messages that change responsibility without babysitting workflow;
- quiet/progress communication policy;
- precise Questions/Approvals/HumanGates;
- Artifact and verified Result delivery;
- crash/restart recovery and acknowledgement;
- packaging and doctor tooling;
- observability that never becomes business authority;
- measured reduction in user re-entry.

## Architecture consolidation

The roadmap intentionally collapses mechanisms that do not deserve independent product/runtime layers:

- Conversation → Commitment moves to v0.5 because durable user control is more foundational than adding a new Environment backend.
- Environment/Computer semantics begin in v0.6 and mature incrementally.
- Execution strategy selection is a small policy under concrete execution needs, not a standalone subsystem/release.
- Work/ready set is a real scheduler primitive; Attention and Effect frontiers remain queries/policies/projections unless implementation evidence requires more.
- Scheduling/wake mechanics remain narrow and release-driven, not a general scheduler.
- v0.8 is semantics plus search/index reuse, not a memory platform.
- v0.9 is promotion authority over Pi Skills, not a Skills runtime.
- model/orchestration cognition is replaceable policy; no permanent cheap-orchestrator architecture is assumed.

## Persistent non-goals through v1

Unless a concrete release requirement falsifies ADR-0001/ADR-0002, do not build:

- a second Agent Engine or provider/model stack beside Pi;
- a second conversation/context/compaction/Skill runtime;
- a custom browser driver;
- a container/VM/isolation runtime;
- a universal workflow/semantic graph;
- a rich internal tracker/workboard that duplicates external planning systems;
- generic GraphMutation, TaskRequirement, or JoinSpec languages;
- mandatory ControlImpactReceipt chains;
- a universal generation/compatibility manager;
- generic ResourceLease before concrete ownership conflicts require it;
- permanent Planner/Clarifier/Reviewer/orchestrator Agent personas;
- automatic inferred social follow-up commitments;
- a generic cron scheduler;
- a broad plugin/channel SDK;
- a vector-first memory platform;
- open-ended multi-agent societies;
- a desktop shell before the autonomous runtime itself is reliable.
