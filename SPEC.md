# Pi-Native Grok Bot Compatibility Specification

## Problem Statement

`pi-sand` is a Linux-first desktop agent application built around Pi.

The product goal is to reproduce the parts of the Grok Bot 0.18 experience that matter to the user without copying or depending on Grok Bot's internal implementation.

The core user need is simple:

> Give a persistent Agent a natural-language task, leave, and come back later to the same Agent with the correct conversation state and result.

A normal task should not require the user to understand process supervision, model contexts, workflow engines, Ralph loops, or specific skills. The user sends a message; Pi decides how to work, uses its normal tools and skills, and reports the result.

The first useful version must prove one vertical slice:

**Desktop → persistent Agent → Pi → work → durable transcript → close Desktop → work continues → reopen → correct state/result**

The project is a clean-room implementation. Public Grok Bot artifacts and reconstruction work may be used to learn user-observable behavior, but they do not define the internal architecture of `pi-sand`.

### Product compatibility target

When practical, `pi-sand` should reproduce Grok Bot 0.18 behavior that users can actually observe, including:

- the interaction model
- Agent persistence semantics
- foreground/background lifecycle behavior
- status and activity visibility
- desktop interaction patterns
- relevant failure and reconnect behavior

### Not a compatibility target

The following have no compatibility value by themselves:

- exact internal process topology
- internal RPC structure
- internal class/module names
- worker supervision implementation
- exact model context strategy
- exact reasoning traces
- exact assistant wording
- recovered source organization

Where Grok Bot's internal architecture and the simplest correct Pi-native implementation differ, user-observable behavior wins.

---

## Solution

Build a desktop client backed by a persistent local service that owns product state and Pi execution independently of the desktop window.

The v0.1 runtime shape is intentionally small:

**Desktop Client → Local Agent Service → Pi**

The Local Agent Service also owns local persistence. Pi operates in the Agent's associated local workspace.

The system has three important concepts:

### Agent

A durable product identity representing the assistant/project relationship the user returns to over time.

### Turn

One execution of one user request. A Turn may run, complete, fail, or be interrupted.

### Transcript

The durable user-visible product record. It is not a replay log for Pi's internal reasoning and is not required to reproduce Pi's model context.

The desktop frontend is not the owner of active work. Closing the Desktop Client must not cancel an active Turn.

Pi remains responsible for reasoning, planning, tool selection, skills, command use, and its autonomous inner work loop. `pi-sand` must not build a second reasoning/orchestration system around Pi.

The first release deliberately does not attempt automatic recovery of an in-flight Pi execution after a service or Pi crash. If Pi exits unexpectedly, the current Turn becomes visibly failed. If the Local Agent Service restarts, completed product state is restored and unfinished work is classified explicitly rather than silently resumed.

This keeps the first release focused on a reliable persistent product shell around Pi rather than prematurely building a general agent platform.

---

## User Stories

### v0.1 Core Stories

1. As a user, I want to create an Agent so that I can keep a persistent assistant for a project or purpose.

2. As a user, I want an Agent to have a stable identity so that returning to it feels like continuing with the same assistant even if Pi's process or session changes later.

3. As a user, I want to open an existing Agent so that I can continue from its previous conversation and workspace.

4. As a user, I want to associate an Agent with a local workspace so that Pi has a clear project environment in which to work.

5. As a user, I want the workspace association to persist so that I do not have to reconfigure the Agent after restarting the app.

6. As a user, I want to send a normal natural-language request so that I do not need special workflow commands.

7. As a user, I want Pi to decide how to approach the request so that the product behaves like an autonomous agent rather than a command launcher.

8. As a user, I want Pi to use its normal tools and installed skills when useful so that existing Pi capabilities continue to work naturally.

9. As a user, I want optional packages such as Matt's Skills to remain capabilities Pi may use rather than mandatory product workflows.

10. As a user, I want Pi to inspect files, modify files, and run commands in the workspace so that it can perform real development work.

11. As a user, I want assistant output to stream into the desktop conversation so that I can see progress without waiting for the final response.

12. As a user, I want to see a simple active state while Pi is working so that I know the request is still in progress.

13. As a user, I want the final assistant response to remain in the transcript so that I can return later and understand the result.

