# pi-sand v0.1 — Pi-native Grok Bot 0.18 Compatibility Specification

Status: **Draft for independent review**

## Problem Statement

`pi-sand` already proves the important runtime foundation for a persistent Pi-native desktop Agent: durable Agent and Turn identity, SQLite persistence, Pi execution, Desktop reconnect, explicit failure and interruption semantics, canonical workspace safety, and safe concurrent work across independent workspaces.

That foundation is not yet the product the user wants.

The target is not a generic local agent shell, a workflow runner, or a developer-operated wrapper around Pi. The target is a Linux-first product that feels recognizably like the core Grok Bot 0.18 Agent conversation experience while keeping Pi as the intelligence and execution runtime underneath.

The current UI and operating model are still too close to an engineering vertical slice. A user should not have to think in terms of Pi processes, RPC sessions, terminal lifetime, ports, database files, or workflow machinery. They should face a persistent Agent, a conversation, visible working state, and reliable background continuity.

The public `grok-bot-0.18-reconstructed` project and the checksum-pinned shipped Grok Bot 0.18 artifacts it documents provide the behavioral reference. They are evidence for user-visible behavior, not an architecture template and not source to copy.

The v0.1 problem is therefore:

> Turn the proven pi-sand foundation into the first Pi-native implementation of the core Grok Bot 0.18 desktop Agent conversation journey, using observable compatibility rather than reconstructed internal structure as the authority.

## Solution

Build the smallest Linux-first pi-sand product that reproduces the evidence-backed core Grok Bot conversation experience while preserving the existing Pi-native ownership model.

The normal user journey should be:

1. Open pi-sand and see a persistent Agent/chat roster next to the selected conversation.
2. Create or select an Agent without thinking about Pi process/session identity.
3. See the selected Agent's identity, conversation history, and current visible status.
4. Type a normal natural-language request in an integrated chat composer.
5. Send it and see the Agent visibly enter a working state.
6. See assistant output and stable user-visible activity update as Pi works.
7. Switch to another Agent without stopping the first Agent's work.
8. Run another independent Agent in another canonical workspace when appropriate.
9. Close or disconnect the Desktop without treating that as cancellation.
10. Reopen and recover authoritative Agent, Turn, transcript, selection, and draft state without duplication or confusion.

The product should preserve the Grok Bot interaction model where evidence is strong: a two-pane Agent/chat shell, Agent identity and status, conversation-first presentation, persistent selection, per-Agent drafts, a structured composer, attachment flow, reconnect states, and visible working/attention states.

The product should not reproduce Grok Bot's inferred internal topology. Pi continues to own reasoning, planning, tool selection, skills, model context, and its autonomous inner loop. pi-sand owns persistence, routing, presentation, reconnect, workspace association, durable product state, and Pi process lifetime.

Detailed artifact evidence belongs in the companion reference map and focused tests. The spec defines behavior, ownership, release scope, and testing seams.

## User Stories

