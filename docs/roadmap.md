# Roadmap: one chat, borrowed machinery

- **Status:** Future-facing planning document
- **Architecture:** ADR-0001 reuse-first + ADR-0002 one-chat responsibility boundary
- **Current implementation evidence:** Issue #48 / PR #62 remain v0.4 facts until superseded by implemented evidence
- **v0.5 spec:** `docs/specs/v0.5-one-chat-responsibility.md`

## Product target

> **The user gives responsibility, not workflow.**

> **One Chat Box != One Agent != One Runtime. It is one responsibility interface.**

The product should feel simpler than a general agent platform:

```text
User: 帮我把 #123 修好，CI 过了以后告诉我。

User later: 不要改数据库 schema。

System eventually: ✓ 已完成
```

The user should not need to choose or understand agents, computers, models, runtimes, work graphs, handoffs, or orchestration topology.

## Historical direction

pi-sand began close to the idea of building a simpler Grok-Bot-like autonomous product.

The project progressively learned that the surrounding machinery should usually be reused rather than rebuilt:

```text
agent loop
computer / browser / terminal
memory / skills
channels
background execution
multi-agent delegation
Git/GitHub mechanics
```

The roadmap therefore no longer treats those capabilities as things pi-sand should eventually implement by default.

The governing question is now:

> **What responsibility/authority semantic remains necessary after mature hosts and executors provide all ordinary mechanics?**

If the answer becomes "none", delete pi-sand instead of preserving a runtime for project identity.

## v0.4 — failure-semantics laboratory

v0.4 explores leave-and-return coding responsibility with a comparatively rich kernel: Commitment, Completion Contract, Evidence, external wait/wake, RemoteEffect, ResultDelivery, repair, and recovery semantics.

Issue #48 / PR #62 remain the authority for what v0.4 actually means and implements.

v0.4 is valuable evidence, but its abstractions are **not automatically the v0.5 foundation**. Later source review and prototypes have shown that many mechanics can be delegated to an existing host/runtime.

## v0.5 — One-Chat Responsibility Boundary

**Product capability:** one Telegram private 1:1 chat can hold one coding responsibility while official Codex works through OpenClaw, and a new durable user message can make stale execution physically unable to publish or authoritatively finish for the current request.

v0.5 assumes:

```text
one Telegram 1:1 conversation
one active Goal / Obligation
OpenClaw as correctness/enforcement testbed
official Codex app-server as executor
GitHub publication as the only protected consequential-effect family
one pinned OpenClaw + Codex capability contract
```

pi-sand itself should own only:

```text
Obligation
current revision
idempotent InputDecision
responsibility classification
```

OpenClaw should own the operational mechanics:

```text
Telegram durable custody
accepted/admitted authority generation
required authority-owner dependency
canonical Codex turn binding/lifecycle
protected writer/quiescence contract
GitHub credential + publication/reconciliation
final Telegram dispatch
```

Codex should own coding execution, thread context, native tools, tests, and ordinary runtime mechanics.

### v0.5 hard proofs

The release must physically prove:

1. durable Telegram acceptance fences protected publication/final before classification;
2. a correction advances responsibility revision before execution control;
3. same-turn steer is never treated as protected authority proof;
4. a retired canonical turn remains stale forever;
5. fresh-turn authority is granted only after the prior verified workspace-writer surface is quiescent/isolated;
6. unknown direct workspace-mutating dynamic tools are incompatible with protected mode;
7. Codex has no independent GitHub write credential/path;
8. GitHub mutation and final delivery revalidate current authority at their actual irrevocable boundaries;
9. restart never silently downgrades a protected session when the required authority owner/contract is missing.

Prototype #65 returned bounded `REVISE`: keyed routing and Codex-owned background cleanup worked, while an arbitrary abort-ignoring dynamic-tool handler could still write the shared workspace late. v0.5 therefore uses a **closed verified writer surface**, not a new generic pi-sand mutation framework.

## After v0.5 — evidence-driven, not a capability ladder

There is intentionally no fixed `v0.6 -> v0.10` plan for Browser, Computer, Memory, Skills, scheduler, or multi-agent features.

Those are primarily host/executor capabilities. Add pi-sand semantics only when a concrete product journey demonstrates a responsibility invariant that the chosen host cannot provide.

Examples of future questions, not promised releases:

```text
Can Grok Bot/Hermes/OpenClaw natively replace more of the responsibility boundary?

Does a second consequential-effect family reveal a semantic that GitHub-only v0.5 cannot express?

Does more than one simultaneous Goal force real scheduling semantics, or should the product still refuse/avoid it?

Does another product host make pi-sand state unnecessary altogether?
```

Each such question should start with falsification and reuse research, not a precommitted subsystem.

## Capabilities that are host concerns by default

Do not put these back onto the pi-sand roadmap without concrete evidence:

```text
cloud computer
browser automation
image/video generation
memory platform
Skills runtime
cron/routines
multi-agent delegation
worker pool
scheduler / DAG
provider/model router
channel SDK
GitHub transport
credential broker
container/VM runtime
second transcript/context system
```

A host may expose these behind the one chat box without changing the product abstraction.

## Long-term product-host posture

OpenClaw is selected for v0.5 because its durable ingress, trusted run identity, Gateway-owned capability mechanics, GitHub publisher, and Codex harness make it a useful responsibility-correctness testbed.

It is **not** frozen as the permanent product host.

Grok Bot and Hermes are important product-shape references/candidates because they already provide persistent computers/agents, broad capabilities, and delegation. Their existence is a reason not to rebuild those layers.

A future host wins if it can preserve the one-chat product shape while making more pi-sand-specific authority state deletable.

## v1 condition

`v1` is not "pi-sand implements every autonomous-agent capability."

The product is ready when the experience is reliably:

```text
one chat box
-> user delegates an outcome
-> user can leave
-> user can correct it later
-> hidden execution may change behind the scenes
-> stale authority cannot silently act
-> the system only says done when the current responsibility is actually eligible to be called done
```

The strongest acceptable v1 outcome is still deletion:

> **If a mature host natively provides this responsibility contract, pi-sand should shrink to an adapter or disappear.**

## Persistent non-goals

Unless a concrete falsifying implementation result proves one necessary, do not build:

```text
second Agent Engine
standalone general agent runtime
generic workflow engine / DAG
generic scheduler / worker pool
generic capability broker
generic Effect framework
generic Evidence/Reviewer/Completion framework
generic filesystem mutation framework
browser/computer platform
memory platform
Skills loader
open-ended multi-agent society
Universal Host Interface
```
