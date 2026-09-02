import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubMutationCoordinator,
  DuplicateMutationClaimError,
} from "../src/v0.5/github-mutation-fence.js";
import {
  SessionAuthorityFencedError,
  StaleTurnAuthorityError,
} from "../src/v0.5/session-authority.js";

test("Issue #68: claims mutation authority step by step under valid authority", () => {
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

  const coordinator = createGitHubMutationCoordinator({
    getAuthority: () => authority,
  });

  const effectKey = coordinator.deriveEffectKey({
    obligationId: "ob-1",
    revision: 1,
    candidateFingerprint: "sha-abc",
  });

  // Step 1: local commit
  const commitClaim = coordinator.claimMutationAuthority({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    generation: 1,
    effectKey,
    step: "local_commit",
  });
  assert.equal(commitClaim.allowed, true);
  assert.equal(commitClaim.step, "local_commit");

  // Step 2: remote push
  const pushClaim = coordinator.claimMutationAuthority({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    generation: 1,
    effectKey,
    step: "remote_push",
  });
  assert.equal(pushClaim.allowed, true);
  assert.equal(coordinator.isPublicationResolved(effectKey), true);
});

test("Issue #68 Trace V05-07: durable correction arrival fences publication mutation claim immediately", () => {
  // Simulating: I2 arrived, acceptedGeneration bumped to 2, admittedGeneration still 1
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 2, // newer ingress won!
    admittedGeneration: 1,
    activeTurnId: "turn-t1",
    activeRevision: 1,
    inputPending: true,
  };

  const coordinator = createGitHubMutationCoordinator({
    getAuthority: () => authority,
  });

  const effectKey = coordinator.deriveEffectKey({
    obligationId: "ob-1",
    revision: 1,
    candidateFingerprint: "sha-abc",
  });

  // Attempting mutation claim must fail immediately
  assert.throws(
    () => coordinator.claimMutationAuthority({
      sessionId: "sess-1",
      turnId: "turn-t1",
      revision: 1,
      generation: 1,
      effectKey,
      step: "remote_push",
    }),
    (err) => err instanceof SessionAuthorityFencedError
  );
});

test("Issue #68: rejects blind replay of already redeemed mutation claim", () => {
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

  const coordinator = createGitHubMutationCoordinator({
    getAuthority: () => authority,
  });

  const effectKey = coordinator.deriveEffectKey({
    obligationId: "ob-1",
    revision: 1,
    candidateFingerprint: "sha-abc",
  });

  // First claim succeeds
  coordinator.claimMutationAuthority({
    sessionId: "sess-1",
    turnId: "turn-t1",
    revision: 1,
    generation: 1,
    effectKey,
    step: "local_commit",
  });

  // Duplicate claim without reconciliation throws
  assert.throws(
    () => coordinator.claimMutationAuthority({
      sessionId: "sess-1",
      turnId: "turn-t1",
      revision: 1,
      generation: 1,
      effectKey,
      step: "local_commit",
    }),
    (err) => err instanceof DuplicateMutationClaimError
  );
});

test("Issue #68: rejects stale turn mutation attempt", () => {
  let authority = {
    sessionId: "sess-1",
    requiredAuthorityOwner: "pi-sand",
    requiredAuthorityContract: "v0.5-one-chat-responsibility",
    acceptedGeneration: 2,
    admittedGeneration: 2,
    activeTurnId: "turn-t2", // T2 is active!
    activeRevision: 2,
    inputPending: false,
  };

  const coordinator = createGitHubMutationCoordinator({
    getAuthority: () => authority,
  });

  const effectKey = coordinator.deriveEffectKey({
    obligationId: "ob-1",
    revision: 1,
    candidateFingerprint: "sha-abc",
  });

  // T1 attempts mutation
  assert.throws(
    () => coordinator.claimMutationAuthority({
      sessionId: "sess-1",
      turnId: "turn-t1", // stale turn!
      revision: 1,
      generation: 2,
      effectKey,
      step: "remote_push",
    }),
    (err) => err instanceof StaleTurnAuthorityError
  );
});
