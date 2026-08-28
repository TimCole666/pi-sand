# Pi-Native Grok Bot Compatibility Specification

## Problem Statement

We want to build an independent desktop agent application that reproduces the core product experience and observable behavior of Grok Bot 0.18 as closely as practical.

The project must be implemented from scratch rather than forked from the public reconstructed repository.

The target is not recovery of Anysphere's original source code. The target is a compatible product experience:

- persistent agents rather than disposable chat sessions
- natural-language interaction without requiring workflow commands
- long-running autonomous work
- background execution independent of the desktop window
- durable conversations
- recoverable worker and coordinator failures
- multiple agents that can operate independently
- rich visibility into agent activity
- a polished desktop experience
- Pi as the primary agent runtime

The user should be able to open the application, select an agent, send a message such as:

> Fix the failing tests in this repository and tell me when you're done.

and then leave.

The agent should be able to inspect the project, use tools, modify files, run commands, continue working, and eventually return a result without requiring the user to manually operate an agent workflow.

The application must continue to behave correctly when the user:

- switches to another agent
- closes or reopens the desktop UI
- temporarily disconnects
- allows work to continue for an extended period
- encounters a recoverable runtime failure

The reference Grok Bot 0.18 application and publicly available evidence may be used to determine observable behavior.

The public reconstruction is explicitly an unofficial reconstruction rather than the original monorepo, and its readable frontend is not claimed to be the original authored frontend. Therefore, its internal code structure must not be treated as the specification for this implementation.

---

## Solution

Build a Linux-first desktop application centered around persistent Agents.

The system will separate four major responsibilities:

**Desktop Client → Coordinator → Agent Runtime → Execution Environment**

The Desktop Client provides the user experience.

The Coordinator owns durable product state and coordinates agent lifecycles.

The Agent Runtime uses Pi to reason, use tools, and perform work.

The Execution Environment gives Pi access to the local machine and project workspaces.

The product must treat an Agent as a durable entity whose lifetime is independent from any individual Pi process, model context, desktop window, or network connection.

Pi is the default and primary agent runtime. The surrounding application exists to make Pi behave like a persistent desktop agent rather than a manually operated CLI session.

The application may later support additional frontends such as Telegram, but those frontends must connect to the same persistent Agents rather than creating a separate agent system.

Grok Bot compatibility will be evaluated primarily through user-observable desktop behavior.

Exact UI details will be researched and implemented incrementally. They are not all frozen in this specification.

The guiding rule is:

> Preserve product behavior without unnecessarily coupling the implementation to the reconstructed product's internal structure.

---

## User Stories

