import test from "node:test";
import assert from "node:assert/strict";
import {
  createFreshTurnCoordinator,
  WriterSurfaceNotQuiescentError,
  UnknownDynamicWriterError,
} from "../src/v0.5/fresh-turn-coordinator.js";

test("Issue #67: creates fresh-turn coordinator with pinned contained profile", () => {
  const coord = createFreshTurnCoordinator({
    sessionId: "sess-1",
    codexProfile: "workspace-write",
  });
  assert.equal(coord.sessionId, "sess-1");
  assert.equal(coord.profile, "workspace-write");
});

test("Issue #67 Trace V05-05: uncontained profile (danger-full-access) fails closed", () => {
  assert.throws(
    () => createFreshTurnCoordinator({
      sessionId: "sess-danger",
      codexProfile: "danger-full-access",
    }),
    (err) => err.message.includes("uncontained execution profile 'danger-full-access'")
  );
});

test("Issue #67: unknown dynamic tool with workspace write capability fails closed", () => {
  const coord = createFreshTurnCoordinator({ sessionId: "sess-1" });

  // Known allowed tools pass
  assert.doesNotThrow(() => coord.validateDynamicTool("read_file"));
  assert.doesNotThrow(() => coord.validateDynamicTool("github_publish"));

  // Arbitrary unverified dynamic tool fails closed
  assert.throws(
    () => coord.validateDynamicTool("unverified_raw_workspace_patcher"),
    (err) => err instanceof UnknownDynamicWriterError
  );
});

test("Issue #67 Trace V05-04: writer quiescence rejects transition if descendants, terminals, or publication writers survive", () => {
  const coord = createFreshTurnCoordinator({ sessionId: "sess-1" });

  // 1. Surviving descendant processes block transition
  assert.throws(
    () => coord.transitionToFreshTurn({
      oldTurnId: "turn-t1",
      newTurnId: "turn-t2",
      resultingRevision: 2,
      codexThreadId: "th-1",
      cwd: "/tmp/ws",
      promptText: "next step",
      activeDescendantPids: [1234, 1235], // surviving descendants!
      backgroundTerminalsCount: 0,
      pendingPublicationRecoveryCount: 0,
    }),
    (err) => err instanceof WriterSurfaceNotQuiescentError && err.message.includes("Active descendant")
  );

  // 2. Unterminated background terminals block transition
  assert.throws(
    () => coord.transitionToFreshTurn({
      oldTurnId: "turn-t1",
      newTurnId: "turn-t2",
      resultingRevision: 2,
      codexThreadId: "th-1",
      cwd: "/tmp/ws",
      promptText: "next step",
      activeDescendantPids: [],
      backgroundTerminalsCount: 1, // unterminated terminal!
      pendingPublicationRecoveryCount: 0,
    }),
    (err) => err instanceof WriterSurfaceNotQuiescentError && err.message.includes("background terminals")
  );

  // 3. Pending publication recovery records block transition
  assert.throws(
    () => coord.transitionToFreshTurn({
      oldTurnId: "turn-t1",
      newTurnId: "turn-t2",
      resultingRevision: 2,
      codexThreadId: "th-1",
      cwd: "/tmp/ws",
      promptText: "next step",
      activeDescendantPids: [],
      backgroundTerminalsCount: 0,
      pendingPublicationRecoveryCount: 1, // pending local git recovery writer!
    }),
    (err) => err instanceof WriterSurfaceNotQuiescentError && err.message.includes("publication/recovery writers")
  );
});

test("Issue #67 Trace V05-03: full transition retires T1 permanently and drops late T1 notifications", () => {
  const coord = createFreshTurnCoordinator({ sessionId: "sess-1" });

  const result = coord.transitionToFreshTurn({
    oldTurnId: "turn-t1",
    newTurnId: "turn-t2",
    resultingRevision: 2,
    codexThreadId: "th-100",
    cwd: "/tmp/ws",
    promptText: "不要改 schema",
    activeDescendantPids: [],
    backgroundTerminalsCount: 0,
    pendingPublicationRecoveryCount: 0,
  });

  assert.equal(result.status, "TRANSITION_COMPLETE");
  assert.equal(result.activeTurnId, "turn-t2");
  assert.equal(result.activeRevision, 2);
  assert.equal(result.turnParams.threadId, "th-100");
  assert.equal(result.turnParams.sandboxPolicy.writableRoots[0], "/tmp/ws");
  assert.equal(result.turnParams.sandboxPolicy.type, "workspaceWrite");

  // T1 is marked retired
  assert.equal(coord.isTurnRetired("turn-t1"), true);
  assert.equal(coord.isTurnRetired("turn-t2"), false);

  // Late notification from T1 is dropped
  const lateNotification = coord.routeNotification({
    turnId: "turn-t1",
    notification: { method: "turn/completed", params: { text: "done" } },
  });
  assert.equal(lateNotification.accepted, false);
  assert.equal(lateNotification.reason, "DROPPED_STALE_TURN");

  // Active notification from T2 is accepted
  const activeNotification = coord.routeNotification({
    turnId: "turn-t2",
    notification: { method: "turn/completed", params: { text: "fixed" } },
  });
  assert.equal(activeNotification.accepted, true);
});
