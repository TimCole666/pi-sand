# Roadmap: reuse-first path to v1

- **Status:** Future-facing planning document
- **Written against:** `main` at `1caed4014b3552d0d12791489122daef7dfaceff` while v0.4 is in progress
- **Current release authority:** Issue #48 is the v0.4 architecture/spec authority; current source/tests and PR #62 are authoritative for current implementation facts

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

## v0.4 — Leave-and-return Coding Commitment

Finish the current architecture without using this roadmap to reopen it.

The release should preserve the v0.3 lifetime/process/Git/IPC invariants while establishing the v0.4 responsibility kernel required by Issue #48: Commitment, Completion Contract, exact candidate verification, Evidence, external wait/wake, bounded continuation/repair, and durable Result delivery.

No post-v0.4 dependency or framework migration is a release requirement.

## Post-v0.4 bridge — isolate mechanics without relocating semantics

Before large new capabilities, prefer small refactors that make reuse safe while preserving the authoritative database and correctness transactions.

Candidate work:

- isolate GitHub transport behind a narrow observation adapter, after a small `gh api` vs Octokit spike;
- split the growing runtime store by semantic/integration boundary without changing critical transaction ownership;
- add explicit database doctor/integrity/migration discipline;
- evolve durable Result delivery toward typed communication records as real use cases appear;
- introduce execution/environment interfaces only when a second implementation is imminent.

These are sequencing candidates, not v0.4 requirements.

## v0.5 — Environment + Browser + Download + Artifact

**Product capability:** pi-sand can perform supported browser work, preserve the relevant workspace/profile state, collect downloads/evidence, and return durable Artifacts without making browser-process lifetime equal responsibility lifetime.

pi-sand should own only:

- durable Environment identity/lifecycle/reconciliation needed by the supported journey;
- browser/profile ownership semantics;
- Artifact identity, hash, provenance, media type, retention, and delivery semantics;
- Evidence binding to exact browser/environment work;
- human takeover/credential gates required by supported flows;
- a minimal deterministic execution-strategy choice once more than one strategy exists.

Current infrastructure candidates include Playwright for browser mechanics and host/container/VM backends for Environment mechanics. The v0.5 spec must choose the smallest operationally credible combination; this roadmap does not lock Docker, Gondolin, or any other backend as mandatory.

Do not build a custom browser driver, browser platform, container runtime, generic plugin system, or large execution router.

## v0.6 — Automatic Admission + Context Reconstruction + Human Gates

**Product capability:** a normal user can hand over an eligible goal without manually constructing runtime objects, and pi-sand can reconstruct the durable responsibility context after waits/restarts without replaying a Manager transcript.

Prefer Pi ResourceLoader, AGENTS/context discovery, Skills, prompts, Session behavior, and compaction for ordinary live context mechanics.

pi-sand should own only:

- automatic Commitment admission policy;
- Completion Contract synthesis/validation policy;
- a bounded Context Receipt describing selected durable facts/resources;
- wake-reason identity;
- typed human-gate semantics;
- typed communication envelopes;
- secret/redaction policy.

Do not build a second Skills loader, context graph, transcript store, compactor, or prompt registry.

## v0.7 — Dynamic Work Ledger + External Wake/Routine

**Product capability:** one accepted responsibility can evolve into bounded dependent work and resume from deterministic external/timed conditions without exposing a workflow system to the user.

pi-sand should own:

- remaining responsibility and durable work identity;
- dependency/readiness semantics;
- parent/child responsibility relation;
- responsible AttemptRun/worker association;
- budgets and bounded retries;
- exact external wait identity;
- due/wake claims and catch-up semantics;
- effect of child work on the parent Completion Contract.

Reuse SQLite transaction/index mechanics, Pi fresh workers, and proven scheduler claim/catch-up designs. If human recurrence expressions are needed, use a focused parser rather than building cron grammar.

The v0.7 release spec must choose the smallest product journey that proves bounded dependent work plus one deterministic timed or external wake path. Recurrence grammar is optional unless that journey requires it.

Do not introduce a generic workflow engine, distributed queue, or scheduler service.

## v0.8 — Experience + Knowledge + Search

**Product capability:** verified outcomes can inform later work through inspectable, provenance-bearing knowledge rather than opaque transcript replay.

pi-sand should own:

- Experience event semantics;
- Knowledge claim/provenance/confidence/supersession;
- scope and retention policy;
- retrieval policy and evaluation;
- feedback from verified outcomes.

Prefer authoritative rows/documents plus rebuildable derived indexes. Current candidates are SQLite FTS5/trigram first, with vector indexing only if measured retrieval failures justify it.

Do not build an "AI memory platform" or make a derived vector index the sole source of truth.

## v0.9 — Gated Skill Promotion

**Product capability:** repeated verified experience can become a reusable procedure without silently granting the model authority to mutate its active operating rules.

Pi remains the canonical Skill representation/discovery/loading layer.

pi-sand should own the promotion pipeline:

```text
verified outcome / Experience
-> candidate Skill change
-> versioned evaluation / evidence
-> risk/policy gate
-> versioned promotion
-> rollback / disable
```

Do not create a parallel Skills runtime or allow unconstrained self-modification of active Skills.

## v0.10 — Bounded Multi-worker + Retained Computer + Optional Channels

**Product capability:** pi-sand can fan a responsibility out to a small number of explicit worker roles, retain useful Environment/Computer state where justified, mediate collaboration, and optionally communicate through one additional surface without exposing worker topology as the product.

Reuse fresh Pi subprocess/subagent mechanics for worker execution.

pi-sand should own:

- durable child responsibility;
- budgets and capability constraints;
- allowed inter-worker communication;
- worktree/Environment leases;
- merge/join/conflict policy;
- shared Evidence and Supervisor completion authority;
- retained Environment/Computer ownership and manual-takeover semantics;
- durable channel delivery policy/receipts if a channel ships.

Start with a few explicit roles such as researcher, implementer, and verifier/reviewer. "Emergence" is not a release criterion.

A remote/channel path is optional, not a v0.10 release criterion. If demonstrated demand justifies one, add at most one path and do not import a broad channel/Gateway runtime by default.

## v1 — One Chat Box outcome UX and hardening

Focus on the product promise rather than another infrastructure layer:

- high-quality default admission;
- reliable leave-and-return execution;
- quiet/progress communication policy;
- precise Questions/Approvals/HumanGates;
- Artifact and verified Result delivery;
- crash/restart recovery and acknowledgement;
- packaging and doctor tooling;
- observability that never becomes business authority;
- measured reduction in user re-entry.

## Roadmap consolidation

The previous future roadmap treated Persistent Environment/Native Computer and ExecutionStrategyRouter as standalone late releases.

This roadmap folds those concepts into the versions where they first become necessary:

- Environment/Computer semantics begin with v0.5 browser work and mature incrementally.
- Execution strategy selection is a small deterministic policy introduced when the second strategy exists; it is not a standalone subsystem/release.
- Scheduling is part of the narrow v0.7 wake model, not a general scheduler.
- v0.8 is semantics plus search/index reuse, not a memory platform.
- v0.9 is promotion authority over Pi Skills, not a Skills runtime.

## Persistent non-goals through v1

Unless a concrete release requirement proves otherwise, do not build:

- a second Agent Engine or provider/model stack beside Pi;
- a custom browser driver;
- a container/VM/isolation runtime;
- a generic workflow engine or distributed queue;
- a generic cron scheduler;
- a broad plugin/channel SDK;
- a custom Skills loader;
- a vector-first memory platform;
- open-ended multi-agent societies;
- a desktop shell before the autonomous runtime itself is reliable.
