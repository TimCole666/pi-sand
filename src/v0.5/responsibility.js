/**
 * v0.5 Minimal One-Chat Responsibility Semantics (Issue #70).
 *
 * Implements the minimal irreducible responsibility state owned by pi-sand:
 * - Obligation: { id, current_revision, status }
 * - InputDecision: { input_id, obligation_id, classification, resulting_revision }
 *
 * Classification values:
 * - "initial_goal" -> creates Obligation at rev 1
 * - "correction" -> advances current_revision
 * - "ordinary_question_or_status" -> current_revision unchanged
 *
 * Reuses OpenClaw/Codex host mechanics through:
 * - session-authority.js (#66)
 * - fresh-turn-coordinator.js (#67)
 * - github-mutation-fence.js (#68)
 * - final-dispatch-gate.js (#69)
 * - github-capability-isolation.js (#77)
 * - contained-codex-profile.js (#76)
 *
 * Spec: docs/specs/v0.5-one-chat-responsibility.md (Section 3, 18, 19)
 * ADR: docs/adr/0002-one-chat-responsibility-boundary.md
 */

import {
  recordDurableTelegramIngress,
  admitSessionIngress,
  getSessionAuthority,
} from "./session-authority.js";

export const CLASSIFICATION = {
  INITIAL_GOAL: "initial_goal",
  CORRECTION: "correction",
  ORDINARY_QUESTION_OR_STATUS: "ordinary_question_or_status",
};

export const OBLIGATION_STATUS = {
  ACTIVE: "active",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

/**
 * Minimal Responsibility Engine for One-Chat Responsibility.
 */
export function createResponsibilityEngine({
  db,
  sessionId,
  freshTurnCoordinator,
  githubMutationCoordinator,
  finalDispatchGate,
}) {
  let activeObligation = null;
  const decisions = new Map(); // input_id -> InputDecision

  return {
    /**
     * Returns the currently active obligation, or null if none.
     */
    getActiveObligation() {
      return activeObligation ? { ...activeObligation } : null;
    },

    /**
     * Gets a committed InputDecision by inputId.
     */
    getInputDecision(inputId) {
      return decisions.get(inputId) ?? null;
    },

    /**
     * Classifies a durably accepted Telegram input and applies responsibility state transitions.
     * Idempotent: repeated calls with the same inputId return existing decision.
     *
     * @param {object} params
     * @param {string} params.inputId
     * @param {string} params.classification - initial_goal | correction | ordinary_question_or_status
     * @param {string} [params.newTurnId] - Required for fresh-turn transitions on corrections
     * @param {string} [params.codexThreadId]
     * @param {string} [params.cwd]
     * @param {string} [params.promptText]
     * @returns {{ obligation: object, decision: object, authority: object }}
     */
    processInputDecision({
      inputId,
      classification,
      newTurnId,
      codexThreadId,
      cwd,
      promptText,
    }) {
      // 1. Idempotency check
      const existing = decisions.get(inputId);
      if (existing) {
        const currentAuthority = getSessionAuthority(db, sessionId);
        return {
          obligation: { ...activeObligation },
          decision: { ...existing },
          authority: currentAuthority,
          isDuplicate: true,
        };
      }

      let resultingRevision;
      let nextTurnId = newTurnId;

      switch (classification) {
        case CLASSIFICATION.INITIAL_GOAL: {
          if (activeObligation) {
            throw new Error("v0.5 supports exactly one active Obligation per protected conversation");
          }
          activeObligation = {
            id: `obl-${Date.now()}`,
            current_revision: 1,
            status: OBLIGATION_STATUS.ACTIVE,
          };
          resultingRevision = 1;
          break;
        }

        case CLASSIFICATION.CORRECTION: {
          if (!activeObligation || activeObligation.status !== OBLIGATION_STATUS.ACTIVE) {
            throw new Error("Cannot apply correction: no active Obligation");
          }
          activeObligation.current_revision += 1;
          resultingRevision = activeObligation.current_revision;

          // Fresh-turn authority transition via coordinator (#67)
          if (freshTurnCoordinator) {
            const currentAuth = getSessionAuthority(db, sessionId);
            freshTurnCoordinator.transitionToFreshTurn({
              oldTurnId: currentAuth.activeTurnId,
              newTurnId,
              resultingRevision,
              codexThreadId,
              cwd,
              promptText: promptText || "Correction applied",
            });
          }
          break;
        }

        case CLASSIFICATION.ORDINARY_QUESTION_OR_STATUS: {
          if (!activeObligation) {
            throw new Error("Cannot query status: no active Obligation");
          }
          // Revision remains unchanged
          resultingRevision = activeObligation.current_revision;
          // Turn remains unchanged
          const currentAuth = getSessionAuthority(db, sessionId);
          nextTurnId = currentAuth.activeTurnId;
          break;
        }

        default:
          throw new Error(`Unknown classification: ${classification}`);
      }

      const decision = {
        input_id: inputId,
        obligation_id: activeObligation.id,
        classification,
        resulting_revision: resultingRevision,
      };
      decisions.set(inputId, decision);

      // Admit in host session authority
      const updatedAuthority = admitSessionIngress(db, {
        sessionId,
        inputId,
        resultingRevision,
        newTurnId: nextTurnId,
      });

      return {
        obligation: { ...activeObligation },
        decision,
        authority: updatedAuthority,
        isDuplicate: false,
      };
    },

    /**
     * Marks the active obligation completed.
     */
    completeObligation() {
      if (!activeObligation || activeObligation.status !== OBLIGATION_STATUS.ACTIVE) {
        throw new Error("No active obligation to complete");
      }
      activeObligation.status = OBLIGATION_STATUS.COMPLETED;
      return { ...activeObligation };
    },
  };
}