14. As a user, I want conversation history to survive Desktop Client restart so that closing the UI does not erase the product record.

15. As a user, I want an active Turn to continue when I close the Desktop Client so that I can leave long-running work unattended.

16. As a user, I want reopening the Desktop Client to reconnect to the same Agent so that I can see whether its Turn is still running or has completed.

17. As a user, I want reconnecting to avoid duplicate or reordered visible messages so that the transcript remains trustworthy.

18. As a user, I want to interrupt an active Turn so that I can stop work that is incorrect or no longer wanted.

19. As a user, I want already persisted conversation content to remain intact after interruption so that stopping a Turn does not destroy useful history.

20. As a user, I want an unexpected Pi exit to produce a visible failed Turn instead of leaving the application pretending that work is still running.

21. As a user, I want a restarted Local Agent Service to restore completed Agent and transcript state so that product history is durable.

22. As a user, I want unfinished work after a Local Agent Service restart to be visibly classified as interrupted or failed rather than silently replayed.

23. As a user, I want the application to work on a normal Linux laptop so that I can build and use it without dedicated server hardware.

### Multi-Agent Product Stories

24. As a user, I want multiple durable Agents so that I can keep separate project contexts.

25. As a user, I want to switch between Agents while preserving their state so that I can work across projects.

26. As a user, I want Agents in different workspaces to run concurrently while Agents sharing a workspace remain safe.

### Later Product Stories

27. As a user, I eventually want richer tool/activity presentation so that I can inspect what an Agent did without reading raw logs.

28. As a user, I eventually want a remote frontend such as Telegram to address the same durable Agents so that mobile access does not create a separate agent system.

---

## Implementation Decisions

### 1. Agent is the primary durable product entity

An Agent is not a Pi process, Pi session, model context, desktop tab, or Turn.

At minimum, an Agent must have durable:

- identity
- user-visible metadata
- workspace association
- creation/update timestamps
- transcript relationship

Pi session identity must remain conceptually separate from Agent identity. One long-lived Agent may eventually use one or many Pi sessions.

The exact database schema is not part of the public product contract.

---

### 2. Turn is separate from Agent

A Turn represents one user request being executed.

At minimum, a Turn needs enough durable information to represent:

- identity
- Agent identity
- initiating user message
- current status
- start time
- finish time when terminal
- optional Pi/runtime reference if the real Pi integration provides one

The initial terminal model is:

- `running`
- `completed`
- `failed`
- `interrupted`

An Agent may project a simple UI state such as `idle` or `active`, but `completed`, `failed`, and `interrupted` describe a Turn, not the long-lived Agent itself.

This distinction must be preserved in persistence, frontend state, and application APIs.

---

### 3. Desktop Client and Local Agent Service are the required lifetime boundary

The only process/lifetime separation required by v0.1 is:

**Desktop Client ≠ Local Agent Service**

This boundary exists because it directly supports the product requirement:

> Closing the UI does not cancel active work.

The Desktop Client is responsible for:

- rendering Agent state
- rendering the transcript
- accepting user actions
- presenting streaming updates
- reconnecting to the Local Agent Service

The Desktop Client must not be the durable state authority and must not own Pi process lifetime.

The specification does not require the Local Agent Service, Pi adapter, and Pi process to have three independently recoverable lifecycles.

---

### 4. Local Agent Service owns product state and Pi process ownership

The Local Agent Service is a local application service, not a general distributed control plane.

For v0.1 it is responsible for:

- creating and loading Agents
- writing the canonical transcript
- creating and updating Turns
- starting Pi work
- translating observable Pi output into product updates
- publishing state changes to the Desktop Client
- accepting interrupt requests
- detecting Pi completion and unexpected exit
- returning authoritative state after frontend reconnect
- reading/writing local persistence

It does not need in v0.1:

- generic runtime registration
- distributed worker discovery
- worker adoption
- automatic task replay
- remote scheduling
- multi-node orchestration
- a general workflow engine

The name `Local Agent Service` intentionally describes its product responsibility without implying a larger control-plane architecture.

---

### 5. Pi owns intelligence and autonomous work

Pi is the production Agent Runtime for the first release.