1. As a pi-sand user, I want the application to open into a recognizable Agent/chat workspace, so that I interact with Agents rather than a developer control panel.
2. As a pi-sand user, I want a persistent roster of saved Agents, so that I can return to ongoing work across sessions.
3. As a pi-sand user, I want the roster and selected conversation visible as two conceptual areas, so that navigation and conversation remain clear at the same time.
4. As a pi-sand user, I want a clear empty state when I have no Agents, so that the application does not look broken or unfinished.
5. As a pi-sand user, I want a clear connecting state while the Desktop is establishing its local connection, so that temporary startup delay is understandable.
6. As a pi-sand user, I want a reconnecting state after a transient connection loss, so that I know the product is trying to recover automatically.
7. As a pi-sand user, I want an unreachable/error state with an explicit retry action, so that local service problems are recoverable without interpreting low-level errors.
8. As a pi-sand user, I want connectivity errors to make clear that my saved Agents are still durable, so that a transient service problem does not look like data loss.
9. As a pi-sand user, I want to create a new Agent from the Agent roster, so that starting a new persistent conversation is a product action rather than a process-management action.
10. As a pi-sand user, I want each Agent row to show a clear identity, so that I can distinguish Agents quickly.
11. As a pi-sand user, I want each Agent row to show useful recent context such as a draft, waiting reason, recent message, or activity preview, so that I can decide where to return without opening every Agent.
12. As a pi-sand user, I want a visible working indicator on an Agent row, so that background work remains discoverable while I am looking elsewhere.
13. As a pi-sand user, I want a visible needs-attention state when an Agent is waiting for me, so that blocked work does not look idle.
14. As a pi-sand user, I want unread/recent activity to be distinguishable from active working state, so that I can tell new results from ongoing execution.
15. As a pi-sand user, I want selecting an Agent to open its conversation without changing whether that Agent is running, so that navigation remains presentation-only.
16. As a pi-sand user, I want the last useful selected Agent to be restored when I reopen the Desktop, so that I return to where I left off.
17. As a pi-sand user, I want selection recovery to fall back sensibly if the previously selected Agent no longer exists, so that stale client state does not strand the UI.
18. As a pi-sand user, I want the conversation header to show the selected Agent's identity, so that the active conversation is always unambiguous.
19. As a pi-sand user, I want the conversation header to show a visible working state while that Agent is active, so that the state is clear even if no new text is currently streaming.
20. As a pi-sand user, I want user and assistant messages to be visually distinct, so that the transcript reads as a conversation rather than a log.
21. As a pi-sand user, I want assistant output to stream into the selected conversation when Pi emits usable output, so that active work feels live.
22. As a pi-sand user, I want transcript ordering and message identity to remain stable across reconnects, so that reopening does not duplicate, reorder, or replace conversation history incorrectly.
23. As a pi-sand user, I want completed, failed, and interrupted history to remain durable after reopening, so that terminal outcomes remain understandable later.
24. As a pi-sand user, I want user-visible activity to remain distinct from private reasoning and raw protocol traffic, so that the product shows useful work without exposing chain-of-thought or implementation noise.
25. As a pi-sand user, I want to type an ordinary natural-language request without choosing a workflow, planner, or skill, so that Pi's autonomy remains behind the conversation surface.
26. As a pi-sand user, I want a visually integrated bottom composer, so that sending work feels like part of the conversation rather than a separate developer form.
27. As a pi-sand user, I want my unsent draft to be preserved per Agent when I switch conversations, so that multitasking does not destroy partially written requests.
28. As a pi-sand user, I want a clear send action and normal chat keyboard behavior, so that submitting a request is predictable.
29. As a pi-sand user, I want to attach files from the composer, so that I can give Pi local artifacts as part of a task.
30. As a pi-sand user, I want to add attachments through a file picker, so that attaching a file does not require typing a path manually.
31. As a pi-sand user, I want drag-and-drop attachment support, so that adding local files is fast.
32. As a pi-sand user, I want pasted files to become attachments when the platform provides them, so that clipboard workflows behave naturally.
33. As a pi-sand user, I want attached files to appear as removable chips or previews before sending, so that I can verify the request payload.
34. As a pi-sand user, I want attachment failures or limits to be explained at the composer, so that a failed attachment does not silently disappear.
35. As a pi-sand user, I want reply context to be preserved when I explicitly reply to an existing message, so that follow-up requests can carry the intended conversational reference.
36. As a pi-sand user, I want a running Agent to show meaningful coarse activity when Pi exposes stable events, so that I can tell that useful work is happening even between message deltas.
37. As a pi-sand user, I want activity presentation to omit uncertain or private events rather than invent semantics, so that the UI stays trustworthy.
38. As a pi-sand user, I want to interrupt the selected Agent's active Turn from the conversation experience, so that stopping work feels like an Agent control rather than process management.
39. As a pi-sand user, I want interrupting one Agent to leave other independent Agents running, so that parallel work remains isolated.
40. As a pi-sand user, I want completing one Agent's Turn to leave other active Agents unchanged, so that parallel work remains isolated.
41. As a pi-sand user, I want one Agent's failure to leave other active Agents unchanged, so that an isolated error does not become a global failure.
42. As a pi-sand user, I want an Agent to have at most one running Turn, so that one persistent identity cannot accidentally drive overlapping work.
43. As a pi-sand user, I want one canonical workspace to have at most one running Turn, so that multiple Agents cannot mutate the same directory concurrently.
44. As a pi-sand user, I want different Agents in different canonical workspaces to work concurrently, so that independent tasks are not serialized unnecessarily.
45. As a pi-sand user, I want `~`, relative paths, normalized paths, and symlink aliases that identify the same real directory to count as one workspace, so that path spelling cannot bypass the single-writer boundary.
46. As a pi-sand user, I want invalid, missing, or non-directory workspaces rejected before work starts, so that process startup failures are not misreported as mysterious Pi errors.
47. As a pi-sand user, I want switching from Agent A to Agent B to leave Agent A running, so that the Desktop behaves like a view onto persistent Agents rather than an owner of one process.
48. As a pi-sand user, I want to close the Desktop while work is running without that closure itself cancelling the Turn, so that background work is independent of the visible window.
49. As a pi-sand user, I want reopening the Desktop to recover the authoritative current state from the Local Agent Service, so that stale client state never wins over durable product state.
50. As a pi-sand user, I want reconnect recovery to avoid duplicate transcript content, so that persistence and live updates compose cleanly.
51. As a pi-sand user, I want a missing Pi executable to appear as an actionable product error, so that I do not have to interpret `spawn` failures.
52. As a pi-sand user, I want Pi prompt rejection and Pi-reported terminal errors to be shown as understandable Turn failures, so that protocol details do not leak into normal use.
53. As a pi-sand user, I want an unexpected Pi exit before settlement to make the affected Turn explicitly failed, so that silent disappearance is impossible.
54. As a pi-sand user, I want a Local Agent Service restart to classify every persisted running Turn explicitly, so that the application never pretends abandoned work is still running.
55. As a pi-sand user, I want service restart handling to avoid automatic replay or worker adoption, so that the product never repeats potentially mutating work without my intent.
56. As a pi-sand user, I want the product to remain local and single-user by default, so that the initial trust boundary stays small and understandable.
57. As a pi-sand user, I want workspace selection to be the primary trust grant for Pi's local tools and shell access, so that the security boundary is explicit.
58. As a pi-sand user, I want the normal product surface to hide raw SQLite, RPC, and process-management details, so that pi-sand feels like an Agent product rather than an infrastructure console.
59. As a pi-sand user, I want the core experience to remain recognizably Grok Bot-like without exact pixel copying, so that behavior and interaction fidelity take priority over cosmetic imitation.
60. As a pi-sand user, I want features with weak reference evidence to remain absent or clearly treated as pi-sand extensions, so that reconstructed guesses do not quietly become compatibility claims.

