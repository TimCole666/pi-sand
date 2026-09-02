import test from "node:test";
import assert from "node:assert/strict";
import {
  createFinalDispatchGate,
  isCompletionCandidateEligible,
} from "../src/v0.5/final-dispatch-gate.js";

test("Issue #69: dispatches authoritative final when semantically eligible and authorized", async () => {
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 1,
    admittedGeneration: 1,
    activeTurnId: "turn-t1",
    activeRevision: 1,
    inputPending: false,
  };

  let committedDispatch = null;
  const gate = createFinalDispatchGate({
    getAuthority: () => authority,
    onCommitDispatch: async (event) => {
      committedDispatch = event;
    },
  });

  const res = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    finalText: "已完成，CI 已通过",
    requiredGitHubResolved: true,
    blockingFactsSatisfied: true,
  });

  assert.equal(res.delivered, true);
  assert.equal(committedDispatch?.finalText, "已完成，CI 已通过");
  assert.equal(gate.isDispatched("sess-1", "turn-t1"), true);
});

test("Issue #69 Trace V05-09: correction arrival fences and withholds authoritative final dispatch", async () => {
  // Simulating: I2 arrived before final dispatch claim was committed
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 2, // newer Telegram input won!
    admittedGeneration: 1,
    activeTurnId: "turn-t1",
    activeRevision: 1,
    inputPending: true,
  };

  let committedDispatch = null;
  const gate = createFinalDispatchGate({
    getAuthority: () => authority,
    onCommitDispatch: async (event) => {
      committedDispatch = event;
    },
  });

  const res = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    finalText: "Old T1 completion",
  });

  // Must be withheld!
  assert.equal(res.delivered, false);
  assert.equal(res.reason, "SEMANTICALLY_INELIGIBLE");
  assert.equal(res.inputPending, true);
  assert.equal(committedDispatch, null);
});

test("Issue #69: withholds final when blocking fact (CI pass) or publication is unresolved", async () => {
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 1,
    admittedGeneration: 1,
    activeTurnId: "turn-t1",
    activeRevision: 1,
    inputPending: false,
  };

  const gate = createFinalDispatchGate({ getAuthority: () => authority });

  // 1. CI has not passed
  const ciBlocked = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    finalText: "Done but CI failed",
    blockingFactsSatisfied: false,
  });
  assert.equal(ciBlocked.delivered, false);

  // 2. GitHub publication unresolved
  const pubBlocked = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    finalText: "Done but GitHub not published",
    requiredGitHubResolved: false,
  });
  assert.equal(pubBlocked.delivered, false);
});

test("Issue #69: withholds final from retired turn T1 when active turn is T2", async () => {
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 2,
    admittedGeneration: 2,
    activeTurnId: "turn-t2",
    activeRevision: 2,
    inputPending: false,
  };

  const gate = createFinalDispatchGate({ getAuthority: () => authority });

  const staleResult = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1", // late T1 final arrives after T2 established!
    revision: 1,
    finalText: "Late T1 answer",
  });

  assert.equal(staleResult.delivered, false);
  assert.equal(staleResult.reason, "SEMANTICALLY_INELIGIBLE");
});

test("Issue #69: fails closed if authority owner is missing/throws error", async () => {
  const gate = createFinalDispatchGate({
    getAuthority: () => {
      throw new Error("Storage unreachable");
    },
  });

  const res = await gate.attemptFinalDispatch({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    finalText: "Text",
  });

  assert.equal(res.delivered, false);
  assert.equal(res.reason, "AUTHORITY_UNAVAILABLE");
});