The first engineering spike must discover Pi's real programmatic integration contract before the surrounding architecture grows further.

The integration should prefer a programmatic API, SDK, RPC, structured CLI/event mode, or another observable contract over terminal UI scraping.

The minimum useful Pi adapter should support only what the real integration proves necessary:

- start a Turn
- receive observable streaming/events
- interrupt active work
- detect completion/exit

Session continuation, stable session IDs, tool event schemas, or crash recovery must only be added after Pi's actual contract is verified.

`pi-sand` must not implement a second system for:

- planning
- tool selection
- skill dispatch
- task decomposition
- automatic self-prompting
- generic retry-the-task loops
- model context summarization
- agent workflow orchestration

unless later real product requirements demonstrate that Pi cannot provide the needed behavior itself.

---

### 6. Skills are capabilities, not product workflows

Pi uses its installed skills normally.

The user should not need to know that Matt's Skills, TDD skills, Ralph-style tools, or any other skill package exists in order to submit ordinary work.

A message such as:

> Fix the failing tests.

must be a valid product interaction by itself.

---

### 7. Canonical transcript is application-owned product history

The Local Agent Service owns the durable user-visible transcript.

For v0.1, the transcript needs to represent:

- user-visible user messages
- user-visible assistant messages
- enough Turn terminal information to explain completion, failure, or interruption
- optional user-visible activity records only where the product actually needs them

The transcript is the product record, not an execution checkpoint.

It is not required to persist:

- Pi's private reasoning
- every internal tool event
- a replayable execution log
- the exact model context sent to Pi

Stable message identities must prevent duplicate visible messages after reconnect or event replay.

---

### 8. Product history, Pi working context, and external ground truth are distinct concepts

The design keeps three concepts separate:

**Product history**

The durable Agent transcript and product metadata owned by `pi-sand`.

**Pi working context**

The context/session state Pi uses to reason during work.

**External ground truth**

The current filesystem, Git state, command output, tests, and process/environment facts.

This is a conceptual boundary, not a requirement to build a custom context-management framework.

For v0.1, Pi is responsible for its own model/session context. `pi-sand` only guarantees that the user-visible transcript does not disappear because Pi compacts or changes its context.

If old model memory conflicts with current external state, the current external state is authoritative.

---

### 9. Workspace is an associated resource, not a separate architecture layer

Each Agent has a local workspace association.

In v0.1, the workspace is simply the directory/environment in which Pi is allowed to operate.

It is not a separate `Execution Environment` service.

Docker, VMs, worktrees, clones, or stronger sandboxing may be added later if real safety or concurrency requirements justify them.

The first release must not assume root privileges.

---

### 10. v0.1 does not automatically resume crashed in-flight work

Recovery is split into separate product concerns.

#### Desktop recovery

Required.

Restarting/reopening the Desktop Client must reconnect to the Local Agent Service and restore the current Agent/transcript view.

#### Local Agent Service state recovery

Required for completed product state.

After service restart, completed Agents, Messages, and terminal Turns must restore from persistence.

An unfinished Turn must be classified explicitly as interrupted or failed unless the real Pi contract later proves safe continuation semantics.

#### In-flight execution recovery

Not required for v0.1.

The first release will not attempt to automatically resume, replay, or adopt a partially executed Pi Turn after process/service failure.

This avoids unsafe replay of filesystem mutations or tool calls and prevents `pi-sand` from becoming a second orchestration engine before Pi's real continuation semantics are known.

---

### 11. Pi failure semantics are simple and explicit

If the Pi process for the current Turn exits unexpectedly in v0.1:

`running → failed`

The transcript and already durable product state remain available.

The user can manually submit a new request afterward.

Automatic retry, bounded task recovery, worker adoption, and semantic replay are future reliability features, not first-release requirements.

---

### 12. Persistence is local and simple

SQLite is the default persistence choice for the first release.

The persistence layer stores product state, not a universal agent event log.

The Desktop Client must not read or write SQLite directly.

All product behavior flows through the Local Agent Service.

Event sourcing is not required.

---

### 13. Frontend communication is semantic but not prematurely versioned

The Desktop Client communicates with the Local Agent Service through a local semantic interface.

The exact IPC mechanism remains open until implementation needs are clearer.