## Implementation Decisions

- `v0.1.0` is the first dogfood-ready product release, not the name of the already-completed architectural vertical slice. The current main branch is the pre-v0.1 foundation.
- The v0.1 compatibility target is the core user-visible Grok Bot 0.18 Agent conversation journey, not every recovered Grok Bot feature.
- The public Grok Bot 0.18 reconstruction and its pinned shipped artifacts are a behavioral/evidence oracle. They are not original source and are not an architecture template.
- Compatibility claims are classified as Observed, Evidence-backed, Inferred, Unknown, or Extension. Only Observed and sufficiently strong Evidence-backed behavior becomes strict parity requirements.
- Desktop-observable behavior is the compatibility authority. Internal contracts support that behavior; they do not define it.
- Detailed artifact anchors stay in the companion reference/evidence map and focused tests rather than turning the main spec into reverse-engineering notes.
- The product remains Linux-first, local-first, and single-user for v0.1.
- The product architecture remains a Desktop Client over a long-lived Local Agent Service, with SQLite for durable product state and Pi processes operating in Agent workspaces.
- Agent identity is durable and does not equal a Pi process, Pi session, Turn, or Desktop window.
- Transcript history is durable product state and does not equal Pi model context.
- Desktop lifetime does not equal Local Agent Service lifetime.
- Pi owns reasoning, planning, tool selection, skills, model context, retries inside its autonomous loop, and the autonomous inner work loop.
- pi-sand owns durable Agent identity, Turn/product state, transcript, workspace association, routing, presentation, reconnect, and Pi process ownership.
- pi-sand does not add a second planner or orchestration loop around Pi.
- The reference application's internal boundaries do not justify matching components in pi-sand. Compatibility evidence may create a behavioral test, but not an internal component by itself.
- The v0.1 Desktop shape is a persistent Agent/chat roster beside a selected conversation workspace. A developer dropdown plus transcript is not sufficient.
- The roster must model meaningful product states including connecting, ready, empty, reconnecting, and unreachable/error with retry.
- Agent selection is client presentation state. Selection persistence must not own or cancel Agent execution.
- The conversation header includes selected Agent identity and a visible running/working projection.
- The transcript is the canonical durable conversation view. Stable user-visible activity may be rendered near the conversation but is not automatically durable transcript content.
- Private reasoning, chain-of-thought, raw RPC traffic, and an exhaustive execution journal are not product transcript data.
- The v0.1 composer includes per-Agent draft persistence, normal text submission, explicit send, file picker attachments, drag/drop, pasted-file support where available, attachment removal, attachment failure feedback, and reply context when exposed by the message UI.
- Voice dictation, complete rich mention/provider behavior, and exact composer micro-animation fidelity are deferred from the v0.1 release gate.
- Activity presentation is derived only from stable Pi-observable events. If an event cannot be mapped reliably to user-visible semantics, pi-sand omits it rather than guessing.
- A static working fallback remains valid when no richer stable activity is available.
- One Agent may have at most one running Turn.
- One canonical real workspace may have at most one running Turn.
- Different Agents in different canonical workspaces may run concurrently.
- Different Agents referring to the same canonical workspace may not run concurrently.
- Workspace identity is the canonical real filesystem path. Home expansion, relative-path resolution, normalization, filesystem alias resolution, existence checking, and directory validation happen before the workspace is accepted.
- Completing, failing, or interrupting one Turn affects only that Turn and its Agent execution.
- A Turn is not treated as successfully terminal merely because an intermediate Pi lifecycle signal says the agent ended. pi-sand waits for the integration's fully settled outcome.
- Prompt rejection, Pi-reported error, and unexpected Pi process exit are explicit failure paths.
- If the Local Agent Service restarts with persisted running Turns, they become explicitly terminal according to the conservative restart rule. v0.1 does not replay requests, adopt old workers, or automatically resume execution.
- Normal Desktop closure/disconnect does not cancel active work. Reopen/reconnect retrieves authoritative service state and then resumes live updates.
- The normal product should present actionable product-level causes for common failures instead of exposing raw process, SQLite, or protocol accidents when a higher-level explanation is available.
- Packaging technology is not prescribed by compatibility. The implementation may use web technology internally, but the resulting surface must behave as a coherent desktop Agent product.
- Operational work such as service startup, Pi discovery, and product-level error handling is included only to the extent required to make the Grok-style journey real and repeatable.

