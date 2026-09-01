# ADR-0001: Reuse-first runtime boundary

- **Status:** Accepted
- **Date:** 2026-09-01
- **Scope:** Architecture policy for post-v0.4 design and future specs
- **Current-release precedence:** for v0.4, current source/tests and the actual PR #62 implementation are authoritative for implementation facts; Issue #48 remains the architecture/spec authority; Issue #38 remains the merged v0.3 authority. This ADR is subordinate to all of them for their respective scope.

## Context

pi-sand is a local-first autonomous runtime built on Pi. v0.3 established that foreground conversation belongs to Pi while durable Task/Attempt execution belongs to `pi-sandd`; accepted work must outlive the Pi client. v0.4 extends that foundation toward a durable coding responsibility with Completion Contract, verification, Evidence, external wait/wake, repair, and durable Result delivery.

The project has a one-maintainer constraint. Future roadmap areas such as browser control, environments/sandboxes, scheduling mechanics, search/indexing, channels, Skills loading, remote transport, and worker execution have substantial existing implementations in Pi, Pi Extensions/examples, Pi-aligned projects, peer runtimes, and mature focused OSS.

If pi-sand implements those mechanics as bespoke subsystems, its maintenance surface grows much faster than its differentiated product semantics.

## Decision

The long-term boundary is:

```text
Pi                         = Agent Engine
Pi ecosystem + mature OSS = live mechanics and infrastructure
pi-sand                    = durable autonomous responsibility semantics
```

The governing rule is:

> **Own semantics. Reuse mechanics. Reuse infrastructure. Borrow proven architecture.**

### Pi owns the Agent Engine

Pi owns ordinary live-agent behavior, including:

- provider/model interaction;
- the single-agent model/tool loop;
- `AgentSession` and foreground Session behavior;
- ordinary messages and conversation;
- context-window mechanics and compaction;
- ordinary Skills representation/discovery/loading;
- ordinary tools;
- provider/model/thinking adapters;
- foreground Extension/UI integration.

A Pi Session is execution context, not durable user responsibility.

```text
Pi Session != pi-sand Commitment
```

### pi-sand owns durable autonomous responsibility

pi-sand owns the semantics needed to answer:

- What work has the runtime accepted responsibility for?
- What exact state is required before that responsibility may be discharged?
- Which evidence proves that state?
- Which authority may change the responsibility or declare completion?
- What happens after crashes, ambiguous external effects, stale workers, waits, retries, or user absence?
- What must be durably communicated or delivered when work completes or requires intervention?

The currently established custom core is the durable responsibility semantics proven by #38/#48: Commitment/Task/Attempt/AttemptRun, Completion Contract, completion authority, Evidence and exact-candidate verification, control/contract/capability fencing, external-effect ambiguity/reconciliation, exact wait/wake semantics, recovery, and durable Result delivery.

Future releases may add pi-sand-owned semantics only when a concrete product spec demonstrates a responsibility, authority, identity, recovery, or durable-delivery invariant that Pi or reused infrastructure cannot own.

### Reused infrastructure returns facts, not domain decisions

Dependencies, CLIs, Extensions, peer-derived modules, and external services may execute work and return normalized observations or receipts.

They do not decide pi-sand state transitions.

Example:

```text
GitHub adapter
    -> exact API observations and transport receipts

pi-sand supervisor
    -> validates repository/SHA/selectors
    -> creates Evidence
    -> evaluates Completion Contract
    -> decides wait / repair / discharge
```

The same boundary applies to browser, Environment, worker, channel, scheduler, Git, search, and remote-client adapters.

Vendor-specific objects and lifecycle semantics should stop at the adapter boundary. Durable records should use stable pi-sand identities, normalized facts, receipts, versions, and content hashes.

### Reuse hierarchy

Before implementing nontrivial mechanics, check in this order:

1. Pi Core and the pinned/current Pi package family.
2. Official Pi Extensions and examples.
3. Pi-aligned projects such as `pi-chat` and Gondolin.
4. Stable/separable Hermes or OpenClaw infrastructure or proven technical designs.
5. Mature focused OSS or an existing CLI.
6. A narrow pi-sand implementation only when a pi-sand-specific invariant still requires ownership.

This is a search/evaluation order, not an adoption mandate. A higher-tier candidate may be rejected for correctness, maintenance, license, security, portability, or operational-fit reasons; prefer the smallest candidate that preserves the semantic boundary.

For peer runtimes, prefer:

