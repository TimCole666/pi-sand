# Spike: v0.5 OpenClaw Native Session Authority & Ingress Fence Falsification Probe

- **Issue Reference:** [TimCole666/pi-sand#75](https://github.com/TimCole666/pi-sand/issues/75)
- **Originating Requirement:** [TimCole666/pi-sand#66](https://github.com/TimCole666/pi-sand/issues/66) (Session Authority + Telegram Ingress Fence)
- **Specification Reference:** [docs/specs/v0.5-one-chat-responsibility.md](file:///home/tiancaijb/projects/pi-sand/docs/specs/v0.5-one-chat-responsibility.md)
- **ADR Reference:** [docs/adr/0002-one-chat-responsibility-boundary.md](file:///home/tiancaijb/projects/pi-sand/docs/adr/0002-one-chat-responsibility-boundary.md)

---

## 1. Executive Summary & Definitive Verdict

### Verdict: `FALSIFIED`

**Core Finding:**
The hypothesis that **OpenClaw's existing native mechanisms (SQLite durable ingress queue, session writer delivery authority, and `WorkerSessionTurnClaim`) already provide the atomic ingress fence and session authority gating required by Issue #66 without modification is decisively FALSIFIED.**

Empirical investigation and real-environment interleaved probing demonstrate that OpenClaw's three mechanisms are completely decoupled across different storage layers and lifecycle domains:
1. When inbound Telegram message $I_2$ (e.g. user correction: *"不要改数据库 schema"*) successfully commits to SQLite (`channel_ingress_events`), **it does NOT invalidate, decrement, or fence turn $T_1$'s session writer authority or placement turn claim**.
2. During the critical race window (after $I_2$ SQLite commit, but before $I_2$ responsibility admission or $T_2$ turn establishment):
   - The authoritative **Telegram final dispatch check** (`assertSessionWriterDeliveryAuthorized`) **PASSES completely** (`allowed: true`);
   - The authoritative **GitHub publication mutation check** (`validateTurnClaim`) **PASSES completely** (`valid: true`).
3. If the host crashes or restarts at the pause point, **the system fails wide open**: the pending ingress row remains in SQLite, but reloaded placement and session stores evaluate $T_1$ purely against stale persisted records, permitting stale dispatches and mutations after recovery.
4. OpenClaw possesses no concept of `accepted_generation` vs `admitted_generation`. Ordinary status queries leave the protected action window wide open, failing to close the race window as required by the v0.5 responsibility invariant.

**Recommendation:** Issue #66 cannot reuse OpenClaw as-is (`REUSE_AS_IS` is rejected). Instead, Issue #66 must introduce a **Minimal Upstream Seam** that binds SQLite ingress transaction commits to an atomic session generation counter (`accepted_generation`), fencing all protected dispatches and mutations whenever `accepted_generation != admitted_generation` (`input_pending == true`).

---

## 2. Pinned Toolchain & Environment Coordinates

All probe experiments were executed directly in the pinned local Linux environment using the official toolchains:

| Coordinate | Pinned Identifier / Value |
| :--- | :--- |
| **OpenClaw Base Commit** | `ff63da7237e5f99e9fc03a86daf56e3c3e8f5356` |
| **Codex Base Commit** | `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67` |
| **pi-sand Working Commit** | `e59682e` (integrated with #76 & #77) |
| **Node.js Runtime** | `v26.8.1` (`npm 12.0.2`, `tsx v4.23.12`) |
| **Operating System** | EndeavourOS Linux x86_64 |
| **Kernel** | Linux `7.1.11-arch1-1 #1 SMP PREEMPT_DYNAMIC` |
| **SQLite Engine** | Node 26 native `node:sqlite` (SQLite 3.x with STRICT table support) |

---

## 3. The Interleaved Falsification Scenario & Probe Matrix

The probe script (`probe.mts`) establishes a real OpenClaw runtime environment using native state databases and session stores, exercising the exact interleaved race condition identified in Issue #75:

```text
[ Timeline of Tested Scenario ]

1. Turn T1 Active:
   - Session store: activeWriterRunId="run-t1", lifecycleRevision=1
   - Placement store: claimId="claim-t1", runId="run-t1", state="active"
   - Telegram final dispatch check: PASSES (Baseline)
   - GitHub publication turn claim: PASSES (Baseline)

2. Ingress I2 Arrives:
   - Inbound Telegram update: update_id=2001 ("不要改数据库 schema")
   - Enqueue into channel_ingress_events committed to SQLite

3. >>> PAUSE INJECTED (Critical Race Window) <<<
   - I2 row committed in SQLite (status='pending')
   - I2 has NOT been admitted by pi-sand
   - T2 has NOT been established
   - Codex turn T1 is still actively running or completing

4. In PAUSE Window, Probe Authority Checks:
   - Test 4A: Telegram final dispatch check (assertSessionWriterDeliveryAuthorized)
   - Test 4B: GitHub publication mutation authority check (validateTurnClaim)

5. Simulate Crash / Restart at PAUSE Point:
   - Process exits; database reopened from disk
   - Re-evaluate Telegram and GitHub authority checks
```

### Empirical Probe Results Matrix

| Scenario / Check Boundary | Pre-Ingress Baseline ($T_1$) | In PAUSE Window Post-$I_2$ Commit | After Crash / Restart at PAUSE Point | Status Query Input ($I_{\text{status}}$) | Expected by v0.5 Spec | Actual OpenClaw Native |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **$I_2$ Ingress SQLite Status** | None | `status = 'pending'` | `status = 'pending'` | `status = 'pending'` | Durably persisted | Durably persisted |
| **Telegram Final Dispatch Check** | **ALLOWED** | **ALLOWED (LEAK)** | **ALLOWED (LEAK)** | **ALLOWED (LEAK)** | **FENCED (CLOSED)** | **ALLOWED (FAIL-OPEN)** |
| **GitHub Mutation Claim Check** | **VALID** | **VALID (LEAK)** | **VALID (LEAK)** | **VALID (LEAK)** | **FENCED (CLOSED)** | **VALID (FAIL-OPEN)** |
| **`input_pending` Enforced?** | No ($G_{\text{acc}} = G_{\text{adm}}$) | **NO** | **NO** | **NO** | **YES** | **NO (FALSIFIED)** |

---

## 4. The 7 Core Metrics & Rigorous Findings

### (1) 精确 OpenClaw/Codex 提交修订 (Exact Commit Revisions)
- **OpenClaw Commit:** `ff63da7237e5f99e9fc03a86daf56e3c3e8f5356`
- **Codex Commit:** `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67`
- Verified by direct Git SHA resolution against `/home/tiancaijb/tmp/pi-sand-openclaw` and `/home/tiancaijb/tmp/pi-sand-codex`.

### (2) 相对于 SQLite commit 的精确暂停注入点 (Exact Pause Injection Point)
- **File:** `/home/tiancaijb/tmp/pi-sand-openclaw/src/channels/message/ingress-queue.ts`
- **Function:** `createChannelIngressQueue.enqueue(...)`
- **Exact Injection Point:** Lines 656–730. The pause is injected immediately after `runOpenClawStateWriteTransaction` commits the SQLite `INSERT INTO channel_ingress_events` transaction to disk, and before:
  1. `createChannelIngressMonitor.claimNext` claims the row;
  2. `telegram-ingress-drain.ts` executes `dispatch()`;
  3. `agentCommandFromGatewayIngress` or pi-sand responsibility admission initiates turn $T_2$.

### (3) 真实权威检查所读取的每一个持久化事实 (Persisted Facts Read by Authority Checks)

#### A. Telegram 最终发送检查 (`assertSessionWriterDeliveryAuthorized`)
- **Location:** `src/auto-reply/reply/session-writer-delivery-authority.ts` -> `isAuthorityCurrent()`
- **Storage Target:** Read-only probe against `sessions.json` (or `session_nodes` in `openclaw-agent.sqlite`), via `loadSessionEntryReadOnly()`.
- **Facts Evaluated:**
  1. `current.sessionId === authority.expectedSessionId`
  2. `authority.expectedLifecycleRevision === undefined || current.lifecycleRevision === authority.expectedLifecycleRevision`
  3. `authority.expectedWriterRunId === undefined || current.activeWriterRunId === authority.expectedWriterRunId`
- **Decoupling Finding:** **Zero queries are made to SQLite table `channel_ingress_events`**. The check has no awareness of unadmitted ingress rows.

#### B. GitHub 受保护变异检查 (`sessions.github.publish` / `coordinator.requestForSession`)
- **Location:** `src/gateway/github-publication-coordinator-methods.ts` -> `params.placements.validateTurnClaim(claim)`
- **Storage Target:** SQLite table `worker_session_placements` in `openclaw.sqlite`, via `isCurrentPlacementTurnClaim()`.
- **Facts Evaluated:**
  1. `record.turnClaim.claimId === claim.claimId`
  2. `record.turnClaim.runId === claim.runId`
  3. `record.turnClaim.generation === claim.placementGeneration`
  4. `record.turnClaim.owner === claim.owner.kind`
  5. `record.state === 'active' || record.state === 'draining'`
  6. `record.environmentId === claim.owner.environmentId`
  7. `record.activeOwnerEpoch === claim.owner.ownerEpoch`
- **Decoupling Finding:** **Zero queries are made to SQLite table `channel_ingress_events`**. `validateTurnClaim` checks only whether the placement record itself was modified or superseded.

### (4) 待处理 Ingress Row 的持久化可查询性 (Persisted Ingress Row Queryability)
- **Status:** **YES (Durably Queryable)**.
- Query: `SELECT queue_name, event_id, status, payload_json FROM channel_ingress_events WHERE status = 'pending';`
- Result during PAUSE window:
  ```json
  {
    "queue_name": "[\"telegram\",\"default\"]",
    "event_id": "0000000000002001",
    "status": "pending",
    "payload_json": "{\"update_id\":2001,\"message\":{\"text\":\"不要改数据库 schema\"}}"
  }
  ```
- The row is durably and immediately committed in SQLite via WAL commit prior to the pause.

### (5) Ingress Row 的消费与完成时机 (Consumption & Completion Lifecycle)
In native OpenClaw, the ingress event lifecycle spans three asynchronous phases:
1. **Durable Enqueue:** Inserted with `status = 'pending'`, `attempts = 0`, `received_at = now()`.
2. **Monitor Drain Claim:** `createChannelIngressMonitor` periodically polls `queue.claimNext()`. This executes an `UPDATE channel_ingress_events SET status = 'claimed', claim_token = ..., claimed_at = now()`. The row remains `claimed` during the entire execution of the turn.
3. **Completion & Tombstoning:** Only after the dispatched agent turn finishes (or fails), `lifecycle.onAdopted()` is called in `telegram-ingress-drain.ts` (lines 366, 417, 447). This invokes `queue.complete({ id, claim })`, which executes:
   ```sql
   UPDATE channel_ingress_events
   SET status = 'completed', completed_at = ?, completed_metadata_json = ?
   WHERE queue_name = ? AND event_id = ? AND status = 'claimed';
   ```
- **Key Realization:** Neither `status = 'pending'` nor `status = 'claimed'` is ever inspected by writer authority checks or placement stores.

### (6) 暂停处崩溃/重启是否仍能维持关闸 (Crash / Restart Behavior)
- **Status:** **NO (Fails Wide Open)**.
- When the host process crashes and restarts during the PAUSE window:
  1. The SQLite database retains the row with `status = 'pending'`.
  2. However, upon restart, `createWorkerSessionPlacementStore` reloads `worker_session_placements`, which still contains $T_1$'s active turn claim.
  3. `loadSessionEntryReadOnly` reloads `sessions.json`, which still lists $T_1$ as the active writer.
  4. Neither store inspects `channel_ingress_events` during startup or during authority checks.
  5. Result: Both `assertSessionWriterDeliveryAuthorized` and `validateTurnClaim` **return `true` after restart**, allowing $T_1$ to publish to Telegram and GitHub after recovery!

### (7) 状态查询类输入是否同样关闭受保护动作窗口 (Status Query Inputs)
- **v0.5 Specification Requirement:**
  Under Section 4 & 5 of `docs/specs/v0.5-one-chat-responsibility.md`:
  $$ \text{input\_pending} := \text{accepted\_generation} \ne \text{admitted\_generation} $$
  The arrival of **ANY** input (including ordinary status queries like *"进度如何？"*) advances $\text{accepted\_generation}$ ($G \to G+1$), creating an immediate mismatch with $\text{admitted\_generation} = G$. The protected action window **MUST CLOSE IMMEDIATELY** upon durable ingress commit, remaining closed until pi-sand classifies the input.
- **OpenClaw Native Reality:**
  In OpenClaw native, status query updates commit to `channel_ingress_events` identically to corrections, but **neither closes the protected action window**. Both Telegram dispatch and GitHub publish checks continue to pass unrestricted (`allowed: true`).

---

## 5. Architectural Root Cause Analysis: Why Native OpenClaw Fails Closed-Loop Authority

```text
       ┌─────────────────────────────────────────────────────────────┐
       │               Incoming Telegram Update I2                   │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
                     [1] enqueue() transaction COMMIT
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │ SQLite Table: channel_ingress_events (openclaw) │
             │ Row: update_id=2001, status='pending'           │
             └─────────────────────────────────────────────────┘
                                      │
                                [DECOUPLED]  <--- ZERO CROSS-TALK
                                      │
       ┌──────────────────────────────┴──────────────────────────────┐
       │                                                             │
       ▼                                                             ▼
┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
│ Telegram Final Dispatch Authority    │     │ GitHub Publication Turn Authority    │
│ (assertSessionWriterDelivery)        │     │ (validateTurnClaim)                  │
├──────────────────────────────────────┤     ├──────────────────────────────────────┤
│ Source: sessions.json                │     │ Source: worker_session_placements    │
│ Reads: activeWriterRunId="run-t1"    │     │ Reads: turn_claim_id="claim-t1"      │
│ Result: PASSES (Ignorant of I2)      │     │ Result: PASSES (Ignorant of I2)      │
└──────────────────────────────────────┘     └──────────────────────────────────────┘
```

1. **Storage Decoupling:**
   - Ingress spooling lives in SQLite table `channel_ingress_events`.
   - Turn placement authority lives in SQLite table `worker_session_placements`.
   - Reply writer delivery authority lives in `sessions.json` (or separate agent-level tables).
   There is no foreign key, no joint transaction, and no shared query joining these subsystems.
2. **Absence of Shared Generation Monotonicity:**
   OpenClaw has no unified authority generation counter binding durable ingress reception to session execution claims.
3. **Fail-Open by Design in Upstream:**
   Upstream OpenClaw designed `channel_ingress_events` purely as an asynchronous buffering spool to absorb Telegram webhook bursts without dropping messages. It was never intended to act as an execution generation barrier or mutual exclusion lock against in-flight agent responses.

---

## 6. Architectural Seam Recommendation for Issue #66

To implement Issue #66 without violating the ADR-0001/0002 boundary or rebuilding OpenClaw's transport layers:

1. **Atomic Ingress Acceptance Ordering Seam:**
   Wrap or hook `createChannelIngressQueue.enqueue()` such that when a message for a protected session commits to `channel_ingress_events`, the same SQLite transaction atomically increments:
   $$ \text{session\_authority.accepted\_generation} \gets \text{accepted\_generation} + 1 $$
2. **Authority Check Gating (`input_pending` Enforcement):**
   Expose an authoritative check seam for both `assertSessionWriterDeliveryAuthorized` and `coordinator.requestForSession` (or `validateTurnClaim`):
   ```ts
   function assertProtectedAuthorityCurrent(sessionKey: string, expectedGeneration: number) {
     const authority = readSessionAuthority(sessionKey);
     if (authority.accepted_generation !== authority.admitted_generation) {
       throw new SessionAuthorityFencedError("Durable ingress pending admission");
     }
     if (authority.admitted_generation !== expectedGeneration) {
       throw new SessionAuthorityStaleError("Turn generation superseded");
     }
   }
   ```
3. **Crash / Restart Invariant:**
   Because `accepted_generation` and `admitted_generation` are persisted in SQLite, after crash/restart, if any unadmitted ingress exists, $\text{accepted\_generation} > \text{admitted\_generation}$ remains strictly true, guaranteeing that stale turns cannot publish after restart before admission.

---

## 7. How to Run & Reproduce the Probe

### Run the Probe Harness directly:
From the OpenClaw repository root:
```bash
cd /home/tiancaijb/tmp/pi-sand-openclaw
./node_modules/.bin/tsx /home/tiancaijb/projects/pi-sand/spikes/v0.5-openclaw-authority-probe/probe.mts
```

### Run the Automated Verifier:
From the `pi-sand` repository root:
```bash
cd /home/tiancaijb/projects/pi-sand
./spikes/v0.5-openclaw-authority-probe/verify.js
```

### Run the Unit Test Suite:
From the `pi-sand` repository root:
```bash
cd /home/tiancaijb/projects/pi-sand
node --test test/v0.5-openclaw-authority-falsification.test.js
```