## Testing Decisions

- Tests should assert observable product behavior rather than reconstructed source structure or implementation details.
- The highest and primary compatibility seam is the Desktop-visible product boundary: roster state, Agent selection, conversation state, composer behavior, working/activity projection, switching, disconnect/reconnect, and terminal outcomes should be covered there when practical.
- The existing Local Agent Service integration seam remains the main deterministic seam for lifecycle, persistence, concurrency, canonical workspace locking, restart semantics, prompt rejection, Pi failure, and Turn isolation where full Desktop coverage would be unnecessarily expensive or brittle.
- A deterministic Pi fake should drive most service and Desktop compatibility tests so concurrency and lifecycle states can be held, completed, failed, interrupted, and reordered deliberately.
- Real Pi coverage remains a very small smoke/acceptance layer proving that the concrete production adapter still works against an externally verifiable workspace outcome.
- Rule-heavy pure logic may have targeted unit tests when that is the clearest seam, but new low-level seams should not be created merely to increase unit-test count.
- Desktop E2E is compatibility authority, not the dominant test layer. A small set of critical end-to-end journeys should prove the product boundary while most permutations stay at the deterministic integration seam.
- Critical Desktop coverage should include: shell loading/empty/error/reconnect states; Agent selection persistence; two independent Agents running simultaneously; switching while background work continues; transcript streaming and reconnect without duplication; per-Agent draft preservation; composer attachment flows; visible working/attention state; isolated completion/failure/interruption; and reopen onto authoritative state.
- Critical Local Agent Service coverage should include: one running Turn per Agent; one running Turn per canonical workspace; canonical alias collision; distinct workspace concurrency; Pi prompt rejection; Pi terminal error; process exit before settlement; settlement semantics; persistence; restart terminalization; and isolation between active Turns.
- Failure tests should verify product-level outcomes, not only thrown error strings, whenever the public product boundary provides a richer state.
- Reference evidence may justify a behavioral regression test. It must not justify a test that freezes an inferred internal module layout.
- Exact pixel snapshots are not the primary compatibility test. Geometry or visual snapshots are appropriate only for a small number of stable shell/composer invariants where visual structure itself is part of the observable contract.
- A v0.1 release gate requires the deterministic suite, the small real-Pi smoke suite, and the core Desktop compatibility journey to pass together.