```text
direct stable package/API
-> CLI/subprocess boundary
-> port one small licensed module with tests and attribution
-> copy technical design
-> copy architecture pattern
-> build custom
```

Do not embed a second Agent Engine beside Pi merely to reuse infrastructure.

Grok Bot/Sand reconstructed source is architecture/product evidence only unless independent rights review establishes a code-reuse basis.

### Durable executor capability must be explicit

The current v0.3/v0.4 coding Fresh Executor is extension-free. That exact process shape is a current-release fact, not a permanent requirement for every future strategy.

The durable invariant is that ambient or arbitrary Extensions must not silently become hidden worker capability. If a future durable worker loads Extensions, the allowed set must be explicit, versioned, and part of the admitted capability fingerprint. Browser, Computer, remote, sandbox, and subagent mechanics may instead use separate execution strategies or host-side adapters when that produces a clearer capability boundary.

This preserves reproducible durable capability without pre-deciding the process shape of future release specs.

### Environment is semantic ownership, not isolation implementation

A future release may introduce a durable `Environment` resource when responsibility must survive across execution backends or retained workspace/profile state.

If it does, pi-sand owns only the stable identity, authority, lifecycle, and reconciliation semantics required by the relevant Commitment. The concrete schema, associations, retention model, capability fields, and first backend belong to that release spec.

pi-sand does not thereby own container, VM, browser, SSH, desktop, namespace, cgroup, seccomp, or network-isolation implementation. Those mechanics should be supplied by replaceable backends.

A future user-facing `Computer` may be a product view over such a resource. A persistent persona/Agent may be useful UX later, but must not become completion authority or replace Commitment as the responsibility root.

### Explicit communication is separate from worker output

Autonomous worker/model output is not automatically user-visible communication or durable delivery.

The preferred boundary is:

```text
worker/model output
    -> runtime observation / state transition
    -> communication policy
    -> typed durable communication / delivery
```

v0.4 Result delivery is the first concrete instance. Message, Question, Approval, Artifact, and other future product shapes belong to the roadmap and their release specs.

If a future release resumes work from multiple causes, it should preserve the reason for that resume as narrow durable identity rather than introducing scheduler authority implicitly. The concrete wake taxonomy belongs to the relevant release spec.

## Current v0.4 non-interference rule

This ADR is deliberately future-facing.

For v0.4, Issue #48 remains the architecture/spec authority, while current source/tests and the actual PR #62 implementation are authoritative for current implementation facts. Do not use this ADR to resolve a #48↔implementation discrepancy or to migrate/refactor the current kernel for reuse purity while v0.4 is converging.

In particular, this ADR does not require v0.4 to adopt:

- Pi protocol/client/server as the local daemon protocol;
- OpenClaw Gateway;
- a new GitHub transport library/CLI;
- Environment/container/sandbox abstractions;
- a query builder or ORM;
- arbitrary Pi Extensions in the coding Fresh Executor;
- a scheduler, workflow engine, memory framework, plugin framework, or second Agent Engine.

If these future-facing recommendations appear to conflict with #48 or the actual v0.4 implementation, resolve that question inside the v0.4 issue/PR process. This ADR must not become an alternate v0.4 conformance authority.

## Consequences

Positive consequences:

- future releases should add more pi-sand semantics than infrastructure mechanics;
- Pi remains the single Agent Engine;
- infrastructure can be replaced behind narrow boundaries;
- external systems cannot accidentally become completion authority;
- one maintainer can focus effort on admission, completion, Evidence, recovery, human gates, Environment ownership, coordination, and user re-entry.

Costs and obligations:

- every adapter needs semantic-boundary and failure-path tests;
- ported/vendored code requires exact source/license/attribution records;
- upstream compatibility must be revalidated when a dependency is actually adopted;
- capability fingerprints must expand when a new strategy/backend changes what a worker can do;
- some peer implementations are useful only as designs because their lifetime root conflicts with Commitment.

## Revisit triggers

Revisit this ADR only when a concrete product or operational fact invalidates the boundary, for example:

- Pi can no longer provide the required Agent Engine boundary;
- the local single-owner runtime is no longer the intended deployment model;
- a remote/multi-host product requirement forces a different authority/transport relationship;
- a reused subsystem must own durable state that cannot remain subordinate to the supervisor;
- measured maintenance/correctness cost proves that a current custom mechanic should move behind a stable upstream implementation.

Do not reopen the boundary merely because a broader agent framework becomes popular or a new dependency exists.