1. As a user, I want to create an Agent so that I can maintain a persistent assistant for a project or purpose.
2. As a user, I want an Agent to have a stable identity so that returning to it feels like continuing with the same assistant.
3. As a user, I want to select an existing Agent from the desktop application so that I can resume previous work.
4. As a user, I want to send an Agent a normal natural-language message so that I do not need to learn special workflow syntax.
5. As a user, I want Pi to automatically decide how to approach my request so that the application behaves like an autonomous agent rather than a command runner.
6. As a user, I want Pi to use its normal tools and installed skills when useful so that the product benefits from the existing Pi ecosystem.
7. As a user, I want optional skill packages such as Matt's Skills to work normally without becoming mandatory parts of the product.
8. As a user, I want the Agent to inspect files and repositories so that it can understand existing projects.
9. As a user, I want the Agent to modify files so that it can perform real development work.
10. As a user, I want the Agent to run shell commands so that it can build, test, inspect, and operate software.
11. As a user, I want the Agent to react to command failures and continue working when appropriate so that I do not need to manually supervise every step.
12. As a user, I want assistant output to appear progressively while the Agent is responding so that the application feels active and responsive.
13. As a user, I want to see that an Agent is working even before its final response is ready so that long-running activity is understandable.
14. As a user, I want relevant tool activity to be visible so that I can understand what the Agent is doing without reading raw internal logs.
15. As a user, I want the final response to clearly summarize what happened so that I can quickly understand the result of unattended work.
16. As a user, I want my conversation history to persist after restarting the desktop application so that closing the application does not erase work.
17. As a user, I want my Agent to continue working if I close the desktop window so that I can leave long-running tasks unattended.
18. As a user, I want to switch from Agent A to Agent B while Agent A is working so that I can use multiple agents concurrently.
19. As a user, I want Agent A's activity to remain isolated from Agent B so that messages and execution state never leak between agents.
20. As a user, I want different Agents to be able to work concurrently when resources allow so that a long task does not block unrelated conversations.
21. As a user, I want messages sent to one Agent to retain a deterministic order so that concurrent interaction does not corrupt its conversation.
22. As a user, I want to interrupt an active Agent so that I can stop work that is incorrect, unnecessary, or too expensive.
23. As a user, I want already completed conversation content to survive an interruption so that stopping a turn does not destroy useful history.
24. As a user, I want a recoverable Pi failure to be handled automatically when practical so that a temporary runtime problem does not destroy an unattended task.
25. As a user, I want an unrecoverable failure to be clearly visible so that the application never silently pretends work is still progressing.
26. As a user, I want the application to recover durable Agent state after a Coordinator restart so that infrastructure restarts do not erase conversations.
27. As a user, I want previously completed transcript entries to remain stable during recovery so that reconnecting does not duplicate or reorder messages.
28. As a user, I want an Agent's product history to remain available even if Pi's model context is compacted or replaced so that long-lived Agents do not require infinitely growing model context.
29. As a user, I want Pi to rediscover current project state when necessary so that stale model memory does not override the actual filesystem, Git state, or test results.
30. As a user, I want an Agent to be associated with a workspace so that it has a clear default project environment.
31. As a user, I want workspace configuration to survive application restarts so that I do not have to repeatedly reconfigure an Agent.
32. As a user, I want the desktop application to reconnect to running background work so that reopening the UI shows the current real state rather than creating a new task.
33. As a user, I want the application to distinguish idle, active, failed, interrupted, and completed states so that I can understand what each Agent is doing.
34. As a user, I want application and worker logs to exist so that failures from unattended sessions can be diagnosed later.
35. As a user, I want the application to work on a normal Linux laptop so that dedicated server hardware is not required for development or initial use.
36. As a user, I want the system to eventually run under normal Linux service supervision so that the Agent runtime can stay available for long periods.
37. As a user, I want remote frontends such as Telegram to eventually address the same Agents that exist in the desktop application so that mobile access does not create a parallel system.
38. As a developer, I want Grok Bot behaviors to be classified by confidence so that assumptions are not accidentally treated as confirmed compatibility requirements.
39. As a developer, I want user-visible Grok Bot behavior to outrank reconstructed internal implementation details so that the clean-room implementation remains independent.
40. As a developer, I want compatibility tests to survive internal refactoring so that improving architecture does not require rewriting the entire test suite.

---

## Implementation Decisions

### Persistent Agent as the primary domain object

The primary product object is an Agent.

An Agent is not equivalent to:

- a Pi process
- a single model request
- a desktop tab
- a model context
- a terminal session

An Agent has a durable identity and retains enough application-owned state to be reconstructed after process restart.

At minimum, persistent Agent state must represent:

- identity
- user-visible metadata
- conversation history
- workspace association
- current or most recent activity state
- runtime/session references needed for continuation
- timestamps required for ordering and recovery

The exact storage schema is an implementation detail and may evolve without changing frontend behavior.

### Desktop as the primary product surface

The desktop application is the primary compatibility surface.

The desktop client is responsible for:

- presenting Agents
- selecting and switching Agents
- displaying conversation history
- accepting user messages
- rendering streaming assistant responses
- presenting relevant activity
- exposing interruption and required controls
- reconnecting to durable runtime state

The frontend must not own the authoritative Agent lifecycle.

Closing, refreshing, or reconnecting the desktop client must not implicitly mean destroying the Agent.

