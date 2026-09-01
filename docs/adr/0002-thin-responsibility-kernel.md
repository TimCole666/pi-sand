# ADR-0002: Thin Responsibility Kernel

- **Status:** Accepted architecture candidate; frozen for v0.5/v0.7 implementation evidence
- **Date:** 2026-09-02
- **Scope:** Post-v0.4 durable responsibility, authority, proof, and delivery semantics
- **Precedence:** ADR-0001 remains the reuse-first boundary. Issue #48 and current source/tests/PR #62 remain authoritative for v0.4. This ADR must not be used to reopen or migrate v0.4 while it is converging.

## Context

ADR-0001 established the reuse-first split:

```text
Pi                         = Agent Engine
Pi ecosystem + mature OSS = live mechanics and infrastructure
pi-sand                    = durable autonomous responsibility semantics
```

Subsequent source-level research and adversarial review tested how thin the pi-sand side can remain while still surviving user corrections, crashes, stale workers, exact approvals, external effects, verification, result sealing, and delivery failure.

The central product thesis is:

> **The user gives responsibility, not workflow instructions.**

And:

> **One Chat Box does not mean one AgentSession, process, worker, or model call. It means one durable relationship between user intent and a verified outcome.**

The runtime therefore needs a hard answer to a narrower question than a general workflow engine:

> What exact current authority basis permits this responsibility-changing, externally visible, or completion-changing transition?

## Decision

pi-sand is a **Thin Responsibility Kernel over Pi**.

> **Pi executes. Skills describe procedure. Trackers may organize planning. Models may propose. pi-sand owns durable responsibility and authority.**

The kernel is intentionally asymmetric. Similar-looking lifecycle concepts do not imply a generic common manager, graph, lease, generation object, or workflow framework.

### Kernel semantic families

The long-term custom semantic surface is limited to these families unless implementation evidence falsifies the boundary:

1. **Commitment** — the outcome pi-sand currently owes.
2. **Intent / Authority Control** — user-grounded outcome, constraints, exclusions, authority, and accepted corrections.
3. **Completion Contract** — what current Evidence must establish before the outcome may be considered satisfied.
4. **WorkRef / Task** — bounded executable responsibility that pi-sand has actually admitted.
5. **Attempt / AttemptRun** — execution episode and exact current execution ownership.
6. **Wait / HumanGate** — durable absence of an external event or an exact user-owned decision.
7. **Artifact / Evidence** — produced information/objects and accepted proof bound to exact candidates.
8. **RemoteEffect** — prepared external mutation, authority release, transmission, receipt/readback, and ambiguity handling.
9. **Runtime causation / provenance** — source identity, idempotency, applicability/version identity, and crash reconciliation where correctness requires it.
10. **Result / ResultDelivery** — canonical proof of satisfied responsibility and separately fenced return to the user.

These are semantic families, not ten required tables or classes.

The **Commitment Supervisor** is the logical fenced authority that admits responsibility and commits responsibility-semantic transitions. It is not an eleventh durable aggregate and not a permanent Agent persona or process.

## Core invariants

### 1. Inference proposes; admission creates responsibility

Conversation interpretation, planning, model confidence, tracker state, Skill instructions, and worker conclusions may produce proposals.

They do not directly create durable responsibility or acquire authority.

```text
conversation/model/tracker/Skill
        -> proposal
        -> admission/control authority
        -> durable semantic transition
```

An Accepted Commitment may begin with a skeletal Completion Contract. Unknown root cause, implementation route, exact tests, or task graph are execution/world uncertainty and are not automatically reasons to withhold admission.

### 2. Intent and Completion Contract are distinct

```text
Intent / Control
= what pi-sand owes and may do

Completion Contract
= how pi-sand proves that responsibility was fulfilled
```

Contract refinement may strengthen proof of an already-owed externally observable outcome. It may not silently add a new externally observable behavior, deliverable, material outcome, or newly authorized side effect.

No separate `IntentAnchor` table is required. A current-intent rewrite may exist as an ephemeral or cached cognitive projection, but is never responsibility truth.

### 3. Planning state must be admitted before it controls execution

Skills and external trackers may own planning procedures, narratives, ticket bodies, planning dependencies, comments, visualization, and planning frontier UI.

Only an admitted WorkRef/Task or admitted immutable work-spec binding becomes executable runtime truth.

```text
planning truth
        -> proposal
        -> admission
        -> execution truth
```

The kernel must not duplicate a tracker into a second rich planning system merely to make it durable.

### 4. Task status may project; AttemptRun owns execution

States such as `ready`, `running`, `waiting`, `verifying`, or `blocked` may be materialized for query/UI convenience.

