/**
 * Protected Writer Class A execution profile configuration and pinning for v0.5.
 *
 * Per ADR-0002 and docs/specs/v0.5-one-chat-responsibility.md:
 * Codex-native execution may mutate the authoritative workspace ONLY under a pinned
 * process-containment profile whose teardown mechanically proves that no descendant
 * process retaining workspace write capability can survive T1 retirement into T2 authority.
 *
 * Empirical verification proved that:
 * - Uncontained profiles ("danger-full-access") fail closed because detached descendants,
 *   new sessions (setsid), and new process groups (setpgid) escape ordinary killpg/cleanup.
 * - The pinned contained profile ("workspace-write") enforces Linux bubblewrap PID and
 *   mount namespace isolation, ensuring kernel-level SIGKILL to all namespace descendants
 *   upon teardown.
 */

export const PROTECTED_CONTAINED_PROFILE = "workspace-write";
export const PROTECTED_CONTAINED_POLICY_TYPE = "workspaceWrite";

export const UNCONTAINED_PROFILES = Object.freeze([
  "danger-full-access",
  "dangerFullAccess",
]);

/**
 * Validates and resolves the execution profile for Protected Writer Class A.
 * Fails closed if the profile is uncontained, missing, or unsupported.
 *
 * @param {object} [options]
 * @param {string} [options.sandbox]
 * @returns {string} The pinned contained profile name ("workspace-write")
 */
export function resolveProtectedCodexExecutionProfile(options = {}) {
  const requested = options.sandbox ?? PROTECTED_CONTAINED_PROFILE;

  if (UNCONTAINED_PROFILES.includes(requested)) {
    throw new Error(
      `Protected Writer Class A violation: uncontained execution profile '${requested}' does not guarantee descendant process containment across turn retirement.`,
    );
  }

  if (requested !== PROTECTED_CONTAINED_PROFILE) {
    throw new Error(
      `Protected Writer Class A violation: unknown or unverified execution profile '${requested}'. Only pinned profile '${PROTECTED_CONTAINED_PROFILE}' is permitted.`,
    );
  }

  return PROTECTED_CONTAINED_PROFILE;
}

/**
 * Constructs the thread/start parameters enforcing the pinned contained profile.
 *
 * @param {object} params
 * @param {string} params.cwd Authoritative workspace directory
 * @param {string} params.model
 * @param {string} params.modelProvider
 * @param {string} [params.sandbox]
 * @returns {object} Canonical thread/start request payload
 */
export function createProtectedThreadStartParams(params) {
  if (!params?.cwd) {
    throw new Error("createProtectedThreadStartParams requires a non-empty cwd");
  }

  const sandbox = resolveProtectedCodexExecutionProfile({ sandbox: params.sandbox });

  return {
    cwd: params.cwd,
    model: params.model,
    modelProvider: params.modelProvider,
    approvalPolicy: "never",
    sandbox,
    ...(params.dynamicTools ? { dynamicTools: params.dynamicTools } : {}),
  };
}

/**
 * Constructs turn/start parameters enforcing the pinned contained sandbox policy.
 *
 * @param {object} params
 * @param {string} params.threadId
 * @param {string} params.workspace Authoritative workspace directory
 * @param {string} params.text User message
 * @param {string} [params.clientUserMessageId]
 * @param {string} [params.effort]
 * @returns {object} Canonical turn/start request payload
 */
export function createProtectedTurnStartParams(params) {
  if (!params?.threadId) {
    throw new Error("createProtectedTurnStartParams requires threadId");
  }
  if (!params?.workspace) {
    throw new Error("createProtectedTurnStartParams requires workspace");
  }

  return {
    threadId: params.threadId,
    input: [{ type: "text", text: params.text }],
    ...(params.clientUserMessageId ? { clientUserMessageId: params.clientUserMessageId } : {}),
    approvalPolicy: "never",
    sandboxPolicy: {
      type: PROTECTED_CONTAINED_POLICY_TYPE,
      writableRoots: [params.workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    effort: params.effort ?? "low",
  };
}