### Coordinator as the durable control plane

A Coordinator sits between frontend clients and the Agent runtime.

It owns canonical application state.

Its responsibilities include:

- Agent lifecycle
- transcript ordering
- turn lifecycle
- frontend subscriptions
- activity projection
- runtime registration
- message routing
- recovery coordination
- persistence
- interruption
- synchronization after reconnect

The Coordinator must not contain Pi-specific reasoning logic.

The reconstructed Grok Bot architecture provides evidence for a similar separation of renderer, coordinator, host/inference, and local execution concerns, but our internal implementation is free to differ.

### Pi as the primary Agent Runtime

Pi is the initial production Agent Runtime.

The application should integrate with Pi through a programmatically observable interface rather than relying on terminal UI scraping.

The integration must provide enough lifecycle information to support:

- starting work
- supplying user input
- receiving streamed assistant output
- observing tool activity where Pi exposes it
- interruption
- clean completion
- abnormal termination
- continuation or restoration where supported

Pi remains responsible for its inner reasoning and tool-selection loop.

The Coordinator should not attempt to reproduce Pi's reasoning loop externally.

### Skills remain capabilities, not application workflows

Pi skills are available to Pi in the normal way.

The desktop application does not require the user to invoke Matt's Skills, Ralph, TDD flows, or another workflow framework before ordinary work can begin.

The user interacts with the Agent conversationally.

Skills may influence how Pi completes work, but they are not part of the core product protocol.

### Canonical transcript is application-owned

Conversation history must exist independently from Pi's current model context.

The canonical transcript represents the product conversation.

Pi may receive a subset, compacted form, summary, or reconstructed context when necessary.

The application must never delete durable transcript history solely because Pi can no longer fit all historical tokens into its active context.

Messages require stable identity so that reconnects and event replay do not create duplicates.

### Context and state are separate concerns

The system distinguishes:

**Product history**

The full durable conversation and relevant Agent metadata.

**Agent working context**

The information Pi currently needs to reason about the task.

**External ground truth**

Current filesystem contents, Git state, command output, running process state, and other environment facts.

External ground truth should be re-read when needed rather than permanently trusted from old model context.

The product must support long-lived Agents without requiring one infinite Pi context.

### One active mutating turn per Agent

By default, each Agent processes one primary mutating turn at a time.

This prevents concurrent turns from independently editing the same workspace or producing nondeterministic transcript ordering.

Additional input received while the Agent is active must follow an explicit deterministic policy.

The initial implementation may choose either:

- queued follow-up input
- supported steering of the current turn

The behavior must remain visible and predictable to the user.

Different Agents may operate concurrently.

### Runtime lifetime is independent from frontend lifetime

The system must preserve this relationship:

**Desktop lifetime ≠ Coordinator lifetime ≠ Agent runtime lifetime**

Closing a desktop window must not automatically terminate ongoing agent work.

The implementation may initially keep the Coordinator and runtime inside related local processes, but component lifetimes must remain logically separable so that later service supervision does not require rewriting product semantics.

### Execution environment

Pi must be able to operate within an explicitly associated workspace.

The execution environment initially targets the local Linux machine.

The architecture should allow stronger isolation later, but Docker or VM isolation is not required for the first release.

The product must not assume root privileges.

### Worker supervision and failure handling

Runtime workers must have observable lifecycle state.

The system must detect unexpected termination.

Recoverable failures may trigger bounded recovery.

Repeated failures must eventually stop automatic recovery and expose a visible failure state rather than creating an infinite restart loop.

If an existing worker is ever adopted after Coordinator restart, adoption must require sufficient identity evidence to avoid attaching to the wrong process.

The exact identity mechanism is an internal implementation decision.

The public reconstruction includes explicit supervisor and local-execution lifecycle behavior, which supports treating failure recovery as a first-class requirement rather than an incidental detail.

### Persistence

Application state must be persisted locally.

SQLite is an acceptable initial choice.

The persistence implementation must support crash-safe writes for canonical data.