They are not execution authority.

Actual authority belongs to exact durable facts:

```text
AttemptRun -> execution ownership
Wait       -> missing external condition
HumanGate  -> unresolved user decision
Evidence   -> accepted proof
blockers   -> admitted upstream proof dependency
```

Recovery must trust exact execution ownership facts and then repair projections, never infer a live owner from `Task.status = running`.

### 5. Execution ownership is recoverable and stale-writer-safe

After process failure or restart, an old execution process may never regain authoritative mutation rights merely because it wakes, reconnects, or emits a delayed message.

A concrete release must provide enough run/ownership identity and reconciliation to establish who currently owns execution.

A committed Attempt that crashes before process launch must recover the **same committed Attempt**, not allocate a fresh Attempt merely because launch had not yet happened.

This invariant does not by itself justify a generic `ResourceLease` abstraction.

### 6. Applicability fencing is domain-local

An authoritative transition may occur only if its exact subject, basis/revision, producer/responder authority, and candidate remain applicable.

Use the natural identity of each domain rather than inventing a universal generation object:

```text
Commitment control -> control version/basis
Completion proof   -> contract revision
WorkRef            -> validity generation/basis
AttemptRun         -> exact execution ownership identity
HumanGate          -> exact Gate subject/revision
RemoteEffect       -> exact effect/candidate identity
Result             -> immutable sealing snapshot
ResultDelivery     -> delivery generation
external tracker   -> admitted revision/digest
```

A shared compatibility/generation abstraction may be introduced only if implementation traces show repeated cross-domain correctness failures that the domain-local identities cannot safely express.

### 7. Durable user control precedes execution steer

A message such as:

```text
“不要修改数据库 schema”
```

has durable Commitment-level meaning before it has execution-level meaning.

```text
user input
  -> accepted control mutation
  -> affected work revalidation/invalidation
  -> optional best-effort Pi steer
```

Steering a live AgentSession is a latency optimization. It is not the authoritative meaning of a user correction.

A pure status query or unrelated side question must not mutate or interrupt the Commitment.

### 8. Control changes require explicit affected-work disposition

After a responsibility-affecting control change, affected admitted work must receive an explicit outcome such as retain/revalidate, invalidate, or supersede.

Compatibility is never inferred merely because the process continues running.

Safe reversible local computation may continue while compatibility is being decided, but outputs from unresolved/stale work may not cross a current-authority boundary.

This does not require a `ControlImpactReceipt` subsystem.

### 9. Human approval binds to an exact live subject

A human answer resolves a currently applicable decision. It never resurrects expired authority and never transfers approval to a replacement candidate.

Approval for commit `abc123` does not authorize `def456` merely because both represent “the merge.”

HumanGate is an orthogonal readiness/authority predicate, not merely a Task status.

### 10. Earlier unresolved ingress fences authority release

A durably received but not yet responsibility-classified user input is an **authority-release fence**, not a global execution pause.

Reversible local computation may continue.

At minimum, these transitions may not leapfrog the earlier unresolved input:

```text
RemoteEffect transmission
Result sealing
```

If classification determines that the input changes responsibility, affected authority remains closed until the control mutation and required revalidation complete.

The implementation may use an ingress watermark/barrier. Ordinary conversation does not thereby become a second pi-sand conversation database.

### 11. Stale producers may record information but not exercise current authority

A stale/superseded AttemptRun may still record provenance-bearing logs, diagnostics, Artifact, Observation, or evidence claims.

That storage authority does not permit it to:

- complete current work;
- satisfy a blocker;
- accept Evidence;
- resolve a HumanGate;
- authorize/transmit a RemoteEffect;
- modify current Commitment control;
- seal a Result.

Historically useful information and currently authoritative information are different concepts.

### 12. Only accepted current Evidence satisfies proof

Worker self-report, tracker closure, Skill completion, test output, or Artifact creation is not automatically Completion authority.

Evidence must be admitted/accepted against the current candidate and current proof basis before it can satisfy a Completion Contract or blocker.

### 13. Result sealing is snapshot-based and immutable

A Result may be sealed only against one current immutable proof proposition, conceptually including:

```text
current control basis
current contract revision
accepted applicable Evidence
exact candidate identity
relevant work/Attempt lineage
ingress barrier basis
```

Concrete representation may use IDs, versions, digests, or equivalent immutable references.

Reading a sealed Result later must reconstruct the same accepted proposition.

> **A sealed Result is immutable.**

Later user input, contract changes, Evidence changes, new candidates, or delivery failures may not silently rewrite it.

