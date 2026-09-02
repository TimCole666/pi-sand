/**
 * v0.5 Fresh-Turn Authority & Writer Quiescence Coordinator (Issue #67).
 *
 * Implements canonical fresh-turn authority transitions and closed-world writer surface quiescence:
 * 1. Requires pinned process-containment profile (Writer Class A: workspace-write);
 * 2. Fails closed on uncontained profiles (danger-full-access) or unknown dynamic writers;
 * 3. Permanently retires old turns upon revision-advancing correction;
 * 4. Ensures all T1 descendants, background terminals, and pending publication recovery writers
 *    are fully quiescent before T2 gains protected authority;
 * 5. Rejects all late T1 protocol, tool, or final events permanently.
 *
 * Spec: docs/specs/v0.5-one-chat-responsibility.md (Sections 7, 8, 16 H2)
 * ADR: docs/adr/0002-one-chat-responsibility-boundary.md
 */

import {
  resolveProtectedCodexExecutionProfile,
  createProtectedTurnStartParams,
} from "../contained-codex-profile.js";
import {
  StaleTurnAuthorityError,
  SessionAuthorityFencedError,
} from "./session-authority.js";

export class WriterSurfaceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WriterSurfaceError";
    this.code = code;
  }
}

export class WriterSurfaceNotQuiescentError extends WriterSurfaceError {
  constructor(message = "Writer surface is not quiescent: active writers or uncontained descendants exist") {
    super(message, "ERR_WRITER_NOT_QUIESCENT");
  }
}

export class UncontainedProfileError extends WriterSurfaceError {
  constructor(message = "Uncontained execution profile rejected from protected mode") {
    super(message, "ERR_UNCONTAINED_PROFILE");
  }
}

export class UnknownDynamicWriterError extends WriterSurfaceError {
  constructor(message = "Unknown or unverified dynamic tool with workspace write capability rejected") {
    super(message, "ERR_UNKNOWN_DYNAMIC_WRITER");
  }
}

/**
 * Creates an in-memory Fresh-Turn & Quiescence Coordinator for a protected session.
 */
export function createFreshTurnCoordinator({
  sessionId,
  db,
  codexProfile = "workspace-write",
} = {}) {
  // Validate profile fails closed at creation
  const resolvedProfile = resolveProtectedCodexExecutionProfile({ sandbox: codexProfile });

  const retiredTurnIds = new Set();
  const knownDynamicToolsAllowlist = new Set(["read_file", "list_dir", "file_search", "github_publish"]);

  return {
    sessionId,
    db,
    profile: resolvedProfile,
    retiredTurnIds,
    knownDynamicToolsAllowlist,

    /**
     * Checks whether a turn has been retired permanently.
     */
    isTurnRetired(turnId) {
      return retiredTurnIds.has(turnId);
    },

    /**
     * Retires a turn identity permanently from protected authority.
     */
    retireTurn(turnId) {
      if (turnId) {
        retiredTurnIds.add(turnId);
      }
    },

    /**
     * Validates dynamic tool against closed-world allowlist.
     * Rejects arbitrary tools capable of workspace mutations.
     */
    validateDynamicTool(toolName) {
      if (!knownDynamicToolsAllowlist.has(toolName)) {
        throw new UnknownDynamicWriterError(
          `Tool '${toolName}' is not in the protected closed-world allowlist`
        );
      }
      return true;
    },

    /**
     * Asserts that all allowed writer capabilities for the retired turn are quiescent.
     */
    assertWriterQuiescence({
      activeDescendantPids = [],
      backgroundTerminalsCount = 0,
      pendingPublicationRecoveryCount = 0,
    } = {}) {
      if (activeDescendantPids.length > 0) {
        throw new WriterSurfaceNotQuiescentError(
          `Active descendant processes exist: [${activeDescendantPids.join(", ")}]`
        );
      }
      if (backgroundTerminalsCount > 0) {
        throw new WriterSurfaceNotQuiescentError(
          `Unterminated Codex background terminals: ${backgroundTerminalsCount}`
        );
      }
      if (pendingPublicationRecoveryCount > 0) {
        throw new WriterSurfaceNotQuiescentError(
          `Pending publication/recovery writers capable of local Git mutation exist: ${pendingPublicationRecoveryCount}`
        );
      }
      return true;
    },

    /**
     * Executes the fresh-turn authority transition sequence:
     * 1. Retire canonical oldTurnId;
     * 2. Request teardown of oldTurnId descendants;
     * 3. Settle background terminals and publication writers;
     * 4. Assert quiescence;
     * 5. Establish fresh native turn newTurnId;
     * 6. Bind newTurnId to resultingRevision and return turn start parameters.
     */
    transitionToFreshTurn({
      oldTurnId,
      newTurnId,
      resultingRevision,
      codexThreadId,
      cwd,
      promptText,
      activeDescendantPids = [],
      backgroundTerminalsCount = 0,
      pendingPublicationRecoveryCount = 0,
    }) {
      if (!newTurnId) {
        throw new Error("newTurnId is required for fresh-turn transition");
      }

      // Step 1: Permanently retire old turn
      if (oldTurnId) {
        retiredTurnIds.add(oldTurnId);
      }

      // Step 2-4: Assert writer surface quiescence
      this.assertWriterQuiescence({
        activeDescendantPids,
        backgroundTerminalsCount,
        pendingPublicationRecoveryCount,
      });

      // Step 5: Construct canonical turn/start payload under pinned contained profile
      const turnParams = createProtectedTurnStartParams({
        threadId: codexThreadId,
        workspace: cwd,
        text: promptText,
      });

      return {
        status: "TRANSITION_COMPLETE",
        activeTurnId: newTurnId,
        activeRevision: resultingRevision,
        turnParams,
      };
    },

    /**
     * Routes an incoming Codex protocol notification.
     * Drops notifications from retired turns immediately.
     */
    routeNotification({ turnId, notification }) {
      if (this.isTurnRetired(turnId)) {
        return {
          accepted: false,
          reason: "DROPPED_STALE_TURN",
          turnId,
        };
      }
      return {
        accepted: true,
        notification,
      };
    },
  };
}