Frontend components must not read the database directly.

All product behavior goes through application-level interfaces.

### Frontend communication

The desktop frontend communicates with the Coordinator through a versioned application protocol.

The protocol should describe semantic operations rather than UI component implementation.

Examples include:

- creating an Agent
- listing Agents
- selecting/retrieving Agent state
- sending a message
- interrupting an Agent
- subscribing to Agent updates
- receiving transcript updates
- receiving activity changes

The same semantic protocol should be reusable by future clients such as Telegram.

### Observable Agent states

The application must expose enough state to distinguish at least:

- idle
- active
- interrupted
- failed

Internally, more detailed states may exist.

The UI may also project states such as thinking, executing a tool, reconnecting, or completing when supported by runtime evidence.

Exact Grok Bot labels, icons, and animations are determined through later reference capture rather than frozen in this spec.

### Compatibility strategy

Compatibility targets user-observable behavior.

Reference behavior is classified as:

- Observed
- Evidence-backed
- Inferred
- Unknown
- Extension

Only behavior that has sufficient evidence should be treated as a strict Grok Bot compatibility requirement.

Unknown behavior should remain open until investigated.

Pi-specific configuration and future Telegram support are extensions rather than claims about original Grok Bot behavior.

### UI fidelity strategy

The product should eventually approach Grok Bot 0.18 visual and interaction fidelity.

However, the main specification does not freeze:

- component hierarchy
- CSS selectors
- exact recovered component names
- pixel measurements
- menu contents that have not yet been observed
- obscure feature behavior inferred only from recovered symbols

These details belong in targeted reference investigations when the corresponding surface is implemented.

This prevents the architecture from being prematurely coupled to incomplete reverse-engineering evidence.

---

## Testing Decisions

### Primary testing seam

The primary compatibility seam is the desktop application observed as a user would observe it.

The most important tests exercise the real desktop frontend together with the real Coordinator and persistence layers.

Pi may be replaced by a deterministic test implementation for most automated compatibility scenarios.

The test should ask:

> Given this visible initial state and this user action, does the application produce the expected visible result?

This keeps compatibility focused on product behavior rather than implementation structure.

### Core desktop E2E scenarios

The first E2E suite must establish a small set of high-value behaviors.

#### Create and use an Agent

A user can create or select an Agent, send a message, observe activity, and receive an assistant response.

#### Streaming

A response can update progressively and converge into one canonical final transcript entry.

Reconnect or state synchronization must not duplicate the message.

#### Agent switching

Agent A may remain active while the user switches to Agent B.

Events from A must never appear inside B.

Returning to A shows its latest state.

#### Frontend restart

After conversation state exists, closing and reopening the desktop application restores the Agent and its conversation.

#### Background execution

An active Agent does not stop merely because its desktop UI is no longer visible.

#### Coordinator recovery

Persisted Agents and completed conversation state survive Coordinator restart.

The desktop application eventually converges to the restored canonical state.

#### Runtime failure

When a controlled Pi runtime fails, the user observes either successful recovery or an explicit failure state.

Conversation history remains intact.

#### Interruption

The user can interrupt an active Agent and eventually observe a stable non-running state.

### Deterministic Agent Runtime for tests

Most E2E tests should not depend on a live language model.

A deterministic Pi-compatible test runtime should simulate:

- immediate completion
- streaming
- long-running activity
- tool activity
- failure
- interruption
- worker termination
- recovery

This keeps CI reliable while preserving the real application boundary.

A smaller smoke suite should exercise the real Pi integration.

### Reference-based compatibility testing

When implementing a Grok Bot surface, reference behavior should be captured before declaring fidelity complete.

A reference case should record:

- initial state
- user action
- observed result
- confidence classification
- relevant screenshot or recording where useful

Only behavior that matters to the current feature needs to be captured.

The project does not need a complete reverse-engineered UI specification before development can begin.

### Lower-level testing

Fast lower-level tests should exist where they make failures easier to diagnose.