### 14. Outcome satisfaction and Commitment terminality are different

Successful flow:

```text
Completion Contract satisfied
-> canonical Result sealed
-> admitted return/delivery obligation terminal
-> successful Commitment discharge
```

But durable responsibility may also terminate without pretending the outcome was satisfied, through an explicit non-success disposition such as cancellation, supersession, acknowledged impossibility, authority withdrawal, or another explicitly defined policy terminal.

Do not invent fake successful Results or Evidence to close failed/cancelled responsibility.

Vague automatic abandonment/expiry is not a garbage-collection escape hatch; if supported later it requires an explicit admitted policy.

### 15. Result and ResultDelivery are separate

Execution/proof success and user delivery are different facts.

```text
Result R1
  -> Delivery generation 1
       -> delivered
       -> blocked/failed/uncertain
             -> Delivery generation 2
```

A delivery retry operates on the same canonical Result. It does not create a new execution Attempt or regenerate the Result.

Where transport acknowledgement is ambiguous, the runtime must represent uncertainty or reconcile exact remote state. It must not claim exactly-once behavior it cannot prove.

## Reuse boundary

ADR-0001 remains authoritative: pi-sand should reuse Pi for ordinary live-agent mechanics including AgentSession/session history, model/tool loop, compaction, steer/follow-up, model selection, Skills loading, ordinary tools, and Extension mechanics where appropriate.

Skills may own procedure such as research, wayfinding, specification, decomposition, implementation, diagnosis, testing, review, and phase/context strategy.

A Skill does not acquire capability or durable authority merely because its text instructs a model to perform an action.

External trackers may host planning graphs. Their state must be admitted before controlling runtime execution.

## Explicitly rejected from the kernel unless future evidence requires them

Do not introduce these merely for symmetry or completeness:

- universal workflow/semantic graph;
- rich internal planning graph as a source of truth;
- generic GraphMutation language;
- generic TaskRequirement framework;
- generic JoinSpec/partial-join engine;
- semantic ResponsibilityKey ontology;
- durable CurrentIntentFrame store;
- ConversationGraph;
- permanent PlannerAgent/ClarifierAgent/ReviewerAgent personas;
- permanent cheap-orchestrator bot;
- first-class AttentionFrontier or EffectFrontier subsystem;
- mandatory ControlImpactReceipt chains;
- universal generation/compatibility manager;
- generic ResourceLease abstraction before a concrete release proves it necessary;
- second context manager, compactor, Skill loader, tracker, or Agent Engine beside Pi;
- automatic inferred social follow-up commitments.

## Consequences

Positive:

- the kernel has a clear authority boundary across conversation races, execution ownership, external effects, proof, sealing, and delivery;
- most cognitive/procedural orchestration remains replaceable and can evolve without schema migration;
- implementation can retain useful stale information without granting stale authority;
- v0.5/v0.7 can validate the architecture through executable traces rather than more architecture prose;
- one maintainer owns fewer framework mechanics.

Costs:

- exact authority/candidate/version identity must be preserved at the transitions where correctness depends on it;
- user-input ordering must be reconciled before irreversible authority release;
- control changes require explicit affected-work compatibility decisions;
- Result and delivery/recovery need separate lifecycle handling;
- terminal non-success responsibility must be modeled honestly rather than collapsed into generic `done`.

## Falsification conditions

Revisit this ADR only if implementation evidence shows one of the following:

1. Domain-local applicability identities repeatedly cause cross-domain correctness bugs that a shared abstraction would clearly eliminate.
2. Minimal WorkRef cannot recover/revalidate execution without recreating a rich workflow graph internally.
3. Pi cannot provide required session/context/execution isolation mechanics without pi-sand duplicating them.
4. Skill-based procedures repeatedly require durable procedural state that cannot be expressed by existing kernel semantics.
5. Exact AttemptRun ownership cannot be made recoverable without a more general leasing abstraction.
6. Result sealing snapshots become too large/dynamic to remain simple immutable references.
7. Result/Delivery separation produces irreducible Commitment recovery or UX contradictions.
8. The ingress barrier cannot identify authority-consuming transitions narrowly enough and therefore materially blocks useful local execution.
9. Explicit WorkRef revalidation after control mutation becomes so expensive or ambiguous that a richer compatibility model is demonstrably required.

Until one of these conditions is demonstrated:

> **Do not promote another abstraction into the kernel.**

## Architecture freeze

The kernel architecture is frozen at this boundary.

The next architecture evidence must come from:

```text
v0.5 failure/race injection
restart/recovery traces
v0.7 dynamic WorkRef traces
```

not from another framework survey or architecture essay.