The interface should express product operations such as:

- create/open Agent
- retrieve Agent snapshot
- send message/start Turn
- subscribe to updates
- interrupt Turn

The interface should support request/response, streamed updates, and reconnect.

It does not need v0.1 protocol version negotiation, backward-compatibility policy, or abstractions designed specifically for future Telegram support.

A future remote frontend can be designed around the product model after the local vertical slice is proven.

---

### 14. Multi-Agent execution uses per-Agent and canonical-workspace exclusion

Independent Agents in independent canonical workspaces may run concurrently. The Local Agent Service enforces these invariants without a scheduler, queue, worker pool, or second orchestration layer around Pi:

- an Agent has at most one running Turn;
- a canonical workspace has at most one running Turn; and
- terminal handling, Desktop disconnect/reconnect, and service-restart classification are scoped to the affected Agent and Turn.

Creating an Agent expands `~`, resolves relative and normalized paths, follows filesystem aliases, verifies the result exists and is a directory, and persists that canonical filesystem path. Consequently, paths that name the same real directory share the same workspace exclusion.

Pi remains responsible for reasoning, retries, tools, skills, and its autonomous inner loop. pi-sand does not replay, adopt, or automatically recover a persisted running Turn after service restart; it explicitly classifies that Turn as interrupted or failed.

---

### 15. Grok compatibility creates behavioral requirements, not internal components

Reference behavior is classified as:

- **Observed**
- **Evidence-backed**
- **Inferred**
- **Unknown**
- **Extension**

Only sufficiently supported behavior should become a strict compatibility expectation.

Most importantly:

> Compatibility evidence may create a behavioral test, but must not by itself create an internal component.

For example, observing that Grok Bot continues work after its window closes may justify:

> Closing the Desktop Client does not cancel an active Turn.

It does not justify requiring the same internal Coordinator/Host/Supervisor process topology as Grok Bot.

Pi-specific configuration and future remote frontends are product extensions, not claims about original Grok Bot behavior.

---

### 16. UI fidelity is incremental

The long-term product should approach Grok Bot 0.18 visual and interaction fidelity where practical.

The main specification intentionally does not freeze:

- recovered React/component structure
- CSS selectors
- internal feature names
- exact pixel measurements
- unobserved menus
- behavior inferred only from symbol names

When a UI surface is implemented, its relevant reference behavior should be researched, recorded, implemented, and tested at that time.

---

## Testing Decisions

### Desktop E2E is the compatibility authority, not the dominant test layer

The desktop user experience is the final authority for Grok Bot behavioral compatibility.

However, most automated tests should run below the full desktop E2E seam because they are faster, more deterministic, and easier to diagnose.

The intended hierarchy is:

1. a small number of Desktop E2E compatibility tests
2. substantial Local Agent Service integration tests with a deterministic Pi fake
3. targeted unit tests for genuinely rule-heavy logic
4. a very small real-Pi smoke suite

Internal tests support development. They do not override verified user-visible behavior.

---

### Core v0.1 Desktop E2E scenarios

The initial E2E suite should stay small and cover product-defining behavior.

#### 1. Create/open Agent → send task → stream → complete

The user can create/open an Agent, submit a task, see a visible running state and streamed assistant output, and reach a completed Turn with one canonical assistant result.

#### 2. Transcript survives Desktop restart

After a completed interaction, closing and reopening the Desktop Client restores the same Agent and durable visible transcript.

#### 3. Close Desktop during work → reopen → same active work/result

A deterministic long-running fake Pi Turn continues while the Desktop Client is closed. Reopening reconnects to the same Agent and shows either the same running Turn or its completed result without duplicate transcript entries.

#### 4. Interrupt → stable interrupted Turn

The user interrupts an active Turn and eventually observes a stable interrupted state while already persisted transcript content remains available.

#### 5. Pi exits unexpectedly → visible failure

A controlled Pi failure causes the active Turn to become visibly failed while the Agent and transcript remain usable.

Multi-Agent service and Desktop E2E tests cover independent concurrent workspaces, shared-workspace exclusion, and independent reconnect behavior.

---

### Local Agent Service integration tests carry most behavioral coverage

Using a deterministic narrow Pi fake, integration tests should cover behavior such as:

