/**
 * v0.5 Authoritative Telegram Final Dispatch Gate (Issue #69).
 *
 * Gates authoritative Telegram completion at the actual terminal final-dispatch boundary:
 * 1. Treats Codex final text as only a completion candidate;
 * 2. Implements thin semantic completion gate (turn, revision, publication resolved, blocking facts satisfied);
 * 3. Takes a one-shot current-authority claim immediately before actual delivery;
 * 4. Fails closed (withholds final) if a newer Telegram ingress has won or authority is unavailable.
 *
 * Spec: docs/specs/v0.5-one-chat-responsibility.md (Sections 12, 13, 16 H4)
 * ADR: docs/adr/0002-one-chat-responsibility-boundary.md
 */

import {
  assertActionAuthorized,
  SessionAuthorityFencedError,
  IncompatibleAuthorityError,
} from "./session-authority.js";

export class FinalDispatchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FinalDispatchError";
    this.code = code;
  }
}

export class FinalDispatchedWithheldError extends FinalDispatchError {
  constructor(message = "Authoritative final delivery withheld: newer input arrived or authority missing") {
    super(message, "ERR_FINAL_WITHHELD");
  }
}

/**
 * Validates whether a Codex completion candidate is semantically eligible for authorization.
 *
 * @param {object} candidate
 * @param {string} candidate.turnId
 * @param {number} candidate.revision
 * @param {string} candidate.text
 * @param {object} context
 * @param {object} context.authority - session authority snapshot
 * @param {boolean} [context.requiredGitHubResolved=true] - whether required GitHub publication is completed
 * @param {boolean} [context.blockingFactsSatisfied=true] - whether user-requested blocking fact (e.g. CI passed) is met
 * @returns {boolean}
 */
export function isCompletionCandidateEligible(candidate, {
  authority,
  requiredGitHubResolved = true,
  blockingFactsSatisfied = true,
} = {}) {
  if (!candidate || !authority) {
    return false;
  }

  // Must not have pending unadmitted ingress
  if (authority.inputPending) {
    return false;
  }

  // Must match current active turn and revision
  if (candidate.turnId !== authority.activeTurnId || candidate.revision !== authority.activeRevision) {
    return false;
  }

  // Must have required GitHub publication resolved
  if (!requiredGitHubResolved) {
    return false;
  }

  // Must satisfy explicit blocking facts (e.g. CI passes)
  if (!blockingFactsSatisfied) {
    return false;
  }

  return true;
}

/**
 * Creates an Authoritative Telegram Final Dispatch Gate.
 */
export function createFinalDispatchGate({ getAuthority, onCommitDispatch }) {
  const dispatchedSessions = new Map(); // sessionId -> { turnId, revision, dispatchedAt }

  return {
    /**
     * Attempts to take a one-shot current-authority claim and dispatch the authoritative final message.
     * Withholds final if authority check fails or newer ingress won.
     *
     * @param {object} params
     * @param {string} params.sessionId
     * @param {string} params.turnId
     * @param {number} params.revision
     * @param {string} params.finalText
     * @param {boolean} [params.requiredGitHubResolved=true]
     * @param {boolean} [params.blockingFactsSatisfied=true]
     * @returns {{ delivered: boolean, dispatchedAt?: number, error?: string }}
     */
    async attemptFinalDispatch({
      sessionId,
      turnId,
      revision,
      finalText,
      requiredGitHubResolved = true,
      blockingFactsSatisfied = true,
    }) {
      let authority;
      try {
        authority = getAuthority ? getAuthority(sessionId) : null;
      } catch (err) {
        // Authority lookup failure fails closed
        return {
          delivered: false,
          reason: "AUTHORITY_UNAVAILABLE",
          error: err.message,
        };
      }

      if (!authority) {
        return {
          delivered: false,
          reason: "NO_AUTHORITY",
        };
      }

      // Check semantic eligibility
      const eligible = isCompletionCandidateEligible(
        { turnId, revision, text: finalText },
        { authority, requiredGitHubResolved, blockingFactsSatisfied }
      );

      if (!eligible) {
        return {
          delivered: false,
          reason: "SEMANTICALLY_INELIGIBLE",
          inputPending: authority.inputPending,
        };
      }

      // Assert full authorization right before delivery
      try {
        assertActionAuthorized(authority, { turnId, revision, action: "telegram_final_dispatch" });
      } catch (err) {
        return {
          delivered: false,
          reason: "AUTHORITY_FENCED",
          error: err.message,
        };
      }

      // One-shot claim redemption: prevent duplicate final deliveries for the same turn
      const existing = dispatchedSessions.get(sessionId);
      if (existing && existing.turnId === turnId && existing.revision === revision) {
        return {
          delivered: false,
          reason: "ALREADY_DISPATCHED",
          dispatchedAt: existing.dispatchedAt,
        };
      }

      const now = Date.now();
      dispatchedSessions.set(sessionId, {
        turnId,
        revision,
        dispatchedAt: now,
      });

      if (onCommitDispatch) {
        await onCommitDispatch({ sessionId, turnId, revision, finalText });
      }

      return {
        delivered: true,
        dispatchedAt: now,
        sessionId,
        turnId,
        revision,
      };
    },

    /**
     * Checks if a session turn has already dispatched its final.
     */
    isDispatched(sessionId, turnId) {
      const entry = dispatchedSessions.get(sessionId);
      return Boolean(entry && (!turnId || entry.turnId === turnId));
    },
  };
}