## Out of Scope

- Exhaustive reconstruction of Grok Bot 0.18.
- Copying reconstructed implementation code, proprietary assets, or inferred source organization.
- Reproducing Grok Bot's Coordinator, Host, Supervisor, LocalExec, remote-box, provider-router, or other internal components solely because they exist in the reference reconstruction.
- Pixel-perfect Grok Bot visual parity.
- Exact animation timing and complete micro-interaction parity.
- Voice recording/dictation for the v0.1 release gate.
- Complete rich mention/provider behavior for the v0.1 release gate.
- Full Agent settings/details parity.
- Computer/screen surfaces beyond the minimum activity needed for the core conversation journey.
- Hidden-chat management.
- Shared rooms, groups, org-chart, and team collaboration surfaces.
- Automations and scheduled work.
- Complete plugin/MCP presentation parity.
- Reactions and full message-action parity unless later evidence makes one essential to the core journey.
- Full onboarding, account, team, cloud-access, and remote-box flows.
- Deep links, feedback/reporting, command-palette parity, and exhaustive keyboard shortcuts.
- A scheduler, task queue, priorities, or worker pool.
- Multiple simultaneous Turns inside one Agent.
- Concurrent mutation of one canonical workspace.
- Automatic Git worktree creation or management.
- A generic agent-runtime or provider abstraction around Pi.
- A second planning/orchestration layer around Pi.
- Automatic replay, recovery, resume, or worker adoption after service restart.
- Execution checkpoint/replay semantics.
- Custom model-context management.
- A custom memory framework.
- Remote, Telegram, or mobile frontends.
- A public/versioned remote protocol.
- Distributed or multi-machine workers.
- Multi-user SaaS.
- Docker or VM sandboxing as a v0.1 product requirement.
- Requiring Electron or Tauri solely to match the reference application's implementation technology.
- Automatic host sleep inhibition.
- Completion notifications until reference evidence and product priority justify them.

## Further Notes

The companion Grok Bot 0.18 reference map is the detailed evidence ledger for this spec. It should continue to record which behaviors are Observed, Evidence-backed, Inferred, Unknown, or pi-sand Extensions.

Known reference gaps should remain explicit rather than being filled by intuition. Current high-value unknowns include the exact stop/interrupt control placement, the exact Agent creation/workspace-selection interaction, the upstream Desktop-close/background-execution semantics, completion notification behavior, the boundary between activity/tool events and ordinary conversation entries, and the exact failed-versus-interrupted presentation.

The product can still make intentional Pi-native decisions where the reference does not apply, especially Linux workspace safety and local-service persistence. Those decisions should be labeled as extensions rather than silently described as Grok Bot parity.

The core architectural phrases remain useful guardrails:

- Pi is the brain/worker, not the product operating system.
- Persistent identity does not require infinite model context.
- The user faces an Agent, not a process, terminal, workflow, or model session.
- Context is short-lived; product state is persistent.
- Compatibility evidence may create a behavioral test, but must not by itself create an internal component.

After independent review of this spec, the next planning step is to run `/to-tickets`. No implementation tickets should be treated as settled until the review has checked scope, user stories, ownership decisions, testing seams, and the reference-versus-extension boundary.