- Agent creation/persistence
- Turn creation and state transitions
- user message persistence before execution starts
- streamed assistant update/finalization
- stable message identity
- reconnect without duplicate messages
- transcript ordering
- interrupt races
- unexpected Pi exit
- completed state restoration after service restart
- unfinished Turn classification after service restart
- workspace association persistence

These tests should use the public Local Agent Service interface rather than internal implementation details where practical.

---

### Deterministic Pi fake must stay narrow

The deterministic test runtime exists to test the Local Agent Service against the same small contract used for Pi.

It should simulate only behavior the real Pi integration actually exposes and the product actually needs, such as:

- streamed output
- completion
- delay/long-running work
- interrupt
- abnormal exit

It must not become a speculative universal `AgentRuntime` abstraction for hypothetical future providers.

---

### Unit tests are targeted

Unit tests are appropriate for compact logic whose behavior is difficult to diagnose through integration tests, such as:

- storage invariants
- Turn state-transition validation
- Pi-event-to-product-event translation
- message deduplication rules

Trivial implementation details do not require extensive unit coverage.

---

### Real Pi smoke tests are small and outcome-focused

A small smoke suite should prove the production Pi integration works end to end.

Tests should avoid asserting exact assistant language.

A useful smoke scenario is a controlled fixture repository where Pi receives a concrete task and produces an externally verifiable result, such as modifying a known file or making a known test pass, followed by a terminal Turn state.

---

### Reference-based compatibility testing is incremental

When implementing a Grok-compatible desktop interaction, capture only the relevant behavior needed for that feature.

A reference record may contain:

- initial visible state
- user action
- observed result
- confidence classification
- screenshot/recording when useful

The project does not need a complete reverse-engineered Grok UI specification before implementation begins.

Tests should assert external behavior, not recovered component structure, selectors, or internal process topology.

---

## Out of Scope

The following are explicitly out of scope for v0.1:

- concurrent mutation of a shared canonical workspace
- workspace scheduler, queue, worker pool, priorities, or generic runtime abstraction
- automatic Pi task recovery after crash
- automatic retry-the-task loops
- worker adoption after Local Agent Service restart
- execution replay/checkpointing
- preserving an in-flight Pi execution across service crash
- distributed workers
- generic runtime/provider abstraction beyond the real Pi contract
- a separate Execution Environment service
- Docker/VM sandbox as a requirement
- custom model-context framework
- custom memory system
- custom planning/orchestration layer
- mandatory Matt's Skills
- mandatory Ralph-style workflow
- exhaustive tool activity UI
- Linux service-manager integration as a product prerequisite
- Telegram or other remote frontend
- public/versioned remote protocol
- macOS support
- Windows support
- multi-user SaaS
- billing or team administration
- exact Grok internal process topology
- recovery of Anysphere's original source code
- forking or copying the reconstructed Grok Bot implementation
- redistribution of proprietary Grok Bot assets
- complete pixel-perfect Grok parity before the core product works
- reproducing unknown behavior without evidence

Future versions may add these capabilities when a demonstrated product need justifies the complexity.

---

## Further Notes

### v0.1 Definition of Done

v0.1 has one core promise:

> A user can give one persistent Pi Agent a real development task, close the Desktop Client, and later return to the same Agent with the correct transcript and either the current running state or the completed result.

v0.1 is complete when:

- the application runs on Linux
- the user can create/open a durable Agent
- the Agent has a persistent local workspace association
- the user can send one natural-language task
- real Pi performs the work using its normal tools and skills
- visible assistant output can stream into the transcript
- the active Turn has a simple visible running state
- the transcript is durable across Desktop restart
- closing the Desktop Client does not cancel the active Turn
- reopening the Desktop Client reconnects to the same Agent and authoritative Turn state
- the user can interrupt an active Turn
- unexpected Pi exit makes the Turn visibly failed
- completed product state survives Local Agent Service restart
- an unfinished Turn after Local Agent Service restart becomes explicitly interrupted/failed rather than silently resumed
- the five core Desktop E2E scenarios pass with a deterministic Pi fake
- Local Agent Service integration tests cover persistence, streaming, reconnect, interruption, and failure semantics
- at least one smoke scenario proves the real Pi integration

