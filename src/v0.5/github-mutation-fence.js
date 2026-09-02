/**
 * v0.5 GitHub Protected Mutation Fence (Issue #68).
 *
 * Enforces one-shot host authority claims at each actual GitHub mutation boundary:
 * 1. Coordinates with Gateway publication handler;
 * 2. Requires one-shot claim before any local Git state mutation or remote push/PR;
 * 3. Binds claims to (generation, turnId, revision, effectKey, mutationStep);
 * 4. Fences mutations if accepted_generation > admitted_generation;
 * 5. Prevents stale publication/recovery state from mutating the newly authoritative workspace;
 * 6. Supports reconciliation without blind replay.
 *
 * Spec: docs/specs/v0.5-one-chat-responsibility.md (Sections 9, 10, 11)
 * ADR: docs/adr/0002-one-chat-responsibility-boundary.md
 */

import { assertActionAuthorized, SessionAuthorityFencedError, StaleTurnAuthorityError, StaleRevisionAuthorityError } from "./session-authority.js";

export class GitHubMutationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GitHubMutationError";
    this.code = code;
  }
}

export class MutationAuthorityClaimError extends GitHubMutationError {
  constructor(message = "GitHub mutation authority claim rejected") {
    super(message, "ERR_MUTATION_CLAIM_REJECTED");
  }
}

export class DuplicateMutationClaimError extends GitHubMutationError {
  constructor(message = "Mutation step already redeemed; blind replay rejected") {
    super(message, "ERR_DUPLICATE_MUTATION_CLAIM");
  }
}

/**
 * Creates an in-memory or database-backed GitHub Publication Mutation Coordinator.
 */
export function createGitHubMutationCoordinator({ getAuthority, updateAuthority }) {
  const redeemedClaims = new Set();
  const publicationRecords = new Map(); // effectKey -> publication state

  return {
    /**
     * Derives a logical effect key for idempotency and recovery.
     * Derived from (obligationId, revision, candidateFingerprint).
     */
    deriveEffectKey({ obligationId, revision, candidateFingerprint }) {
      return `${obligationId}:rev${revision}:github-pub:${candidateFingerprint}`;
    },

    /**
     * Claims one-shot authority immediately before executing a concrete mutation step.
     * Steps: "local_commit", "remote_push", "create_pull_request".
     *
     * @param {object} params
     * @param {string} params.sessionId
     * @param {string} params.turnId
     * @param {number} params.revision
     * @param {number} params.generation
     * @param {string} params.effectKey
     * @param {string} params.step
     * @returns {{ allowed: boolean, claimId: string, effectKey: string }}
     */
    claimMutationAuthority({
      sessionId,
      turnId,
      revision,
      generation,
      effectKey,
      step,
    }) {
      const claimId = `${effectKey}:${step}`;

      // Check duplicate/replay: cannot re-claim already redeemed non-idempotent mutation
      if (redeemedClaims.has(claimId)) {
        throw new DuplicateMutationClaimError(
          `Mutation claim '${claimId}' has already been redeemed. Re-execution requires reconciliation.`
        );
      }

      // Check current authority
      const authority = getAuthority(sessionId);
      if (!authority) {
        throw new MutationAuthorityClaimError(`Session authority for ${sessionId} not found`);
      }

      // Generation must match and cannot have pending unadmitted ingress
      if (authority.inputPending || authority.acceptedGeneration !== generation) {
        throw new SessionAuthorityFencedError(
          `Mutation '${step}' fenced: accepted generation (${authority.acceptedGeneration}) ` +
          `!= claim generation (${generation}) or input pending (${authority.inputPending})`
        );
      }

      // Assert turn and revision validity
      assertActionAuthorized(authority, { turnId, revision, action: `github_mutation:${step}` });

      // Atomically redeem claim
      redeemedClaims.add(claimId);

      // Track publication status
      const existing = publicationRecords.get(effectKey) || {
        effectKey,
        sessionId,
        turnId,
        revision,
        generation,
        steps: [],
        resolved: false,
      };
      existing.steps.push({ step, claimedAt: Date.now() });
      if (step === "create_pull_request" || step === "remote_push") {
        existing.resolved = true;
      }
      publicationRecords.set(effectKey, existing);

      return {
        allowed: true,
        claimId,
        effectKey,
        step,
      };
    },

    /**
     * Checks if a publication effect has already resolved (for recovery readback).
     */
    isPublicationResolved(effectKey) {
      const record = publicationRecords.get(effectKey);
      return Boolean(record?.resolved);
    },

    /**
     * Gets count of pending (unresolved) publication recovery operations.
     */
    getPendingPublicationRecoveryCount() {
      let pending = 0;
      for (const record of publicationRecords.values()) {
        if (!record.resolved) {
          pending++;
        }
      }
      return pending;
    },
  };
}
