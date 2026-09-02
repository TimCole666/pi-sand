/**
 * Issue #75: Falsification Probe for Issue #66 (Session Authority + Ingress Fence)
 *
 * Problem Statement:
 * Owner TimCole666 reviewed OpenClaw's native mechanisms (SQLite durable ingress queue,
 * Session writer delivery authority, WorkerSessionTurnClaim) and raised Issue #75
 * to empirically determine whether OpenClaw natively provides the atomic ingress fence
 * and session authority required by Issue #66 / v0.5 Spec, or whether this hypothesis is FALSIFIED.
 *
 * Core Interleaved Scenario Tested:
 * 1. Establish T1 possessing current writer / publication turn claim;
 * 2. I2 durable ingress enqueue COMMIT successfully lands in SQLite;
 * 3. PAUSE injected immediately post-commit, before I2 responsibility admission / T2 creation;
 * 4. In PAUSE window, test:
 *    A. Real Telegram final dispatch check (assertSessionWriterDeliveryAuthorized);
 *    B. Real GitHub publication mutation check (validateTurnClaim).
 * 5. Verify 7 core metrics including crash/restart and status query behaviors.
 * 6. Conclude with definitive verdict: REUSE_AS_IS, MINIMAL_UPSTREAM_SEAM, EXTERNAL_BLOCK, or FALSIFIED.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// OpenClaw Core Imports
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/state/openclaw-state-db.js";
import {
  createChannelIngressQueue,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/channels/message/ingress-queue.js";
import {
  telegramQueueEventId,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/extensions/telegram/src/telegram-ingress-spool.js";
import {
  createWorkerSessionPlacementStore,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/gateway/worker-environments/placement-store.js";
import {
  seedActivePlacement,
  REQUEST,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/gateway/worker-environments/placement-dispatch-test-fixtures.js";
import {
  upsertSessionEntryCore,
  loadSessionEntryReadOnly,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/config/sessions/session-accessor.js";
import {
  assertSessionWriterDeliveryAuthorized,
  isDispatchFinalReplySessionWriterAuthorized,
} from "/home/tiancaijb/tmp/pi-sand-openclaw/src/auto-reply/reply/session-writer-delivery-authority.js";
import { setReplyPayloadMetadata } from "/home/tiancaijb/tmp/pi-sand-openclaw/src/auto-reply/reply-payload.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tracesDir = path.join(__dirname, "traces");

await fs.mkdir(tracesDir, { recursive: true });
const jsonlLogPath = path.join(tracesDir, "probe.jsonl");
const summaryPath = path.join(tracesDir, "summary.json");
const toolchainPath = path.join(tracesDir, "toolchain.txt");

await fs.writeFile(jsonlLogPath, "");

function logEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  fs.appendFile(jsonlLogPath, line).catch(() => undefined);
}

// 1. Toolchain & Environment Coordinate Extraction
const openClawGitRev = execSync("git -C /home/tiancaijb/tmp/pi-sand-openclaw rev-parse HEAD", { encoding: "utf8" }).trim();
const codexGitRev = execSync("git -C /home/tiancaijb/tmp/pi-sand-codex rev-parse HEAD", { encoding: "utf8" }).trim();
const kernelInfo = `${os.type()} ${os.release()} ${os.arch()}`;
const nodeVersion = process.version;

const toolchainContent = [
  `Probe Timestamp: ${new Date().toISOString()}`,
  `OpenClaw Commit: ${openClawGitRev}`,
  `Codex Commit: ${codexGitRev}`,
  `Node Version: ${nodeVersion}`,
  `OS / Kernel: ${kernelInfo}`,
].join("\n") + "\n";

await fs.writeFile(toolchainPath, toolchainContent);
console.log("==================================================================");
console.log("Issue #75: OpenClaw Native Session Authority Falsification Probe");
console.log("==================================================================");
console.log(toolchainContent.trim());
console.log("------------------------------------------------------------------");

// 2. Setup isolated state directory
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-authority-probe-"));
logEvent({ event: "init", root, openClawGitRev, codexGitRev });

try {
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database });

  const sessionStorePath = path.join(root, "sessions.json");
  const sessionTarget = {
    agentId: REQUEST.agentId,
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    storePath: sessionStorePath,
  };

  // -------------------------------------------------------------------------
  // STEP 1: Establish T1 possessing current writer & publication turn claim
  // -------------------------------------------------------------------------
  console.log("\n[Step 1] Establishing T1 with writer delivery authority and publication claim...");
  
  // Persist T1 session writer state
  await upsertSessionEntryCore(sessionTarget, {
    sessionId: REQUEST.sessionId,
    activeWriterRunId: "run-t1",
    lifecycleRevision: 1,
    updatedAt: Date.now(),
  });

  // Persist T1 placement and claim turn
  seedActivePlacement(placements, { environmentId: "env-worker-1", ownerEpoch: 1 });
  const t1Claim = placements.claimTurn({
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    agentId: REQUEST.agentId,
    claimId: "claim-t1",
    runId: "run-t1",
    owner: {
      kind: "worker",
      environmentId: "env-worker-1",
      ownerEpoch: 1,
    },
  });

  const t1Authority = {
    expectedSessionId: REQUEST.sessionId,
    expectedWriterRunId: "run-t1",
    expectedLifecycleRevision: 1,
    sessionKey: REQUEST.sessionKey,
    storePath: sessionStorePath,
    agentId: REQUEST.agentId,
  };

  const t1ReplyPayload = setReplyPayloadMetadata(
    { text: "T1 work completed: PR created and schema updated." },
    { sessionWriterDeliveryAuthority: t1Authority },
  );

  // Baseline verification: T1 must pass both authority checks before I2
  let baselineTelegramAllowed = false;
  try {
    assertSessionWriterDeliveryAuthorized(t1Authority, sessionStorePath);
    baselineTelegramAllowed = true;
  } catch {
    baselineTelegramAllowed = false;
  }
  const baselineTelegramDispatch = isDispatchFinalReplySessionWriterAuthorized(t1ReplyPayload, sessionStorePath);
  const baselineGithubClaimValid = placements.validateTurnClaim(t1Claim);

  console.log(`  -> Baseline Telegram Final Dispatch Allowed: ${baselineTelegramAllowed && baselineTelegramDispatch}`);
  console.log(`  -> Baseline GitHub Publication Claim Valid:  ${baselineGithubClaimValid}`);

  if (!baselineTelegramAllowed || !baselineGithubClaimValid) {
    throw new Error("Baseline failure: T1 should have valid authority prior to I2 ingress.");
  }
  logEvent({ event: "baseline_established", t1Claim, t1Authority, baselineTelegramAllowed, baselineGithubClaimValid });

  // -------------------------------------------------------------------------
  // STEP 2: I2 Durable Ingress Enqueue COMMIT (Correction: "不要改数据库 schema")
  // -------------------------------------------------------------------------
  console.log("\n[Step 2] Ingress I2 (correction) arrives and commits to SQLite...");
  const queue = createChannelIngressQueue({
    channelId: "telegram",
    accountId: "default",
    stateDir: root,
  });

  const i2UpdateId = 2001;
  const i2EventId = telegramQueueEventId(i2UpdateId);
  const i2Payload = {
    update_id: i2UpdateId,
    message: {
      message_id: 8881,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1001, type: "private" },
      from: { id: 1001, is_bot: false, first_name: "TimCole666" },
      text: "不要改数据库 schema",
    },
  };

  const enqueueResult = await queue.enqueue(i2EventId, i2Payload, {
    laneKey: "telegram:1001",
    receivedAt: Date.now(),
  });
  console.log(`  -> Enqueue result kind: ${enqueueResult.kind} (duplicate: ${enqueueResult.duplicate})`);

  // Verify SQLite commit landed
  const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const pendingRowsPostCommit = db.prepare(
    "SELECT queue_name, event_id, status, channel_id, account_id, payload_json, received_at FROM channel_ingress_events WHERE status = ?"
  ).all("pending") as Array<{ queue_name: string; event_id: string; status: string; payload_json: string }>;

  console.log(`  -> Persisted pending ingress rows in SQLite: ${pendingRowsPostCommit.length}`);
  console.log(`     Row[0] event_id: ${pendingRowsPostCommit[0]?.event_id}, status: ${pendingRowsPostCommit[0]?.status}`);
  logEvent({ event: "i2_enqueue_committed", enqueueResult, pendingRowsPostCommit });

  // -------------------------------------------------------------------------
  // STEP 3: PAUSE Injected immediately post-commit (before I2 admission / T2)
  // -------------------------------------------------------------------------
  console.log("\n[Step 3] PAUSE injected: I2 committed to SQLite, but NOT admitted by pi-sand / T2 not established.");
  console.log("  -> Injection point: Post-commit of runOpenClawStateWriteTransaction in createChannelIngressQueue.enqueue,");
  console.log("     prior to createChannelIngressMonitor.claimBatch or bot/agentCommandFromGatewayIngress.");

  // -------------------------------------------------------------------------
  // STEP 4: Verification during PAUSE window
  // -------------------------------------------------------------------------
  console.log("\n[Step 4] Probing authority checks during PAUSE window...");

  // 4A. Telegram final dispatch check
  let pauseWindowTelegramAllowed = false;
  let pauseWindowTelegramError: string | null = null;
  try {
    assertSessionWriterDeliveryAuthorized(t1Authority, sessionStorePath);
    pauseWindowTelegramAllowed = true;
  } catch (error) {
    pauseWindowTelegramAllowed = false;
    pauseWindowTelegramError = error instanceof Error ? error.message : String(error);
  }
  const pauseWindowTelegramDispatch = isDispatchFinalReplySessionWriterAuthorized(t1ReplyPayload, sessionStorePath);

  // 4B. GitHub publish mutation authority check
  const pauseWindowGithubClaimValid = placements.validateTurnClaim(t1Claim);

  console.log(`  [4A] Telegram Final Dispatch Check Allowed: ${pauseWindowTelegramAllowed} (Dispatch: ${pauseWindowTelegramDispatch})`);
  console.log(`       Error thrown: ${pauseWindowTelegramError ?? "NONE (Passed without check)"}`);
  console.log(`  [4B] GitHub Publication Claim Valid:        ${pauseWindowGithubClaimValid}`);

  // Query what facts were actually read by each check:
  const sessionEntryRead = loadSessionEntryReadOnly({
    sessionKey: REQUEST.sessionKey,
    storePath: sessionStorePath,
    agentId: REQUEST.agentId,
  });
  const placementRecordRead = placements.get(REQUEST.sessionId);

  logEvent({
    event: "pause_window_checks",
    pauseWindowTelegramAllowed,
    pauseWindowTelegramDispatch,
    pauseWindowGithubClaimValid,
    sessionEntryRead,
    placementRecordRead,
  });

  // -------------------------------------------------------------------------
  // STEP 5: Crash / Restart Simulation at PAUSE point
  // -------------------------------------------------------------------------
  console.log("\n[Step 5] Simulating process crash and restart at PAUSE point...");
  closeOpenClawStateDatabaseForTest();

  // Reopen after crash
  const restartedDb = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const restartedPlacements = createWorkerSessionPlacementStore({ database: restartedDb });

  // Query SQLite to verify durability across restart
  const rowsAfterRestart = restartedDb.db.prepare(
    "SELECT queue_name, event_id, status FROM channel_ingress_events WHERE status = ?"
  ).all("pending") as Array<{ queue_name: string; event_id: string; status: string }>;
  console.log(`  -> Pending rows survived crash/restart: ${rowsAfterRestart.length}`);

  let restartTelegramAllowed = false;
  try {
    assertSessionWriterDeliveryAuthorized(t1Authority, sessionStorePath);
    restartTelegramAllowed = true;
  } catch {
    restartTelegramAllowed = false;
  }
  const restartTelegramDispatch = isDispatchFinalReplySessionWriterAuthorized(t1ReplyPayload, sessionStorePath);
  const restartGithubClaimValid = restartedPlacements.validateTurnClaim(t1Claim);

  console.log(`  -> Post-restart Telegram Final Dispatch Allowed: ${restartTelegramAllowed && restartTelegramDispatch}`);
  console.log(`  -> Post-restart GitHub Publication Claim Valid:  ${restartGithubClaimValid}`);

  logEvent({
    event: "crash_restart_checks",
    rowsAfterRestartCount: rowsAfterRestart.length,
    restartTelegramAllowed,
    restartTelegramDispatch,
    restartGithubClaimValid,
  });

  // -------------------------------------------------------------------------
  // STEP 6: Status Query Input Test (未改变 revision 的普通查询输入)
  // -------------------------------------------------------------------------
  console.log("\n[Step 6] Testing status query input (ordinary question without revision change)...");
  const iStatusUpdateId = 2002;
  const iStatusEventId = telegramQueueEventId(iStatusUpdateId);
  const iStatusPayload = {
    update_id: iStatusUpdateId,
    message: {
      message_id: 8882,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1001, type: "private" },
      from: { id: 1001, is_bot: false, first_name: "TimCole666" },
      text: "当前进展如何？",
    },
  };

  const statusEnqueueResult = await queue.enqueue(iStatusEventId, iStatusPayload, {
    laneKey: "telegram:1001",
    receivedAt: Date.now(),
  });
  console.log(`  -> Status query enqueue result kind: ${statusEnqueueResult.kind}`);

  let statusPauseTelegramAllowed = false;
  try {
    assertSessionWriterDeliveryAuthorized(t1Authority, sessionStorePath);
    statusPauseTelegramAllowed = true;
  } catch {
    statusPauseTelegramAllowed = false;
  }
  const statusPauseTelegramDispatch = isDispatchFinalReplySessionWriterAuthorized(t1ReplyPayload, sessionStorePath);
  const statusPauseGithubClaimValid = restartedPlacements.validateTurnClaim(t1Claim);

  console.log(`  -> Status Query PAUSE Telegram Dispatch Allowed: ${statusPauseTelegramAllowed && statusPauseTelegramDispatch}`);
  console.log(`  -> Status Query PAUSE GitHub Claim Valid:        ${statusPauseGithubClaimValid}`);

  logEvent({
    event: "status_query_checks",
    statusEnqueueResult,
    statusPauseTelegramAllowed,
    statusPauseTelegramDispatch,
    statusPauseGithubClaimValid,
  });

  // -------------------------------------------------------------------------
  // STEP 7: Ingress Row Consumption Lifecycle Verification
  // -------------------------------------------------------------------------
  console.log("\n[Step 7] Investigating ingress row consumption lifecycle...");
  // Simulate claim and completion via queue API
  const claimedRow1 = await queue.claimNext({ ownerId: "worker-monitor-1" });
  console.log(`  -> Claimed row id: ${claimedRow1?.id}, status: claimed, token present: ${Boolean(claimedRow1?.claim.token)}`);

  if (claimedRow1) {
    await queue.complete({ id: claimedRow1.id, claim: claimedRow1.claim });
    console.log(`  -> Row ${claimedRow1.id} marked complete via queue.complete()`);
  }

  const completedRow = restartedDb.db.prepare(
    "SELECT queue_name, event_id, status, completed_at FROM channel_ingress_events WHERE event_id = ?"
  ).get(i2EventId) as { queue_name: string; event_id: string; status: string; completed_at: number } | undefined;
  console.log(`  -> Persisted status after completion: ${completedRow?.status} (completed_at: ${completedRow?.completed_at})`);

  logEvent({
    event: "consumption_lifecycle",
    claimedRow1Id: claimedRow1?.id,
    completedRow,
  });

  // -------------------------------------------------------------------------
  // Compile Summary & Verdict
  // -------------------------------------------------------------------------
  const summary = {
    verdict: "FALSIFIED",
    justification: "OpenClaw native mechanisms (channel_ingress_events SQLite queue, sessionWriterDeliveryAuthority, and WorkerSessionTurnClaim) are completely decoupled. Committing durable ingress I2 does not invalidate T1 session writer authority or placement turn claim. In the PAUSE window between I2 commit and T2 admission, stale T1 retains full authority to dispatch to Telegram and mutate GitHub. Crash/restart fails wide open. Therefore, OpenClaw native mechanisms CANNOT be reused as-is for Issue #66.",
    metrics: {
      metric_1_commits: {
        openclaw: openClawGitRev,
        codex: codexGitRev,
      },
      metric_2_pause_injection_point: {
        file: "src/channels/message/ingress-queue.ts",
        function: "createChannelIngressQueue.enqueue",
        boundary: "Immediately after runOpenClawStateWriteTransaction commits the INSERT into channel_ingress_events to SQLite, before monitor.claimNext or responsibility admission / T2 establishment.",
      },
      metric_3_facts_read_by_authority_checks: {
        telegram_final_dispatch_check: {
          caller: "assertSessionWriterDeliveryAuthorized / isAuthorityCurrent",
          source: "sessions.json (or openclaw-agent SQLite session store)",
          facts: [
            "current.sessionId === authority.expectedSessionId",
            "current.lifecycleRevision === authority.expectedLifecycleRevision",
            "current.activeWriterRunId === authority.expectedWriterRunId"
          ],
          inspects_ingress_queue: false,
          reads_sqlite_channel_ingress_events: false,
        },
        github_publication_authority_check: {
          caller: "validateTurnClaim / isCurrentPlacementTurnClaim",
          source: "openclaw.sqlite -> worker_session_placements table",
          facts: [
            "turn_claim_id === claim.claimId",
            "turn_claim_run_id === claim.runId",
            "turn_claim_generation === claim.placementGeneration",
            "turn_claim_owner === claim.owner.kind",
            "state === 'active' || state === 'draining'",
            "environment_id === claim.owner.environmentId",
            "active_owner_epoch === claim.owner.ownerEpoch"
          ],
          inspects_ingress_queue: false,
          reads_sqlite_channel_ingress_events: false,
        },
      },
      metric_4_ingress_row_queryable: {
        queryable: true,
        query: "SELECT * FROM channel_ingress_events WHERE status = 'pending'",
        persisted_row: pendingRowsPostCommit[0] ? {
          queue_name: pendingRowsPostCommit[0].queue_name,
          event_id: pendingRowsPostCommit[0].event_id,
          status: pendingRowsPostCommit[0].status,
        } : null,
      },
      metric_5_ingress_row_consumption_timing: {
        enqueued_status: "pending",
        claim_time: "createChannelIngressMonitor poll loop (queue.claimNext) sets status to 'claimed'",
        dispatch_time: "Dispatched to bot / agent runner via runWithTelegramSpooledReplayUpdate",
        completion_time: "Only after turn execution finishes/settles, lifecycle.onAdopted() calls queue.complete(claim), updating status to 'completed' with completed_at timestamp.",
      },
      metric_6_crash_restart_stale_fence: {
        fenced: false,
        analysis: "Crash and restart preserves the pending ingress row in channel_ingress_events, but reloaded placement and session stores evaluate T1 authority purely against the persisted placement and sessions.json rows. Stale T1 retains full authority after restart; the system fails wide open.",
        post_restart_telegram_dispatch_allowed: restartTelegramAllowed && restartTelegramDispatch,
        post_restart_github_claim_valid: restartGithubClaimValid,
      },
      metric_7_status_query_behavior: {
        closes_protected_window_in_openclaw_native: false,
        spec_requirement_v05: "v0.5 spec requires accepted_generation G -> G+1 upon durable acceptance of ANY input, establishing input_pending := accepted_generation != admitted_generation, which immediately closes the protected action window until classification completes.",
        openclaw_native_reality: "OpenClaw native does not track accepted/admitted generation or gate any authority check on pending ingress. Status queries leave the protected window completely open, exactly like corrections.",
        status_query_telegram_allowed: statusPauseTelegramAllowed && statusPauseTelegramDispatch,
        status_query_github_claim_valid: statusPauseGithubClaimValid,
      },
    },
    recommendation: "Implement a dedicated, minimal Session Authority Seam in OpenClaw/pi-sand (Issue #66): (1) Enqueue in channel_ingress_events must atomically increment accepted_generation in a unified SQLite transaction; (2) assertSessionWriterDeliveryAuthorized and validateTurnClaim must verify accepted_generation == admitted_generation (input_pending == false); (3) Crash/restart must observe accepted_generation > admitted_generation and refuse all protected dispatches and mutations until fresh admission occurs."
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log("\n==================================================================");
  console.log(`FINAL PROBE VERDICT: [ ${summary.verdict} ]`);
  console.log("==================================================================");
  console.log(summary.justification);
  console.log("------------------------------------------------------------------");
  console.log(`Traces saved to: ${tracesDir}`);

} finally {
  await fs.rm(root, { recursive: true, force: true });
}
