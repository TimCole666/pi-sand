import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  initSessionAuthoritySchema,
  getOrCreateSessionAuthority,
  recordDurableTelegramIngress,
  getSessionAuthority,
  assertActionAuthorized,
  SessionAuthorityFencedError,
  StaleTurnAuthorityError,
} from "../src/v0.5/session-authority.js";

import {
  createFreshTurnCoordinator,
  WriterSurfaceNotQuiescentError,
} from "../src/v0.5/fresh-turn-coordinator.js";

import {
  createGitHubMutationCoordinator,
} from "../src/v0.5/github-mutation-fence.js";

import {
  createFinalDispatchGate,
} from "../src/v0.5/final-dispatch-gate.js";

import {
  createResponsibilityEngine,
  CLASSIFICATION,
  OBLIGATION_STATUS,
} from "../src/v0.5/responsibility.js";

async function setupTestEnvironment() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-e2e-"));
  const dbPath = path.join(tmpDir, "e2e.sqlite");
  const db = new DatabaseSync(dbPath);
  initSessionAuthoritySchema(db);

  const sessionId = "tg-session-42";
  getOrCreateSessionAuthority(db, { sessionId });

  const freshTurnCoordinator = createFreshTurnCoordinator({
    sessionId,
    db,
    codexProfile: "workspace-write",
  });

  const githubMutationCoordinator = createGitHubMutationCoordinator({
    getAuthority: (sId) => getSessionAuthority(db, sId),
  });

  let dispatchedFinals = [];
  const finalDispatchGate = createFinalDispatchGate({
    getAuthority: (sId) => getSessionAuthority(db, sId),
    onCommitDispatch: async (event) => {
      dispatchedFinals.push(event);
    },
  });

  const engine = createResponsibilityEngine({
    db,
    sessionId,
    freshTurnCoordinator,
    githubMutationCoordinator,
    finalDispatchGate,
  });

  return {
    db,
    sessionId,
    engine,
    freshTurnCoordinator,
    githubMutationCoordinator,
    finalDispatchGate,
    getDispatchedFinals: () => dispatchedFinals,
    cleanup: async () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Issue #70: End-to-end v0.5 Telegram responsibility release journey", async () => {
  const env = await setupTestEnvironment();
  try {
    const { db, sessionId, engine, freshTurnCoordinator, githubMutationCoordinator, finalDispatchGate } = env;

    // -------------------------------------------------------------
    // Step 1: User says: "帮我把 #123 修好，CI 过了以后告诉我。"
    // -------------------------------------------------------------
    const ingress1 = recordDurableTelegramIngress(db, {
      sessionId,
      inputId: "input-1",
      updateId: 101,
      payload: { text: "帮我把 #123 修好，CI 过了以后告诉我。" },
    });
    assert.equal(ingress1.generation, 1);
    assert.equal(ingress1.authority.acceptedGeneration, 1);
    assert.equal(ingress1.authority.inputPending, true);

    // pi-sand classifies as initial_goal
    const goalResult = engine.processInputDecision({
      inputId: "input-1",
      classification: CLASSIFICATION.INITIAL_GOAL,
      newTurnId: "turn-t1",
    });

    assert.equal(goalResult.obligation.current_revision, 1);
    assert.equal(goalResult.obligation.status, OBLIGATION_STATUS.ACTIVE);
    assert.equal(goalResult.authority.admittedGeneration, 1);
    assert.equal(goalResult.authority.activeTurnId, "turn-t1");
    assert.equal(goalResult.authority.inputPending, false);

    // -------------------------------------------------------------
    // Step 2: User while T1 is live says: "不要改数据库 schema。"
    // -------------------------------------------------------------
    const ingress2 = recordDurableTelegramIngress(db, {
      sessionId,
      inputId: "input-2",
      updateId: 102,
      payload: { text: "不要改数据库 schema。" },
    });
    assert.equal(ingress2.generation, 2);
    assert.equal(ingress2.authority.acceptedGeneration, 2);
    assert.equal(ingress2.authority.admittedGeneration, 1);
    assert.equal(ingress2.authority.inputPending, true);

    // Stale T1 immediately fenced: attempts to mutate GitHub or dispatch final fail!
    const effectKeyT1 = githubMutationCoordinator.deriveEffectKey({
      obligationId: goalResult.obligation.id,
      revision: 1,
      candidateFingerprint: "fingerprint-t1",
    });
    assert.throws(
      () => githubMutationCoordinator.claimMutationAuthority({
        sessionId,
        turnId: "turn-t1",
        revision: 1,
        generation: 1,
        effectKey: effectKeyT1,
        step: "local_commit",
      }),
      (err) => err instanceof SessionAuthorityFencedError
    );

    const staleFinalAttempt = await finalDispatchGate.attemptFinalDispatch({
      sessionId,
      turnId: "turn-t1",
      revision: 1,
      finalText: "Old T1 result",
    });
    assert.equal(staleFinalAttempt.delivered, false);
    assert.equal(staleFinalAttempt.reason, "SEMANTICALLY_INELIGIBLE");

    // pi-sand classifies input-2 as correction -> revision 2, fresh turn T2
    const corrResult = engine.processInputDecision({
      inputId: "input-2",
      classification: CLASSIFICATION.CORRECTION,
      newTurnId: "turn-t2",
      codexThreadId: "th-42",
      cwd: "/tmp/ws",
      promptText: "不要改数据库 schema。",
    });

    assert.equal(corrResult.obligation.current_revision, 2);
    assert.equal(corrResult.authority.admittedGeneration, 2);
    assert.equal(corrResult.authority.activeTurnId, "turn-t2");
    assert.equal(corrResult.authority.inputPending, false);

    // T1 is now permanently retired
    assert.equal(freshTurnCoordinator.isTurnRetired("turn-t1"), true);
    assert.equal(freshTurnCoordinator.isTurnRetired("turn-t2"), false);

    // Late protocol event from T1 is dropped
    const lateT1 = freshTurnCoordinator.routeNotification({
      turnId: "turn-t1",
      notification: { method: "turn/completed" },
    });
    assert.equal(lateT1.accepted, false);

    // -------------------------------------------------------------
    // Step 3: User says: "reconnect 也测一下。"
    // -------------------------------------------------------------
    recordDurableTelegramIngress(db, {
      sessionId,
      inputId: "input-3",
      updateId: 103,
      payload: { text: "reconnect 也测一下。" },
    });
    const reconnectResult = engine.processInputDecision({
      inputId: "input-3",
      classification: CLASSIFICATION.CORRECTION,
      newTurnId: "turn-t3",
      codexThreadId: "th-42",
      cwd: "/tmp/ws",
      promptText: "reconnect 也测一下。",
    });
    assert.equal(reconnectResult.obligation.current_revision, 3);
    assert.equal(reconnectResult.authority.activeTurnId, "turn-t3");

    // -------------------------------------------------------------
    // Step 4: T3 completes work, CI passes, GitHub publication occurs
    // -------------------------------------------------------------
    const effectKeyT3 = githubMutationCoordinator.deriveEffectKey({
      obligationId: reconnectResult.obligation.id,
      revision: 3,
      candidateFingerprint: "fingerprint-t3",
    });

    // Local commit mutation claim under T3 authority
    const commitClaim = githubMutationCoordinator.claimMutationAuthority({
      sessionId,
      turnId: "turn-t3",
      revision: 3,
      generation: 3,
      effectKey: effectKeyT3,
      step: "local_commit",
    });
    assert.equal(commitClaim.allowed, true);

    // Remote push mutation claim under T3 authority
    const pushClaim = githubMutationCoordinator.claimMutationAuthority({
      sessionId,
      turnId: "turn-t3",
      revision: 3,
      generation: 3,
      effectKey: effectKeyT3,
      step: "remote_push",
    });
    assert.equal(pushClaim.allowed, true);
    assert.equal(githubMutationCoordinator.isPublicationResolved(effectKeyT3), true);

    // -------------------------------------------------------------
    // Step 5: Telegram authoritative final dispatch
    // -------------------------------------------------------------
    // Candidate evaluated: CI passed (blockingFactsSatisfied=true), publication resolved
    const finalDelivery = await finalDispatchGate.attemptFinalDispatch({
      sessionId,
      turnId: "turn-t3",
      revision: 3,
      finalText: "✓ 已完成：#123 已修复，未改动 DB schema，已增加 reconnect 测试，CI 全部通过。",
      requiredGitHubResolved: true,
      blockingFactsSatisfied: true,
    });

    assert.equal(finalDelivery.delivered, true);
    assert.equal(env.getDispatchedFinals().length, 1);
    assert.equal(
      env.getDispatchedFinals()[0].finalText,
      "✓ 已完成：#123 已修复，未改动 DB schema，已增加 reconnect 测试，CI 全部通过。"
    );

    // Complete obligation
    const completed = engine.completeObligation();
    assert.equal(completed.status, OBLIGATION_STATUS.COMPLETED);
    assert.equal(completed.current_revision, 3);
  } finally {
    await env.cleanup();
  }
});