This release supports independent concurrent Agents only when their canonical workspaces differ; it does not need automatic recovery, remote access, or a generic agent platform.

---

### Recommended implementation progression

#### Step 1 — Real Pi integration spike

Before building the application architecture in depth, prove the real Pi contract with a small local experiment.

Determine what is actually available for:

- programmatic task submission
- streamed messages/events
- tool activity events
- session identity
- interruption
- abnormal exit
- continuation/resume semantics

This real contract should shape the adapter and recovery design.

#### Step 2 — First real product vertical slice

Build the smallest real lifetime architecture:

**Desktop Client → Local Agent Service → Pi**

The Local Agent Service may initially use temporary/in-memory product state during this slice.

Prove:

- Desktop can send a task
- Service owns Pi
- output streams back to Desktop
- closing Desktop does not kill Service/Pi

#### Step 3 — Add durable Agent, Turn, and transcript

Introduce SQLite and persist:

- Agent
- workspace association
- Messages
- Turn state

Prove Desktop restart restores product history.

#### Step 4 — Reconnect to background work

Reopening Desktop should retrieve an authoritative snapshot and subscribe to current changes.

Prove a deterministic long-running Turn survives Desktop closure and reconnection without duplicate transcript entries.

At this point, the core product idea is already real.

#### Step 5 — Interrupt and failure visibility

Add:

- user interrupt
- unexpected Pi exit → failed Turn
- explicit unfinished-Turn classification after service restart

Do not add automatic recovery.

This is the v0.1 release boundary.

#### Step 6 — Multiple Agents and safe concurrency

Add multiple durable Agents and Agent switching with one running Turn per Agent and per canonical workspace. Independent workspaces may run concurrently; a shared workspace remains excluded. Keep this as direct service enforcement, not a scheduler or worker system.

#### Step 7 — Stronger workspace isolation

If later product needs require shared-project parallelism, evaluate explicit isolation mechanisms such as worktrees or containers rather than allowing same-workspace concurrent mutation.

#### Step 8 — Service restart/recovery research

Only after observing the real Pi integration and real failure modes should the project decide whether it needs:

- resumable Pi sessions
- bounded process restart
- automatic continuation
- worker adoption

These are reliability hardening decisions, not assumptions embedded in v0.1.

#### Step 9 — Additional Grok fidelity and remote access

Once the persistent local Agent product is stable, expand:

- richer desktop fidelity
- tool/activity presentation
- additional Grok reference behaviors
- Linux service-manager integration
- optional remote frontend such as Telegram

---

### Architectural principles that should remain stable

The project should preserve these principles even while implementation details change:

1. **Agent identity outlives Pi process/session identity.**

2. **The Desktop Client does not own active work.**

3. **The product transcript is durable and application-owned.**

4. **Pi owns reasoning, tools, skills, and the autonomous inner work loop.**

5. **Product history, Pi working context, and external ground truth are conceptually different.**

6. **Frontend behavior goes through a semantic application boundary rather than direct database access.**

7. **Grok compatibility is behavioral, not architectural.**

8. **Compatibility evidence may justify a behavioral test but cannot, by itself, justify an internal component.**

9. **Each development stage should leave a runnable product vertical slice rather than disconnected infrastructure.**

These principles define `pi-sand` more strongly than any specific process topology or framework choice.

---

### Open implementation questions

The following should remain open until real implementation evidence answers them:

- What exact programmatic Pi integration mode should the Local Agent Service use?
- Does Pi expose a stable session identity?
- Can a Pi session be resumed safely after process interruption?
- Which Pi tool/activity events are stable enough to expose in the product?
- How frequently should streaming assistant content be durably checkpointed?
- Which activity records, if any, belong permanently in the transcript?
- Should one Agent eventually map to one long Pi session or multiple sessions over its lifetime?
- Which local IPC mechanism best fits Desktop ↔ Local Agent Service communication?
- When multiple Agents arrive, should shared-workspace safety use locks, worktrees, clones, containers, or another mechanism?
- After real failure data exists, is automatic runtime recovery actually worth its complexity?

These questions must not block v0.1 unless the real Pi spike proves one of them is necessary for the core vertical slice.