Useful areas include:

- Coordinator state transitions
- transcript ordering and deduplication
- persistence
- Pi adapter behavior
- worker supervision
- runtime recovery
- protocol serialization

These tests support implementation.

They do not replace desktop behavior as the compatibility authority.

### Test philosophy

Tests should assert external behavior rather than private structure.

Tests should not require:

- specific internal class names
- specific reconstructed module names
- React component hierarchy
- private database layout
- recovered CSS selectors

If the implementation can be internally redesigned while preserving the same user-visible behavior, the compatibility suite should continue to pass.

---

## Out of Scope

The first major implementation does not require:

- recovering Anysphere's original source code
- reproducing original source filenames, comments, or variable names
- forking the reconstructed Grok Bot repository
- copying reconstructed implementation code
- exact proprietary branding
- redistribution of proprietary application assets
- complete pixel parity before the runtime is functional
- every obscure Grok Bot feature before the core Agent experience works
- macOS support
- Windows support
- multi-user SaaS
- billing
- enterprise administration
- distributed worker clusters
- local GPU model hosting
- mandatory Docker isolation
- mandatory Matt's Skills
- mandatory Ralph-style looping
- a custom Pi skill system
- full Telegram support in the initial desktop milestone
- reproducing behavior that cannot currently be established from evidence

Features discovered during reference research may be added later without changing the core architecture if they fit the Agent/Coordinator model.

---

## Further Notes

### Clean-room principle

The reference product answers:

> What should the user observe?

It should not automatically answer:

> How should we implement it?

Behavioral evidence may shape compatibility tests.

Our internal architecture remains independently designed.

### Product principle

The product abstraction is the Agent.

The user should not have to think about:

- processes
- sessions
- model context windows
- orchestrators
- supervisors
- workflow engines

Those exist only to support the experience:

> Send the Agent a message and let it work.

### Pi principle

Pi provides the intelligence and tool-using agent behavior.

The surrounding system provides persistence, lifecycle, synchronization, recovery, and product UX.

A useful conceptual distinction is:

**Pi does the work.**

**The application makes the worker persistent and reliable.**

### Fidelity principle

Compatibility should be developed incrementally.

When implementing an interaction:

1. Determine what Grok Bot does when practical.
2. Record the behavior.
3. Implement the same observable semantics.
4. Add an E2E scenario.
5. Move on.

Do not reverse-engineer the entire application before building anything.

### Recommended implementation progression

The expected development sequence is:

1. Desktop shell with deterministic fake runtime.
2. Persistent Agent model and canonical transcript.
3. Send, stream, and complete a basic turn.
4. Real Pi runtime integration.
5. Agent switching and concurrent Agents.
6. Durable restart behavior.
7. Background runtime lifecycle.
8. Interruption and failure recovery.
9. Activity/tool presentation.
10. Iterative Grok Bot UI fidelity work.
11. Additional compatibility surfaces.
12. Optional Telegram frontend.

Each stage should leave a runnable application rather than producing disconnected infrastructure components.

### First major release definition of done

The first major release is complete when:

- the application runs on Linux
- the user can create and reopen persistent Agents
- Pi is the production Agent Runtime
- sending one natural-language message starts work without requiring workflow commands
- responses stream into a durable transcript
- Pi can use its normal tools and installed skills
- switching Agents does not terminate active work
- multiple Agents can operate independently
- closing and reopening the frontend does not erase conversation state
- active work can continue independently from frontend visibility
- Coordinator restart preserves durable completed state
- interruption works
- runtime failure is handled visibly
- logs are sufficient to investigate unattended failures
- core desktop E2E scenarios pass
- at least one smoke scenario uses real Pi
- implemented Grok Bot compatibility behavior is supported by documented reference evidence
- the reconstructed Grok Bot repository is not required as source code, build input, or runtime dependency

At that point the product should already feel like a persistent Grok-style desktop Agent rather than a Pi chat wrapper.

Further releases can focus increasingly on interaction and visual fidelity.
