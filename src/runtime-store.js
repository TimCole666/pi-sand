import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDatabaseLock } from "./database-lock.js";
import {
  checkFreshExecutorCompatibility,
  startFreshExecutor,
} from "./fresh-executor.js";
import { processGroupStatus, stopOwnedProcessGroupSync } from "./process.js";
import { runtimeDatabasePath } from "./runtime-ipc.js";
import {
  linuxBootIdentity,
  processGroupIdentity,
  processGroupIsAlive,
  processStartIdentity,
  recordedWorkerIsGone,
  recordedWorkerIsOwned,
} from "./process-group.js";

export const RUNTIME_OWNERSHIP_ERROR =
  "The pi-sand runtime is already owned by another daemon.";
export const TASK_RUNTIME_UNSUPPORTED_ERROR =
  "Fresh Executor Tasks are supported only on Linux.";
export const MAX_TASK_GOAL_LENGTH = 8 * 1024;
export const MAX_TASK_PACKET_LENGTH = 16 * 1024;
export const MAX_TASK_RESULT_LENGTH = 4 * 1024;
export const MAX_TASK_DETAIL_LENGTH = 2 * 1024;
export const MAX_TERMINAL_DETAIL_LENGTH = 1_000;
export const MAX_EVIDENCE_OUTPUT_LENGTH = 8 * 1024;
export const MAX_EVIDENCE_PAYLOAD_LENGTH = 64 * 1024;
export const MAX_LOCAL_GATE_COUNT = 16;
export const MAX_LOCAL_GATE_COMMAND_LENGTH = 4 * 1024;
export const MAX_LOCAL_GATE_TIMEOUT_MS = 60_000;
export const MAX_RESULT_PAYLOAD_LENGTH = 64 * 1024;
export const RESULT_CLAIM_LEASE_MS = 30_000;
export const MAX_RESULT_CLAIM_LEASE_MS = 24 * 60 * 60 * 1000;
export const WORKER_STOP_TIMEOUT_MS = 2_000;
export const MAX_ATTEMPT_RUNS_PER_ATTEMPT = 4;
export const MAX_CONTINUATION_PROMPT_LENGTH = MAX_TASK_PACKET_LENGTH;
export const COMMITMENT_CONTRACT_VERSION = 1;
export const COMMITMENT_CONTROL_VERSION = 1;
export const REMOTE_REF_PREFIX = "refs/heads/pi-sand/";
export const MAX_REMOTE_PUBLICATIONS = 3;
export const MAX_REMOTE_EFFECTS_PER_TASK = 32;
export const MAX_REMOTE_REPOSITORY_ID_LENGTH = 1_024;
const REMOTE_PUBLICATION_TASK_STATES = new Set(["accepted", "running"]);
export const MAX_REMOTE_EFFECT_DETAIL_LENGTH = 2 * 1_024;
export const MAX_WAIT_SUBSCRIPTIONS_PER_TASK = 32;
export const MAX_REQUIRED_CHECKS = 64;
export const MAX_CHECK_SELECTOR_LENGTH = 1_024;
export const CHECK_SELECTOR_REGEX =
  /^(check_run:[^/\0\s]+\/[^\0\s]+|commit_status:[^\0\s]+)$/;
export const DEFAULT_CI_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_CI_CHECK_APPEARANCE_GRACE_MS = 10 * 60 * 1000;
export const CI_RECONCILE_INTERVAL_INITIAL_MS = 30_000;
export const CI_RECONCILE_INTERVAL_MID_MS = 60_000;
export const CI_RECONCILE_INTERVAL_LATE_MS = 300_000;
export const WAIT_REACTOR_IDLE_INTERVAL_MS = 60_000;
const INITIAL_ATTEMPT_RUN_SEQUENCE = 1;
const ACTIVE_ATTEMPT_STATES = new Set(["starting", "running"]);
const ACTIVE_GATE_STATES = new Set(["running", "ambiguous"]);
const WAIT_RECONCILE_CAPABILITY = Symbol("runtime-owned-wait-reconcile");
const WAIT_TRIGGER_CAPABILITY = Symbol("runtime-owned-wait-trigger");
const RETRYABLE_TASK_STATES = new Set(["failed", "stopped", "interrupted"]);
const WORKER_RETIRE_TIMEOUT_MS = 2_000;
const now = () => new Date().toISOString();
const resultTimestamp = (clock) => {
  const value = typeof clock === "function" ? clock() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
};
const commandError = (error) =>
  String(error?.stderr || error?.message || "command failed").trim();
const git = (cwd, args, options = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
const canonicalPath = (path) => realpathSync.native(resolve(path));
const bounded = (value, limit) => String(value ?? "").slice(0, limit);
const appendBounded = (value, chunk, limit) => {
  const current = String(value ?? "");
  const bytes = Buffer.from(String(chunk ?? ""), "utf8");
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  if (bytes.byteLength <= remaining) return current + bytes.toString("utf8");
  let addition = bytes.subarray(0, remaining).toString("utf8");
  while (Buffer.byteLength(addition, "utf8") > remaining)
    addition = addition.slice(0, -1);
  return current + addition;
};

function assertTaskWorktreeIdentity(task) {
  if (canonicalPath(task.sourceRepoRoot) !== task.sourceRepoRoot)
    throw new Error("Task source repository identity changed");
  const records = git(task.sourceRepoRoot, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((record) => {
      const lines = record.split("\n");
      return {
        path: lines
          .find((line) => line.startsWith("worktree "))
          ?.slice("worktree ".length),
        branch: lines
          .find((line) => line.startsWith("branch "))
          ?.slice("branch ".length),
      };
    });
  const record = records.find(
    ({ path }) => path && canonicalPath(path) === task.taskWorktree,
  );
  if (!record || record.branch !== `refs/heads/${task.taskBranch}`) {
    throw new Error("Task worktree or branch identity changed");
  }
  return task;
}
const boundedDetail = (value) => bounded(value, MAX_TERMINAL_DETAIL_LENGTH);
const RESTART_DETAIL =
  "pi-sandd restarted before the Fresh Executor finished; the Attempt was not resumed or replayed.";
const ORPHAN_DETAIL =
  "The prior Fresh Executor could not be safely identified or terminated. The Task is blocked and its worktree was retained.";
const DAEMON_SHUTDOWN_REASON = "daemon-shutdown";
export const DEFAULT_BUDGET = {
  maxTotalAttempts: 7,
  maxCodeProducingAttempts: 4,
  maxReviewerAttempts: 3,
  maxStartupFailures: 2,
  maxPiRunsPerAttempt: 4,
  maxPiTurnsPerAttempt: 20,
  maxActiveAttemptDurationMs: 60 * 60 * 1000,
  maxCiRepairCycles: 2,
  maxRemotePublications: 3,
  maxSameFailureFingerprint: 2,
  maxNoProgressSupervisorIterations: 2,
  maxModelOrThinkingEscalations: 1,
  ciCheckAppearanceGraceMs: 10 * 60 * 1000,
  ciWaitDeadlineMs: 24 * 60 * 60 * 1000,
  totalCommitmentWallClockDeadlineMs: 72 * 60 * 60 * 1000,
};

export function normalizeBudget(rawBudget) {
  if (rawBudget == null) return { ...DEFAULT_BUDGET };
  const budget = typeof rawBudget === "string" ? parsed(rawBudget, {}) : rawBudget;
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
    throw new Error("Task budget must be an object.");
  }
  assertNoRemoteCredentials(budget, "budget");
  const normalized = { ...DEFAULT_BUDGET };
  for (const [key, value] of Object.entries(budget)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_BUDGET, key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Task budget property '${key}' must be a non-negative number.`);
      }
      normalized[key] = Math.min(DEFAULT_BUDGET[key], Math.floor(value));
    }
  }
  return normalized;
}

export function localGateFailureFingerprint({ candidateSha, criterion, exitCategory, exitCode, stderr, error }) {
  const stderrSnippet = bounded(
    typeof stderr === "string" && stderr ? stderr : typeof error === "string" ? error : "",
    500,
  );
  return digest(
    JSON.stringify({
      kind: "local_gate_failure",
      candidateSha: candidateSha ?? "",
      criterion: criterion ?? "",
      exitCategory: exitCategory ?? "",
      exitCode: exitCode ?? null,
      stderr: stderrSnippet,
    }),
  );
}

export function ciFailureFingerprint({ revisionSha, classification, failingChecks = [] }) {
  const checks = Array.isArray(failingChecks)
    ? failingChecks
        .map((c) => ({
          name: c.name ?? c.context ?? c.selector ?? "",
          selector: c.selector ?? "",
          conclusion: c.conclusion ?? c.normalizedState ?? c.state ?? "",
          status: c.status ?? "",
        }))
        .sort((a, b) => (a.name || a.selector).localeCompare(b.name || b.selector))
    : [];
  return digest(
    JSON.stringify({
      kind: "ci_failure",
      revisionSha: revisionSha ?? "",
      classification: classification ?? "failure",
      checks,
    }),
  );
}
const DEFAULT_AUTHORITY = { owner: "pi-sandd" };
const DEFAULT_RETURN_ROUTE = { kind: "manager" };
const TASK_SELECT = `SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit,
  task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state,
  latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt,
  final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead,
  shutdown_reason AS shutdownReason, completion_contract AS completionContract,
  contract_version AS contractVersion, control_version AS controlVersion, authority,
  budget, return_route AS returnRoute, accepted_at AS acceptedAt,
  final_revision AS finalRevision, completion_evidence_ref AS completionEvidenceRef,
  terminal_reason AS terminalReason, publication_count AS publicationCount
  FROM tasks`;
const ATTEMPT_SELECT = `SELECT id, task_id AS taskId, number, applied_provider AS provider, applied_model_id AS modelId,
  applied_thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt,
  worker_pid AS workerPid, worker_pgid AS workerPgid, worker_terminated AS workerTerminated,
  worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId,
  gate_pid AS gatePid, gate_pgid AS gatePgid, gate_start_identity AS gateStartIdentity,
  gate_boot_id AS gateBootId, gate_state AS gateState, gate_terminated AS gateTerminated,
  final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead,
  pi_turn_count AS piTurns, shutdown_reason AS shutdownReason, resume_wait_id AS resumeWaitId, cause
  FROM attempts`;
const ATTEMPT_RUN_SELECT = `SELECT attempt_id AS attemptId, sequence, kind,
  control_version AS controlVersion, contract_version AS contractVersion,
  prompt_digest AS promptDigest, state, settled_outcome AS settledOutcome,
  evidence_refs AS evidenceRefs, started_at AS startedAt, settled_at AS settledAt
  FROM attempt_runs`;
const EVIDENCE_SELECT = `SELECT id, task_id AS taskId, attempt_id AS attemptId,
  attempt_run_id AS attemptRunId, kind, source, subject, subject_digest AS subjectDigest,
  payload, payload_digest AS payloadDigest, dedupe_key AS dedupeKey,
  observed_at AS observedAt FROM evidence`;
const REMOTE_EFFECT_SELECT = `SELECT id, task_id AS taskId,
  control_version AS controlVersion, contract_version AS contractVersion,
  remote, repository, remote_url_digest AS remoteUrlDigest, ref,
  expected_old_oid AS expectedOldOid, new_oid AS newOid,
  action_digest AS actionDigest, state, attempt_count AS attemptCount,
  detail, created_at AS createdAt, prepared_at AS preparedAt,
  transmitted_at AS transmittedAt, confirmed_at AS confirmedAt,
  updated_at AS updatedAt, last_readback_oid AS lastReadbackOid
  FROM remote_effects`;
const RESULT_SELECT = `SELECT id, task_id AS taskId,
  control_version AS controlVersion, contract_version AS contractVersion,
  kind, outcome, payload, payload_digest AS payloadDigest, state,
  claim_owner AS claimOwner, claim_handle AS claimHandle,
  claim_expires_at AS claimExpiresAt, created_at AS createdAt,
  acked_at AS ackedAt FROM result_deliveries`;
const WAIT_SUBSCRIPTION_SELECT = `SELECT id, task_id AS taskId, generation,
  control_version AS controlVersion, contract_version AS contractVersion,
  created_by_attempt_id AS createdByAttemptId, kind, github_host AS githubHost,
  repository_id AS repositoryId, repository_name_snapshot AS repositoryNameSnapshot,
  revision_sha AS revisionSha, published_ref AS publishedRef,
  required_checks AS requiredChecks, accepted_conclusions AS acceptedConclusions,
  status, created_at AS createdAt, deadline_at AS deadlineAt,
  last_reconciled_at AS lastReconciledAt, next_reconcile_at AS nextReconcileAt,
  trigger_evidence_id AS triggerEvidenceId, continuation_attempt_id AS continuationAttemptId
  FROM wait_subscriptions`;

function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function assistantOutcome(event) {
  if (event?.type !== "message_end" || event.message?.role !== "assistant")
    return null;
  return {
    result: assistantText(event.message),
    stopReason: String(event.message.stopReason ?? "").toLowerCase(),
    hasError: Boolean(event.message.error || event.message.errorMessage),
  };
}

function serialized(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parsed(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function promptDigest(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function exactOid(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
    ? value
    : null;
}

function remoteError(code, message, cause) {
  return Object.assign(new Error(message), { code, cause });
}

function remoteDetail(error) {
  const candidate = typeof error?.code === "string" ? error.code : "";
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : "transport";
  return `Remote Git ${code} failure.`;
}

function remoteCredentialField(key) {
  return /token|secret|password|credential|authorization|private.?key|api.?key/i.test(
    String(key),
  );
}

function assertNoRemoteCredentials(value, path = "authority") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertNoRemoteCredentials(entry, `${path}[${index}]`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (remoteCredentialField(key))
      throw new Error(`${path} contains a credential field.`);
    if (
      typeof entry === "string" &&
      /[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(entry)
    )
      throw new Error(`${path}.${key} contains embedded credentials.`);
    assertNoRemoteCredentials(entry, `${path}.${key}`);
  }
}

function boundedRemoteRepositoryId(value) {
  if (typeof value !== "string" || !value) return null;
  if (
    value !== value.trim() ||
    /[\s\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_REMOTE_REPOSITORY_ID_LENGTH
  )
    throw new Error("Remote publication repository identity is invalid or bounded.");
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(parts[0]) ||
    !/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(parts[1]) ||
    parts.some((part) => part === "." || part === "..") ||
    parts[1].toLowerCase().endsWith(".git")
  )
    throw new Error(
      "Remote publication repository identity must be canonical owner/name.",
    );
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

function repositoryIdFromRemotePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2)
    throw new Error("Remote publication endpoint has no repository identity.");
  const repository = parts.at(-1).replace(/\.git$/i, "");
  return boundedRemoteRepositoryId(`${parts.at(-2)}/${repository}`);
}

function credentialFreeRemoteEndpoint(cwd, value) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("Remote publication endpoint is not credential-free.");

  if (/^file:/i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      throw new Error("Remote publication endpoint is invalid.", { cause: error });
    }
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Remote publication endpoint is not credential-free.");
    const endpoint = canonicalPath(fileURLToPath(url));
    return {
      endpoint,
      repositoryId: repositoryIdFromRemotePath(endpoint),
      remoteUrlDigest: digest(endpoint),
    };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      throw new Error("Remote publication endpoint is invalid.", { cause: error });
    }
    const supportedSshUser =
      url.protocol === "ssh:" && url.username === "git" && !url.password;
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      (url.username && !supportedSshUser) ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname
    )
      throw new Error("Remote publication endpoint is not credential-free.");
    return {
      endpoint: value,
      repositoryId: repositoryIdFromRemotePath(url.pathname),
      remoteUrlDigest: digest(value),
    };
  }

  const scpEndpoint = value.match(/^(?:(git)@)?([^/:@]+):(.+)$/);
  if (scpEndpoint) {
    if (value.includes("?") || value.includes("#"))
      throw new Error("Remote publication endpoint is not credential-free.");
    return {
      endpoint: value,
      repositoryId: repositoryIdFromRemotePath(scpEndpoint[3]),
      remoteUrlDigest: digest(value),
    };
  }
  if (value.includes("@") || value.includes("?") || value.includes("#"))
    throw new Error("Remote publication endpoint is not credential-free.");
  const endpoint = canonicalPath(resolve(cwd, value));
  return {
    endpoint,
    repositoryId: repositoryIdFromRemotePath(endpoint),
    remoteUrlDigest: digest(endpoint),
  };
}

function resolveRemotePublicationEndpoint(cwd, authority) {
  let configuredEndpoint;
  try {
    configuredEndpoint = git(cwd, [
      "remote",
      "get-url",
      "--push",
      authority.remote,
    ]);
  } catch (error) {
    throw new Error("Remote publication remote identity could not be read.", {
      cause: error,
    });
  }
  const resolved = credentialFreeRemoteEndpoint(cwd, configuredEndpoint);
  if (resolved.repositoryId !== authority.repositoryId)
    throw new Error(
      "Remote publication endpoint does not match the canonical repository identity.",
    );
  if (
    authority.remoteUrlDigest &&
    resolved.remoteUrlDigest !== authority.remoteUrlDigest
  )
    throw new Error("Remote publication remote identity does not match authority.");
  return resolved;
}

function bindRemotePublicationAuthority(authority, cwd) {
  if (!authority.remotePublication) return authority;
  const resolved = resolveRemotePublicationEndpoint(
    cwd,
    authority.remotePublication,
  );
  return {
    ...authority,
    remotePublication: {
      ...authority.remotePublication,
      remoteUrlDigest: resolved.remoteUrlDigest,
    },
  };
}

function remotePublicationAuthority(authority) {
  const parsedAuthority = parsed(authority, null);
  const raw =
    parsedAuthority?.remotePublication ?? parsedAuthority?.remote_publication;
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Task remotePublication authority must be a JSON object.");
  assertNoRemoteCredentials(raw, "authority.remotePublication");
  const remote = raw.remote ?? raw.remoteName ?? raw.remote_name;
  const repository = boundedRemoteRepositoryId(
    raw.repositoryId ??
      raw.repository_id ??
      raw.repository ??
      raw.repositoryIdentity ??
      raw.repository_identity,
  );
  const allowedRefPrefix =
    raw.allowedRefPrefix ?? raw.allowed_ref_prefix ?? REMOTE_REF_PREFIX;
  const allowCreateOrFastForward =
    raw.allowCreateOrFastForward ?? raw.allow_create_or_fast_forward;
  const allowRewrite = raw.allowRewrite ?? raw.allow_rewrite ?? false;
  const allowDelete = raw.allowDelete ?? raw.allow_delete ?? false;
  const allowPr = raw.allowPr ?? raw.allow_pr ?? false;
  const allowMerge = raw.allowMerge ?? raw.allow_merge ?? false;
  const maxPublications = Number(
    raw.maxPublications ??
      raw.max_publications ??
      raw.publicationBudget ??
      MAX_REMOTE_PUBLICATIONS,
  );
  const remoteUrlDigest =
    raw.remoteUrlDigest ?? raw.remote_url_digest ?? null;
  const githubHost = Object.hasOwn(raw, "githubHost") || Object.hasOwn(raw, "github_host")
    ? normalizeGithubHost(raw.githubHost ?? raw.github_host)
    : null;
  if (remote !== "origin")
    throw new Error("Remote publication authority must name origin.");
  if (repository === null)
    throw new Error("Remote publication authority requires repository identity.");
  if (allowedRefPrefix !== REMOTE_REF_PREFIX)
    throw new Error("Remote publication authority has an unsupported ref prefix.");
  if (allowCreateOrFastForward !== true)
    throw new Error("Remote publication authority must allow create/fast-forward.");
  if ([allowRewrite, allowDelete, allowPr, allowMerge].some((value) => value === true))
    throw new Error("Remote publication authority permits an out-of-scope mutation.");
  if (!Number.isInteger(maxPublications) || maxPublications <= 0 || maxPublications > MAX_REMOTE_PUBLICATIONS)
    throw new Error("Remote publication budget is bounded.");
  if (
    remoteUrlDigest !== null &&
    (typeof remoteUrlDigest !== "string" || !/^[0-9a-f]{64}$/i.test(remoteUrlDigest))
  )
    throw new Error("Remote publication remote URL digest is invalid.");
  return {
    provider: typeof raw.provider === "string" && raw.provider.trim()
      ? raw.provider.trim()
      : "git",
    remote,
    repositoryId: repository,
    remoteUrlDigest: remoteUrlDigest?.toLowerCase() ?? null,
    ...(githubHost ? { githubHost } : {}),
    allowedRefPrefix,
    allowCreateOrFastForward: true,
    allowRewrite: false,
    allowDelete: false,
    allowPr: false,
    allowMerge: false,
    maxPublications,
  };
}

function normalizeAuthority(authority) {
  if (authority == null) return DEFAULT_AUTHORITY;
  const parsedAuthority =
    typeof authority === "string" ? parsed(authority, null) : authority;
  if (
    !parsedAuthority ||
    typeof parsedAuthority !== "object" ||
    Array.isArray(parsedAuthority)
  )
    throw new Error("Task authority must be a JSON object.");
  assertNoRemoteCredentials(parsedAuthority);

  const normalized = {};
  if (Object.hasOwn(parsedAuthority, "owner")) {
    if (typeof parsedAuthority.owner !== "string" || !parsedAuthority.owner.trim())
      throw new Error("Task authority owner must be a non-empty string.");
    normalized.owner = parsedAuthority.owner.trim();
  }
  const rawRemote =
    parsedAuthority.remotePublication ?? parsedAuthority.remote_publication;
  if (rawRemote != null)
    normalized.remotePublication = remotePublicationAuthority(parsedAuthority);
  return normalized;
}

function readExactRemoteRef({ cwd, endpoint, ref }) {
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-remote", "--exit-code", "--refs", endpoint, ref],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    if (error?.status === 2 && !String(error.stdout ?? "").trim()) return null;
    throw remoteError("read", "Remote ref read failed.", error);
  }
  const rows = String(output)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0][1] !== ref || !exactOid(rows[0][0]))
    throw remoteError("read", "Remote ref read was not exact.");
  return rows[0][0].toLowerCase();
}

function pushExactRemoteRef({ cwd, endpoint, ref, expectedOldOid, newOid }) {
  execFileSync(
    "git",
    [
      "push",
      "--porcelain",
      endpoint,
      `${newOid}:${ref}`,
      `--force-with-lease=${ref}:${expectedOldOid ?? ""}`,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function normalizedRemoteOid(value) {
  if (value == null || value === "") return null;
  const oid = exactOid(value);
  if (!oid) throw remoteError("read", "Remote ref read was not an exact object ID.");
  return oid.toLowerCase();
}

function remoteActionDigest({
  taskId,
  controlVersion,
  contractVersion,
  remote,
  repository,
  remoteUrlDigest,
  ref,
  expectedOldOid,
  newOid,
}) {
  return digest(
    JSON.stringify(
      sortedSnapshot({
        taskId,
        controlVersion,
        contractVersion,
        remote,
        repository,
        remoteUrlDigest: remoteUrlDigest ?? null,
        ref,
        expectedOldOid: expectedOldOid ?? null,
        newOid,
      }),
    ),
  );
}

function sortedSnapshot(value) {
  if (Array.isArray(value)) return value.map(sortedSnapshot);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedSnapshot(entry)]),
    );
  return value;
}

function snapshotsEqual(left, right) {
  return JSON.stringify(sortedSnapshot(left)) === JSON.stringify(sortedSnapshot(right));
}

function attemptRunLimit(task) {
  const budget = normalizeBudget(task?.budget);
  return Math.min(
    MAX_ATTEMPT_RUNS_PER_ATTEMPT,
    budget.maxPiRunsPerAttempt ?? MAX_ATTEMPT_RUNS_PER_ATTEMPT,
  );
}

function effectiveMaxPublications(authority, budget) {
  const authorityObject =
    typeof authority === "string" ? parsed(authority, {}) : authority ?? {};
  const remoteAuthority =
    authorityObject.remotePublication ?? authorityObject.remote_publication;
  const authorityMax =
    remoteAuthority?.maxPublications ??
    remoteAuthority?.max_publications ??
    remoteAuthority?.publicationBudget;
  return Math.min(
    Number(authorityMax ?? DEFAULT_BUDGET.maxRemotePublications),
    Number(budget?.maxRemotePublications ?? DEFAULT_BUDGET.maxRemotePublications),
  );
}

function continuationAcknowledgementStatus(acknowledgement) {
  if (acknowledgement === false) return "rejected";
  if (
    !acknowledgement ||
    typeof acknowledgement !== "object" ||
    Array.isArray(acknowledgement)
  )
    return "ambiguous";
  const accepted =
    acknowledgement.accepted === true || acknowledgement.success === true;
  const rejected =
    acknowledgement.accepted === false || acknowledgement.success === false;
  if (accepted && !rejected) return "accepted";
  if (rejected && !accepted) return "rejected";
  return "ambiguous";
}

function continuationBoundary(acknowledgement) {
  for (const key of ["promptGeneration", "attemptRunSequence", "runSequence"]) {
    if (Object.hasOwn(acknowledgement, key)) {
      const value = Number(acknowledgement[key]);
      return Number.isInteger(value) ? value : NaN;
    }
  }
  return null;
}

function defaultCompletionContract(goal) {
  return { objective: goal };
}

function normalizeGithubHost(value) {
  if (value == null) return "github.com";
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error("Task GitHub host must be a valid hostname.");
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host))
    throw new Error("Task GitHub host must be a valid hostname.");
  return host;
}

function requiredChecksFromContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract))
    return [];
  return contract.requiredChecks ??
    contract.required_checks ??
    contract.ciChecks ??
    contract.requiredCiChecks ??
    contract.ci?.requiredChecks ??
    contract.ci?.required_checks ??
    [];
}

function acceptedConclusionsFromContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract))
    return ["success"];
  return contract.acceptedConclusions ??
    contract.accepted_conclusions ??
    contract.ci?.acceptedConclusions ??
    contract.ci?.accepted_conclusions ??
    ["success"];
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
    return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function localGatesFromContract(contract) {
  if (contract == null) return [];
  if (typeof contract !== "object" || Array.isArray(contract))
    throw new Error("Task completionContract must be a JSON object.");
  const rawGates =
    contract.localGates ??
    contract.requiredLocalGates ??
    contract.requiredCommands ??
    null;
  if (rawGates == null) return [];
  if (!Array.isArray(rawGates) || rawGates.length > MAX_LOCAL_GATE_COUNT)
    throw new Error("Task completionContract localGates are bounded.");

  return rawGates.map((rawGate, index) => {
    const gateObject =
      rawGate && typeof rawGate === "object" && !Array.isArray(rawGate)
        ? rawGate
        : null;
    const rawCommand = gateObject?.command ?? rawGate;
    const command =
      Array.isArray(rawCommand)
        ? rawCommand
        : gateObject && typeof rawCommand === "object"
          ? [rawCommand.program, ...(rawCommand.args ?? [])]
          : typeof rawCommand === "string"
            ? [rawCommand]
            : null;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || !part || part.includes("\0"))
    )
      throw new Error(
        "Each local gate must provide a non-empty executable command array.",
      );
    const commandLength = Buffer.byteLength(JSON.stringify(command), "utf8");
    if (commandLength > MAX_LOCAL_GATE_COMMAND_LENGTH)
      throw new Error("Task completionContract local gate command is too large.");
    const id = gateObject?.id ?? gateObject?.name ?? `local-gate-${index + 1}`;
    if (typeof id !== "string" || !id.trim() || Buffer.byteLength(id, "utf8") > 256)
      throw new Error("Each local gate must have a bounded criterion identity.");
    const requestedTimeout = gateObject?.timeoutMs;
    const timeoutMs =
      requestedTimeout == null
        ? MAX_LOCAL_GATE_TIMEOUT_MS
        : Number(requestedTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_LOCAL_GATE_TIMEOUT_MS)
      throw new Error("Each local gate timeout must be bounded.");
    return { id: id.trim(), command, timeoutMs };
  });
}

function migratedAttemptRunState(state) {
  if (state === "completed") return "settled";
  if (state === "running") return "accepted";
  if (state === "starting") return "pending";
  if (state === "orphaned") return "ambiguous";
  return "aborted";
}

export function resolveGitRepositoryRoot(cwd) {
  try {
    return canonicalPath(git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    throw new Error(
      `Git repository root could not be resolved: ${commandError(error)}`,
      { cause: error },
    );
  }
}

export function preflightGitWorkspace(cwd) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
      throw new Error("workspace is not a Git worktree");
    const sourceRepoRoot = resolveGitRepositoryRoot(cwd);
    if (
      git(sourceRepoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    )
      throw new Error(
        "the source Git worktree must be clean (including untracked files)",
      );
    const baseCommit = git(sourceRepoRoot, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit))
      throw new Error("source HEAD is unavailable");
    return { sourceRepoRoot, baseCommit };
  } catch (error) {
    if (/clean \(including untracked files\)/.test(error.message)) throw error;
    throw new Error(`Task Git preflight failed: ${commandError(error)}`, {
      cause: error,
    });
  }
}

function attemptRunSnapshot(row) {
  return {
    attemptId: row.attemptId,
    sequence: row.sequence,
    kind: row.kind,
    controlVersion: row.controlVersion,
    contractVersion: row.contractVersion,
    promptDigest: row.promptDigest ?? null,
    state: row.state,
    settledOutcome: row.settledOutcome ?? null,
    evidenceRefs: parsed(row.evidenceRefs, []),
    startedAt: row.startedAt,
    settledAt: row.settledAt ?? null,
  };
}

function evidenceSnapshot(row) {
  return {
    id: row.id,
    taskId: row.taskId,
    attemptId: row.attemptId ?? null,
    attemptRunId: row.attemptRunId ?? null,
    kind: row.kind,
    source: row.source,
    subject: row.subject,
    subjectDigest: row.subjectDigest,
    payload: parsed(row.payload, row.payload),
    payloadDigest: row.payloadDigest,
    dedupeKey: row.dedupeKey ?? null,
    observedAt: row.observedAt,
  };
}

function remoteEffectSnapshot(row) {
  return {
    id: row.id,
    taskId: row.taskId,
    controlVersion: row.controlVersion,
    contractVersion: row.contractVersion,
    remote: row.remote,
    repository: row.repository,
    remoteUrlDigest: row.remoteUrlDigest ?? null,
    ref: row.ref,
    expectedOldOid: row.expectedOldOid ?? null,
    newOid: row.newOid,
    actionDigest: row.actionDigest,
    state: row.state,
    attemptCount: Number(row.attemptCount ?? 0),
    detail: row.detail ?? null,
    createdAt: row.createdAt,
    preparedAt: row.preparedAt,
    transmittedAt: row.transmittedAt ?? null,
    confirmedAt: row.confirmedAt ?? null,
    updatedAt: row.updatedAt,
    lastReadbackOid: row.lastReadbackOid ?? null,
  };
}

function resultSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.taskId,
    controlVersion: row.controlVersion,
    contractVersion: row.contractVersion,
    kind: row.kind,
    outcome: row.outcome,
    payload: parsed(row.payload, row.payload),
    payloadDigest: row.payloadDigest,
    state: row.state,
    claimOwner: row.claimOwner ?? null,
    claimHandle: row.claimHandle ?? null,
    claimExpiresAt: row.claimExpiresAt ?? null,
    createdAt: row.createdAt,
    ackedAt: row.ackedAt ?? null,
  };
}

function attemptSnapshot(row, attemptRuns = []) {
  return {
    id: row.id,
    taskId: row.taskId,
    number: row.number,
    provider: row.provider,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel,
    state: row.state,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    shutdownReason: row.shutdownReason ?? null,
    workerPid: row.workerPid ?? null,
    workerPgid: row.workerPgid ?? null,
    finalResult: row.finalResult ?? null,
    terminalDetail: row.terminalDetail ?? null,
    finalBranchHead: row.finalBranchHead ?? null,
    workerTerminated: row.workerTerminated === 1,
    workerStartIdentity: row.workerStartIdentity ?? null,
    workerBootId: row.workerBootId ?? null,
    piTurns: Number(row.piTurns ?? 0),
    gatePid: row.gatePid ?? null,
    gatePgid: row.gatePgid ?? null,
    gateStartIdentity: row.gateStartIdentity ?? null,
    gateBootId: row.gateBootId ?? null,
    gateState:
      row.gateState ?? (row.gateTerminated === 1 ? "none" : "ambiguous"),
    gateTerminated: row.gateTerminated === 1,
    resumeWaitId: row.resumeWaitId ?? null,
    cause: row.cause ?? null,
    attemptRuns,
  };
}

function waitSubscriptionSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.taskId,
    generation: Number(row.generation),
    controlVersion: Number(row.controlVersion),
    contractVersion: Number(row.contractVersion),
    createdByAttemptId: row.createdByAttemptId,
    kind: row.kind,
    githubHost: row.githubHost,
    repositoryId: row.repositoryId,
    repositoryNameSnapshot: row.repositoryNameSnapshot,
    revisionSha: row.revisionSha,
    publishedRef: row.publishedRef,
    requiredChecks: parsed(row.requiredChecks, []),
    acceptedConclusions: parsed(row.acceptedConclusions, []),
    status: row.status,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    lastReconciledAt: row.lastReconciledAt ?? null,
    nextReconcileAt: row.nextReconcileAt ?? null,
    triggerEvidenceId: row.triggerEvidenceId ?? null,
    continuationAttemptId: row.continuationAttemptId ?? null,
  };
}

export function matchCheckRun(selector, checkRun) {
  if (
    typeof selector !== "string" ||
    !selector.startsWith("check_run:") ||
    !checkRun
  )
    return false;
  const rest = selector.slice("check_run:".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return false;
  const appSelector = rest.slice(0, slashIdx).trim();
  const checkName = rest.slice(slashIdx + 1).trim();

  if (checkRun.name !== checkName) return false;

  const app = checkRun.app;
  if (!app) return false;
  if (app.slug && app.slug.toLowerCase() === appSelector.toLowerCase())
    return true;
  if (app.id != null && String(app.id) === appSelector) return true;
  if (
    app.name &&
    (app.name.toLowerCase() === appSelector.toLowerCase() ||
      app.name.toLowerCase().replace(/\s+/g, "-") ===
        appSelector.toLowerCase())
  )
    return true;
  return false;
}

export function matchCommitStatus(selector, status, revisionSha) {
  if (
    typeof selector !== "string" ||
    !selector.startsWith("commit_status:") ||
    !status ||
    typeof revisionSha !== "string" ||
    typeof status.sha !== "string" ||
    status.sha.length !== revisionSha.length ||
    status.sha.toLowerCase() !== revisionSha.toLowerCase()
  )
    return false;
  const targetContext = selector.slice("commit_status:".length).trim();
  const context = status.context ?? "default";
  return context === targetContext;
}

export function normalizeCheckRun(checkRun, acceptedConclusions = ["success"]) {
  const status = String(checkRun?.status ?? "").toLowerCase();
  const conclusion =
    checkRun?.conclusion != null
      ? String(checkRun.conclusion).toLowerCase()
      : null;
  const isTerminal = status === "completed" || conclusion != null;

  if (!isTerminal) {
    return {
      normalizedState: "pending",
      conclusion: null,
      isTerminal: false,
    };
  }

  const effectiveConclusion = conclusion ?? "unknown";
  if (acceptedConclusions.includes(effectiveConclusion)) {
    return {
      normalizedState: "success",
      conclusion: effectiveConclusion,
      isTerminal: true,
    };
  }
  return {
    normalizedState: "failure",
    conclusion: effectiveConclusion,
    isTerminal: true,
  };
}

export function normalizeCommitStatus(
  status,
  acceptedConclusions = ["success"],
) {
  const state = String(status?.state ?? "").toLowerCase();
  const isTerminal =
    state === "success" || state === "failure" || state === "error";

  if (!isTerminal || state === "pending") {
    return {
      normalizedState: "pending",
      conclusion: state,
      isTerminal: false,
    };
  }

  if (acceptedConclusions.includes(state)) {
    return {
      normalizedState: "success",
      conclusion: state,
      isTerminal: true,
    };
  }
  return {
    normalizedState: "failure",
    conclusion: state,
    isTerminal: true,
  };
}

export function classifyOverallObservation(selectorResults) {
  if (selectorResults.some((r) => r.normalizedState === "failure"))
    return "failure";
  if (selectorResults.some((r) => r.normalizedState === "ci_not_observable"))
    return "ci_not_observable";
  if (selectorResults.some((r) => r.normalizedState === "pending"))
    return "pending";
  if (
    selectorResults.length > 0 &&
    selectorResults.every((r) => r.normalizedState === "success")
  )
    return "success";
  return "pending";
}

export function computeReconcileInterval(
  createdAt,
  currentTime = Date.now(),
  subscriptionId = "",
) {
  const elapsedMs = Math.max(
    0,
    currentTime - new Date(createdAt).getTime(),
  );
  let interval = CI_RECONCILE_INTERVAL_LATE_MS;
  if (elapsedMs < 10 * 60 * 1000) interval = CI_RECONCILE_INTERVAL_INITIAL_MS;
  else if (elapsedMs < 60 * 60 * 1000) interval = CI_RECONCILE_INTERVAL_MID_MS;
  const jitter = subscriptionId
    ? createHash("sha256").update(subscriptionId).digest().readUInt16BE(0) %
      1000
    : 0;
  return interval + jitter;
}

export async function callFetchCheckRuns(adapter, params) {
  const fn = adapter?.fetchCheckRuns ?? adapter?.getCheckRuns;
  if (typeof fn !== "function")
    throw new Error(
      "GitHub adapter must provide fetchCheckRuns or getCheckRuns.",
    );
  const res = await fn.call(adapter, params);
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.check_runs)) return res.check_runs;
  return [];
}

export async function callFetchCommitStatuses(adapter, params) {
  const fn =
    adapter?.fetchCommitStatuses ??
    adapter?.getCommitStatuses ??
    adapter?.fetchCommitStatus ??
    adapter?.getCommitStatus;
  if (typeof fn !== "function")
    throw new Error(
      "GitHub adapter must provide fetchCommitStatuses or getCommitStatus.",
    );
  const res = await fn.call(adapter, params);
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.statuses)) return res.statuses;
  return [];
}

function redactSecrets(message) {
  return String(message ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{82,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}

async function fetchGitHubJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pi-sand",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw Object.assign(new Error(`GitHub network error: ${err.message}`), {
      code: "network_error",
      cause: err,
    });
  }

  if (!res.ok) {
    const status = res.status;
    const text = await res.text().catch(() => "");
    if (status === 429 || status === 401 || status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      const resetHeader = res.headers.get("x-ratelimit-reset");
      if (status === 429 || remaining === "0" || retryAfter) {
        const retryAfterMs = retryAfter
          ? Number(retryAfter) * 1000
          : resetHeader
            ? Math.max(0, Number(resetHeader) * 1000 - Date.now())
            : 60_000;
        throw Object.assign(new Error("GitHub API rate limit exceeded"), {
          code: "rate_limited",
          retryAfterMs,
          status,
        });
      }
      throw Object.assign(
        new Error(
          `GitHub API authentication/permission error (${status}): ${text.slice(0, 200)}`,
        ),
        { code: "auth_failure", status },
      );
    }
    if (status >= 500) {
      throw Object.assign(
        new Error(`GitHub API server error (${status})`),
        { code: "provider_error", status },
      );
    }
    throw Object.assign(
      new Error(
        `GitHub API request failed (${status}): ${text.slice(0, 200)}`,
      ),
      { code: "api_error", status },
    );
  }

  return await res.json();
}

async function fetchGitHubPages({ apiBase, repository, sha, path, key }) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${apiBase}/repos/${repository}/commits/${sha}/${path}?per_page=100&page=${page}`;
    const data = await fetchGitHubJson(url, token);
    const pageItems = Array.isArray(data?.[key]) ? data[key] : [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return items;
}

export const defaultGitHubAdapter = {
  async fetchCheckRuns({ repository, sha, githubHost = "github.com" }) {
    const apiBase =
      githubHost === "github.com"
        ? "https://api.github.com"
        : `https://${githubHost}/api/v3`;
    return fetchGitHubPages({
      apiBase,
      repository,
      sha,
      path: "check-runs",
      key: "check_runs",
    });
  },

  async fetchCommitStatuses({ repository, sha, githubHost = "github.com" }) {
    const apiBase =
      githubHost === "github.com"
        ? "https://api.github.com"
        : `https://${githubHost}/api/v3`;
    const statuses = await fetchGitHubPages({
      apiBase,
      repository,
      sha,
      path: "status",
      key: "statuses",
    });
    // The commit-status endpoint identifies the commit in its URL, but the
    // documented status items do not normally repeat that SHA. Preserve an
    // explicitly returned SHA for the observer's mismatch fence and annotate
    // only items where the provider omitted the field.
    return statuses.map((status) => {
      if (
        !status ||
        typeof status !== "object" ||
        Object.hasOwn(status, "sha")
      )
        return status;
      return { ...status, sha };
    });
  },
};

function taskSnapshot(row, attempts = [], evidence = [], remoteEffects = [], waitSubscriptions = []) {
  return {
    id: row.id,
    sourceRepoRoot: row.sourceRepoRoot,
    baseCommit: row.baseCommit,
    taskBranch: row.taskBranch,
    taskWorktree: row.taskWorktree,
    goal: row.goal,
    state: row.state,
    latestAttemptId: row.latestAttemptId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    shutdownReason: row.shutdownReason ?? null,
    finalResult: row.finalResult ?? null,
    terminalDetail: row.terminalDetail ?? null,
    finalBranchHead: row.finalBranchHead ?? null,
    completionContract: parsed(row.completionContract),
    contractVersion: row.contractVersion ?? null,
    controlVersion: row.controlVersion ?? null,
    authority: parsed(row.authority),
    budget: parsed(row.budget),
    returnRoute: parsed(row.returnRoute),
    acceptedAt: row.acceptedAt ?? null,
    finalRevision: row.finalRevision ?? null,
    completionEvidenceRef: row.completionEvidenceRef ?? null,
    terminalReason: row.terminalReason ?? null,
    publicationCount: Number(row.publicationCount ?? 0),
    evidence,
    remoteEffects,
    waitSubscriptions,
    attempts,
  };
}

export function buildTaskPacket({
  taskId,
  attemptNumber,
  goal,
  taskBranch,
  taskWorktree,
  baseCommit,
  priorState,
  priorDetail,
}) {
  const lines = [
    "pi-sand Task Packet",
    `Task id: ${taskId}`,
    `Attempt: ${attemptNumber}`,
    `Goal: ${goal}`,
    `Task branch: ${taskBranch}`,
    `Task worktree: ${taskWorktree}`,
    `Base commit: ${baseCommit}`,
  ];
  if (priorState) lines.push(`Previous attempt outcome: ${priorState}`);
  if (priorDetail)
    lines.push(`Previous attempt detail: ${boundedDetail(priorDetail)}`);
  lines.push(
    "Execution rules:",
    "- Work only in the task worktree identified above.",
    "- This is a fresh executor; inspect the current filesystem instead of expecting conversation history.",
    "- Existing filesystem changes from earlier Attempts may remain; do not reset or clean them.",
    "- Use Pi's normal built-in tools, Skills, and context discovery as needed.",
    "- Do not create, enqueue, or run another pi-sand Task. You are not the foreground Manager.",
  );
  const packet = lines.join("\n");
  if (Buffer.byteLength(packet, "utf8") > MAX_TASK_PACKET_LENGTH)
    throw new Error("Task Packet exceeds its bounded size.");
  return packet;
}

export function buildRepairPrompt({
  taskId,
  attemptNumber,
  goal,
  taskBranch,
  taskWorktree,
  baseCommit,
  candidateSha,
  completionContract,
  failingGate,
  ciEvidence,
  priorFailureDetail,
  remainingBudget,
}) {
  const lines = [
    "pi-sand Verification Repair Request",
    `Task id: ${taskId}`,
    `Attempt: ${attemptNumber}`,
    `Goal: ${goal}`,
    `Task branch: ${taskBranch}`,
    `Task worktree: ${taskWorktree}`,
    `Base commit: ${baseCommit}`,
  ];
  if (candidateSha) {
    lines.push(`Candidate SHA: ${candidateSha}`);
  }
  if (completionContract) {
    lines.push(
      `Completion contract: ${typeof completionContract === "string" ? completionContract : JSON.stringify(completionContract)}`,
    );
  }
  if (failingGate) {
    lines.push(
      `Failing local gate: ${failingGate.criterion ?? failingGate.id ?? ""}`,
      `Exit category: ${failingGate.exitCategory ?? ""}`,
      `Exit code: ${failingGate.exitCode ?? ""}`,
    );
    if (failingGate.stderr) {
      lines.push(`Failure stderr snippet:\n${bounded(failingGate.stderr, 500)}`);
    }
    if (failingGate.error) {
      lines.push(`Failure error:\n${bounded(failingGate.error, 500)}`);
    }
  }
  if (ciEvidence) {
    lines.push(
      `Failing CI observation:\n${typeof ciEvidence === "string" ? ciEvidence : JSON.stringify(ciEvidence)}`,
    );
  }
  if (priorFailureDetail) {
    lines.push(`Prior failure detail: ${boundedDetail(priorFailureDetail)}`);
  }
  if (remainingBudget) {
    lines.push(
      `Remaining budget: ${typeof remainingBudget === "string" ? remainingBudget : JSON.stringify(remainingBudget)}`,
    );
  }
  lines.push(
    "Repair instructions:",
    "- Work only in the task worktree identified above.",
    "- Repair the codebase to resolve the failure described above and satisfy the completion contract.",
    "- Do not clean or reset untracked changes unnecessarily.",
  );
  const prompt = lines.join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_CONTINUATION_PROMPT_LENGTH)
    throw new Error("Repair prompt exceeds its bounded size.");
  return prompt;
}

function workerMetadata(worker) {
  const workerPid = Number(worker?.workerPid ?? worker?.pid);
  const workerPgid = Number(
    worker?.workerPgid ?? worker?.processGroupId ?? workerPid,
  );
  if (
    !Number.isInteger(workerPid) ||
    workerPid <= 0 ||
    !Number.isInteger(workerPgid) ||
    workerPgid <= 0
  )
    return null;
  return {
    workerPid,
    workerPgid,
    workerStartIdentity:
      worker.workerStartIdentity ??
      worker.startIdentity ??
      processStartIdentity(workerPid),
    workerBootId: worker.workerBootId ?? worker.bootId ?? linuxBootIdentity(),
  };
}

export class RuntimeStore {
  constructor({
    dbPath = runtimeDatabasePath(),
    piCommand = process.env.PI_BIN ?? "pi",
    workerFactory = startFreshExecutor,
    workerEnv = process.env,
    worktreeRoot,
    workerRetireTimeoutMs = WORKER_RETIRE_TIMEOUT_MS,
    workerStopTimeoutMs = WORKER_STOP_TIMEOUT_MS,
    bootId = linuxBootIdentity(),
    resultClaimLeaseMs = process.env.PI_SAND_RESULT_CLAIM_LEASE_MS ?? RESULT_CLAIM_LEASE_MS,
    resultClock = () => Date.now(),
    remoteTransport,
    beforeRemotePush,
    gitHubAdapter,
    gitHubClient,
    waitClock = () => Date.now(),
    waitTimer = globalThis,
    waitObserver,
    attemptClock = () => Date.now(),
    attemptTimer = globalThis,
  } = {}) {
    this.dbPath = dbPath;
    this.piCommand = piCommand;
    this.workerFactory = workerFactory;
    this.workerEnv = workerEnv;
    this.worktreeRoot = worktreeRoot;
    this.workerRetireTimeoutMs = Math.max(
      0,
      Number(workerRetireTimeoutMs) || 0,
    );
    this.workerStopTimeoutMs = Math.max(0, Number(workerStopTimeoutMs) || 0);
    this.bootId = bootId;
    const configuredResultClaimLeaseMs = Number(resultClaimLeaseMs);
    this.resultClaimLeaseMs = Number.isFinite(configuredResultClaimLeaseMs)
      ? Math.min(Math.max(1, Math.floor(configuredResultClaimLeaseMs)), MAX_RESULT_CLAIM_LEASE_MS)
      : RESULT_CLAIM_LEASE_MS;
    this.resultClock = resultClock;
    this.remoteTransport = remoteTransport ?? {
      readRef: readExactRemoteRef,
      push: pushExactRemoteRef,
    };
    if (
      typeof this.remoteTransport.readRef !== "function" ||
      typeof this.remoteTransport.push !== "function"
    )
      throw new Error("Remote publication transport must provide readRef and push.");
    this.beforeRemotePush = beforeRemotePush;
    this.gitHubAdapter = gitHubAdapter ?? gitHubClient ?? defaultGitHubAdapter;
    this.waitClock = typeof waitClock === "function" ? waitClock : () => Date.now();
    this.waitTimer = waitTimer ?? globalThis;
    if (
      typeof this.waitTimer.setTimeout !== "function" ||
      typeof this.waitTimer.clearTimeout !== "function"
    )
      throw new Error("Wait reactor timer must provide setTimeout and clearTimeout.");
    this.waitObserver = waitObserver ?? null;
    this.attemptClock = typeof attemptClock === "function" ? attemptClock : () => Date.now();
    this.attemptTimer = attemptTimer ?? globalThis;
    if (
      typeof this.attemptTimer.setTimeout !== "function" ||
      typeof this.attemptTimer.clearTimeout !== "function"
    )
      throw new Error("Attempt watchdog timer must provide setTimeout and clearTimeout.");
    this.waitReactorEnabled = false;
    this.waitReactorTimer = null;
    this.waitReactorRunning = false;
    this.waitReactorRequested = false;
    this.databaseLock = null;
    this.db = null;
    this.active = null;
    this.closed = false;
    this.shuttingDown = false;
  }

  ensureSupported() {
    if (process.platform !== "linux")
      throw new Error(TASK_RUNTIME_UNSUPPORTED_ERROR);
  }

  ensureCompletionColumns() {
    const columns = (table) =>
      new Set(
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name),
      );
    const taskColumns = columns("tasks");
    const attemptColumns = columns("attempts");
    for (const [name, type] of [
      ["final_result", "TEXT"],
      ["terminal_detail", "TEXT"],
      ["final_branch_head", "TEXT"],
    ]) {
      if (!taskColumns.has(name))
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      if (!attemptColumns.has(name))
        this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
    }
    if (!attemptColumns.has("worker_terminated"))
      this.db.exec(
        "ALTER TABLE attempts ADD COLUMN worker_terminated INTEGER NOT NULL DEFAULT 1",
      );
    if (!attemptColumns.has("pi_turn_count"))
      this.db.exec(
        "ALTER TABLE attempts ADD COLUMN pi_turn_count INTEGER NOT NULL DEFAULT 0",
      );
    for (const [name, type] of [
      ["gate_pid", "INTEGER"],
      ["gate_pgid", "INTEGER"],
      ["gate_start_identity", "TEXT"],
      ["gate_boot_id", "TEXT"],
      ["gate_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["gate_terminated", "INTEGER NOT NULL DEFAULT 1"],
    ]) {
      if (!attemptColumns.has(name))
        this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
    }
    for (const [table, column] of [
      ["tasks", "shutdown_reason"],
      ["attempts", "shutdown_reason"],
    ]) {
      const columnsForTable = table === "tasks" ? taskColumns : attemptColumns;
      if (!columnsForTable.has(column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    for (const column of [
      "worker_start_identity",
      "worker_boot_id",
      "applied_provider",
      "applied_model_id",
      "applied_thinking_level",
    ]) {
      if (!attemptColumns.has(column))
        this.db.exec(`ALTER TABLE attempts ADD COLUMN ${column} TEXT`);
    }
    const attemptSchema = this.db.prepare("PRAGMA table_info(attempts)").all();
    if (
      attemptSchema.some(
        (column) =>
          ["provider", "model_id", "thinking_level"].includes(column.name) &&
          column.notnull,
      )
    ) {
      this.db.exec("PRAGMA foreign_keys = OFF; BEGIN;");
      try {
        this.db.exec(`ALTER TABLE attempts RENAME TO attempts_legacy;
          CREATE TABLE attempts (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
            provider TEXT, model_id TEXT, thinking_level TEXT, state TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
            worker_start_identity TEXT, worker_boot_id TEXT,
            worker_terminated INTEGER NOT NULL DEFAULT 1,
            pi_turn_count INTEGER NOT NULL DEFAULT 0,
            gate_pid INTEGER, gate_pgid INTEGER, gate_start_identity TEXT, gate_boot_id TEXT,
            gate_state TEXT NOT NULL DEFAULT 'none' CHECK(gate_state IN ('none', 'running', 'terminated', 'ambiguous')),
            gate_terminated INTEGER NOT NULL DEFAULT 1,
            final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT,
            applied_provider TEXT, applied_model_id TEXT, applied_thinking_level TEXT,
            resume_wait_id TEXT UNIQUE REFERENCES wait_subscriptions(id),
            cause TEXT CHECK(cause IN ('initial', 'continuation', 'repair', 'review', 'retry')),
            UNIQUE(task_id, number)
          );
          INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at,
            finished_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated,
            gate_pid, gate_pgid, gate_start_identity, gate_boot_id, gate_state, gate_terminated,
            final_result, terminal_detail, final_branch_head, shutdown_reason, pi_turn_count, applied_provider,
            applied_model_id, applied_thinking_level)
          SELECT id, task_id, number, provider, model_id, thinking_level, state, started_at,
            finished_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated,
            gate_pid, gate_pgid, gate_start_identity, gate_boot_id, gate_state, gate_terminated,
            final_result, terminal_detail, final_branch_head, shutdown_reason, 0, applied_provider,
            applied_model_id, applied_thinking_level
          FROM attempts_legacy;
          DROP TABLE attempts_legacy;
          CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);
          CREATE UNIQUE INDEX IF NOT EXISTS attempts_resume_wait ON attempts(resume_wait_id);`);
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON;");
      }
    }
  }

  ensureAttemptColumns() {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(attempts)")
        .all()
        .map((row) => row.name),
    );
    for (const [name, type] of [
      ["resume_wait_id", "TEXT REFERENCES wait_subscriptions(id)"],
      ["cause", "TEXT CHECK(cause IN ('initial', 'continuation', 'repair', 'review', 'retry'))"],
    ]) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
      }
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS attempts_resume_wait ON attempts(resume_wait_id)",
    );
  }

  ensureCommitmentColumns() {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((row) => row.name),
    );
    for (const [name, type] of [
      ["completion_contract", "TEXT"],
      ["contract_version", "INTEGER NOT NULL DEFAULT 1"],
      ["control_version", "INTEGER NOT NULL DEFAULT 1"],
      ["authority", "TEXT"],
      ["budget", "TEXT"],
      ["return_route", "TEXT"],
      ["accepted_at", "TEXT"],
      ["final_revision", "TEXT"],
      ["completion_evidence_ref", "TEXT"],
      ["terminal_reason", "TEXT"],
      ["publication_count", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }

    const rows = this.db
      .prepare(
        `SELECT id, goal, created_at AS createdAt, state, terminal_detail AS terminalDetail,
        final_branch_head AS finalBranchHead FROM tasks`,
      )
      .all();
    if (rows.length === 0) return;
    const update = this.db.prepare(`UPDATE tasks SET
      completion_contract = COALESCE(completion_contract, ?),
      contract_version = COALESCE(contract_version, ?),
      control_version = COALESCE(control_version, ?),
      authority = COALESCE(authority, ?),
      budget = COALESCE(budget, ?),
      return_route = COALESCE(return_route, ?),
      accepted_at = COALESCE(accepted_at, ?),
      final_revision = COALESCE(final_revision, ?),
      terminal_reason = COALESCE(terminal_reason, ?)
      WHERE id = ?`);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const terminal = [
          "completed",
          "failed",
          "stopped",
          "interrupted",
          "blocked",
        ].includes(row.state);
        update.run(
          JSON.stringify(defaultCompletionContract(row.goal)),
          COMMITMENT_CONTRACT_VERSION,
          COMMITMENT_CONTROL_VERSION,
          JSON.stringify(DEFAULT_AUTHORITY),
          JSON.stringify({}),
          JSON.stringify(DEFAULT_RETURN_ROUTE),
          row.createdAt,
          row.finalBranchHead ?? null,
          terminal ? row.terminalDetail ?? null : null,
          row.id,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  ensureAttemptRuns() {
    const rows = this.db
      .prepare(
        `SELECT a.id AS attemptId, a.task_id AS taskId, a.number,
        a.state AS attemptState, a.started_at AS startedAt, a.finished_at AS finishedAt,
        a.final_result AS finalResult, t.control_version AS controlVersion,
        t.contract_version AS contractVersion
        FROM attempts AS a
        JOIN tasks AS t ON t.id = a.task_id
        WHERE NOT EXISTS (
          SELECT 1 FROM attempt_runs AS existing
          WHERE existing.attempt_id = a.id AND existing.sequence = ?
        )`,
      )
      .all(INITIAL_ATTEMPT_RUN_SEQUENCE);
    if (rows.length === 0) return;
    const insert = this.db.prepare(`INSERT INTO attempt_runs
      (attempt_id, sequence, kind, control_version, contract_version, prompt_digest,
       state, settled_outcome, evidence_refs, started_at, settled_at)
      VALUES (?, ?, 'initial', ?, ?, NULL, ?, ?, '[]', ?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const state = migratedAttemptRunState(row.attemptState);
        insert.run(
          row.attemptId,
          INITIAL_ATTEMPT_RUN_SEQUENCE,
          row.controlVersion ?? COMMITMENT_CONTROL_VERSION,
          row.contractVersion ?? COMMITMENT_CONTRACT_VERSION,
          state,
          state === "settled" ? row.finalResult ?? null : null,
          row.startedAt,
          state === "settled" ? row.finishedAt ?? null : null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  ensureRemoteEffects() {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(remote_effects)")
        .all()
        .map((row) => row.name),
    );
    for (const [name, type] of [
      ["repository", "TEXT NOT NULL DEFAULT ''"],
      ["remote_url_digest", "TEXT"],
      ["expected_old_oid", "TEXT"],
      ["new_oid", "TEXT NOT NULL DEFAULT ''"],
      ["action_digest", "TEXT NOT NULL DEFAULT ''"],
      ["state", "TEXT NOT NULL DEFAULT 'failed'"],
      ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["detail", "TEXT"],
      ["prepared_at", "TEXT"],
      ["transmitted_at", "TEXT"],
      ["confirmed_at", "TEXT"],
      ["updated_at", "TEXT"],
      ["last_readback_oid", "TEXT"],
    ]) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE remote_effects ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      UPDATE remote_effects SET
        prepared_at = COALESCE(prepared_at, created_at),
        updated_at = COALESCE(updated_at, created_at)
      WHERE prepared_at IS NULL OR updated_at IS NULL;
      UPDATE tasks SET publication_count = MIN(
        ${MAX_REMOTE_PUBLICATIONS},
        COALESCE((
          SELECT SUM(CASE
            WHEN attempt_count <= 0 THEN 0
            WHEN attempt_count >= ${MAX_REMOTE_PUBLICATIONS} THEN ${MAX_REMOTE_PUBLICATIONS}
            ELSE attempt_count
          END)
          FROM remote_effects WHERE remote_effects.task_id = tasks.id
        ), 0)
      ) WHERE publication_count = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS remote_effect_identity
        ON remote_effects(task_id, ref, new_oid, action_digest);
    `);
  }

  ensureWaitSubscriptions() {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(wait_subscriptions)")
        .all()
        .map((row) => row.name),
    );
    if (columns.size === 0) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS wait_subscriptions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        generation INTEGER NOT NULL,
        control_version INTEGER NOT NULL,
        contract_version INTEGER NOT NULL,
        created_by_attempt_id TEXT NOT NULL REFERENCES attempts(id),
        kind TEXT NOT NULL CHECK(kind = 'github_ci'),
        github_host TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_name_snapshot TEXT NOT NULL,
        revision_sha TEXT NOT NULL,
        published_ref TEXT NOT NULL,
        required_checks TEXT NOT NULL,
        accepted_conclusions TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'triggered', 'superseded', 'cancelled', 'timed_out')),
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        last_reconciled_at TEXT,
        next_reconcile_at TEXT,
        trigger_evidence_id TEXT REFERENCES evidence(id),
        continuation_attempt_id TEXT REFERENCES attempts(id),
        UNIQUE(task_id, generation)
      );
      CREATE INDEX IF NOT EXISTS wait_subscriptions_task_generation
        ON wait_subscriptions(task_id, generation, status);
      CREATE INDEX IF NOT EXISTS wait_subscriptions_status_reconcile
        ON wait_subscriptions(status, next_reconcile_at, deadline_at);`);
      return;
    }
    for (const [name, type] of [
      ["control_version", "INTEGER NOT NULL DEFAULT 1"],
      ["contract_version", "INTEGER NOT NULL DEFAULT 1"],
      ["github_host", "TEXT NOT NULL DEFAULT 'github.com'"],
      ["repository_id", "TEXT NOT NULL DEFAULT ''"],
      ["repository_name_snapshot", "TEXT NOT NULL DEFAULT ''"],
      ["revision_sha", "TEXT NOT NULL DEFAULT ''"],
      ["published_ref", "TEXT NOT NULL DEFAULT ''"],
      ["required_checks", "TEXT NOT NULL DEFAULT '[]'"],
      ["accepted_conclusions", "TEXT NOT NULL DEFAULT '[\"success\"]'"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ["created_at", "TEXT NOT NULL DEFAULT ''"],
      ["deadline_at", "TEXT NOT NULL DEFAULT ''"],
      ["last_reconciled_at", "TEXT"],
      ["next_reconcile_at", "TEXT"],
      ["trigger_evidence_id", "TEXT REFERENCES evidence(id)"],
      ["continuation_attempt_id", "TEXT REFERENCES attempts(id)"],
    ]) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE wait_subscriptions ADD COLUMN ${name} ${type}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wait_subscriptions_task_generation
        ON wait_subscriptions(task_id, generation, status);
      CREATE INDEX IF NOT EXISTS wait_subscriptions_status_reconcile
        ON wait_subscriptions(status, next_reconcile_at, deadline_at);
    `);
  }

  open() {
    this.ensureSupported();
    if (this.closed) throw new Error("The pi-sand runtime is closed.");
    if (this.db) return this;
    if (this.dbPath !== ":memory:")
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      this.databaseLock = acquireDatabaseLock(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      if (this.dbPath !== ":memory:") chmodSync(this.dbPath, 0o600);
      this.db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
          task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
          state TEXT NOT NULL, latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT,
          completion_contract TEXT, contract_version INTEGER NOT NULL DEFAULT 1,
          control_version INTEGER NOT NULL DEFAULT 1, authority TEXT, budget TEXT,
          return_route TEXT, accepted_at TEXT, final_revision TEXT,
          completion_evidence_ref TEXT, terminal_reason TEXT,
          publication_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
          provider TEXT, model_id TEXT, thinking_level TEXT, state TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
          worker_start_identity TEXT, worker_boot_id TEXT,
          worker_terminated INTEGER NOT NULL DEFAULT 1,
          pi_turn_count INTEGER NOT NULL DEFAULT 0,
          gate_pid INTEGER, gate_pgid INTEGER, gate_start_identity TEXT, gate_boot_id TEXT,
          gate_state TEXT NOT NULL DEFAULT 'none' CHECK(gate_state IN ('none', 'running', 'terminated', 'ambiguous')),
          gate_terminated INTEGER NOT NULL DEFAULT 1,
          final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT,
          applied_provider TEXT, applied_model_id TEXT, applied_thinking_level TEXT,
          resume_wait_id TEXT UNIQUE REFERENCES wait_subscriptions(id),
          cause TEXT CHECK(cause IN ('initial', 'continuation', 'repair', 'review', 'retry')),
          UNIQUE(task_id, number)
        );
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
        CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);`);
      this.ensureCompletionColumns();
      this.ensureCommitmentColumns();
      this.ensureAttemptColumns();
      this.db.exec(`CREATE TABLE IF NOT EXISTS attempt_runs (
        attempt_id TEXT NOT NULL REFERENCES attempts(id), sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('initial', 'continue', 'local_repair', 'review')),
        control_version INTEGER NOT NULL, contract_version INTEGER NOT NULL,
        prompt_digest TEXT, state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'settled', 'aborted', 'ambiguous')),
        settled_outcome TEXT, evidence_refs TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL, settled_at TEXT, UNIQUE(attempt_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS attempt_runs_attempt ON attempt_runs(attempt_id, sequence);`);
      this.ensureAttemptRuns();
      this.db.exec(`CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT REFERENCES attempts(id), attempt_run_id TEXT,
        kind TEXT NOT NULL, source TEXT NOT NULL, subject TEXT NOT NULL,
        subject_digest TEXT NOT NULL, payload TEXT NOT NULL,
        payload_digest TEXT NOT NULL, dedupe_key TEXT UNIQUE, observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_task ON evidence(task_id, observed_at, id);
      CREATE TRIGGER IF NOT EXISTS evidence_immutable_update
      BEFORE UPDATE ON evidence BEGIN
        SELECT RAISE(ABORT, 'Evidence is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_immutable_delete
      BEFORE DELETE ON evidence BEGIN
        SELECT RAISE(ABORT, 'Evidence is immutable');
      END;
      CREATE TABLE IF NOT EXISTS result_deliveries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        control_version INTEGER NOT NULL,
        contract_version INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind = 'final_result'),
        outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'failed', 'cancelled')),
        payload TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'claimed', 'acked')),
        claim_owner TEXT,
        claim_handle TEXT,
        claim_expires_at TEXT,
        created_at TEXT NOT NULL,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS result_deliveries_claimable
        ON result_deliveries(state, created_at, id);
      CREATE INDEX IF NOT EXISTS result_deliveries_task
        ON result_deliveries(task_id, created_at, id);
      CREATE TABLE IF NOT EXISTS remote_effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        control_version INTEGER NOT NULL,
        contract_version INTEGER NOT NULL,
        remote TEXT NOT NULL,
        repository TEXT NOT NULL,
        remote_url_digest TEXT,
        ref TEXT NOT NULL,
        expected_old_oid TEXT,
        new_oid TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared', 'transmitted_unknown', 'confirmed', 'conflict', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        created_at TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        transmitted_at TEXT,
        confirmed_at TEXT,
        updated_at TEXT NOT NULL,
        last_readback_oid TEXT,
        UNIQUE(task_id, ref, new_oid, action_digest)
      );
      CREATE INDEX IF NOT EXISTS remote_effects_task
        ON remote_effects(task_id, created_at, id);
      CREATE INDEX IF NOT EXISTS remote_effects_current
        ON remote_effects(task_id, ref, state, created_at, id);
      CREATE TABLE IF NOT EXISTS wait_subscriptions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        generation INTEGER NOT NULL,
        control_version INTEGER NOT NULL,
        contract_version INTEGER NOT NULL,
        created_by_attempt_id TEXT NOT NULL REFERENCES attempts(id),
        kind TEXT NOT NULL CHECK(kind = 'github_ci'),
        github_host TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_name_snapshot TEXT NOT NULL,
        revision_sha TEXT NOT NULL,
        published_ref TEXT NOT NULL,
        required_checks TEXT NOT NULL,
        accepted_conclusions TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'triggered', 'superseded', 'cancelled', 'timed_out')),
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        last_reconciled_at TEXT,
        next_reconcile_at TEXT,
        trigger_evidence_id TEXT REFERENCES evidence(id),
        continuation_attempt_id TEXT REFERENCES attempts(id),
        UNIQUE(task_id, generation)
      );
      CREATE INDEX IF NOT EXISTS wait_subscriptions_task_generation
        ON wait_subscriptions(task_id, generation, status);
      CREATE INDEX IF NOT EXISTS wait_subscriptions_status_reconcile
        ON wait_subscriptions(status, next_reconcile_at, deadline_at);`);
      this.ensureRemoteEffects();
      this.ensureWaitSubscriptions();
      this.reconcilePriorGates();
      this.reconcilePriorAttempts();
      return this;
    } catch (error) {
      this.release();
      if (/already running for this database/i.test(error.message))
        throw new Error(RUNTIME_OWNERSHIP_ERROR, { cause: error });
      throw error;
    }
  }

  attemptRows() {
    return this.db
      .prepare(`SELECT id, task_id AS taskId, state, worker_pid AS workerPid,
      worker_pgid AS workerPgid, worker_start_identity AS workerStartIdentity,
      worker_boot_id AS workerBootId, worker_terminated AS workerTerminated,
      gate_pid AS gatePid, gate_pgid AS gatePgid, gate_start_identity AS gateStartIdentity,
      gate_boot_id AS gateBootId, gate_state AS gateState, gate_terminated AS gateTerminated
      FROM attempts WHERE state IN ('starting', 'running', 'orphaned')
      OR (state = 'interrupted' AND worker_terminated = 0)
      OR gate_terminated = 0 OR gate_state IN ('running', 'ambiguous')
      ORDER BY started_at, id`)
      .all();
  }

  #gateUnresolved(attempt) {
    return Boolean(
      attempt &&
        (attempt.gateTerminated === 0 || ACTIVE_GATE_STATES.has(attempt.gateState)),
    );
  }

  #gateMetadata(attempt) {
    return {
      workerPid: Number(attempt?.gatePid),
      workerPgid: Number(attempt?.gatePgid),
      workerStartIdentity: attempt?.gateStartIdentity ?? null,
      workerBootId: attempt?.gateBootId ?? null,
    };
  }

  #setGateState(attemptId, state) {
    if (!this.db) return false;
    const gateTerminated = state === "terminated" ? 1 : 0;
    const row = this.db
      .prepare(
        "SELECT gate_state AS gateState, gate_terminated AS gateTerminated FROM attempts WHERE id = ?",
      )
      .get(attemptId);
    if (!row) return false;
    if (
      row.gateState === state &&
      Number(row.gateTerminated) === gateTerminated
    )
      return true;
    return (
      this.db
        .prepare(
          "UPDATE attempts SET gate_state = ?, gate_terminated = ? WHERE id = ?",
        )
        .run(state, gateTerminated, attemptId).changes === 1
    );
  }

  #recordGateProcess(active, metadata, identityProven) {
    const gateState = identityProven ? "running" : "ambiguous";
    const gateTerminated = 0;
    const result = this.db
      .prepare(`UPDATE attempts SET gate_pid = ?, gate_pgid = ?,
        gate_start_identity = ?, gate_boot_id = ?, gate_state = ?, gate_terminated = ?
        WHERE id = ? AND task_id = ? AND state = 'running'
        AND gate_terminated = 1`)
      .run(
        Number.isInteger(metadata?.workerPid) ? metadata.workerPid : null,
        Number.isInteger(metadata?.workerPgid) ? metadata.workerPgid : null,
        metadata?.workerStartIdentity ?? null,
        metadata?.workerBootId ?? null,
        gateState,
        gateTerminated,
        active.attemptId,
        active.taskId,
      );
    if (result.changes !== 1)
      throw new Error("Local gate process identity could not be durably recorded.");
    return true;
  }

  #markGateBlocked(attempt, { reason = null } = {}) {
    const detail = reason
      ? `pi-sandd ${reason} could not prove safe local gate termination; the Task is blocked and its worktree was retained.`
      : "The prior local gate could not be safely identified or terminated. The Task is blocked and its worktree was retained.";
    this.markBlocked(attempt.taskId, attempt.id, detail);
  }

  #reconcileGate(attempt) {
    if (!this.#gateUnresolved(attempt)) return "none";
    const metadata = this.#gateMetadata(attempt);
    let safelyGone = false;
    // A boot boundary proves the recorded gate cannot execute, but never
    // permits signalling a reused PID or process-group id.
    if (
      attempt.gateBootId &&
      this.bootId &&
      attempt.gateBootId !== this.bootId
    ) {
      safelyGone = true;
    } else {
      const status = processGroupStatus(metadata.workerPgid);
      if (status === "gone") safelyGone = true;
      else if (
        status === "alive" &&
        stopOwnedProcessGroupSync(metadata, {
          timeoutMs: this.workerStopTimeoutMs,
          currentBootId: this.bootId,
        })
      ) {
        safelyGone = true;
      }
    }
    if (safelyGone) {
      try {
        if (this.#setGateState(attempt.id, "terminated")) return "terminated";
      } catch {}
    }
    try {
      this.#setGateState(attempt.id, "ambiguous");
    } catch {}
    return "ambiguous";
  }

  reconcilePriorGates({ reason = null } = {}) {
    const attempts = this.db
      .prepare(
        `${ATTEMPT_SELECT} WHERE gate_terminated = 0 OR gate_state IN ('running', 'ambiguous') ORDER BY started_at, id`,
      )
      .all();
    for (const attempt of attempts) {
      if (this.#reconcileGate(attempt) === "ambiguous")
        this.#markGateBlocked(attempt, { reason });
    }
  }

  updateTaskForAttempt(attempt, state, detail, shutdownReason = null) {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE attempts SET state = ?, finished_at = COALESCE(finished_at, ?),
      terminal_detail = ?, shutdown_reason = COALESCE(?, shutdown_reason), worker_terminated = ? WHERE id = ?`)
        .run(
          state,
          timestamp,
          boundedDetail(detail),
          shutdownReason,
          state === "interrupted" ? 1 : 0,
          attempt.id,
        );
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = ?, updated_at = ?, terminal_detail = ?,
      terminal_reason = ?, shutdown_reason = COALESCE(?, shutdown_reason)
      WHERE id = ? AND latest_attempt_id = ?`)
        .run(
          state === "orphaned" ? "blocked" : "interrupted",
          timestamp,
          boundedDetail(detail),
          boundedDetail(detail),
          shutdownReason,
          attempt.taskId,
          attempt.id,
        );
      this.db
        .prepare(`UPDATE attempt_runs SET state = ?, settled_outcome = COALESCE(settled_outcome, ?),
        settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND state IN ('pending', 'accepted')`)
        .run(
          state === "orphaned" ? "ambiguous" : "aborted",
          boundedDetail(detail),
          timestamp,
          attempt.id,
        );
      if (taskUpdate.changes === 1 && state === "interrupted") {
        const resultId = this.#insertResultDelivery({
          task: this.#taskRow(attempt.taskId),
          outcome: "failed",
          finalResult: attempt.finalResult ?? null,
          terminalDetail: boundedDetail(detail),
          terminalReason: "interrupted",
          finalRevision: attempt.finalBranchHead ?? null,
          finalBranchHead: attempt.finalBranchHead ?? null,
        });
        if (!resultId) throw new Error("Interrupted Task did not produce a Result delivery.");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  reconcileAttempt(attempt, { reason = null } = {}) {
    if (
      attempt.state === "starting" &&
      attempt.workerPid == null &&
      attempt.workerPgid == null
    ) {
      return "starting";
    }
    const detail = reason
      ? `pi-sandd ${reason} could not prove safe worker termination; the Task is blocked and its worktree was retained.`
      : ORPHAN_DETAIL;
    // A Linux boot boundary is a complete proof that the old worker cannot
    // execute. It is checked before any signal is considered.
    if (
      attempt.workerBootId &&
      this.bootId &&
      attempt.workerBootId !== this.bootId
    ) {
      this.updateTaskForAttempt(
        attempt,
        "interrupted",
        "The recorded Fresh Executor belongs to a prior Linux boot; it was not resumed or replayed.",
        reason,
      );
      return "interrupted";
    }
    const status = processGroupStatus(attempt.workerPgid);
    if (status === "gone") {
      this.updateTaskForAttempt(
        attempt,
        "interrupted",
        reason
          ? "The daemon stopped the Fresh Executor; its process group is proven gone."
          : RESTART_DETAIL,
        reason,
      );
      return "interrupted";
    }
    const worker = {
      workerPid: attempt.workerPid,
      workerPgid: attempt.workerPgid,
      workerStartIdentity: attempt.workerStartIdentity,
      workerBootId: attempt.workerBootId,
    };
    if (
      status === "alive" &&
      stopOwnedProcessGroupSync(worker, {
        timeoutMs: this.workerStopTimeoutMs,
        currentBootId: this.bootId,
      })
    ) {
      this.updateTaskForAttempt(
        attempt,
        "interrupted",
        reason
          ? "The daemon stopped the owned Fresh Executor; its process group is proven gone."
          : RESTART_DETAIL,
        reason,
      );
      return "interrupted";
    }
    this.updateTaskForAttempt(attempt, "orphaned", detail, reason);
    return "orphaned";
  }

  reconcilePriorAttempts({ reason = null } = {}) {
    for (const attempt of this.attemptRows()) {
      if (this.#gateUnresolved(attempt)) {
        this.#markGateBlocked(attempt, { reason });
        continue;
      }
      this.reconcileAttempt(attempt, { reason });
    }
  }

  listTasks() {
    this.open();
    const rows = this.db
      .prepare(`${TASK_SELECT} ORDER BY created_at, id`)
      .all();
    const attempts = this.db
      .prepare(`${ATTEMPT_SELECT} ORDER BY task_id, number`)
      .all();
    const attemptRuns = this.db
      .prepare(`${ATTEMPT_RUN_SELECT} ORDER BY attempt_id, sequence`)
      .all();
    const runsByAttempt = new Map();
    for (const run of attemptRuns)
      runsByAttempt.set(run.attemptId, [
        ...(runsByAttempt.get(run.attemptId) ?? []),
        attemptRunSnapshot(run),
      ]);
    const evidenceRows = this.db
      .prepare(`${EVIDENCE_SELECT} ORDER BY task_id, observed_at, id`)
      .all();
    const evidenceByTask = new Map();
    for (const evidence of evidenceRows)
      evidenceByTask.set(evidence.taskId, [
        ...(evidenceByTask.get(evidence.taskId) ?? []),
        evidenceSnapshot(evidence),
      ]);
    const remoteEffectRows = this.db
      .prepare(`${REMOTE_EFFECT_SELECT} ORDER BY task_id, created_at, id`)
      .all();
    const remoteEffectsByTask = new Map();
    for (const effect of remoteEffectRows)
      remoteEffectsByTask.set(effect.taskId, [
        ...(remoteEffectsByTask.get(effect.taskId) ?? []),
        remoteEffectSnapshot(effect),
      ]);
    const waitSubscriptionRows = this.db
      .prepare(`${WAIT_SUBSCRIPTION_SELECT} ORDER BY task_id, generation, created_at, id`)
      .all();
    const waitSubscriptionsByTask = new Map();
    for (const wait of waitSubscriptionRows)
      waitSubscriptionsByTask.set(wait.taskId, [
        ...(waitSubscriptionsByTask.get(wait.taskId) ?? []),
        waitSubscriptionSnapshot(wait),
      ]);
    const grouped = new Map();
    for (const attempt of attempts)
      grouped.set(attempt.taskId, [
        ...(grouped.get(attempt.taskId) ?? []),
        attemptSnapshot(attempt, runsByAttempt.get(attempt.id) ?? []),
      ]);
    return rows.map((row) =>
      taskSnapshot(
        row,
        grouped.get(row.id) ?? [],
        evidenceByTask.get(row.id) ?? [],
        remoteEffectsByTask.get(row.id) ?? [],
        waitSubscriptionsByTask.get(row.id) ?? [],
      ),
    );
  }

  #taskRow(id) {
    return this.db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id);
  }

  #taskAttemptRows(id) {
    return this.db
      .prepare(`${ATTEMPT_SELECT} WHERE task_id = ? ORDER BY number`)
      .all(id);
  }

  #attemptRunRows(attemptId) {
    return this.db
      .prepare(`${ATTEMPT_RUN_SELECT} WHERE attempt_id = ? ORDER BY sequence`)
      .all(attemptId);
  }

  getTask(id) {
    this.open();
    const row = this.#taskRow(id);
    if (!row) return null;
    const attempts = this.#taskAttemptRows(id).map((attempt) =>
      attemptSnapshot(
        attempt,
        this.#attemptRunRows(attempt.id).map(attemptRunSnapshot),
      ),
    );
    const evidence = this.db
      .prepare(`${EVIDENCE_SELECT} WHERE task_id = ? ORDER BY observed_at, id`)
      .all(id)
      .map(evidenceSnapshot);
    const remoteEffects = this.db
      .prepare(`${REMOTE_EFFECT_SELECT} WHERE task_id = ? ORDER BY created_at, id`)
      .all(id)
      .map(remoteEffectSnapshot);
    const waitSubscriptions = this.db
      .prepare(`${WAIT_SUBSCRIPTION_SELECT} WHERE task_id = ? ORDER BY generation, created_at, id`)
      .all(id)
      .map(waitSubscriptionSnapshot);
    return taskSnapshot(row, attempts, evidence, remoteEffects, waitSubscriptions);
  }

  #remoteEffectRow(id) {
    return this.db.prepare(`${REMOTE_EFFECT_SELECT} WHERE id = ?`).get(id);
  }

  #remoteEffectResult(taskId, id) {
    const effect = this.#remoteEffectRow(id);
    return {
      task: this.getTask(taskId),
      remoteEffect: effect ? remoteEffectSnapshot(effect) : null,
    };
  }

  #updateRemoteEffect(
    id,
    state,
    { detail = null, readback = undefined, transmitted = true } = {},
  ) {
    const timestamp = now();
    const confirmedAt = state === "confirmed" ? timestamp : null;
    const transmittedAt =
      transmitted &&
      ["transmitted_unknown", "confirmed", "conflict", "failed"].includes(state)
        ? timestamp
        : null;
    const result = this.db
      .prepare(`UPDATE remote_effects SET state = ?, detail = ?,
        last_readback_oid = COALESCE(?, last_readback_oid),
        transmitted_at = COALESCE(transmitted_at, ?),
        confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?`)
      .run(
        state,
        detail == null ? null : bounded(detail, MAX_REMOTE_EFFECT_DETAIL_LENGTH),
        readback === undefined ? null : readback,
        transmittedAt,
        confirmedAt,
        timestamp,
        id,
      );
    if (result.changes !== 1) throw new Error("Remote publication effect transition was not recorded.");
    return this.#remoteEffectRow(id);
  }

  #remotePublicationFailure(effectId, code, message) {
    const error = Object.assign(new Error(message), {
      code,
      remoteEffect: effectId ? remoteEffectSnapshot(this.#remoteEffectRow(effectId)) : null,
    });
    return error;
  }

  #assertRemoteCandidate(task, candidateSha) {
    const candidate = exactOid(candidateSha);
    if (!candidate) throw new Error("Remote publication requires an exact 40-character candidate SHA.");
    assertTaskWorktreeIdentity(task);
    const observed = this.currentBranchHead(task.taskWorktree);
    if (observed !== candidate.toLowerCase())
      throw new Error("Remote publication candidate SHA is not the exact Task worktree HEAD.");
    if (
      git(task.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    )
      throw new Error("Remote publication requires a clean Task worktree.");
    try {
      git(task.taskWorktree, ["cat-file", "-e", `${candidate}^{commit}`]);
    } catch (error) {
      throw new Error("Remote publication candidate is not a local commit.", { cause: error });
    }
    return candidate.toLowerCase();
  }

  async publishTask({ id, candidateSha }) {
    this.ensureSupported();
    if (typeof id !== "string" || !id.trim())
      throw new Error("Remote publication requires a Task id.");
    this.open();
    const taskId = id.trim();
    let taskRow = this.#taskRow(taskId);
    if (!taskRow) throw new Error(`Task ${taskId} was not found.`);
    const authority = remotePublicationAuthority(taskRow.authority);
    if (!authority)
      throw new Error("Task has no explicit remote publication authority.");
    const capturedControlVersion = Number(taskRow.controlVersion);
    const capturedContractVersion = Number(taskRow.contractVersion);
    if (!REMOTE_PUBLICATION_TASK_STATES.has(taskRow.state)) {
      throw Object.assign(
        new Error("Remote publication requires an accepted or running Task."),
        { code: "remote_task_ineligible" },
      );
    }
    const task = taskSnapshot(taskRow);
    if (!authority.remoteUrlDigest)
      throw new Error("Remote publication authority has no bound remote identity.");
    const authorizedRemote = resolveRemotePublicationEndpoint(
      task.sourceRepoRoot,
      authority,
    );
    const newOid = this.#assertRemoteCandidate(task, candidateSha);
    const ref = `${REMOTE_REF_PREFIX}${taskId}`;
    const transport = this.remoteTransport;
    const readRemote = async () =>
      normalizedRemoteOid(
        await transport.readRef({
          cwd: task.taskWorktree,
          endpoint: authorizedRemote.endpoint,
          repository: authority.repositoryId,
          ref,
        }),
      );
    let remoteOid;
    try {
      remoteOid = await readRemote();
    } catch (error) {
      throw new Error("Remote publication ref could not be read.", { cause: error });
    }

    const latestConfirmed = this.db
      .prepare(`${REMOTE_EFFECT_SELECT}
        WHERE task_id = ? AND ref = ? AND state = 'confirmed'
        ORDER BY confirmed_at DESC, created_at DESC, id DESC LIMIT 1`)
      .get(taskId, ref);
    const priorEffect = this.db
      .prepare(`${REMOTE_EFFECT_SELECT}
        WHERE task_id = ? AND ref = ? AND new_oid = ?
          AND state IN ('prepared', 'transmitted_unknown')
        ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(taskId, ref, newOid);

    if (latestConfirmed?.newOid?.toLowerCase() === newOid) {
      if (remoteOid !== newOid) {
        const error = this.#remotePublicationFailure(
          latestConfirmed.id,
          "remote_conflict",
          "Remote publication no longer matches the last confirmed candidate.",
        );
        this.#updateRemoteEffect(latestConfirmed.id, "conflict", {
          detail: "Remote ref drifted after confirmation.",
          readback: remoteOid,
        });
        error.remoteEffect = remoteEffectSnapshot(this.#remoteEffectRow(latestConfirmed.id));
        throw error;
      }
      return this.#remoteEffectResult(taskId, latestConfirmed.id);
    }

    let effect = priorEffect;
    let expectedOldOid = effect?.expectedOldOid
      ? effect.expectedOldOid.toLowerCase()
      : null;
    if (!effect) {
      if (latestConfirmed) {
        expectedOldOid = latestConfirmed.newOid.toLowerCase();
        if (remoteOid !== expectedOldOid) {
          throw this.#remotePublicationFailure(
            latestConfirmed.id,
            "remote_conflict",
            "Remote ref drifted from the last confirmed candidate.",
          );
        }
        let isAncestor = false;
        try {
          execFileSync(
            "git",
            ["merge-base", "--is-ancestor", expectedOldOid, newOid],
            { cwd: task.taskWorktree, stdio: "ignore" },
          );
          isAncestor = true;
        } catch {}
        if (!isAncestor)
          throw this.#remotePublicationFailure(
            latestConfirmed.id,
            "remote_non_fast_forward",
            "Remote publication candidate is not a fast-forward from the confirmed candidate.",
          );
      } else if (remoteOid !== null) {
        throw this.#remotePublicationFailure(
          null,
          "remote_conflict",
          "The first remote publication cannot overwrite an existing ref.",
        );
      }
      const actionDigest = remoteActionDigest({
        taskId,
        controlVersion: capturedControlVersion,
        contractVersion: capturedContractVersion,
        remote: authority.remote,
        repository: authority.repositoryId,
        remoteUrlDigest: authority.remoteUrlDigest,
        ref,
        expectedOldOid,
        newOid,
      });
      const effectCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM remote_effects WHERE task_id = ?")
        .get(taskId).count;
      if (Number(effectCount) >= MAX_REMOTE_EFFECTS_PER_TASK)
        throw new Error("Task remote publication effect history is bounded.");
      const effectId = randomUUID();
      const timestamp = now();
      this.db
        .prepare(`INSERT INTO remote_effects (
          id, task_id, control_version, contract_version, remote, repository,
          remote_url_digest, ref, expected_old_oid, new_oid, action_digest,
          state, attempt_count, detail, created_at, prepared_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?, ?)`)
        .run(
          effectId,
          taskId,
          capturedControlVersion,
          capturedContractVersion,
          authority.remote,
          authority.repositoryId,
          authority.remoteUrlDigest,
          ref,
          expectedOldOid,
          newOid,
          actionDigest,
          timestamp,
          timestamp,
          timestamp,
        );
      effect = this.#remoteEffectRow(effectId);
    }

    const expectedActionDigest = remoteActionDigest({
      taskId,
      controlVersion: capturedControlVersion,
      contractVersion: capturedContractVersion,
      remote: authority.remote,
      repository: authority.repositoryId,
      remoteUrlDigest: authority.remoteUrlDigest,
      ref,
      expectedOldOid,
      newOid,
    });
    if (
      Number(effect.controlVersion) !== capturedControlVersion ||
      Number(effect.contractVersion) !== capturedContractVersion ||
      effect.remote !== authority.remote ||
      effect.repository !== authority.repositoryId ||
      (effect.remoteUrlDigest ?? null) !== authority.remoteUrlDigest ||
      effect.ref !== ref ||
      effect.newOid.toLowerCase() !== newOid ||
      (effect.expectedOldOid?.toLowerCase() ?? null) !== expectedOldOid ||
      effect.actionDigest !== expectedActionDigest
    ) {
      throw this.#remotePublicationFailure(
        effect.id,
        "remote_conflict",
        "Remote publication effect identity does not match the current Task authority.",
      );
    }
    if (remoteOid === newOid) {
      this.#updateRemoteEffect(effect.id, "confirmed", {
        detail: "Exact remote readback confirmed the prepared candidate.",
        readback: remoteOid,
      });
      return this.#remoteEffectResult(taskId, effect.id);
    }
    if (remoteOid !== expectedOldOid) {
      this.#updateRemoteEffect(effect.id, "conflict", {
        detail: "Remote ref drifted before the prepared effect could be transmitted.",
        readback: remoteOid,
        transmitted: false,
      });
      throw this.#remotePublicationFailure(
        effect.id,
        "remote_conflict",
        "Remote ref drifted before remote publication.",
      );
    }
    if (typeof this.beforeRemotePush === "function")
      await this.beforeRemotePush({
        task: this.getTask(taskId),
        effect: remoteEffectSnapshot(effect),
      });

    let currentRemote = null;
    try {
      currentRemote = resolveRemotePublicationEndpoint(
        task.sourceRepoRoot,
        authority,
      );
    } catch {}
    const remoteStillAuthorized =
      currentRemote?.endpoint === authorizedRemote.endpoint &&
      currentRemote?.remoteUrlDigest === authorizedRemote.remoteUrlDigest &&
      currentRemote?.repositoryId === authorizedRemote.repositoryId;

    let reservationFailure = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      taskRow = this.#taskRow(taskId);
      effect = this.#remoteEffectRow(effect.id);
      let currentAuthority = null;
      try {
        currentAuthority = remotePublicationAuthority(taskRow?.authority);
      } catch {}
      const staleReservation =
        !remoteStillAuthorized ||
        !taskRow ||
        !REMOTE_PUBLICATION_TASK_STATES.has(taskRow.state) ||
        !currentAuthority ||
        !snapshotsEqual(currentAuthority, authority) ||
        Number(taskRow.controlVersion) !== capturedControlVersion ||
        Number(taskRow.contractVersion) !== capturedContractVersion ||
        !effect ||
        !["prepared", "transmitted_unknown"].includes(effect.state) ||
        Number(effect.controlVersion) !== capturedControlVersion ||
        Number(effect.contractVersion) !== capturedContractVersion ||
        effect.remote !== authority.remote ||
        effect.repository !== authority.repositoryId ||
        (effect.remoteUrlDigest ?? null) !== authority.remoteUrlDigest ||
        effect.ref !== ref ||
        effect.newOid.toLowerCase() !== newOid ||
        (effect.expectedOldOid?.toLowerCase() ?? null) !== expectedOldOid ||
        effect.actionDigest !== expectedActionDigest;
      if (staleReservation) {
        reservationFailure = {
          code: "stale_remote_publication",
          detail: "Task, authority, or prepared effect changed before remote transmission.",
          message: "Task control, contract, authority, or effect changed before remote publication.",
        };
        throw new Error(reservationFailure.message);
      }
      const taskBudget = normalizeBudget(taskRow.budget);
      const effectiveMaxPubs = effectiveMaxPublications(
        { remotePublication: authority },
        taskBudget,
      );
      if (Number(taskRow.publicationCount) >= effectiveMaxPubs) {
        reservationFailure = {
          code: "remote_budget_exhausted",
          detail: "Task-wide remote publication budget exhausted.",
          message: "Remote publication budget exhausted.",
        };
        throw new Error(reservationFailure.message);
      }

      const reservedAt = now();
      const taskReservation = this.db
        .prepare(`UPDATE tasks SET publication_count = publication_count + 1,
          updated_at = ? WHERE id = ? AND state IN ('accepted', 'running', 'waiting')
          AND control_version = ? AND contract_version = ?
          AND publication_count < ?`)
        .run(
          reservedAt,
          taskId,
          capturedControlVersion,
          capturedContractVersion,
          effectiveMaxPubs,
        );
      if (taskReservation.changes !== 1)
        throw new Error("Remote publication Task budget reservation was not recorded.");
      const effectReservation = this.db
        .prepare(`UPDATE remote_effects SET attempt_count = attempt_count + 1,
          updated_at = ? WHERE id = ? AND state IN ('prepared', 'transmitted_unknown')
          AND control_version = ? AND contract_version = ?`)
        .run(
          reservedAt,
          effect.id,
          capturedControlVersion,
          capturedContractVersion,
        );
      if (effectReservation.changes !== 1)
        throw new Error("Remote publication effect attempt reservation was not recorded.");
      this.db.exec("COMMIT");
      effect = this.#remoteEffectRow(effect.id);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      if (!reservationFailure) throw error;
      const currentEffect = this.#remoteEffectRow(effect?.id);
      if (["prepared", "transmitted_unknown"].includes(currentEffect?.state)) {
        this.#updateRemoteEffect(currentEffect.id, "failed", {
          detail: reservationFailure.detail,
          readback: remoteOid,
          transmitted: false,
        });
      }
      throw this.#remotePublicationFailure(
        effect?.id,
        reservationFailure.code,
        reservationFailure.message,
      );
    }
    try {
      await transport.push({
        cwd: task.taskWorktree,
        endpoint: authorizedRemote.endpoint,
        repository: authority.repositoryId,
        ref,
        expectedOldOid,
        newOid,
      });
    } catch (error) {
      this.#updateRemoteEffect(effect.id, "transmitted_unknown", {
        detail: remoteDetail(error),
      });
    }

    let readback;
    try {
      readback = await readRemote();
    } catch (error) {
      this.#updateRemoteEffect(effect.id, "transmitted_unknown", {
        detail: "Remote Git readback failure.",
      });
      throw new Error("Remote publication outcome is unknown; exact readback failed.", {
        cause: error,
      });
    }
    if (readback === newOid) {
      this.#updateRemoteEffect(effect.id, "confirmed", {
        detail: "Exact remote readback confirmed the published candidate.",
        readback,
      });
      return this.#remoteEffectResult(taskId, effect.id);
    }
    if (readback === expectedOldOid) {
      this.#updateRemoteEffect(effect.id, "transmitted_unknown", {
        detail: "Remote readback still shows the expected old ref; the exact effect may be retried within budget.",
        readback,
      });
      return this.#remoteEffectResult(taskId, effect.id);
    }
    this.#updateRemoteEffect(effect.id, "conflict", {
      detail: "Remote readback found an unexpected ref value.",
      readback,
    });
    throw this.#remotePublicationFailure(
      effect.id,
      "remote_conflict",
      "Remote publication readback found an unexpected ref value.",
    );
  }

  #reconcileRetiredWaitRegistrationFailure(fence, error) {
    const detail = boundedDetail(
      `Wait registration failed after the Fresh Executor was retired: ${commandError(error)} The Attempt was safely interrupted.`,
    );
    const timestamp = now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#taskRow(fence.taskId);
      const attempt = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
        .get(fence.attemptId, fence.taskId);
      const activeWait = this.db
        .prepare(`SELECT id, generation FROM wait_subscriptions
          WHERE task_id = ? AND status = 'active'
          ORDER BY generation DESC, created_at DESC, id DESC LIMIT 1`)
        .get(fence.taskId);
      const maxGeneration = Number(
        this.db
          .prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM wait_subscriptions WHERE task_id = ?")
          .get(fence.taskId).generation,
      );
      const registrationWait = this.db
        .prepare("SELECT id FROM wait_subscriptions WHERE id = ? AND task_id = ?")
        .get(fence.operationId, fence.taskId);
      const priorWaitStillCurrent = fence.preExistingActiveWaitId
        ? activeWait?.id === fence.preExistingActiveWaitId &&
          Number(activeWait.generation) === fence.preExistingActiveWaitGeneration
        : !activeWait;
      const noNewerWait =
        maxGeneration <= fence.preExistingMaxWaitGeneration && !registrationWait;
      const fenceMatches =
        task &&
        task.latestAttemptId === fence.attemptId &&
        Number(task.controlVersion) === fence.controlVersion &&
        Number(task.contractVersion) === fence.contractVersion &&
        ["accepted", "running", "waiting"].includes(task.state) &&
        attempt &&
        ["starting", "running", "parked_wait"].includes(attempt.state);

      // A failed registration may only repair the state it fenced before
      // retiring the worker. In particular, an active wait with a newer
      // generation belongs to another registration and must be left alone.
      if (!fenceMatches || !priorWaitStillCurrent || !noNewerWait) {
        this.db.exec("ROLLBACK");
        return false;
      }

      // Retirement already proved this exact worker gone. Only fence the
      // durable bit; retain PID/PGID/start/boot identity for the audit trail.
      this.db
        .prepare("UPDATE attempts SET worker_terminated = 1 WHERE id = ? AND task_id = ?")
        .run(fence.attemptId, fence.taskId);

      // A pre-existing wait belongs to this failed registration's fenced
      // state. Cancel only that exact identity; a newer registration is
      // rejected above and is never touched by compensation.
      if (fence.preExistingActiveWaitId) {
        const cancelledWait = this.db
          .prepare(`UPDATE wait_subscriptions SET status = 'cancelled'
            WHERE id = ? AND task_id = ? AND generation = ? AND status = 'active'`)
          .run(
            fence.preExistingActiveWaitId,
            fence.taskId,
            fence.preExistingActiveWaitGeneration,
          );
        if (cancelledWait.changes !== 1) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }

      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = 'interrupted', updated_at = ?,
          final_result = NULL, final_branch_head = COALESCE(final_branch_head, ?),
          final_revision = COALESCE(final_revision, ?), terminal_detail = ?,
          terminal_reason = ? WHERE id = ? AND latest_attempt_id = ?
          AND state IN ('accepted', 'running', 'waiting')
          AND control_version = ? AND contract_version = ?`)
        .run(
          timestamp,
          attempt.finalBranchHead ?? task.finalBranchHead ?? null,
          task.finalRevision ?? attempt.finalBranchHead ?? null,
          detail,
          "wait_registration_interrupted",
          fence.taskId,
          fence.attemptId,
          fence.controlVersion,
          fence.contractVersion,
        );
      if (taskUpdate.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }

      this.db
        .prepare(`UPDATE attempts SET state = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN 'interrupted'
            ELSE state END,
          finished_at = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN COALESCE(finished_at, ?)
            ELSE finished_at END,
          terminal_detail = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN ?
            ELSE terminal_detail END,
          worker_terminated = 1 WHERE id = ? AND task_id = ?
          AND state IN ('starting', 'running', 'parked_wait')`)
        .run(timestamp, detail, fence.attemptId, fence.taskId);
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'aborted',
          settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ?
          AND state IN ('pending', 'accepted')`)
        .run(detail, timestamp, fence.attemptId);
      const currentTask = this.#taskRow(fence.taskId);
      const resultId = this.#insertResultDelivery({
        task: currentTask,
        outcome: "failed",
        finalResult: null,
        terminalDetail: detail,
        terminalReason: "wait_registration_interrupted",
        finalRevision: currentTask?.finalRevision ?? null,
        finalBranchHead: currentTask?.finalBranchHead ?? null,
      });
      if (!resultId)
        throw new Error("Interrupted Task did not produce a Result delivery.");

      this.db.exec("COMMIT");
      return true;
    } catch (reconciliationError) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw reconciliationError;
    }
  }

  #reconcileRetiredWaitRegistrationFailureClosed(fence, error) {
    const detail = boundedDetail(
      `Wait registration failed after the Fresh Executor was retired: ${commandError(error)} The retired Attempt was reconciled fail-closed.`,
    );
    const timestamp = now();
    const workerMatches = (attempt) => {
      if (!attempt) return false;
      const retired = fence.retiredWorker;
      if (!retired) {
        return (
          attempt.workerPid == null &&
          attempt.workerPgid == null &&
          (attempt.workerStartIdentity ?? null) === null &&
          (attempt.workerBootId ?? null) === (fence.workerBootId ?? null)
        );
      }
      return (
        Number(attempt.workerPid ?? 0) === Number(retired.workerPid ?? 0) &&
        Number(attempt.workerPgid ?? 0) === Number(retired.workerPgid ?? 0) &&
        (attempt.workerStartIdentity ?? null) ===
          (retired.workerStartIdentity ?? null) &&
        (attempt.workerBootId ?? null) === (retired.workerBootId ?? null)
      );
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#taskRow(fence.taskId);
      const attempt = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
        .get(fence.attemptId, fence.taskId);
      if (!task || !attempt || !workerMatches(attempt)) {
        this.db.exec("ROLLBACK");
        return false;
      }

      const registrationWait = this.db
        .prepare("SELECT id FROM wait_subscriptions WHERE id = ? AND task_id = ?")
        .get(fence.operationId, fence.taskId);
      if (registrationWait) {
        // The registration operation itself committed; its post-commit path
        // must own its outcome and this compensation must not rewrite it.
        this.db.exec("ROLLBACK");
        return false;
      }
      const activeWait = this.db
        .prepare(`SELECT id, generation, control_version AS controlVersion,
            contract_version AS contractVersion, created_by_attempt_id AS createdByAttemptId
          FROM wait_subscriptions WHERE task_id = ? AND status = 'active'
          ORDER BY generation DESC, created_at DESC, id DESC LIMIT 1`)
        .get(fence.taskId);
      const waitIsNewer =
        activeWait && Number(activeWait.generation) > fence.preExistingMaxWaitGeneration;

      // A newer (or already-winning) wait owns the Task state. Retain it and
      // only publish the exact retired worker fence; never cancel a wait from
      // another operation. If the wait is current, repair the only impossible
      // pairing left by the race: running Task + retired worker.
      if (activeWait) {
        const waitIdentityMatches = waitIsNewer
          ? true
          : activeWait.id === fence.preExistingActiveWaitId &&
            Number(activeWait.generation) === fence.preExistingActiveWaitGeneration;
        const waitIsCurrent =
          waitIdentityMatches &&
          Number(activeWait.controlVersion) === Number(task.controlVersion) &&
          Number(activeWait.contractVersion) === Number(task.contractVersion) &&
          activeWait.createdByAttemptId === fence.attemptId;
        const ownsRetiredAttempt =
          task.latestAttemptId === fence.attemptId &&
          ['starting', 'running', 'parked_wait'].includes(attempt.state);
        const runningPair =
          task.latestAttemptId === fence.attemptId &&
          ['accepted', 'running', 'waiting'].includes(task.state) &&
          ['starting', 'running'].includes(attempt.state);
        if (waitIsCurrent && ownsRetiredAttempt) {
          if (task.state !== 'waiting') {
            const taskUpdate = this.db
              .prepare(`UPDATE tasks SET state = 'waiting', updated_at = ?
                WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
                  AND control_version = ? AND contract_version = ?`)
              .run(
                timestamp,
                fence.taskId,
                fence.attemptId,
                task.controlVersion,
                task.contractVersion,
              );
            if (taskUpdate.changes !== 1) {
              this.db.exec("ROLLBACK");
              return false;
            }
          }
          const attemptUpdate = this.db
            .prepare(`UPDATE attempts SET state = 'parked_wait', worker_terminated = 1,
                gate_state = 'terminated', gate_terminated = 1
              WHERE id = ? AND task_id = ? AND state IN ('starting', 'running', 'parked_wait')`)
            .run(fence.attemptId, fence.taskId);
          if (attemptUpdate.changes !== 1) {
            this.db.exec("ROLLBACK");
            return false;
          }
          this.db.exec("COMMIT");
          return true;
        }
        if (runningPair && !waitIsCurrent) {
          // An active wait that does not match the current Task versions is
          // stale, not a winner. It may be cancelled only by this exact
          // reconciliation; a newer valid wait takes the branch above.
          const cancelledWait = this.db
            .prepare(`UPDATE wait_subscriptions SET status = 'cancelled'
              WHERE id = ? AND task_id = ? AND generation = ? AND status = 'active'`)
            .run(activeWait.id, fence.taskId, activeWait.generation);
          if (cancelledWait.changes !== 1) {
            this.db.exec("ROLLBACK");
            return false;
          }
          // Continue to the terminal fail-closed transition below.
        } else {
          const attemptUpdate = this.db
            .prepare(`UPDATE attempts SET worker_terminated = 1
              WHERE id = ? AND task_id = ? AND worker_terminated = 0`)
            .run(fence.attemptId, fence.taskId);
          if (attemptUpdate.changes !== 1 && attempt.workerTerminated !== 1) {
            this.db.exec("ROLLBACK");
            return false;
          }
          this.db.exec("COMMIT");
          return true;
        }
      }

      // No wait won this operation. A still-running Task must not survive the
      // retirement of its exact worker. Use the versions that currently own
      // the Task (not the failed registration's stale versions), and let a
      // prior cancellation/terminal transition win by leaving it untouched.
      if (
        task.latestAttemptId !== fence.attemptId ||
        !['accepted', 'running', 'waiting'].includes(task.state)
      ) {
        const attemptUpdate = this.db
          .prepare(`UPDATE attempts SET state = CASE
              WHEN state IN ('starting', 'running', 'parked_wait') THEN 'failed'
              ELSE state END,
            finished_at = CASE
              WHEN state IN ('starting', 'running', 'parked_wait') THEN COALESCE(finished_at, ?)
              ELSE finished_at END,
            terminal_detail = CASE
              WHEN state IN ('starting', 'running', 'parked_wait') THEN ?
              ELSE terminal_detail END,
            worker_terminated = 1 WHERE id = ? AND task_id = ?`)
          .run(timestamp, detail, fence.attemptId, fence.taskId);
        if (attemptUpdate.changes !== 1) {
          this.db.exec("ROLLBACK");
          return false;
        }
        this.db.exec("COMMIT");
        return true;
      }

      const terminalDetail = `${detail} No valid WaitSubscription was committed; the Task is blocked.`;
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = 'blocked', updated_at = ?, final_result = NULL,
          final_branch_head = COALESCE(final_branch_head, ?),
          final_revision = COALESCE(final_revision, ?), terminal_detail = ?,
          terminal_reason = ? WHERE id = ? AND latest_attempt_id = ?
          AND state IN ('accepted', 'running', 'waiting')
          AND control_version = ? AND contract_version = ?`)
        .run(
          timestamp,
          attempt.finalBranchHead ?? task.finalBranchHead ?? null,
          task.finalRevision ?? attempt.finalBranchHead ?? null,
          terminalDetail,
          'wait_registration_worker_retired',
          fence.taskId,
          fence.attemptId,
          task.controlVersion,
          task.contractVersion,
        );
      if (taskUpdate.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }

      const attemptUpdate = this.db
        .prepare(`UPDATE attempts SET state = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN 'failed'
            ELSE state END,
          finished_at = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN COALESCE(finished_at, ?)
            ELSE finished_at END,
          terminal_detail = CASE
            WHEN state IN ('starting', 'running', 'parked_wait') THEN ?
            ELSE terminal_detail END,
          worker_terminated = 1 WHERE id = ? AND task_id = ?
          AND state IN ('starting', 'running', 'parked_wait')`)
        .run(timestamp, terminalDetail, fence.attemptId, fence.taskId);
      if (attemptUpdate.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'aborted',
          settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ?
          AND state IN ('pending', 'accepted')`)
        .run(terminalDetail, timestamp, fence.attemptId);
      const resultId = this.#insertResultDelivery({
        task: this.#taskRow(fence.taskId),
        outcome: 'failed',
        finalResult: null,
        terminalDetail,
        terminalReason: 'wait_registration_worker_retired',
        finalRevision: task.finalRevision ?? null,
        finalBranchHead: task.finalBranchHead ?? null,
      });
      if (!resultId)
        throw new Error('Blocked Task did not produce a Result delivery.');

      this.db.exec("COMMIT");
      return true;
    } catch (reconciliationError) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw reconciliationError;
    }
  }

  async registerWaitSubscription({
    id,
    taskId,
    task_id,
    revisionSha,
    candidateSha,
    revision_sha,
    candidate_sha,
    requiredChecks,
    required_checks,
    checks,
    acceptedConclusions,
    accepted_conclusions,
    conclusions,
    githubHost,
    github_host,
    repositoryId,
    repository_id,
    repositoryNameSnapshot,
    repository_name_snapshot,
    deadlineAt,
    deadline_at,
    timeoutMs,
    timeout_ms,
    kind = "github_ci",
  } = {}) {
    this.ensureSupported();
    const targetTaskId = String(taskId ?? id ?? task_id ?? "").trim();
    if (!targetTaskId)
      throw new Error("Wait registration requires a Task id.");
    this.open();

    const taskRow = this.#taskRow(targetTaskId);
    if (!taskRow)
      throw new Error(`Task ${targetTaskId} was not found.`);

    const validTaskStates = new Set(["accepted", "running", "waiting"]);
    if (!validTaskStates.has(taskRow.state)) {
      throw Object.assign(
        new Error(`Task ${targetTaskId} is in state "${taskRow.state}" and cannot be parked on wait.`),
        { code: "task_ineligible_for_wait" },
      );
    }

    const latestAttemptId = taskRow.latestAttemptId;
    if (!latestAttemptId)
      throw new Error(`Task ${targetTaskId} has no attempt.`);

    const attemptRow = this.db
      .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
      .get(latestAttemptId, targetTaskId);
    if (!attemptRow)
      throw new Error(`Task ${targetTaskId} attempt ${latestAttemptId} was not found.`);

    const validAttemptStates = new Set(["starting", "running", "parked_wait"]);
    if (!validAttemptStates.has(attemptRow.state)) {
      throw Object.assign(
        new Error(`Attempt ${latestAttemptId} is in state "${attemptRow.state}" and cannot be parked on wait.`),
        { code: "attempt_ineligible_for_wait" },
      );
    }

    if (kind !== "github_ci") {
      throw Object.assign(
        new Error(`v0.4 supports only github_ci wait subscriptions, got: "${kind}".`),
        { code: "unsupported_wait_kind" },
      );
    }

    const targetSha = String(
      revisionSha ?? candidateSha ?? revision_sha ?? candidate_sha ?? "",
    ).trim();
    const normalizedSha = exactOid(targetSha)?.toLowerCase();
    if (!normalizedSha) {
      throw Object.assign(
        new Error("Wait registration requires an exact 40-character revision SHA."),
        { code: "invalid_revision_sha" },
      );
    }

    const expectedRef = `${REMOTE_REF_PREFIX}${targetTaskId}`;
    const confirmedEffect = this.db
      .prepare(`${REMOTE_EFFECT_SELECT}
        WHERE task_id = ? AND ref = ? AND new_oid = ? AND state = 'confirmed'
        ORDER BY confirmed_at DESC, created_at DESC, id DESC LIMIT 1`)
      .get(targetTaskId, expectedRef, normalizedSha);

    if (!confirmedEffect) {
      throw Object.assign(
        new Error(
          `Wait registration requires a confirmed remote publication on ${expectedRef} for candidate SHA ${normalizedSha}.`,
        ),
        { code: "unconfirmed_remote_publication" },
      );
    }
    if (
      Number(confirmedEffect.controlVersion) !== Number(taskRow.controlVersion) ||
      Number(confirmedEffect.contractVersion) !== Number(taskRow.contractVersion)
    ) {
      throw Object.assign(
        new Error("Wait registration requires a publication accepted under the current Task contract."),
        { code: "stale_remote_publication" },
      );
    }

    const taskAuthority = parsed(taskRow.authority, {});
    const remoteAuth = taskAuthority?.remotePublication ?? taskAuthority?.remote_publication;

    const trustedRepoId = boundedRemoteRepositoryId(
      confirmedEffect.repository ??
        remoteAuth?.repositoryId ??
        remoteAuth?.repository_id,
    );
    if (!trustedRepoId) {
      throw Object.assign(
        new Error("Wait registration requires a canonical repository identity."),
        { code: "invalid_repository_id" },
      );
    }
    const requestedRepoId = repositoryId ?? repository_id;
    if (
      requestedRepoId != null &&
      boundedRemoteRepositoryId(requestedRepoId) !== trustedRepoId
    ) {
      throw Object.assign(
        new Error("Wait registration repository does not match accepted remote authority."),
        { code: "wait_authority_mismatch" },
      );
    }
    const normalizedRepoId = trustedRepoId;
    const repoNameSnapshot = normalizedRepoId;

    const trustedHost = normalizeGithubHost(
      remoteAuth?.githubHost ?? remoteAuth?.github_host,
    );
    const requestedHost = githubHost ?? github_host;
    const normalizedHost = normalizeGithubHost(requestedHost ?? trustedHost);
    if (normalizedHost !== trustedHost) {
      throw Object.assign(
        new Error("Wait registration GitHub host does not match accepted remote authority."),
        { code: "wait_authority_mismatch" },
      );
    }

    const completionContract = parsed(taskRow.completionContract, {});
    const trustedChecks = requiredChecksFromContract(completionContract);
    const requestedChecks = requiredChecks ?? required_checks ?? checks;
    const rawChecks = requestedChecks ?? trustedChecks;
    const checkSelectorsMatch =
      requestedChecks == null ||
      (Array.isArray(requestedChecks) && sameStringSet(requestedChecks, trustedChecks));

    if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
      throw Object.assign(
        new Error("Wait registration requires at least one typed CI check selector."),
        { code: "invalid_required_checks" },
      );
    }
    if (rawChecks.length > MAX_REQUIRED_CHECKS) {
      throw Object.assign(
        new Error(`Wait registration required checks exceed limit of ${MAX_REQUIRED_CHECKS}.`),
        { code: "too_many_required_checks" },
      );
    }

    const validatedRequiredChecks = rawChecks.map((selector) => {
      if (
        typeof selector !== "string" ||
        !selector.trim() ||
        selector.includes("\0") ||
        Buffer.byteLength(selector.trim(), "utf8") > MAX_CHECK_SELECTOR_LENGTH ||
        !CHECK_SELECTOR_REGEX.test(selector.trim())
      ) {
        throw Object.assign(
          new Error(
            `Invalid CI check selector: "${selector}". Check selectors must match ^(check_run:<app-id-or-slug>/<check-name>|commit_status:<context>).`,
          ),
          { code: "invalid_check_selector" },
        );
      }
      return selector.trim();
    });
    if (!checkSelectorsMatch) {
      throw Object.assign(
        new Error("Wait registration check selectors do not match the accepted Completion Contract."),
        { code: "wait_authority_mismatch" },
      );
    }

    const trustedConclusions = acceptedConclusionsFromContract(completionContract);
    const requestedConclusions =
      acceptedConclusions ?? accepted_conclusions ?? conclusions;
    const rawConclusions = requestedConclusions ?? trustedConclusions;
    const conclusionsMatch =
      requestedConclusions == null ||
      (Array.isArray(requestedConclusions) &&
        sameStringSet(
          requestedConclusions.map((value) => String(value).trim().toLowerCase()),
          trustedConclusions.map((value) => String(value).trim().toLowerCase()),
        ));
    if (!Array.isArray(rawConclusions) || rawConclusions.length === 0) {
      throw Object.assign(
        new Error("Wait registration requires at least one accepted conclusion."),
        { code: "invalid_accepted_conclusions" },
      );
    }

    const validatedAcceptedConclusions = rawConclusions.map((conclusion) => {
      if (
        typeof conclusion !== "string" ||
        !conclusion.trim() ||
        conclusion.includes("\0")
      ) {
        throw Object.assign(
          new Error(`Invalid accepted conclusion: "${conclusion}".`),
          { code: "invalid_accepted_conclusion" },
        );
      }
      return conclusion.trim().toLowerCase();
    });
    if (!conclusionsMatch) {
      throw Object.assign(
        new Error("Wait registration conclusions do not match the accepted Completion Contract."),
        { code: "wait_authority_mismatch" },
      );
    }

    const taskBudget = normalizeBudget(taskRow.budget);
    const waitClockTime = new Date(this.waitClock()).getTime();
    if (!Number.isFinite(waitClockTime)) {
      throw Object.assign(
        new Error("Wait reactor clock returned an invalid time."),
        { code: "invalid_wait_clock" },
      );
    }
    const maximumCiDeadline = waitClockTime + taskBudget.ciWaitDeadlineMs;
    const acceptedAt = new Date(taskRow.acceptedAt || taskRow.createdAt).getTime();
    const maximumCommitmentDeadline = Number.isFinite(acceptedAt)
      ? acceptedAt + taskBudget.totalCommitmentWallClockDeadlineMs
      : Number.POSITIVE_INFINITY;
    const maximumDeadline = Math.min(
      maximumCiDeadline,
      maximumCommitmentDeadline,
    );
    const requestedDeadline = deadlineAt ?? deadline_at;
    let normalizedDeadlineAt;
    if (requestedDeadline) {
      const parsedDate = new Date(requestedDeadline);
      if (Number.isNaN(parsedDate.getTime())) {
        throw Object.assign(
          new Error("Wait registration deadline is invalid."),
          { code: "invalid_deadline" },
        );
      }
      normalizedDeadlineAt = new Date(
        Math.min(parsedDate.getTime(), maximumDeadline),
      ).toISOString();
    } else {
      const requestedTimeout = Number(timeoutMs ?? timeout_ms ?? taskBudget.ciWaitDeadlineMs);
      if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
        throw Object.assign(
          new Error("Wait registration timeout must be a positive number."),
          { code: "invalid_timeout" },
        );
      }
      normalizedDeadlineAt = new Date(
        Math.min(
          waitClockTime + Math.min(requestedTimeout, taskBudget.ciWaitDeadlineMs),
          maximumCommitmentDeadline,
        ),
      ).toISOString();
    }

    const subscriptionId = randomUUID();
    const timestamp = now();
    const capturedControlVersion = Number(taskRow.controlVersion);
    const capturedContractVersion = Number(taskRow.contractVersion);
    const preExistingActiveWait = this.db
      .prepare(`SELECT id, generation FROM wait_subscriptions
        WHERE task_id = ? AND status = 'active'
        ORDER BY generation DESC, created_at DESC, id DESC LIMIT 1`)
      .get(targetTaskId);
    const preExistingMaxWaitGeneration = Number(
      this.db
        .prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM wait_subscriptions WHERE task_id = ?")
        .get(targetTaskId).generation,
    );
    const registrationFence = {
      taskId: targetTaskId,
      attemptId: latestAttemptId,
      controlVersion: capturedControlVersion,
      contractVersion: capturedContractVersion,
      operationId: subscriptionId,
      preExistingActiveWaitId: preExistingActiveWait?.id ?? null,
      preExistingActiveWaitGeneration: preExistingActiveWait
        ? Number(preExistingActiveWait.generation)
        : null,
      preExistingMaxWaitGeneration,
    };

    // Do not publish a parked/waiting state until both ownership barriers have
    // been proven. In particular, a live local gate must remain unresolved in
    // durable state when cancellation is ambiguous.
    const active = this.active?.attemptId === latestAttemptId ? this.active : null;
    let gateRetired = true;
    if (active) gateRetired = this.#cancelLocalGate(active);
    if (!gateRetired) {
      const gateAttempt = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
        .get(latestAttemptId, targetTaskId);
      gateRetired = this.#reconcileGate(gateAttempt) === "terminated";
    }
    if (!gateRetired) {
      this.markBlocked(
        targetTaskId,
        latestAttemptId,
        "Local gate could not be safely retired when parking Task on wait; executor capacity remains blocked.",
      );
      throw Object.assign(
        new Error("Local gate could not be safely retired when parking Task on wait."),
        { code: "gate_retirement_unproven" },
      );
    }

    const workerToRetire = active?.worker ?? attemptRow;
    const metadataToRetire = active?.workerMetadata ?? workerMetadata(attemptRow);
    // Fence the identity actually handed to the ownership-checked retirement
    // path, not merely the earlier database snapshot.
    registrationFence.retiredWorker = metadataToRetire ?? {
      workerPid: attemptRow.workerPid ?? null,
      workerPgid: attemptRow.workerPgid ?? null,
      workerStartIdentity: attemptRow.workerStartIdentity ?? null,
      workerBootId: attemptRow.workerBootId ?? this.bootId ?? null,
    };
    registrationFence.workerBootId =
      registrationFence.retiredWorker.workerBootId ?? null;
    let workerRetired = false;
    try {
      workerRetired = await this.retireWorker(workerToRetire, metadataToRetire);
    } catch {
      workerRetired = false;
    }
    if (!workerRetired) {
      this.markBlocked(
        targetTaskId,
        latestAttemptId,
        "Fresh Executor could not be safely retired when parking Task on wait; executor capacity remains blocked.",
      );
      throw Object.assign(
        new Error("Fresh Executor could not be safely retired when parking Task on wait."),
        { code: "worker_retirement_unproven" },
      );
    }

    let generation;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const freshTask = this.#taskRow(targetTaskId);
      if (
        !freshTask ||
        !validTaskStates.has(freshTask.state) ||
        Number(freshTask.controlVersion) !== capturedControlVersion ||
        Number(freshTask.contractVersion) !== capturedContractVersion
      ) {
        throw Object.assign(
          new Error("Task state or versions changed before wait registration."),
          { code: "stale_wait_registration" },
        );
      }

      const freshAttempt = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
        .get(latestAttemptId, targetTaskId);
      if (!freshAttempt || !validAttemptStates.has(freshAttempt.state)) {
        throw Object.assign(
          new Error("Attempt state changed before wait registration."),
          { code: "stale_wait_registration" },
        );
      }

      const existingWaitCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM wait_subscriptions WHERE task_id = ?")
        .get(targetTaskId).count;
      if (Number(existingWaitCount) >= MAX_WAIT_SUBSCRIPTIONS_PER_TASK) {
        throw Object.assign(
          new Error("Task wait subscription history is bounded."),
          { code: "too_many_wait_subscriptions" },
        );
      }

      const generationRow = this.db
        .prepare("SELECT COALESCE(MAX(generation), 0) + 1 AS nextGeneration FROM wait_subscriptions WHERE task_id = ?")
        .get(targetTaskId);
      generation = Number(generationRow.nextGeneration);

      // Mark any existing active wait subscription for this task as superseded
      this.db
        .prepare("UPDATE wait_subscriptions SET status = 'superseded' WHERE task_id = ? AND status = 'active'")
        .run(targetTaskId);

      // Both barriers were proven before this transaction. Retain that proof in
      // the same transition that exposes Task waiting and parks the Attempt.
      const attemptUpdate = this.db
        .prepare("UPDATE attempts SET state = 'parked_wait', gate_state = 'terminated', gate_terminated = 1, worker_terminated = 1 WHERE id = ? AND gate_terminated = 1")
        .run(latestAttemptId);
      if (attemptUpdate.changes !== 1)
        throw new Error("Attempt gate/worker retirement fence rejected wait registration.");

      // Update Task: state = 'waiting', updated_at = timestamp
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = 'waiting', updated_at = ?
          WHERE id = ? AND state IN ('accepted', 'running', 'waiting')
          AND control_version = ? AND contract_version = ?`)
        .run(timestamp, targetTaskId, capturedControlVersion, capturedContractVersion);
      if (taskUpdate.changes !== 1)
        throw new Error("Task state fence rejected wait registration.");

      // Insert new wait_subscriptions row with status 'active'
      this.db
        .prepare(`INSERT INTO wait_subscriptions (
          id, task_id, generation, control_version, contract_version,
          created_by_attempt_id, kind, github_host, repository_id,
          repository_name_snapshot, revision_sha, published_ref,
          required_checks, accepted_conclusions, status, created_at,
          deadline_at, last_reconciled_at, next_reconcile_at,
          trigger_evidence_id, continuation_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, NULL, NULL)`)
        .run(
          subscriptionId,
          targetTaskId,
          generation,
          capturedControlVersion,
          capturedContractVersion,
          latestAttemptId,
          kind,
          normalizedHost,
          normalizedRepoId,
          repoNameSnapshot,
          normalizedSha,
          expectedRef,
          JSON.stringify(validatedRequiredChecks),
          JSON.stringify(validatedAcceptedConclusions),
          timestamp,
          normalizedDeadlineAt,
          timestamp,
        );

      this.#appendEvidence({
        taskId: targetTaskId,
        attemptId: latestAttemptId,
        attemptRunId: `${latestAttemptId}:${freshAttempt.number ?? 1}`,
        kind: "wait_subscription",
        subject: normalizedSha,
        payload: {
          waitSubscriptionId: subscriptionId,
          taskId: targetTaskId,
          generation,
          kind,
          githubHost: normalizedHost,
          repositoryId: normalizedRepoId,
          repositoryNameSnapshot: repoNameSnapshot,
          revisionSha: normalizedSha,
          publishedRef: expectedRef,
          requiredChecks: validatedRequiredChecks,
          acceptedConclusions: validatedAcceptedConclusions,
          deadlineAt: normalizedDeadlineAt,
          createdAt: timestamp,
        },
        dedupeKey: `wait_subscription:${targetTaskId}:${generation}:${subscriptionId}`,
      });

      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      if (workerRetired) {
        try {
          let reconciled = this.#reconcileRetiredWaitRegistrationFailure(
            registrationFence,
            error,
          );
          // The strict compensation intentionally yields to a concurrent
          // control/version or wait-generation winner. Retirement still
          // happened, however, so leave no live in-memory worker paired with
          // a durable running Attempt: reconcile the exact retired identity
          // fail-closed before clearing active.
          if (!reconciled) {
            reconciled = this.#reconcileRetiredWaitRegistrationFailureClosed(
              registrationFence,
              error,
            );
          }
          if (reconciled && this.active?.attemptId === latestAttemptId)
            this.active = null;
        } catch (reconciliationError) {
          throw new Error(
            `Wait registration failed after worker retirement and could not durably reconcile: ${commandError(reconciliationError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (this.active?.attemptId === latestAttemptId) {
      this.#clearAttemptWatchdog(this.active);
      this.active = null;
    }

    if (this.waitReactorEnabled) {
      await this.reconcileWaitSubscription(subscriptionId, {
        now: this.waitClock(),
        gitHubAdapter: this.waitObserver ?? this.gitHubAdapter,
        trigger: true,
      }, WAIT_RECONCILE_CAPABILITY);
      this.#scheduleWaitReactor();
    }

    const subscriptionRow = this.db
      .prepare(`${WAIT_SUBSCRIPTION_SELECT} WHERE id = ?`)
      .get(subscriptionId);

    return {
      task: this.getTask(targetTaskId),
      waitSubscription: waitSubscriptionSnapshot(subscriptionRow),
    };
  }

  async parkTaskOnWait(options) {
    return this.registerWaitSubscription(options);
  }

  async registerWait(options) {
    return this.registerWaitSubscription(options);
  }

  getWaitSubscriptions(taskId) {
    this.open();
    return this.db
      .prepare(`${WAIT_SUBSCRIPTION_SELECT} WHERE task_id = ? ORDER BY generation, created_at, id`)
      .all(taskId)
      .map(waitSubscriptionSnapshot);
  }

  getWaitSubscription(id) {
    this.open();
    const row = this.db
      .prepare(`${WAIT_SUBSCRIPTION_SELECT} WHERE id = ?`)
      .get(id);
    return waitSubscriptionSnapshot(row);
  }

  getActiveWaitSubscriptions() {
    this.open();
    return this.db
      .prepare(
        `${WAIT_SUBSCRIPTION_SELECT} WHERE status = 'active' ORDER BY created_at, id`,
      )
      .all()
      .map(waitSubscriptionSnapshot);
  }

  #recordCiNotObservableEvidence(subscription, selector, observedAt) {
    return this.#appendEvidence({
      taskId: subscription.taskId,
      attemptId: subscription.createdByAttemptId,
      attemptRunId: null,
      kind: "github_ci_control_observation",
      source: "github_ci",
      subject: subscription.revisionSha,
      payload: {
        waitSubscriptionId: subscription.id,
        taskId: subscription.taskId,
        generation: subscription.generation,
        controlVersion: subscription.controlVersion,
        contractVersion: subscription.contractVersion,
        repository: subscription.repositoryId,
        ref: subscription.publishedRef,
        sha: subscription.revisionSha,
        selector,
        normalizedState: "ci_not_observable",
        conclusion: null,
        reason: "appearance_grace_expired",
        observedAt,
      },
      dedupeKey: `github_ci_control_observation:${subscription.taskId}:${subscription.generation}:${subscription.controlVersion}:${subscription.contractVersion}:${subscription.repositoryId}:${subscription.publishedRef}:${subscription.revisionSha}:${selector}`,
    });
  }

  async reconcileWaitSubscription(
    subscriptionId,
    options = {},
    capability = null,
  ) {
    const {
      now: nowOverride,
      gitHubAdapter,
      gitHubClient,
      markBlockedOnAuth = true,
      trigger = false,
      autoTrigger = false,
    } = options;
    this.ensureSupported();
    const id = String(subscriptionId ?? "").trim();
    if (!id) throw new Error("Wait reconciliation requires a subscription id.");
    this.open();

    const subscription = this.getWaitSubscription(id);
    if (!subscription)
      throw new Error(`Wait subscription ${id} was not found.`);

    if (subscription.status !== "active") {
      return {
        task: this.getTask(subscription.taskId),
        waitSubscription: subscription,
        classification: "inactive",
      };
    }

    const taskRow = this.#taskRow(subscription.taskId);
    if (!taskRow) throw new Error(`Task ${subscription.taskId} was not found.`);

    const nowTime = nowOverride ? new Date(nowOverride).getTime() : new Date(this.waitClock()).getTime();
    const nowIso = new Date(nowTime).toISOString();
    const taskBudget = normalizeBudget(taskRow.budget);
    const acceptedAt = new Date(taskRow.acceptedAt || taskRow.createdAt).getTime();
    const totalCommitmentDeadline = Number.isFinite(acceptedAt)
      ? acceptedAt + taskBudget.totalCommitmentWallClockDeadlineMs
      : Number.NaN;
    const subscriptionDeadline = new Date(subscription.deadlineAt).getTime();
    const effectiveDeadline = Number.isFinite(totalCommitmentDeadline)
      ? Math.min(subscriptionDeadline, totalCommitmentDeadline)
      : subscriptionDeadline;
    const effectiveDeadlineIso = Number.isFinite(effectiveDeadline)
      ? new Date(effectiveDeadline).toISOString()
      : subscription.deadlineAt;

    const adapter = gitHubAdapter ?? gitHubClient ?? this.gitHubAdapter;
    let checkRuns = [];
    let commitStatuses = [];

    try {
      const [runsRes, statusesRes] = await Promise.all([
        callFetchCheckRuns(adapter, {
          repository: subscription.repositoryId,
          sha: subscription.revisionSha,
          githubHost: subscription.githubHost,
        }),
        callFetchCommitStatuses(adapter, {
          repository: subscription.repositoryId,
          sha: subscription.revisionSha,
          githubHost: subscription.githubHost,
        }),
      ]);
      checkRuns = runsRes;
      commitStatuses = statusesRes;
    } catch (error) {
      const isRateLimit =
        error.code === "rate_limited" ||
        error.status === 429 ||
        error.statusCode === 429;
      const isAuth =
        error.code === "auth_failure" ||
        error.code === "permission_denied" ||
        error.code === "github_auth_error" ||
        error.status === 401 ||
        error.statusCode === 401 ||
        (error.status === 403 && !isRateLimit) ||
        (error.statusCode === 403 && !isRateLimit);
      const isNetwork =
        error.code === "network_error" ||
        error.code === "provider_error" ||
        error.status >= 500 ||
        error.statusCode >= 500 ||
        ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(error.code) ||
        ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(error.cause?.code);

      const atOrAfterEffectiveDeadline =
        Number.isFinite(effectiveDeadline) && nowTime >= effectiveDeadline;

      if (isAuth) {
        this.db
          .prepare(
            "UPDATE wait_subscriptions SET last_reconciled_at = ?, deadline_at = MIN(deadline_at, ?) WHERE id = ?",
          )
          .run(nowIso, effectiveDeadlineIso, id);
        // Before the deadline, preserve the caller's choice to leave an auth
        // failure for user handling. At the deadline, however, that choice
        // cannot leave the daemon-owned wait replayable forever.
        if (markBlockedOnAuth || atOrAfterEffectiveDeadline) {
          this.markBlocked(
            subscription.taskId,
            subscription.createdByAttemptId,
            `GitHub authentication/permission failure: ${redactSecrets(error.message)}`,
          );
        }
        return {
          task: this.getTask(subscription.taskId),
          waitSubscription: this.getWaitSubscription(id),
          classification: "blocked_on_user",
          error: {
            code: error.code || "auth_failure",
            message: bounded(redactSecrets(error.message), MAX_TASK_DETAIL_LENGTH),
          },
        };
      }

      if (isRateLimit || isNetwork) {
        const transientError = {
          code:
            error.code || (isRateLimit ? "rate_limited" : "network_error"),
          message: bounded(error.message, MAX_TASK_DETAIL_LENGTH),
        };
        if (atOrAfterEffectiveDeadline) {
          // This provider request is the one final exact reconciliation. A
          // transient failure cannot establish CI truth, so fail closed as an
          // external timeout rather than scheduling a retry beyond the bound.
          if (
            capability === WAIT_RECONCILE_CAPABILITY &&
            (trigger || autoTrigger)
          ) {
            return await this.#triggerWaitSubscription(
              id,
              {
                model: options.model,
                thinkingLevel: options.thinkingLevel,
                timedOut: true,
                now: nowOverride,
                skipSpawn: options.skipSpawn === true,
              },
              WAIT_TRIGGER_CAPABILITY,
            );
          }
          this.db
            .prepare(
              "UPDATE wait_subscriptions SET status = 'timed_out', last_reconciled_at = ?, next_reconcile_at = NULL, deadline_at = MIN(deadline_at, ?) WHERE id = ? AND status = 'active'",
            )
            .run(nowIso, effectiveDeadlineIso, id);
          return {
            task: this.getTask(subscription.taskId),
            waitSubscription: this.getWaitSubscription(id),
            classification: "timed_out",
            transientError,
          };
        }
        const retryDelay =
          error.retryAfterMs ?? (isRateLimit ? 60_000 : 15_000);
        const nextReconcileIso = new Date(nowTime + retryDelay).toISOString();
        this.db
          .prepare(
            "UPDATE wait_subscriptions SET last_reconciled_at = ?, next_reconcile_at = ?, deadline_at = MIN(deadline_at, ?) WHERE id = ?",
          )
          .run(nowIso, nextReconcileIso, effectiveDeadlineIso, id);
        return {
          task: this.getTask(subscription.taskId),
          waitSubscription: this.getWaitSubscription(id),
          classification: "pending",
          transientError,
        };
      }

      throw error;
    }

    const graceMs = taskBudget.ciCheckAppearanceGraceMs;
    const elapsedMs = nowTime - new Date(subscription.createdAt).getTime();
    const graceExpired = elapsedMs >= graceMs;

    const requiredChecks = subscription.requiredChecks;
    const acceptedConclusions = subscription.acceptedConclusions;
    const selectorResults = [];
    const evidenceIds = [];

    for (const selector of requiredChecks) {
      if (selector.startsWith("check_run:")) {
        const matching = checkRuns.filter(
          (run) =>
            run.head_sha &&
            run.head_sha.toLowerCase() ===
              subscription.revisionSha.toLowerCase() &&
            matchCheckRun(selector, run),
        );
        if (matching.length > 0) {
          matching.sort((a, b) => {
            const aTime = a.completed_at
              ? new Date(a.completed_at).getTime()
              : a.started_at
                ? new Date(a.started_at).getTime()
                : 0;
            const bTime = b.completed_at
              ? new Date(b.completed_at).getTime()
              : b.started_at
                ? new Date(b.started_at).getTime()
                : 0;
            if (bTime !== aTime) return bTime - aTime;
            return Number(b.id) - Number(a.id);
          });
          const latestRun = matching[0];
          const { normalizedState, conclusion } = normalizeCheckRun(
            latestRun,
            acceptedConclusions,
          );
          const dedupeKey = `github_check_observation:${subscription.taskId}:${subscription.generation}:${subscription.revisionSha}:${selector}:${latestRun.id}:${normalizedState}:${conclusion ?? "null"}`;
          const evidenceId = this.#appendEvidence({
            taskId: subscription.taskId,
            attemptId: subscription.createdByAttemptId,
            attemptRunId: null,
            kind: "github_check_observation",
            source: "github_ci",
            subject: subscription.revisionSha,
            payload: {
              waitSubscriptionId: subscription.id,
              taskId: subscription.taskId,
              generation: subscription.generation,
              repository: subscription.repositoryId,
              sha: subscription.revisionSha,
              selector,
              normalizedState,
              conclusion,
              status: latestRun.status ?? null,
              runId: latestRun.id,
              metadata: {
                name: latestRun.name,
                status: latestRun.status ?? null,
                conclusion: latestRun.conclusion ?? null,
                startedAt: latestRun.started_at ?? null,
                completedAt: latestRun.completed_at ?? null,
                htmlUrl: latestRun.html_url ?? null,
                detailsUrl: latestRun.details_url ?? null,
                app: latestRun.app
                  ? {
                      id: latestRun.app.id ?? null,
                      slug: latestRun.app.slug ?? null,
                      name: latestRun.app.name ?? null,
                    }
                  : null,
              },
              observedAt: nowIso,
            },
            dedupeKey,
          });
          evidenceIds.push(evidenceId);
          selectorResults.push({
            selector,
            normalizedState,
            conclusion,
            matched: true,
            item: latestRun,
            evidenceId,
          });
        } else {
          const normalizedState = graceExpired
            ? "ci_not_observable"
            : "pending";
          const evidenceId = graceExpired
            ? this.#recordCiNotObservableEvidence(subscription, selector, nowIso)
            : null;
          if (evidenceId) evidenceIds.push(evidenceId);
          selectorResults.push({
            selector,
            normalizedState,
            matched: false,
            evidenceId,
          });
        }
      } else if (selector.startsWith("commit_status:")) {
        const matching = commitStatuses.filter((st) =>
          matchCommitStatus(selector, st, subscription.revisionSha),
        );
        if (matching.length > 0) {
          matching.sort((a, b) => {
            const aTime = a.updated_at
              ? new Date(a.updated_at).getTime()
              : a.created_at
                ? new Date(a.created_at).getTime()
                : 0;
            const bTime = b.updated_at
              ? new Date(b.updated_at).getTime()
              : b.created_at
                ? new Date(b.created_at).getTime()
                : 0;
            if (bTime !== aTime) return bTime - aTime;
            return Number(b.id) - Number(a.id);
          });
          const latestStatus = matching[0];
          const { normalizedState, conclusion } = normalizeCommitStatus(
            latestStatus,
            acceptedConclusions,
          );
          const dedupeKey = `github_status_observation:${subscription.taskId}:${subscription.generation}:${subscription.revisionSha}:${selector}:${latestStatus.id}:${normalizedState}:${conclusion}`;
          const evidenceId = this.#appendEvidence({
            taskId: subscription.taskId,
            attemptId: subscription.createdByAttemptId,
            attemptRunId: null,
            kind: "github_status_observation",
            source: "github_ci",
            subject: subscription.revisionSha,
            payload: {
              waitSubscriptionId: subscription.id,
              taskId: subscription.taskId,
              generation: subscription.generation,
              repository: subscription.repositoryId,
              sha: subscription.revisionSha,
              selector,
              normalizedState,
              conclusion,
              statusId: latestStatus.id,
              metadata: {
                context: latestStatus.context,
                state: latestStatus.state,
                description: latestStatus.description ?? null,
                targetUrl: latestStatus.target_url ?? null,
                createdAt: latestStatus.created_at ?? null,
                updatedAt: latestStatus.updated_at ?? null,
              },
              observedAt: nowIso,
            },
            dedupeKey,
          });
          evidenceIds.push(evidenceId);
          selectorResults.push({
            selector,
            normalizedState,
            conclusion,
            matched: true,
            item: latestStatus,
            evidenceId,
          });
        } else {
          const normalizedState = graceExpired
            ? "ci_not_observable"
            : "pending";
          const evidenceId = graceExpired
            ? this.#recordCiNotObservableEvidence(subscription, selector, nowIso)
            : null;
          if (evidenceId) evidenceIds.push(evidenceId);
          selectorResults.push({
            selector,
            normalizedState,
            matched: false,
            evidenceId,
          });
        }
      }
    }

    let classification = classifyOverallObservation(selectorResults);

    if (
      classification !== "success" &&
      Number.isFinite(effectiveDeadline) &&
      nowTime >= effectiveDeadline
    ) {
      classification = "timed_out";
      // Keep the row active until the runtime-owned trigger transaction when
      // this is a wake. That transaction must atomically create the timeout
      // Result; an intervening daemon crash must leave the wait replayable.
      if (!(capability === WAIT_RECONCILE_CAPABILITY && (trigger || autoTrigger))) {
        this.db
          .prepare(
            "UPDATE wait_subscriptions SET status = 'timed_out', last_reconciled_at = ?, next_reconcile_at = NULL WHERE id = ?",
          )
          .run(nowIso, id);
      }
    }

    let nextReconcileIso = null;
    if (classification === "pending") {
      const nextInterval = computeReconcileInterval(
        subscription.createdAt,
        nowTime,
        subscription.id,
      );
      nextReconcileIso = new Date(
        Math.min(nowTime + nextInterval, effectiveDeadline),
      ).toISOString();
    }

    if (
      capability === WAIT_RECONCILE_CAPABILITY &&
      (options.trigger === true || options.autoTrigger === true) &&
      (classification === "success" ||
        classification === "failure" ||
        classification === "ci_not_observable" ||
        classification === "timed_out")
    ) {
      return await this.#triggerWaitSubscription(
        id,
        {
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          timedOut: classification === "timed_out",
          now: nowOverride,
          skipSpawn: options.skipSpawn === true,
        },
        WAIT_TRIGGER_CAPABILITY,
      );
    }

    this.db
      .prepare(
        "UPDATE wait_subscriptions SET last_reconciled_at = ?, next_reconcile_at = ?, deadline_at = MIN(deadline_at, ?) WHERE id = ?",
      )
      .run(nowIso, nextReconcileIso, effectiveDeadlineIso, id);

    return {
      task: this.getTask(subscription.taskId),
      waitSubscription: this.getWaitSubscription(id),
      classification,
      selectorResults,
      evidenceIds,
    };
  }

  async triggerWaitSubscription() {
    throw Object.assign(
      new Error("Wait triggering is runtime-internal; use wait reconciliation."),
      { code: "wait_trigger_internal_only" },
    );
  }

  #validatedWaitObservation(waitRow, taskRow) {
    const expectedRef = `${REMOTE_REF_PREFIX}${taskRow.id}`;
    const requiredChecks = parsed(waitRow.requiredChecks, []);
    const acceptedConclusions = parsed(waitRow.acceptedConclusions, []);
    if (
      waitRow.taskId !== taskRow.id ||
      waitRow.publishedRef !== expectedRef ||
      Number(waitRow.controlVersion) !== Number(taskRow.controlVersion) ||
      Number(waitRow.contractVersion) !== Number(taskRow.contractVersion)
    )
      return null;

    const confirmedPublication = this.db
      .prepare(`${REMOTE_EFFECT_SELECT}
        WHERE task_id = ? AND control_version = ? AND contract_version = ?
          AND remote = 'origin' AND repository = ? AND ref = ? AND new_oid = ?
          AND state = 'confirmed'
        ORDER BY confirmed_at DESC, created_at DESC, id DESC LIMIT 1`)
      .get(
        taskRow.id,
        taskRow.controlVersion,
        taskRow.contractVersion,
        waitRow.repositoryId,
        expectedRef,
        waitRow.revisionSha,
      );
    if (!confirmedPublication) return null;

    const contract = parsed(taskRow.completionContract, {});
    const contractChecks = requiredChecksFromContract(contract)
      .map((selector) => typeof selector === "string" ? selector.trim() : selector);
    const contractConclusions = acceptedConclusionsFromContract(contract)
      .map((conclusion) => typeof conclusion === "string" ? conclusion.trim().toLowerCase() : conclusion);
    if (
      !sameStringSet(requiredChecks, contractChecks) ||
      !sameStringSet(acceptedConclusions, contractConclusions)
    )
      return null;

    const rows = this.db
      .prepare(`SELECT id, attempt_id AS attemptId, kind, source, subject, payload,
          observed_at AS observedAt
        FROM evidence
        WHERE task_id = ? AND attempt_id = ? AND source = 'github_ci'
          AND subject = ? AND kind IN ('github_check_observation', 'github_status_observation', 'github_ci_control_observation')
        ORDER BY observed_at DESC, id DESC`)
      .all(taskRow.id, waitRow.createdByAttemptId, waitRow.revisionSha);
    const latestBySelector = new Map();
    for (const row of rows) {
      let payload;
      try {
        payload = parsed(row.payload, null);
      } catch {
        continue;
      }
      const selector = payload?.selector;
      const normalizedState = payload?.normalizedState;
      const conclusion = payload?.conclusion;
      const isControlObservation = row.kind === "github_ci_control_observation";
      const isProviderObservation =
        row.kind === "github_check_observation" ||
        row.kind === "github_status_observation";
      if (
        !isProviderObservation && !isControlObservation
      )
        continue;
      if (
        payload?.waitSubscriptionId !== waitRow.id ||
        payload?.taskId !== taskRow.id ||
        Number(payload?.generation) !== Number(waitRow.generation) ||
        payload?.repository !== waitRow.repositoryId ||
        payload?.sha !== waitRow.revisionSha ||
        !requiredChecks.includes(selector) ||
        (isControlObservation &&
          (payload?.controlVersion == null ||
            Number(payload.controlVersion) !== Number(waitRow.controlVersion) ||
            payload?.contractVersion == null ||
            Number(payload.contractVersion) !== Number(waitRow.contractVersion) ||
            payload?.ref !== waitRow.publishedRef ||
            normalizedState !== "ci_not_observable" ||
            conclusion !== null ||
            payload?.reason !== "appearance_grace_expired")) ||
        (isProviderObservation &&
          (!["success", "failure"].includes(normalizedState) ||
            typeof conclusion !== "string" ||
            !conclusion.trim() ||
            (normalizedState === "success" &&
              !acceptedConclusions.includes(conclusion.toLowerCase()))))
      )
        continue;
      latestBySelector.set(selector, {
        selector,
        normalizedState,
        conclusion: typeof conclusion === "string" ? conclusion.toLowerCase() : null,
        matched: !isControlObservation,
        evidenceId: row.id,
        observedAt: row.observedAt,
      });
    }

    const selectorResults = requiredChecks.map((selector) =>
      latestBySelector.get(selector) ?? {
        selector,
        normalizedState: "pending",
        matched: false,
      },
    );
    return {
      classification: classifyOverallObservation(selectorResults),
      selectorResults,
      evidenceIds: selectorResults
        .map((result) => result.evidenceId)
        .filter(Boolean),
    };
  }

  async #triggerWaitSubscription(
    subscriptionId,
    {
      model = null,
      thinkingLevel = null,
      now: nowOverride = null,
      skipSpawn = false,
      timedOut = false,
    } = {},
    capability = null,
  ) {
    this.ensureSupported();
    if (capability !== WAIT_TRIGGER_CAPABILITY)
      throw Object.assign(
        new Error("Wait triggering requires the runtime-owned reconciliation capability."),
        { code: "wait_trigger_internal_only" },
      );
    const id = String(subscriptionId ?? "").trim();
    if (!id)
      throw new Error("Triggering wait subscription requires a subscription id.");
    this.open();

    const timestamp = nowOverride != null
      ? resultTimestamp(() => nowOverride)
      : now();

    let taskToLaunch = null;
    let newAttemptId = null;
    let newAttemptNumber = null;
    let launchPacket = null;
    let effectiveModel = null;
    let effectiveThinkingLevel = null;
    let repairDetail = null;
    let targetTaskId = null;
    let classification = null;
    let selectorResults = [];
    let evidenceIds = [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const waitRow = this.db
        .prepare(`${WAIT_SUBSCRIPTION_SELECT} WHERE id = ?`)
        .get(id);
      if (!waitRow) {
        throw new Error(`Wait subscription ${id} was not found.`);
      }

      targetTaskId = waitRow.taskId;

      // Idempotency: If already triggered, return current task & subscription without allocating again
      if (waitRow.status === "triggered") {
        this.db.exec("COMMIT");
        return {
          task: this.getTask(waitRow.taskId),
          waitSubscription: waitSubscriptionSnapshot(waitRow),
          triggered: false,
          alreadyTriggered: true,
          classification: null,
        };
      }

      // A timed-out row is admitted only when this invocation follows the
      // final exact reconciliation that durably marked it timed out.
      if (waitRow.status !== "active" && !(timedOut && waitRow.status === "timed_out")) {
        this.db.exec("COMMIT");
        return {
          task: this.getTask(waitRow.taskId),
          waitSubscription: waitSubscriptionSnapshot(waitRow),
          triggered: false,
          stale: true,
          classification: null,
        };
      }

      const taskRow = this.#taskRow(waitRow.taskId);
      if (!taskRow) {
        throw new Error(`Task ${waitRow.taskId} was not found.`);
      }
      const triggerBudget = normalizeBudget(taskRow.budget);
      const triggerAcceptedAt = new Date(
        taskRow.acceptedAt || taskRow.createdAt,
      ).getTime();
      const totalCommitmentDeadline = Number.isFinite(triggerAcceptedAt)
        ? triggerAcceptedAt + triggerBudget.totalCommitmentWallClockDeadlineMs
        : Number.NaN;
      const waitDeadline = new Date(waitRow.deadlineAt).getTime();
      const effectiveDeadline = Number.isFinite(totalCommitmentDeadline)
        ? Math.min(waitDeadline, totalCommitmentDeadline)
        : waitDeadline;

      // Require Task is non-terminal (state IN ('waiting', 'running', 'accepted'))
      if (!["waiting", "running", "accepted"].includes(taskRow.state)) {
        this.db.exec("COMMIT");
        return {
          task: this.getTask(taskRow.id),
          waitSubscription: waitSubscriptionSnapshot(waitRow),
          triggered: false,
          stale: true,
          classification: null,
        };
      }

      // Require exact task + generation + control_version + contract_version match
      if (
        taskRow.controlVersion !== waitRow.controlVersion ||
        taskRow.contractVersion !== waitRow.contractVersion
      ) {
        this.db.exec("COMMIT");
        return {
          task: this.getTask(taskRow.id),
          waitSubscription: waitSubscriptionSnapshot(waitRow),
          triggered: false,
          stale: true,
          classification: null,
        };
      }

      const durableObservation = this.#validatedWaitObservation(waitRow, taskRow);
      if (!durableObservation || durableObservation.classification === "pending") {
        if (!timedOut) {
          this.db.exec("COMMIT");
          return {
            task: this.getTask(taskRow.id),
            waitSubscription: waitSubscriptionSnapshot(waitRow),
            triggered: false,
            pending: true,
            classification: durableObservation?.classification ?? "pending",
          };
        }
        classification = "timed_out";
        selectorResults = durableObservation?.selectorResults ?? [];
        evidenceIds = durableObservation?.evidenceIds ?? [];
      } else {
        classification = durableObservation.classification;
        selectorResults = durableObservation.selectorResults;
        evidenceIds = durableObservation.evidenceIds;
      }

      // Insert/fetch immutable trigger Evidence from validated durable runtime
      // Evidence. Caller-provided classifications, observations, and ids never
      // participate in the completion authority.
      const dedupeKey = `wait_trigger:${taskRow.id}:${waitRow.generation}:${waitRow.revisionSha}:${classification}`;
      const triggerEvidenceId = this.#appendEvidence({
        taskId: taskRow.id,
        attemptId: waitRow.createdByAttemptId,
        attemptRunId: null,
        kind: "wait_trigger",
        source: "github_ci",
        subject: waitRow.revisionSha,
        payload: {
          waitSubscriptionId: waitRow.id,
          taskId: taskRow.id,
          generation: waitRow.generation,
          classification,
          revisionSha: waitRow.revisionSha,
          repositoryId: waitRow.repositoryId,
          selectorResults,
          triggeredAt: timestamp,
        },
        dedupeKey,
      });

      const allEvidenceIds = Array.from(
        new Set([triggerEvidenceId, ...evidenceIds].filter(Boolean)),
      );
      const evidenceRefsJson = JSON.stringify(allEvidenceIds);

      if (classification === "ci_not_observable") {
        // A missing required selector is a bounded external-observability block,
        // not a CI failure. End the wait and retain the exact control receipt
        // without manufacturing a failed provider result or repair Attempt.
        const terminalDetail = `Required GitHub CI selector(s) did not appear within the grace window for revision ${waitRow.revisionSha}.`;
        const taskUpdate = this.db
          .prepare(
            `UPDATE tasks SET state = 'blocked', updated_at = ?, final_result = ?,
            terminal_detail = ?, final_branch_head = ?, final_revision = ?,
            completion_evidence_ref = ?, terminal_reason = ?
            WHERE id = ? AND state IN ('waiting', 'running', 'accepted')
            AND control_version = ? AND contract_version = ?`,
          )
          .run(
            timestamp,
            null,
            terminalDetail,
            waitRow.revisionSha,
            waitRow.revisionSha,
            evidenceRefsJson,
            "ci_not_observable",
            taskRow.id,
            taskRow.controlVersion,
            taskRow.contractVersion,
          );
        if (taskUpdate.changes !== 1)
          throw new Error("Task state CAS failed when blocking unobservable CI.");

        const attemptUpdate = this.db
          .prepare(
            `UPDATE attempts SET state = 'failed', finished_at = ?, worker_terminated = 1,
            final_result = ?, terminal_detail = ?, final_branch_head = ?
            WHERE id = ? AND task_id = ? AND state = 'parked_wait'
              AND worker_terminated = 1 AND gate_terminated = 1`,
          )
          .run(
            timestamp,
            null,
            terminalDetail,
            waitRow.revisionSha,
            waitRow.createdByAttemptId,
            taskRow.id,
          );
        if (attemptUpdate.changes !== 1)
          throw new Error("Parked Attempt fence rejected unobservable CI block.");

        const waitUpdate = this.db
          .prepare(
            `UPDATE wait_subscriptions SET status = 'triggered',
            trigger_evidence_id = ?, last_reconciled_at = ?, next_reconcile_at = NULL
            WHERE id = ? AND status = 'active'`,
          )
          .run(triggerEvidenceId, timestamp, id);
        if (waitUpdate.changes !== 1)
          throw new Error("Wait subscription trigger CAS failed.");

        const resultId = this.#insertResultDelivery({
          task: this.#taskRow(taskRow.id),
          outcome: "failed",
          finalResult: null,
          terminalDetail,
          terminalReason: "ci_not_observable",
          finalRevision: waitRow.revisionSha,
          finalBranchHead: waitRow.revisionSha,
          evidenceRefs: allEvidenceIds,
        });
        if (!resultId)
          throw new Error("Blocked Task did not produce a Result delivery.");
      } else if (classification === "success") {
        // 7A. CI Success without remaining model work: CAS Task -> completed
        const taskUpdate = this.db
          .prepare(
            `UPDATE tasks SET state = 'completed', updated_at = ?, final_result = ?,
            terminal_detail = ?, final_branch_head = ?, final_revision = ?,
            completion_evidence_ref = ?, terminal_reason = ?
            WHERE id = ? AND state IN ('waiting', 'running', 'accepted')
            AND control_version = ? AND contract_version = ?`,
          )
          .run(
            timestamp,
            null,
            "Task completed after GitHub CI checks passed.",
            waitRow.revisionSha,
            waitRow.revisionSha,
            evidenceRefsJson,
            "verified_ci",
            taskRow.id,
            taskRow.controlVersion,
            taskRow.contractVersion,
          );

        if (taskUpdate.changes !== 1) {
          throw new Error("Task state CAS failed when completing verified CI.");
        }

        // Complete the parked attempt if still in parked_wait/running/starting
        this.db
          .prepare(
            `UPDATE attempts SET state = 'completed', finished_at = ?, worker_terminated = 1,
            final_result = ?, terminal_detail = ?, final_branch_head = ?
            WHERE id = ? AND task_id = ? AND state IN ('parked_wait', 'running', 'starting')`,
          )
          .run(
            timestamp,
            null,
            "Task completed after GitHub CI checks passed.",
            waitRow.revisionSha,
            waitRow.createdByAttemptId,
            taskRow.id,
          );

        // Mark wait subscription triggered
        const waitUpdate = this.db
          .prepare(
            `UPDATE wait_subscriptions SET status = 'triggered',
            trigger_evidence_id = ?, last_reconciled_at = ?, next_reconcile_at = NULL
            WHERE id = ? AND status = 'active'`,
          )
          .run(triggerEvidenceId, timestamp, id);

        if (waitUpdate.changes !== 1) {
          throw new Error("Wait subscription trigger CAS failed.");
        }

        // Insert pending result_deliveries row
        const resultId = this.#insertResultDelivery({
          task: this.#taskRow(taskRow.id),
          outcome: "completed",
          finalResult: null,
          terminalDetail: "Task completed after GitHub CI checks passed.",
          terminalReason: "verified_ci",
          finalRevision: waitRow.revisionSha,
          finalBranchHead: waitRow.revisionSha,
          evidenceRefs: allEvidenceIds,
        });

        if (!resultId) {
          throw new Error("Completed Task did not produce a Result delivery.");
        }
      } else {
        // 7B. CI Failure, ci_not_observable, timed_out, etc.
        const budget = normalizeBudget(taskRow.budget);
        const maxPubs = effectiveMaxPublications(taskRow.authority, budget);
        const totalAttempts = this.#getTaskAttemptsCount(taskRow.id);
        const codeAttempts = this.#getTaskCodeAttemptsCount(taskRow.id);
        const startupFailures = this.#getTaskStartupFailuresCount(taskRow.id);
        const ciRepairs = this.#getTaskCiRepairsCount(taskRow.id);
        const pubCount = Number(taskRow.publicationCount ?? 0);
        const nowTime = new Date(timestamp).getTime();
        const wallClockElapsed = nowTime - new Date(taskRow.acceptedAt || taskRow.createdAt).getTime();

        const lastAttemptRow = this.db
          .prepare(
            "SELECT id, number, provider, model_id, thinking_level, applied_provider, applied_model_id, applied_thinking_level FROM attempts WHERE task_id = ? ORDER BY number DESC LIMIT 1",
          )
          .get(taskRow.id);
        const nextNumber = Number(lastAttemptRow?.number ?? 1) + 1;
        effectiveModel = model ?? {
          provider:
            lastAttemptRow?.applied_provider ??
            lastAttemptRow?.provider ??
            "anthropic",
          id:
            lastAttemptRow?.applied_model_id ??
            lastAttemptRow?.model_id ??
            "claude-3-5-sonnet",
        };
        effectiveThinkingLevel =
          thinkingLevel ??
          lastAttemptRow?.applied_thinking_level ??
          lastAttemptRow?.thinking_level ??
          "off";
        const lastApplied = this.#getTaskLastAppliedConfiguration(taskRow.id);
        const requestedEscalation = Boolean(
          lastApplied &&
          (lastApplied.provider !== effectiveModel.provider ||
            lastApplied.modelId !== effectiveModel.id ||
            lastApplied.thinkingLevel !== effectiveThinkingLevel),
        );
        const escalationBudgetExhausted =
          requestedEscalation &&
          this.#getTaskModelOrThinkingEscalationsCount(taskRow.id) >=
            budget.maxModelOrThinkingEscalations;

        const fp = ciFailureFingerprint({
          revisionSha: waitRow.revisionSha,
          classification,
          failingChecks: selectorResults,
        });
        const history = this.#getTaskCiFailureHistory(taskRow.id);
        let consecutiveCount = 0;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].fingerprint === fp) consecutiveCount++;
          else break;
        }

        let terminalReason = null;
        let terminalDetail = null;

        if (classification === "timed_out" || wallClockElapsed >= budget.totalCommitmentWallClockDeadlineMs) {
          terminalReason = "external_timeout";
          terminalDetail =
            Number.isFinite(totalCommitmentDeadline) &&
            nowTime >= totalCommitmentDeadline
              ? "Task total commitment wall-clock deadline expired."
              : `GitHub CI wait subscription deadline expired for revision ${waitRow.revisionSha}.`;
        } else if (consecutiveCount >= budget.maxSameFailureFingerprint) {
          terminalReason = "stalled";
          terminalDetail = `Task CI repair stalled on repeated failure fingerprint for revision ${waitRow.revisionSha}.`;
        } else if (ciRepairs >= budget.maxCiRepairCycles) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task CI repair cycle budget (${budget.maxCiRepairCycles}) exhausted.`;
        } else if (pubCount >= maxPubs) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task remote publication budget (${maxPubs}) exhausted.`;
        } else if (totalAttempts >= budget.maxTotalAttempts) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task total attempt budget (${budget.maxTotalAttempts}) exhausted.`;
        } else if (codeAttempts >= budget.maxCodeProducingAttempts) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task code-producing attempt budget (${budget.maxCodeProducingAttempts}) exhausted.`;
        } else if (startupFailures >= budget.maxStartupFailures) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task startup failure budget (${budget.maxStartupFailures}) exhausted.`;
        } else if (escalationBudgetExhausted) {
          terminalReason = "budget_exhausted";
          terminalDetail = `Task model/thinking escalation budget (${budget.maxModelOrThinkingEscalations}) exhausted.`;
        }

        if (terminalReason) {
          this.db
            .prepare(
              `UPDATE tasks SET state = 'failed', updated_at = ?, final_result = NULL,
              terminal_detail = ?, final_branch_head = ?, final_revision = ?,
              terminal_reason = ? WHERE id = ? AND state IN ('waiting', 'running', 'accepted')
              AND control_version = ? AND contract_version = ?`,
            )
            .run(
              timestamp,
              terminalDetail,
              waitRow.revisionSha,
              waitRow.revisionSha,
              terminalReason,
              taskRow.id,
              taskRow.controlVersion,
              taskRow.contractVersion,
            );

          this.db
            .prepare(
              `UPDATE attempts SET state = 'failed', finished_at = ?, worker_terminated = 1,
              terminal_detail = ?, final_branch_head = ?
              WHERE id = ? AND task_id = ? AND state = 'parked_wait'`,
            )
            .run(
              timestamp,
              terminalDetail,
              waitRow.revisionSha,
              waitRow.createdByAttemptId,
              taskRow.id,
            );

          this.db
            .prepare(
              `UPDATE wait_subscriptions SET status = ?, trigger_evidence_id = ?,
              last_reconciled_at = ?, next_reconcile_at = NULL WHERE id = ? AND status = 'active'`,
            )
            .run(
              classification === "timed_out" ? "timed_out" : "triggered",
              triggerEvidenceId,
              timestamp,
              id,
            );

          const resultId = this.#insertResultDelivery({
            task: this.#taskRow(taskRow.id),
            outcome: "failed",
            finalResult: null,
            terminalDetail,
            terminalReason,
            finalRevision: waitRow.revisionSha,
            finalBranchHead: waitRow.revisionSha,
            evidenceRefs: allEvidenceIds,
          });
          if (!resultId) {
            throw new Error("Failed Task did not produce a Result delivery.");
          }

          this.db.exec("COMMIT");
          return {
            task: this.getTask(taskRow.id),
            waitSubscription: this.getWaitSubscription(id),
            classification,
            continuationAttemptId: null,
            triggered: true,
          };
        }

        this.#assertFreshAttemptBudget(
          taskRow.id,
          effectiveModel,
          effectiveThinkingLevel,
        );
        const freshAttemptId = randomUUID();

        repairDetail =
          classification === "ci_not_observable"
            ? `GitHub CI check appearance grace window expired for revision ${waitRow.revisionSha}.`
            : `GitHub CI checks failed on revision ${waitRow.revisionSha}.`;

        const remainingCommitmentMs = Number.isFinite(totalCommitmentDeadline)
          ? Math.max(0, totalCommitmentDeadline - nowTime)
          : null;
        const remainingBudget = {
          remainingTotalAttempts: Math.max(0, budget.maxTotalAttempts - nextNumber),
          remainingCodeProducingAttempts: Math.max(0, budget.maxCodeProducingAttempts - codeAttempts),
          remainingCiRepairCycles: Math.max(0, budget.maxCiRepairCycles - (ciRepairs + 1)),
          remainingPublications: Math.max(0, maxPubs - (pubCount + 1)),
          remainingRunsInAttempt: budget.maxPiRunsPerAttempt,
          remainingPiTurnsInAttempt: budget.maxPiTurnsPerAttempt,
          remainingStartupFailures: Math.max(0, budget.maxStartupFailures - startupFailures),
          remainingSameFailureFingerprint: Math.max(0, budget.maxSameFailureFingerprint - consecutiveCount),
          remainingNoProgressSupervisorIterations: budget.maxNoProgressSupervisorIterations,
          remainingModelOrThinkingEscalations: Math.max(
            0,
            budget.maxModelOrThinkingEscalations -
              this.#getTaskModelOrThinkingEscalationsCount(taskRow.id),
          ),
          remainingCommitmentWallClockMs: remainingCommitmentMs,
          remainingCiWaitMs: Math.max(0, effectiveDeadline - nowTime),
        };
        launchPacket = buildRepairPrompt({
          taskId: taskRow.id,
          attemptNumber: nextNumber,
          goal: taskRow.goal,
          taskBranch: taskRow.taskBranch,
          taskWorktree: taskRow.taskWorktree,
          baseCommit: taskRow.baseCommit,
          candidateSha: waitRow.revisionSha,
          completionContract: parsed(taskRow.completionContract),
          ciEvidence: {
            revisionSha: waitRow.revisionSha,
            classification,
            failingChecks: selectorResults.map((result) => ({
              selector: result.selector,
              normalizedState: result.normalizedState,
              conclusion: result.conclusion ?? null,
              evidenceId: result.evidenceId ?? null,
            })),
            evidenceRefs: allEvidenceIds,
          },
          priorFailureDetail: `Previous attempt outcome: ci_failed; ${repairDetail}`,
          remainingBudget,
        });

        // Insert fresh Attempt
        this.db
          .prepare(
            `INSERT INTO attempts (
              id, task_id, number, provider, model_id, thinking_level,
              state, started_at, worker_terminated, resume_wait_id, cause
            ) VALUES (?, ?, ?, NULL, NULL, NULL, 'starting', ?, 0, ?, 'repair')`,
          )
          .run(
            freshAttemptId,
            taskRow.id,
            nextNumber,
            timestamp,
            waitRow.id,
          );

        // Insert attempt_runs row
        this.db
          .prepare(
            `INSERT INTO attempt_runs (
              attempt_id, sequence, kind, control_version, contract_version,
              prompt_digest, state, evidence_refs, started_at
            ) VALUES (?, 1, 'local_repair', ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            freshAttemptId,
            taskRow.controlVersion,
            taskRow.contractVersion,
            promptDigest(launchPacket),
            evidenceRefsJson,
            timestamp,
          );

        // Update task latest_attempt_id = freshAttemptId, state = 'running', updated_at = timestamp
        const taskUpdate = this.db
          .prepare(
            `UPDATE tasks SET state = 'running', latest_attempt_id = ?, updated_at = ?
            WHERE id = ? AND state IN ('waiting', 'running', 'accepted')
            AND control_version = ? AND contract_version = ?`,
          )
          .run(
            freshAttemptId,
            timestamp,
            taskRow.id,
            taskRow.controlVersion,
            taskRow.contractVersion,
          );

        if (taskUpdate.changes !== 1) {
          throw new Error("Task state update failed when allocating continuation attempt.");
        }

        // Update wait_subscriptions: status = 'triggered', continuation_attempt_id = freshAttemptId
        const waitUpdate = this.db
          .prepare(
            `UPDATE wait_subscriptions SET status = 'triggered',
            trigger_evidence_id = ?, continuation_attempt_id = ?,
            last_reconciled_at = ?, next_reconcile_at = NULL
            WHERE id = ? AND status = 'active'`,
          )
          .run(
            triggerEvidenceId,
            freshAttemptId,
            timestamp,
            id,
          );

        if (waitUpdate.changes !== 1) {
          throw new Error("Wait subscription trigger update failed.");
        }

        newAttemptId = freshAttemptId;
        newAttemptNumber = nextNumber;
        taskToLaunch = {
          id: taskRow.id,
          sourceRepoRoot: taskRow.sourceRepoRoot,
          baseCommit: taskRow.baseCommit,
          taskBranch: taskRow.taskBranch,
          taskWorktree: taskRow.taskWorktree,
          goal: taskRow.goal,
          contractVersion: taskRow.contractVersion,
          controlVersion: taskRow.controlVersion,
        };

        effectiveModel = model ?? {
          provider:
            lastAttemptRow?.applied_provider ??
            lastAttemptRow?.provider ??
            "anthropic",
          id:
            lastAttemptRow?.applied_model_id ??
            lastAttemptRow?.model_id ??
            "claude-3-5-sonnet",
        };
        effectiveThinkingLevel =
          thinkingLevel ??
          lastAttemptRow?.applied_thinking_level ??
          lastAttemptRow?.thinking_level ??
          "off";
      }

      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    // Step 9: AFTER COMMIT: only then spawn if a new Attempt exists
    if (newAttemptId && taskToLaunch && !skipSpawn) {
      await this.launchAttempt({
        task: taskToLaunch,
        attemptId: newAttemptId,
        number: newAttemptNumber,
        model: effectiveModel,
        thinkingLevel: effectiveThinkingLevel,
        packet: launchPacket,
        priorState: "ci_failed",
        priorDetail: repairDetail,
      });
    }

    return {
      task: this.getTask(targetTaskId ?? (this.getWaitSubscription(id)?.taskId ?? id)),
      waitSubscription: this.getWaitSubscription(id),
      classification,
      continuationAttemptId: newAttemptId ?? null,
      triggered: true,
    };
  }

  #getTaskLocalGateFailureHistory(taskId) {
    const rows = this.db
      .prepare(
        "SELECT payload FROM evidence WHERE task_id = ? AND kind = 'local_gate_result' ORDER BY observed_at ASC, id ASC",
      )
      .all(taskId);
    return rows
      .map((r) => parsed(r.payload, {}))
      .filter((p) => p.exitCategory !== "zero" && (p.exitCode !== 0 || p.error))
      .map((p) => ({
        fingerprint: localGateFailureFingerprint(p),
        candidateSha: p.candidateSha,
      }));
  }

  #getTaskCiFailureHistory(taskId) {
    const rows = this.db
      .prepare(
        "SELECT payload FROM evidence WHERE task_id = ? AND kind = 'wait_trigger' ORDER BY observed_at ASC, id ASC",
      )
      .all(taskId);
    return rows
      .map((r) => parsed(r.payload, {}))
      .filter((p) => p.classification !== "success")
      .map((p) => ({
        fingerprint: ciFailureFingerprint({
          revisionSha: p.revisionSha,
          classification: p.classification,
          failingChecks: p.selectorResults,
        }),
        revisionSha: p.revisionSha,
      }));
  }

  #consumePiTurn(active) {
    const task = this.#taskRow(active.taskId);
    if (!task) return false;
    const budget = normalizeBudget(task.budget);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`UPDATE attempts SET pi_turn_count = pi_turn_count + 1
          WHERE id = ? AND task_id = ? AND state = 'running'
          AND pi_turn_count < ?`)
        .run(active.attemptId, active.taskId, budget.maxPiTurnsPerAttempt);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #getTaskAttemptsCount(taskId) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM attempts WHERE task_id = ?")
      .get(taskId);
    return Number(row?.count ?? 0);
  }

  #getTaskCodeAttemptsCount(taskId) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM attempts WHERE task_id = ? AND (applied_provider IS NOT NULL OR provider IS NOT NULL)",
      )
      .get(taskId);
    return Number(row?.count ?? 0);
  }

  #getTaskCiRepairsCount(taskId) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM attempts WHERE task_id = ? AND cause = 'repair' AND resume_wait_id IS NOT NULL",
      )
      .get(taskId);
    return Number(row?.count ?? 0);
  }

  #getTaskModelOrThinkingEscalationsCount(taskId) {
    const rows = this.db
      .prepare(`SELECT applied_provider AS provider, applied_model_id AS modelId,
        applied_thinking_level AS thinkingLevel FROM attempts
        WHERE task_id = ? AND applied_provider IS NOT NULL ORDER BY number, id`)
      .all(taskId);
    let previous = null;
    let count = 0;
    for (const row of rows) {
      const current = {
        provider: row.provider,
        modelId: row.modelId,
        thinkingLevel: row.thinkingLevel,
      };
      if (previous && JSON.stringify(previous) !== JSON.stringify(current)) count++;
      previous = current;
    }
    return count;
  }

  #getTaskLastAppliedConfiguration(taskId) {
    return this.db
      .prepare(`SELECT applied_provider AS provider, applied_model_id AS modelId,
        applied_thinking_level AS thinkingLevel FROM attempts
        WHERE task_id = ? AND applied_provider IS NOT NULL ORDER BY number DESC, id DESC LIMIT 1`)
      .get(taskId) ?? null;
  }

  #assertFreshAttemptBudget(taskId, model, thinkingLevel) {
    const task = this.#taskRow(taskId);
    const budget = normalizeBudget(task?.budget);
    const attempts = this.#getTaskAttemptsCount(taskId);
    const codeAttempts = this.#getTaskCodeAttemptsCount(taskId);
    const startupFailures = this.#getTaskStartupFailuresCount(taskId);
    if (attempts >= budget.maxTotalAttempts)
      throw new Error(`Task total attempt budget (${budget.maxTotalAttempts}) exhausted.`);
    if (codeAttempts >= budget.maxCodeProducingAttempts)
      throw new Error(`Task code-producing attempt budget (${budget.maxCodeProducingAttempts}) exhausted.`);
    if (startupFailures >= budget.maxStartupFailures)
      throw new Error(`Task startup failure budget (${budget.maxStartupFailures}) exhausted.`);
    const last = this.#getTaskLastAppliedConfiguration(taskId);
    const escalates = last && (
      last.provider !== model?.provider ||
      last.modelId !== model?.id ||
      last.thinkingLevel !== thinkingLevel
    );
    if (
      escalates &&
      this.#getTaskModelOrThinkingEscalationsCount(taskId) >=
        budget.maxModelOrThinkingEscalations
    )
      throw new Error(
        `Task model/thinking escalation budget (${budget.maxModelOrThinkingEscalations}) exhausted.`,
      );
  }

  #failActiveForBudget(active, detail, terminalReason = "budget_exhausted") {
    if (active.budgetFailurePromise) return active.budgetFailurePromise;
    active.budgetFailurePromise = (async () => {
      let retired = false;
      try {
        retired = await this.retireWorker(active.worker, active.workerMetadata);
      } catch {}
      if (this.active !== active || active.stopRequested) return;
      await this.settle(active, {
        success: false,
        result: active.finalAssistant?.result ?? null,
        detail,
        terminalReason,
        checkpoint: false,
      });
      if (!retired && this.active === active) {
        this.markBlocked(active.taskId, active.attemptId, detail);
      }
    })();
    return active.budgetFailurePromise;
  }

  #getTaskStartupFailuresCount(taskId) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts a
         WHERE a.task_id = ? AND a.state IN ('failed', 'orphaned')
         AND a.provider IS NULL`,
      )
      .get(taskId);
    return Number(row?.count ?? 0);
  }

  async processWaitObservation(subscriptionIdOrOptions, options = {}) {
    const id =
      typeof subscriptionIdOrOptions === "string"
        ? subscriptionIdOrOptions
        : subscriptionIdOrOptions?.subscriptionId ??
          subscriptionIdOrOptions?.id ??
          subscriptionIdOrOptions?.waitId;
    const opts =
      typeof subscriptionIdOrOptions === "object" &&
      subscriptionIdOrOptions !== null
        ? { ...subscriptionIdOrOptions, ...options }
        : options;
    return this.reconcileWaitSubscription(id, opts);
  }

  #scheduleWaitReactor() {
    if (!this.waitReactorEnabled || this.closed || !this.db) return;
    if (this.waitReactorTimer) this.waitTimer.clearTimeout(this.waitReactorTimer);
    const clockValue = this.waitClock();
    const currentTime = new Date(clockValue).getTime();
    const next = this.db
      .prepare(`SELECT MIN(next_reconcile_at) AS nextReconcileAt
        FROM wait_subscriptions WHERE status = 'active'`)
      .get()?.nextReconcileAt;
    const nextTime = next ? new Date(next).getTime() : Number.NaN;
    const delay = Number.isFinite(nextTime)
      ? Math.max(0, nextTime - currentTime)
      : WAIT_REACTOR_IDLE_INTERVAL_MS;
    this.waitReactorTimer = this.waitTimer.setTimeout(() => {
      this.waitReactorTimer = null;
      void this.#runWaitReactor();
    }, delay);
    this.waitReactorTimer?.unref?.();
  }

  async #runWaitReactor() {
    if (!this.waitReactorEnabled || this.closed || !this.db) return;
    if (this.waitReactorRunning) {
      this.waitReactorRequested = true;
      return;
    }
    this.waitReactorRunning = true;
    try {
      do {
        this.waitReactorRequested = false;
        await this.reconcileActiveWaits({
          dueOnly: true,
          now: this.waitClock(),
          gitHubAdapter: this.waitObserver ?? this.gitHubAdapter,
          trigger: true,
        }, WAIT_RECONCILE_CAPABILITY);
      } while (this.waitReactorRequested);
    } finally {
      this.waitReactorRunning = false;
      this.#scheduleWaitReactor();
    }
  }

  async startWaitReactor({ observer, skipSpawn = false, model, thinkingLevel } = {}) {
    this.open();
    if (observer) this.waitObserver = observer;
    this.waitReactorEnabled = true;
    try {
      return await this.reconcileActiveWaits({
        now: this.waitClock(),
        gitHubAdapter: this.waitObserver ?? this.gitHubAdapter,
        trigger: true,
        skipSpawn,
        model,
        thinkingLevel,
      }, WAIT_RECONCILE_CAPABILITY);
    } finally {
      this.#scheduleWaitReactor();
    }
  }

  stopWaitReactor() {
    this.waitReactorEnabled = false;
    this.waitReactorRequested = false;
    if (this.waitReactorTimer) this.waitTimer.clearTimeout(this.waitReactorTimer);
    this.waitReactorTimer = null;
  }

  async reconcileActiveWaits(options = {}, capability = null) {
    this.open();
    const dueOnly = options.dueOnly === true;
    const nowValue = options.now ?? this.waitClock();
    const nowTime = new Date(nowValue).getTime();
    const rows = dueOnly
      ? this.db
          .prepare(`SELECT id FROM wait_subscriptions
            WHERE status = 'active' AND
              (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
            ORDER BY created_at, id`)
          .all(new Date(nowTime).toISOString())
      : this.db
          .prepare(
            "SELECT id FROM wait_subscriptions WHERE status = 'active' ORDER BY created_at, id",
          )
          .all();
    const results = [];
    for (const row of rows) {
      try {
        const result = await this.reconcileWaitSubscription(row.id, options, capability);
        if (result) results.push(result);
      } catch (error) {
        results.push({
          subscriptionId: row.id,
          error: {
            code: error.code || "reconciliation_failed",
            message: bounded(error.message, MAX_TASK_DETAIL_LENGTH),
          },
        });
      }
    }
    return results;
  }

  #insertResultDelivery({
    task,
    outcome,
    finalResult = null,
    terminalDetail = null,
    terminalReason = null,
    finalRevision = null,
    finalBranchHead = null,
    evidenceRefs = [],
  }) {
    if (!new Set(["completed", "failed", "cancelled"]).has(outcome))
      return null;
    const boundedResult = finalResult == null
      ? null
      : bounded(finalResult, MAX_TASK_RESULT_LENGTH);
    const boundedDetailValue = terminalDetail == null
      ? null
      : bounded(terminalDetail, MAX_TASK_DETAIL_LENGTH);
    const payload = {
      taskId: task.id,
      objective: task.goal,
      result: boundedResult,
      outcome,
      taskBranch: task.taskBranch,
      finalRevision: finalRevision ?? null,
      finalBranchHead: finalBranchHead ?? null,
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
      terminalReason: terminalReason ?? null,
      terminalDetail: boundedDetailValue,
    };
    const payloadText = JSON.stringify(payload);
    if (Buffer.byteLength(payloadText, "utf8") > MAX_RESULT_PAYLOAD_LENGTH)
      throw new Error("Result payload exceeds its bounded size limit.");
    const payloadDigest = digest(payloadText);
    const id = randomUUID();
    const result = this.db
      .prepare(`INSERT INTO result_deliveries (
        id, task_id, control_version, contract_version, kind, outcome,
        payload, payload_digest, state, created_at
      ) VALUES (?, ?, ?, ?, 'final_result', ?, ?, ?, 'pending', ?)`)
      .run(
        id,
        task.id,
        task.controlVersion ?? COMMITMENT_CONTROL_VERSION,
        task.contractVersion ?? COMMITMENT_CONTRACT_VERSION,
        outcome,
        payloadText,
        payloadDigest,
        now(),
      );
    if (result.changes !== 1)
      throw new Error("Result delivery could not be persisted.");
    return id;
  }

  claimResult(clientInstanceId) {
    this.open();
    const requestedOwner =
      clientInstanceId && typeof clientInstanceId === "object"
        ? clientInstanceId.clientInstanceId ?? clientInstanceId.client_instance_id
        : clientInstanceId;
    if (
      typeof requestedOwner !== "string" ||
      !requestedOwner.trim() ||
      Buffer.byteLength(requestedOwner.trim(), "utf8") > 256 ||
      requestedOwner.includes("\0")
    ) {
      throw Object.assign(
        new Error("result.claim requires a bounded clientInstanceId."),
        { code: "invalid_result_claim" },
      );
    }
    const owner = requestedOwner.trim();
    const claimedAt = resultTimestamp(this.resultClock);
    const claimExpiresAt = new Date(
      Date.parse(claimedAt) + this.resultClaimLeaseMs,
    ).toISOString();
    const claimHandle = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(`${RESULT_SELECT}
          WHERE state = 'pending'
             OR (state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
          ORDER BY created_at, id LIMIT 1`)
        .get(claimedAt);
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const update = this.db
        .prepare(`UPDATE result_deliveries SET state = 'claimed',
          claim_owner = ?, claim_handle = ?, claim_expires_at = ?
          WHERE id = ? AND (
            state = 'pending'
            OR (state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
          )`)
        .run(owner, claimHandle, claimExpiresAt, candidate.id, claimedAt);
      if (update.changes !== 1)
        throw new Error("Result claim was lost before it could be recorded.");
      const claimed = this.db
        .prepare(`${RESULT_SELECT} WHERE id = ?`)
        .get(candidate.id);
      this.db.exec("COMMIT");
      return resultSnapshot(claimed);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  ackResult(resultId, claimHandle) {
    this.open();
    const requestedAck =
      resultId && typeof resultId === "object"
        ? resultId
        : { resultId, claimHandle };
    const requestedResultId = requestedAck.resultId ?? requestedAck.result_id;
    const requestedClaimHandle = requestedAck.claimHandle ?? requestedAck.claim_handle;
    if (
      typeof requestedResultId !== "string" ||
      !requestedResultId.trim() ||
      Buffer.byteLength(requestedResultId.trim(), "utf8") > 256 ||
      requestedResultId.includes("\0") ||
      typeof requestedClaimHandle !== "string" ||
      !requestedClaimHandle.trim() ||
      Buffer.byteLength(requestedClaimHandle.trim(), "utf8") > 256 ||
      requestedClaimHandle.includes("\0")
    ) {
      throw Object.assign(
        new Error("result.ack requires a bounded resultId and claimHandle."),
        { code: "invalid_result_ack" },
      );
    }
    const id = requestedResultId.trim();
    const handle = requestedClaimHandle.trim();
    const ackedAt = resultTimestamp(this.resultClock);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db
        .prepare(`UPDATE result_deliveries SET state = 'acked', acked_at = ?,
          claim_owner = NULL, claim_handle = NULL, claim_expires_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_handle = ?
            AND claim_expires_at IS NOT NULL AND claim_expires_at > ?`)
        .run(ackedAt, id, handle, ackedAt);
      if (update.changes !== 1) {
        const row = this.db
          .prepare("SELECT state, claim_expires_at AS claimExpiresAt FROM result_deliveries WHERE id = ?")
          .get(id);
        if (!row)
          throw Object.assign(new Error("Result was not found."), { code: "result_not_found" });
        throw Object.assign(
          new Error(
            row.state === "acked"
              ? "Result has already been acknowledged."
              : "Result claim is missing, expired, or does not match.",
          ),
          { code: row.state === "acked" ? "result_already_acked" : "result_claim_invalid" },
        );
      }
      const acknowledged = this.db
        .prepare(`${RESULT_SELECT} WHERE id = ?`)
        .get(id);
      this.db.exec("COMMIT");
      return resultSnapshot(acknowledged);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  createWorktree({ repoRoot, baseCommit, taskId }) {
    const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks");
    const worktree = join(root, taskId);
    const branch = `pi-sand/task-${taskId}`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      execFileSync(
        "git",
        ["worktree", "add", "-b", branch, worktree, baseCommit],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { taskBranch: branch, taskWorktree: canonicalPath(worktree) };
    } catch (error) {
      throw new Error(`Task worktree creation failed: ${commandError(error)}`, {
        cause: error,
      });
    }
  }

  hasCapacityConflict() {
    return (
      Boolean(this.active) ||
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM tasks WHERE state IN ('accepted', 'running', 'waiting', 'blocked') LIMIT 1`,
          )
          .get(),
      ) ||
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM attempts WHERE state IN ('starting', 'running', 'orphaned') OR gate_terminated = 0 OR gate_state IN ('running', 'ambiguous') LIMIT 1",
          )
          .get(),
      )
    );
  }

  async createTask({
    goal,
    cwd,
    trusted,
    model,
    thinkingLevel,
    completionContract,
    authority,
    budget,
    returnRoute,
  }) {
    this.ensureSupported();
    if (typeof goal !== "string" || !goal.trim())
      throw new Error("/task requires a goal");
    if (Buffer.byteLength(goal.trim(), "utf8") > MAX_TASK_GOAL_LENGTH)
      throw new Error("/task goal exceeds the bounded size limit.");
    if (trusted !== true)
      throw new Error("/task requires a trusted Pi project.");
    if (!model?.provider || !model?.id)
      throw new Error("/task requires a selected provider and model.");
    if (!thinkingLevel)
      throw new Error("/task requires a selected thinking level.");
    const requestedCompletionContract =
      completionContract ?? defaultCompletionContract(goal.trim());
    localGatesFromContract(requestedCompletionContract);
    const normalizedAuthority = normalizeAuthority(authority);

    const preflight = preflightGitWorkspace(cwd);
    const requestedAuthority = bindRemotePublicationAuthority(
      normalizedAuthority,
      preflight.sourceRepoRoot,
    );
    const compatibility = checkFreshExecutorCompatibility({
      command: this.piCommand,
      cwd: preflight.sourceRepoRoot,
      env: this.workerEnv,
    });
    if (!compatibility.compatible)
      throw new Error("/task requires an installed Pi 0.84.4 executable.");

    this.open();
    if (this.hasCapacityConflict())
      throw new Error(
        "A Fresh Executor is already active or unresolved; v0.3 does not queue Tasks.",
      );
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const timestamp = now();
    const { taskBranch, taskWorktree } = this.createWorktree({
      repoRoot: preflight.sourceRepoRoot,
      baseCommit: preflight.baseCommit,
      taskId,
    });
    const cleanGoal = goal.trim();
    const storedCompletionContract = serialized(requestedCompletionContract, {
      objective: cleanGoal,
    });
    const storedAuthority = serialized(requestedAuthority, DEFAULT_AUTHORITY);
    const normalizedBudget = budget == null ? {} : normalizeBudget(budget);
    const storedBudget = serialized(normalizedBudget, {});
    const storedReturnRoute = serialized(returnRoute, DEFAULT_RETURN_ROUTE);
    let packet;
    try {
      packet = buildTaskPacket({
        taskId,
        attemptNumber: 1,
        goal: cleanGoal,
        taskBranch,
        taskWorktree,
        baseCommit: preflight.baseCommit,
      });
    } catch (error) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", taskWorktree], {
          cwd: preflight.sourceRepoRoot,
          stdio: "ignore",
        });
      } catch {}
      throw error;
    }

    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(`INSERT INTO tasks (
          id, source_repo_root, base_commit, task_branch, task_worktree, goal,
          state, latest_attempt_id, created_at, updated_at, completion_contract,
          contract_version, control_version, authority, budget, return_route,
          accepted_at, final_revision, completion_evidence_ref, terminal_reason
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
        .run(
          taskId,
          preflight.sourceRepoRoot,
          preflight.baseCommit,
          taskBranch,
          taskWorktree,
          cleanGoal,
          attemptId,
          timestamp,
          timestamp,
          storedCompletionContract,
          COMMITMENT_CONTRACT_VERSION,
          COMMITMENT_CONTROL_VERSION,
          storedAuthority,
          storedBudget,
          storedReturnRoute,
          timestamp,
        );
      this.db
        .prepare(`INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated, cause)
        VALUES (?, ?, 1, NULL, NULL, NULL, 'starting', ?, 0, 'initial')`)
        .run(attemptId, taskId, timestamp);
      this.db
        .prepare(`INSERT INTO attempt_runs (
          attempt_id, sequence, kind, control_version, contract_version,
          prompt_digest, state, evidence_refs, started_at
        ) VALUES (?, ?, 'initial', ?, ?, ?, 'pending', '[]', ?)`)
        .run(
          attemptId,
          INITIAL_ATTEMPT_RUN_SEQUENCE,
          COMMITMENT_CONTROL_VERSION,
          COMMITMENT_CONTRACT_VERSION,
          promptDigest(packet),
          timestamp,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      try {
        execFileSync("git", ["worktree", "remove", "--force", taskWorktree], {
          cwd: preflight.sourceRepoRoot,
          stdio: "ignore",
        });
      } catch {}
      throw error;
    }

    const task = {
      id: taskId,
      sourceRepoRoot: preflight.sourceRepoRoot,
      baseCommit: preflight.baseCommit,
      taskBranch,
      taskWorktree,
      goal: cleanGoal,
      contractVersion: COMMITMENT_CONTRACT_VERSION,
      controlVersion: COMMITMENT_CONTROL_VERSION,
    };
    return this.launchAttempt({
      task,
      attemptId,
      number: 1,
      model,
      thinkingLevel,
      packet,
    });
  }

  #recordAttemptWorker(attemptId, worker) {
    const metadata = workerMetadata(worker);
    if (!metadata) return null;
    this.db
      .prepare(`UPDATE attempts SET worker_pid = ?, worker_pgid = ?, worker_start_identity = ?, worker_boot_id = ?, worker_terminated = 0
      WHERE id = ? AND state = 'starting'`)
      .run(
        metadata.workerPid,
        metadata.workerPgid,
        metadata.workerStartIdentity,
        metadata.workerBootId,
        attemptId,
      );
    return metadata;
  }

  #acceptAttemptRun(active, { provider, modelId, thinkingLevel, workerPid, workerPgid }) {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE tasks SET state = 'running', updated_at = ?
          WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
          AND contract_version = ? AND control_version = ?`)
        .run(
          timestamp,
          active.taskId,
          active.attemptId,
          active.contractVersion,
          active.controlVersion,
        );
      this.db
        .prepare(`UPDATE attempts SET state = 'running', provider = ?, model_id = ?,
          thinking_level = ?, applied_provider = ?, applied_model_id = ?,
          applied_thinking_level = ?, worker_pid = ?, worker_pgid = ?,
          worker_start_identity = ?, worker_boot_id = ?
          WHERE id = ? AND state = 'starting'`)
        .run(
          provider,
          modelId,
          thinkingLevel,
          provider,
          modelId,
          thinkingLevel,
          workerPid,
          workerPgid,
          active.workerMetadata?.workerStartIdentity ?? null,
          this.bootId ?? active.workerMetadata?.workerBootId ?? null,
          active.attemptId,
        );
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'accepted'
          WHERE attempt_id = ? AND sequence = ? AND state = 'pending'
          AND control_version = ? AND contract_version = ?`)
        .run(
          active.attemptId,
          active.runSequence,
          active.controlVersion,
          active.contractVersion,
        );
      this.db.exec("COMMIT");
      active.runAccepted = true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #clearAttemptWatchdog(active) {
    if (active?.attemptWatchdogTimer == null) return;
    this.attemptTimer.clearTimeout(active.attemptWatchdogTimer);
    active.attemptWatchdogTimer = null;
  }

  #scheduleAttemptWatchdog(active) {
    this.#clearAttemptWatchdog(active);
    const task = this.#taskRow(active.taskId);
    const attempt = this.db
      .prepare("SELECT started_at AS startedAt FROM attempts WHERE id = ? AND task_id = ?")
      .get(active.attemptId, active.taskId);
    const startedAt = new Date(attempt?.startedAt ?? "").getTime();
    const currentTime = new Date(this.attemptClock()).getTime();
    const budget = normalizeBudget(task?.budget);
    const deadline = startedAt + budget.maxActiveAttemptDurationMs;
    const delay = Number.isFinite(startedAt) && Number.isFinite(currentTime)
      ? Math.max(0, deadline - currentTime)
      : 0;
    active.attemptWatchdogTimer = this.attemptTimer.setTimeout(() => {
      active.attemptWatchdogTimer = null;
      void this.#runAttemptWatchdog(active);
    }, delay);
    active.attemptWatchdogTimer?.unref?.();
  }

  async #runAttemptWatchdog(active) {
    if (this.active !== active || active.stopRequested || active.runSettled) return;
    const task = this.#taskRow(active.taskId);
    const attempt = this.db
      .prepare("SELECT state, started_at AS startedAt FROM attempts WHERE id = ? AND task_id = ?")
      .get(active.attemptId, active.taskId);
    const currentTime = new Date(this.attemptClock()).getTime();
    const startedAt = new Date(attempt?.startedAt ?? "").getTime();
    const budget = normalizeBudget(task?.budget);
    if (
      !attempt ||
      !task ||
      !Number.isFinite(currentTime) ||
      !Number.isFinite(startedAt) ||
      currentTime - startedAt < budget.maxActiveAttemptDurationMs
    ) {
      this.#scheduleAttemptWatchdog(active);
      return;
    }
    if (active.finalizing) {
      active.attemptWatchdogDue = true;
      return;
    }
    await this.#failActiveForBudget(
      active,
      "Task active Attempt duration expired.",
      "external_timeout",
    );
  }

  async launchAttempt({
    task,
    attemptId,
    number,
    model,
    thinkingLevel,
    packet,
    priorState,
    priorDetail,
  }) {
    const taskPacket =
      packet ??
      buildTaskPacket({
        taskId: task.id,
        attemptNumber: number,
        goal: task.goal,
        taskBranch: task.taskBranch,
        taskWorktree: task.taskWorktree,
        baseCommit: task.baseCommit,
        priorState,
        priorDetail,
      });
    const active = {
      taskId: task.id,
      attemptId,
      runSequence: INITIAL_ATTEMPT_RUN_SEQUENCE,
      contractVersion: task.contractVersion ?? COMMITMENT_CONTRACT_VERSION,
      controlVersion: task.controlVersion ?? COMMITMENT_CONTROL_VERSION,
      provider: model.provider,
      modelId: model.id,
      thinkingLevel,
      taskWorktree: task.taskWorktree,
      sourceRepoRoot: task.sourceRepoRoot,
      taskBranch: task.taskBranch,
      baseCommit: task.baseCommit,
      worker: null,
      executionSnapshot: null,
      sessionId: null,
      awaitingAgentStart: false,
      packet: taskPacket,
      finalAssistant: null,
      settled: false,
      runAccepted: false,
      runSettled: false,
      runPromptInFlight: false,
      promptAmbiguous: false,
      ambiguousHandlingPromise: null,
      rpcCoherent: true,
      finalizing: false,
      settlementPromise: null,
      pendingEvents: [],
      pendingClose: null,
      previousRun: null,
      attemptNumber: number,
      stopRequested: false,
      workerMetadata: null,
      gateProcess: null,
      gateCancellation: null,
      attemptWatchdogTimer: null,
      attemptWatchdogDue: false,
      budgetFailurePromise: null,
    };
    this.active = active;
    this.#scheduleAttemptWatchdog(active);
    try {
      assertTaskWorktreeIdentity(task);
      const worker = await this.workerFactory({
        cwd: task.taskWorktree,
        command: this.piCommand,
        env: this.workerEnv,
        provider: model.provider,
        modelId: model.id,
        thinkingLevel,
        taskPrompt: taskPacket,
        onEvent: (event, metadata) => this.handleWorkerEvent(active, event, metadata),
        onClose: (details) => this.handleWorkerClose(active, details),
        workerStopTimeoutMs: this.workerStopTimeoutMs,
        onWorkerSpawn: (worker) => {
          active.workerMetadata = this.#recordAttemptWorker(attemptId, worker);
        },
      });
      if (this.active !== active) {
        await this.retireWorker(worker, workerMetadata(worker));
        return this.getTask(task.id);
      }
      active.worker = worker;
      const workerSnapshot = worker?.executionSnapshot;
      active.executionSnapshot = workerSnapshot
        ? sortedSnapshot(workerSnapshot)
        : {
            cwd: task.taskWorktree,
            provider: model.provider,
            modelId: model.id,
            thinkingLevel,
            sessionId: null,
          };
      const sessionId = worker?.sessionId ?? active.executionSnapshot?.sessionId;
      active.sessionId =
        typeof sessionId === "string" && sessionId.length > 0
          ? sessionId
          : null;
      const metadata = workerMetadata(worker) ?? active.workerMetadata;
      if (metadata) {
        active.workerMetadata =
          this.#recordAttemptWorker(attemptId, metadata) ?? metadata;
      }
      if (
        (worker?.pid != null || worker?.processGroupId != null) &&
        (!active.workerMetadata?.workerStartIdentity ||
          !active.workerMetadata?.workerBootId)
      ) {
        throw new Error(
          "Fresh Executor worker identity metadata is incomplete.",
        );
      }
      const workerPid =
        active.workerMetadata?.workerPid ??
        (Number.isInteger(worker?.pid) ? worker.pid : null);
      const workerPgid =
        active.workerMetadata?.workerPgid ??
        (Number.isInteger(worker?.processGroupId)
          ? worker.processGroupId
          : null);
      this.#acceptAttemptRun(active, {
        provider: model.provider,
        modelId: model.id,
        thinkingLevel,
        workerPid,
        workerPgid,
      });
      // Constructor callbacks are attached by the production Fresh Executor.
      // Its event history covers the prompt response and agent_settled event
      // when both arrive before this startup promise resumes.
      if (!worker?.callbacksAttached) {
        worker?.onEvent?.((event, metadata) => this.handleWorkerEvent(active, event, metadata));
        worker?.onClose?.((details) => this.handleWorkerClose(active, details));
      }
      const replayed = new Set();
      for (const event of Array.isArray(worker?.events) ? worker.events : []) {
        replayed.add(event);
        this.handleWorkerEvent(active, event, { promptAcknowledged: true });
      }
      for (const pending of active.pendingEvents) {
        const event = pending?.event ?? pending;
        if (!replayed.has(event)) this.handleWorkerEvent(active, event, pending?.metadata);
      }
      active.pendingEvents = [];
      // The production Fresh Executor has already accepted its packet before
      // returning. There is intentionally no second prompt-dispatch path here.
      if (active.pendingClose)
        this.handleWorkerClose(active, active.pendingClose);
      active.pendingClose = null;
      return this.getTask(task.id);
    } catch (error) {
      if (this.active === active && !active.finalizing) {
        active.workerMetadata =
          active.workerMetadata ?? workerMetadata(error.workerMetadata);
        if (active.workerMetadata)
          this.#recordAttemptWorker(attemptId, active.workerMetadata);
        await this.settle(active, {
          success: false,
          result: null,
          detail: `Fresh Executor failed before prompt acceptance: ${commandError(error)}`,
          checkpoint: false,
        });
      }
      throw new Error(
        `Fresh Executor failed before prompt acceptance: ${commandError(error)}`,
        { cause: error },
      );
    }
  }

  handleWorkerEvent(active, event, metadata = null) {
    if (this.active !== active || active.runSettled || active.promptAmbiguous) return;
    if (active.budgetFailurePromise) return;
    if (
      active.runPromptInFlight &&
      event?.type !== "session" &&
      event?.type !== "executor_error"
    ) {
      // Buffer the complete in-flight stream. The acknowledgement is the
      // durable boundary; the drain below discards late Run1 output until the
      // first fresh agent_start, even when a test worker supplies no metadata.
      active.pendingEvents.push({ event, metadata });
      return;
    }
    if (active.finalizing) return;
    if (!active.worker) {
      active.pendingEvents.push({ event, metadata });
      return;
    }
    if (event?.type === "session") {
      const sessionId = event.id ?? event.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (active.sessionId && active.sessionId !== sessionId) {
        active.rpcCoherent = false;
        if (active.runPromptInFlight) {
          void this.#handleAmbiguousContinuation(
            active,
            new Error("Fresh Executor session identity changed before continuation acknowledgement."),
          );
        } else {
          void this.settle(active, {
            success: false,
            result: active.finalAssistant?.result ?? null,
            detail: "Fresh Executor session identity changed inside the Attempt.",
            checkpoint: false,
          });
        }
      }
      // A session event is an identity observation only. The authoritative
      // session id is captured from get_state, never learned from the stream.
      return;
    }
    if (event?.type === "executor_error") {
      active.rpcCoherent = false;
      if (active.runPromptInFlight) {
        void this.#handleAmbiguousContinuation(
          active,
          new Error("Fresh Executor RPC lifecycle became incoherent before prompt acknowledgement."),
        );
      } else {
        void this.settle(active, {
          success: false,
          result: active.finalAssistant?.result ?? null,
          detail:
            "Fresh Executor RPC lifecycle became incoherent before settlement.",
          checkpoint: false,
        });
      }
      return;
    }
    if (active.runPromptInFlight) {
      // A response acknowledgement is the only safe point at which a
      // continuation's stream may enter the pending boundary buffer. Events
      // before it may be late output from the already-settled run.
      if (metadata?.promptAcknowledged === true)
        active.pendingEvents.push({ event, metadata });
      return;
    }
    if (!active.runAccepted) {
      if (metadata?.promptAcknowledged === true)
        active.pendingEvents.push({ event, metadata });
      return;
    }
    if (active.awaitingAgentStart) {
      // Pi RPC has no request/run id on ordinary events. The first fresh
      // agent_start after an acknowledged continuation is the only supported
      // boundary; all other pre-boundary output is ignored fail-closed.
      if (
        event?.type !== "agent_start" ||
        metadata?.promptAcknowledged === false
      )
        return;
      active.awaitingAgentStart = false;
    }
    if (event?.type === "agent_start") {
      if (!this.#consumePiTurn(active)) {
        this.#failActiveForBudget(
          active,
          "Task per-Attempt Pi turn budget exhausted.",
        );
        return;
      }
      active.settled = false;
    }
    const outcome = assistantOutcome(event);
    if (outcome) active.finalAssistant = outcome;
    if (event?.type === "agent_settled") active.settled = true;
    if (active.settled && active.finalAssistant && !active.stopRequested) {
      active.settlementPromise ??= this.finishSettled(active);
    }
  }

  handleWorkerClose(active, details) {
    if (
      this.active !== active ||
      active.finalizing ||
      active.runSettled ||
      active.promptAmbiguous ||
      active.stopRequested
    )
      return;
    if (!active.worker) {
      active.pendingClose = details;
      return;
    }
    active.rpcCoherent = false;
    if (active.runPromptInFlight) {
      void this.#handleAmbiguousContinuation(
        active,
        new Error("Fresh Executor closed before continuation prompt acknowledgement."),
      );
      return;
    }
    void this.settle(active, {
      success: false,
      result: active.finalAssistant?.result ?? null,
      detail: "Fresh Executor closed before a healthy settled outcome.",
      checkpoint: false,
    });
  }

  async settleRun(active, outcome) {
    if (
      this.active !== active ||
      active.finalizing ||
      active.stopRequested ||
      !active.rpcCoherent ||
      !active.runAccepted ||
      active.runSettled
    )
      return false;
    try {
      assertTaskWorktreeIdentity(this.getTask(active.taskId));
    } catch (error) {
      await this.settle(active, {
        success: false,
        result: outcome?.result,
        detail: `Task Git finalization failed: ${commandError(error)}`,
        checkpoint: false,
      });
      return false;
    }
    const timestamp = now();
    const settledOutcome = bounded(outcome?.result, MAX_TASK_RESULT_LENGTH);
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(`UPDATE attempt_runs SET state = 'settled', settled_outcome = ?,
          settled_at = ? WHERE attempt_id = ? AND sequence = ? AND state = 'accepted'
          AND control_version = ? AND contract_version = ?
          AND EXISTS (
            SELECT 1 FROM attempts AS a JOIN tasks AS t ON t.id = a.task_id
            WHERE a.id = attempt_runs.attempt_id AND a.id = ?
              AND a.state = 'running' AND t.latest_attempt_id = a.id
              AND t.state IN ('accepted', 'running')
              AND t.control_version = ? AND t.contract_version = ?
          )`)
        .run(
          settledOutcome,
          timestamp,
          active.attemptId,
          active.runSequence,
          active.controlVersion,
          active.contractVersion,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
        );
      this.db.exec("COMMIT");
      active.runSettled = result.changes === 1;
      return active.runSettled;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async settleInitialRun(active, outcome) {
    return this.settleRun(active, outcome);
  }

  async finishSettled(active) {
    if (
      this.active !== active ||
      active.finalizing ||
      active.stopRequested ||
      active.runSettled ||
      !active.rpcCoherent ||
      !active.settled ||
      !active.finalAssistant
    )
      return;
    const outcome = active.finalAssistant;
    const healthy =
      !outcome.hasError &&
      outcome.stopReason !== "error" &&
      outcome.stopReason !== "aborted";
    if (!healthy) {
      await this.settle(active, {
        success: false,
        result: outcome.result,
        detail: `Fresh Executor reported an ${outcome.stopReason || "error"} assistant outcome.`,
        checkpoint: false,
      });
      return;
    }
    const settled = await this.settleInitialRun(active, outcome);
    if (settled) await this.superviseSettled(active, outcome);
  }

  #supervisorState(active) {
    const task = this.#taskRow(active.taskId);
    if (
      !task ||
      !["accepted", "running"].includes(task.state) ||
      task.latestAttemptId !== active.attemptId ||
      task.controlVersion !== active.controlVersion ||
      task.contractVersion !== active.contractVersion
    )
      return null;
    const attempt = this.db
      .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
      .get(active.attemptId, active.taskId);
    const run = this.db
      .prepare(
        `${ATTEMPT_RUN_SELECT} WHERE attempt_id = ? AND sequence = ?`,
      )
      .get(active.attemptId, active.runSequence);
    if (
      !attempt ||
      attempt.state !== "running" ||
      !run ||
      run.state !== "settled" ||
      run.controlVersion !== active.controlVersion ||
      run.contractVersion !== active.contractVersion
    )
      return null;
    return { task, attempt, run };
  }

  #appendEvidence({
    taskId,
    attemptId,
    attemptRunId,
    kind,
    source = "runtime",
    subject,
    payload,
    dedupeKey,
  }) {
    const payloadText = JSON.stringify(payload);
    if (Buffer.byteLength(payloadText, "utf8") > MAX_EVIDENCE_PAYLOAD_LENGTH)
      throw new Error("Evidence payload exceeds its bounded size limit.");
    const id = randomUUID();
    const observedAt = now();
    this.db
      .prepare(`INSERT INTO evidence (
        id, task_id, attempt_id, attempt_run_id, kind, source, subject,
        subject_digest, payload, payload_digest, dedupe_key, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(
        id,
        taskId,
        attemptId,
        attemptRunId,
        kind,
        source,
        subject,
        digest(subject),
        payloadText,
        digest(payloadText),
        dedupeKey,
        observedAt,
      );
    const row = this.db
      .prepare("SELECT id FROM evidence WHERE dedupe_key = ?")
      .get(dedupeKey);
    if (!row) throw new Error("Evidence could not be persisted.");
    return row.id;
  }

  #linkEvidence(active, evidenceIds) {
    if (!evidenceIds.length) return;
    const row = this.db
      .prepare(
        "SELECT evidence_refs AS evidenceRefs FROM attempt_runs WHERE attempt_id = ? AND sequence = ?",
      )
      .get(active.attemptId, active.runSequence);
    const existing = parsed(row?.evidenceRefs, []);
    const refs = Array.isArray(existing) ? existing : [];
    for (const evidenceId of evidenceIds)
      if (!refs.includes(evidenceId)) refs.push(evidenceId);
    this.db
      .prepare(`UPDATE attempt_runs SET evidence_refs = ?
        WHERE attempt_id = ? AND sequence = ? AND state = 'settled'
        AND control_version = ? AND contract_version = ?`)
      .run(
        JSON.stringify(refs),
        active.attemptId,
        active.runSequence,
        active.controlVersion,
        active.contractVersion,
      );
  }

  #candidateIdentity(task, candidateSha) {
    assertTaskWorktreeIdentity(task);
    const branch = git(task.taskWorktree, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const fields = git(task.taskWorktree, [
      "show",
      "--quiet",
      "--format=%H%x00%an%x00%ae%x00%cn%x00%ce",
      candidateSha,
    ]).split("\0");
    if (fields[0] !== candidateSha || branch !== task.taskBranch)
      throw new Error("Task candidate identity changed");
    return {
      candidateSha,
      sourceRepoRoot: task.sourceRepoRoot,
      taskWorktree: task.taskWorktree,
      taskBranch: task.taskBranch,
      branch,
      author: { name: fields[1], email: fields[2] },
      committer: { name: fields[3], email: fields[4] },
    };
  }

  #recordCandidate(active, task, candidateSha) {
    const identity = this.#candidateIdentity(task, candidateSha);
    const timestamp = now();
    const evidencePayload = {
      ...identity,
      observedAt: timestamp,
    };
    const evidenceIds = [];
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(`UPDATE tasks SET final_revision = ?, updated_at = ?
          WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
          AND control_version = ? AND contract_version = ?`)
        .run(
          candidateSha,
          timestamp,
          active.taskId,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
        );
      if (result.changes !== 1)
        throw new Error("Task completion versions are no longer current.");
      evidenceIds.push(
        this.#appendEvidence({
          taskId: active.taskId,
          attemptId: active.attemptId,
          attemptRunId: `${active.attemptId}:${active.runSequence}`,
          kind: "git_identity",
          subject: candidateSha,
          payload: evidencePayload,
          dedupeKey: `git_identity:${active.taskId}:${candidateSha}`,
        }),
      );
      this.#linkEvidence(active, evidenceIds);
      this.db.exec("COMMIT");
      return { identity, evidenceIds };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async #startFreshLocalRepair(active, task, gateResult, candidateSha, evidenceRefs = []) {
    const budget = normalizeBudget(task.budget);
    const attemptsCount = this.#getTaskAttemptsCount(task.id);
    const codeAttemptsCount = this.#getTaskCodeAttemptsCount(task.id);
    const startupFailuresCount = this.#getTaskStartupFailuresCount(task.id);
    if (
      attemptsCount >= budget.maxTotalAttempts ||
      codeAttemptsCount >= budget.maxCodeProducingAttempts ||
      startupFailuresCount >= budget.maxStartupFailures
    )
      return false;

    const nextNumber = attemptsCount + 1;
    const freshAttemptId = randomUUID();
    const repairPrompt = buildRepairPrompt({
      taskId: task.id,
      attemptNumber: nextNumber,
      goal: task.goal,
      taskBranch: task.taskBranch,
      taskWorktree: task.taskWorktree,
      baseCommit: task.baseCommit,
      candidateSha,
      completionContract: parsed(task.completionContract),
      failingGate: gateResult,
      priorFailureDetail: `Local gate '${gateResult.criterion}' failed (${gateResult.exitCategory}, exit code ${gateResult.exitCode}).`,
      remainingBudget: {
        remainingAttempts: Math.max(0, budget.maxTotalAttempts - nextNumber),
        remainingRunsInAttempt: budget.maxPiRunsPerAttempt,
        remainingCiRepairCycles: Math.max(
          0,
          budget.maxCiRepairCycles - this.#getTaskCiRepairsCount(task.id),
        ),
        remainingPublications: Math.max(
          0,
          effectiveMaxPublications(task.authority, budget) -
            Number(task.publicationCount ?? 0),
        ),
      },
    });
    const timestamp = now();
    const repairDetail = `Local gate '${gateResult.criterion}' failed; starting a fresh repair Attempt.`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const freshTask = this.#taskRow(task.id);
      this.#assertFreshAttemptBudget(task.id, {
        provider: active.provider,
        id: active.modelId,
      }, active.thinkingLevel);
      if (
        !freshTask ||
        freshTask.latestAttemptId !== active.attemptId ||
        !["accepted", "running"].includes(freshTask.state) ||
        Number(freshTask.controlVersion) !== Number(active.controlVersion) ||
        Number(freshTask.contractVersion) !== Number(active.contractVersion)
      )
        throw new Error("Task changed before fresh local repair allocation.");

      this.db
        .prepare(`UPDATE attempts SET state = 'failed', finished_at = ?, worker_terminated = 1,
          terminal_detail = ?, final_branch_head = ?
          WHERE id = ? AND task_id = ? AND state = 'running'`)
        .run(
          timestamp,
          repairDetail,
          candidateSha,
          active.attemptId,
          task.id,
        );
      this.db
        .prepare(`INSERT INTO attempts (
          id, task_id, number, provider, model_id, thinking_level, state,
          started_at, worker_terminated, cause
        ) VALUES (?, ?, ?, NULL, NULL, NULL, 'starting', ?, 0, 'repair')`)
        .run(freshAttemptId, task.id, nextNumber, timestamp);
      this.db
        .prepare(`INSERT INTO attempt_runs (
          attempt_id, sequence, kind, control_version, contract_version,
          prompt_digest, state, evidence_refs, started_at
        ) VALUES (?, 1, 'local_repair', ?, ?, ?, 'pending', ?, ?)`)
        .run(
          freshAttemptId,
          active.controlVersion,
          active.contractVersion,
          promptDigest(repairPrompt),
          JSON.stringify(evidenceRefs),
          timestamp,
        );
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = 'running', latest_attempt_id = ?, updated_at = ?
          WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
          AND control_version = ? AND contract_version = ?`)
        .run(
          freshAttemptId,
          timestamp,
          task.id,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
        );
      if (taskUpdate.changes !== 1)
        throw new Error("Task fence rejected fresh local repair allocation.");
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    if (this.active === active) {
      this.#clearAttemptWatchdog(active);
      this.active = null;
    }
    await this.launchAttempt({
      task: {
        id: task.id,
        sourceRepoRoot: task.sourceRepoRoot,
        baseCommit: task.baseCommit,
        taskBranch: task.taskBranch,
        taskWorktree: task.taskWorktree,
        goal: task.goal,
        contractVersion: task.contractVersion,
        controlVersion: task.controlVersion,
      },
      attemptId: freshAttemptId,
      number: nextNumber,
      model: {
        provider: active.provider,
        id: active.modelId,
      },
      thinkingLevel: active.thinkingLevel,
      packet: repairPrompt,
      priorState: "local_gate_failed",
      priorDetail: repairDetail,
    });
    return true;
  }

  #runLocalGate(active, task, candidateSha, gate) {
    const startedAt = now();
    return new Promise((resolve) => {
      let child = null;
      let timer = null;
      let metadata = null;
      let stdout = "";
      let stderr = "";
      let exitCode = null;
      let signal = null;
      let errorDetail = null;
      let timedOut = false;
      let cancelled = false;
      let processTerminated = false;
      let terminationResult = null;
      let settled = false;

      const clearGateReferences = () => {
        if (active.gateCancellation === cancel) active.gateCancellation = null;
        if (active.gateProcess?.child === child) active.gateProcess = null;
      };

      const persistGateState = (state) => {
        try {
          return this.#setGateState(active.attemptId, state);
        } catch {
          return false;
        }
      };

      const terminate = () => {
        if (terminationResult === true) return true;
        if (!metadata) {
          processTerminated = false;
          return false;
        }
        let terminated = false;
        try {
          terminated = stopOwnedProcessGroupSync(metadata, {
            timeoutMs: this.workerStopTimeoutMs,
            currentBootId: this.bootId,
          });
        } catch {
          terminated = false;
        }
        if (terminated && persistGateState("terminated")) {
          terminationResult = true;
          processTerminated = true;
          clearGateReferences();
          return true;
        }
        processTerminated = false;
        return false;
      };

      const finish = ({ code = exitCode, signal: exitSignal = signal, error = null } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        exitCode = code;
        signal = exitSignal;
        if (error)
          errorDetail = bounded(
            typeof error === "string" ? error : commandError(error),
            MAX_TASK_DETAIL_LENGTH,
          );
        if (terminationResult !== true) {
          if (!active.gateProcess && !metadata) {
            processTerminated = true;
          } else {
            const groupStatus = metadata
              ? processGroupStatus(metadata.workerPgid)
              : "unknown";
            const gone =
              groupStatus === "gone" &&
              recordedWorkerIsGone(metadata);
            processTerminated = gone && persistGateState("terminated");
            if (!processTerminated) persistGateState("ambiguous");
          }
        }
        if (processTerminated) clearGateReferences();

        let exitCategory;
        if (!processTerminated)
          exitCategory = timedOut
            ? "timeout_termination_ambiguous"
            : "gate_termination_ambiguous";
        else if (cancelled) exitCategory = "cancelled";
        else if (timedOut) exitCategory = "timeout";
        else if (error) exitCategory = "error";
        else if (signal) exitCategory = "signal";
        else if (exitCode === 0) exitCategory = "passed";
        else exitCategory = "nonzero";

        const finishedAt = now();
        const postCandidateSha = this.currentBranchHead(task.taskWorktree);
        let postStatus = "";
        try {
          postStatus = git(task.taskWorktree, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]);
        } catch {
          postStatus = "<unavailable>";
        }
        if (processTerminated && postCandidateSha !== candidateSha)
          exitCategory = "candidate_changed";
        else if (processTerminated && postStatus)
          exitCategory = "working_tree_changed";
        const resultDigest = digest(
          JSON.stringify({
            candidateSha,
            criterion: gate.id,
            command: gate.command,
            cwd: task.taskWorktree,
            exitCategory,
            exitCode,
            signal,
            error: errorDetail,
            stdout,
            stderr,
            processTerminated,
          }),
        );
        resolve({
          criterion: gate.id,
          command: gate.command,
          cwd: task.taskWorktree,
          candidateSha,
          startedAt,
          finishedAt,
          exitCategory,
          exitCode,
          signal,
          error: errorDetail,
          stdout,
          stderr,
          postCandidateSha,
          postStatus,
          processTerminated,
          resultDigest,
          passed: exitCategory === "passed" && processTerminated,
        });
      };

      const cancel = () => {
        cancelled = true;
        const terminated = terminate();
        if (!terminated && !settled)
          finish({ error: new Error("Local gate process could not be safely terminated.") });
        return terminated;
      };

      try {
        child = spawn(gate.command[0], gate.command.slice(1), {
          cwd: task.taskWorktree,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const childPid = Number(child.pid);
        metadata = workerMetadata({
          pid: childPid,
          processGroupId: childPid,
          workerBootId: this.bootId,
        }) ?? {
          workerPid: Number.isInteger(childPid) && childPid > 0 ? childPid : null,
          workerPgid: Number.isInteger(childPid) && childPid > 0 ? childPid : null,
          workerStartIdentity: processStartIdentity(childPid),
          workerBootId: null,
        };
        active.gateProcess = { child, metadata };
        active.gateCancellation = cancel;
        const identityProven = Boolean(
          Number.isInteger(metadata?.workerPid) &&
            Number.isInteger(metadata?.workerPgid) &&
            metadata.workerStartIdentity &&
            metadata.workerBootId &&
            recordedWorkerIsOwned(metadata, this.bootId),
        );
        let persisted = false;
        try {
          persisted = this.#recordGateProcess(active, metadata, identityProven);
        } catch (error) {
          errorDetail = bounded(commandError(error), MAX_TASK_DETAIL_LENGTH);
        }
        if (!persisted || !identityProven) {
          terminate();
          finish({
            error:
              errorDetail ||
              new Error("Local gate process identity could not be proven or persisted."),
          });
          return;
        }
        child.stdout?.setEncoding?.("utf8");
        child.stderr?.setEncoding?.("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout = appendBounded(stdout, chunk, MAX_EVIDENCE_OUTPUT_LENGTH);
        });
        child.stderr?.on("data", (chunk) => {
          stderr = appendBounded(stderr, chunk, MAX_EVIDENCE_OUTPUT_LENGTH);
        });
        child.once("error", (error) => finish({ error }));
        child.once("close", (code, closeSignal) =>
          finish({ code, signal: closeSignal }),
        );
        timer = setTimeout(() => {
          timedOut = true;
          if (!terminate()) finish();
        }, gate.timeoutMs);
        if (active.stopRequested) cancel();
      } catch (error) {
        finish({ error });
      }
    });
  }

  #recordLocalGateEvidence(active, gateResult) {
    const payload = { ...gateResult };
    delete payload.passed;
    const dedupeKey = `local_gate_result:${active.taskId}:${gateResult.candidateSha}:${gateResult.criterion}:${gateResult.resultDigest}`;
    const existing = this.db
      .prepare("SELECT id FROM evidence WHERE dedupe_key = ?")
      .get(dedupeKey);
    const evidenceId = this.#appendEvidence({
      taskId: active.taskId,
      attemptId: active.attemptId,
      attemptRunId: `${active.attemptId}:${active.runSequence}`,
      kind: "local_gate_result",
      subject: gateResult.candidateSha,
      payload,
      dedupeKey,
    });
    return { evidenceId, isNew: !existing };
  }

  #verificationFailure(
    active,
    {
      state = "failed",
      reason,
      detail,
      observedCandidateSha = null,
      recordedCandidateSha = null,
      finalBranchHead = observedCandidateSha,
      workerTerminated,
      evidenceRefs = null,
    },
  ) {
    this.#clearAttemptWatchdog(active);
    const timestamp = now();
    const finalResult = active.finalAssistant?.result ?? null;
    const revisionFence =
      recordedCandidateSha === null
        ? "AND final_revision IS NULL"
        : "AND final_revision = ?";
    this.db.exec("BEGIN");
    try {
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = ?, updated_at = ?, final_result = ?,
          terminal_detail = ?, final_branch_head = ?, final_revision = COALESCE(final_revision, ?),
          terminal_reason = ?, completion_evidence_ref = NULL
          WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
          AND control_version = ? AND contract_version = ?
          ${revisionFence}`)
        .run(
          state,
          timestamp,
          finalResult,
          bounded(detail, MAX_TASK_DETAIL_LENGTH),
          finalBranchHead,
          recordedCandidateSha,
          reason,
          active.taskId,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
          ...(recordedCandidateSha === null ? [] : [recordedCandidateSha]),
        );
      if (taskUpdate.changes !== 1) {
        this.db.exec("COMMIT");
        return false;
      }
      const attemptUpdate = this.db
        .prepare(`UPDATE attempts SET state = ?, finished_at = ?, worker_terminated = ?,
          final_result = ?, terminal_detail = ?, final_branch_head = ?
          WHERE id = ? AND task_id = ? AND state = 'running'`)
        .run(
          state === "blocked" ? "orphaned" : "failed",
          timestamp,
          workerTerminated ? 1 : 0,
          finalResult,
          bounded(detail, MAX_TASK_DETAIL_LENGTH),
          finalBranchHead,
          active.attemptId,
          active.taskId,
        );
      if (attemptUpdate.changes !== 1) throw new Error("Attempt completion fence rejected verification outcome.");
      if (state === "failed") {
        const taskRow = this.#taskRow(active.taskId);
        const runEvidenceRefs = this.db
          .prepare(`SELECT evidence_refs AS evidenceRefs FROM attempt_runs
            WHERE attempt_id = ? AND sequence = ?`)
          .get(active.attemptId, active.runSequence);
        const deliveryEvidenceRefs = Array.isArray(evidenceRefs)
          ? evidenceRefs
          : parsed(runEvidenceRefs?.evidenceRefs, []);
        const resultId = this.#insertResultDelivery({
          task: taskRow,
          outcome: "failed",
          finalResult,
          terminalDetail: bounded(detail, MAX_TASK_DETAIL_LENGTH),
          terminalReason: reason,
          finalRevision: taskRow?.finalRevision ?? recordedCandidateSha,
          finalBranchHead,
          evidenceRefs: deliveryEvidenceRefs,
        });
        if (!resultId) throw new Error("Failed Task did not produce a Result delivery.");
      }
      this.db.exec("COMMIT");
      if (this.active === active && !active.gateProcess) this.active = null;
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #completeVerified(active, candidateSha, evidenceIds) {
    const timestamp = now();
    const finalResult = active.finalAssistant?.result ?? null;
    const completionEvidenceRef = JSON.stringify(evidenceIds);
    this.db.exec("BEGIN");
    try {
      const taskUpdate = this.db
        .prepare(`UPDATE tasks SET state = 'completed', updated_at = ?, final_result = ?,
          terminal_detail = ?, final_branch_head = ?, final_revision = ?,
          completion_evidence_ref = ?, terminal_reason = ?
          WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
          AND control_version = ? AND contract_version = ? AND final_revision = ?`)
        .run(
          timestamp,
          finalResult,
          "Task completed after all required local gates passed.",
          candidateSha,
          candidateSha,
          completionEvidenceRef,
          "verified_local",
          active.taskId,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
          candidateSha,
        );
      if (taskUpdate.changes !== 1) {
        this.db.exec("COMMIT");
        return false;
      }
      const attemptUpdate = this.db
        .prepare(`UPDATE attempts SET state = 'completed', finished_at = ?, worker_terminated = 1,
          final_result = ?, terminal_detail = ?, final_branch_head = ?
          WHERE id = ? AND task_id = ? AND state = 'running' AND gate_terminated = 1`)
        .run(
          timestamp,
          finalResult,
          "Task completed after all required local gates passed.",
          candidateSha,
          active.attemptId,
          active.taskId,
        );
      if (attemptUpdate.changes !== 1) throw new Error("Attempt completion fence rejected verified outcome.");
      const runUpdate = this.db
        .prepare(`UPDATE attempt_runs SET evidence_refs = ?
          WHERE attempt_id = ? AND sequence = ? AND state = 'settled'
          AND control_version = ? AND contract_version = ?`)
        .run(
          completionEvidenceRef,
          active.attemptId,
          active.runSequence,
          active.controlVersion,
          active.contractVersion,
        );
      if (runUpdate.changes !== 1) throw new Error("AttemptRun completion fence rejected verified outcome.");
      const resultId = this.#insertResultDelivery({
        task: this.#taskRow(active.taskId),
        outcome: "completed",
        finalResult,
        terminalDetail: "Task completed after all required local gates passed.",
        terminalReason: "verified_local",
        finalRevision: candidateSha,
        finalBranchHead: candidateSha,
        evidenceRefs: evidenceIds,
      });
      if (!resultId) throw new Error("Completed Task did not produce a Result delivery.");
      this.db.exec("COMMIT");
      if (this.active === active) {
        this.#clearAttemptWatchdog(active);
        this.active = null;
      }
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async superviseSettled(active) {
    if (this.active !== active || active.stopRequested || active.finalizing) return;
    active.finalizing = true;
    let observedCandidateSha = null;
    let recordedCandidateSha = null;
    let candidateEvidenceIds = [];
    let localGateEvidenceIds = [];
    try {
      const current = this.#supervisorState(active);
      if (!current) return;
      const task = current.task;
      const budget = normalizeBudget(task.budget);
      const attemptStartedAt = new Date(current.attempt.startedAt).getTime();
      const attemptNow = new Date(this.attemptClock()).getTime();
      if (
        Number.isFinite(attemptStartedAt) &&
        Number.isFinite(attemptNow) &&
        attemptNow - attemptStartedAt >= budget.maxActiveAttemptDurationMs
      ) {
        const retired = await this.retireWorker(active.worker, active.workerMetadata);
        if (this.active !== active || active.stopRequested) return;
        this.#verificationFailure(active, {
          state: retired ? "failed" : "blocked",
          reason: retired ? "external_timeout" : "worker_retirement_ambiguous",
          detail: retired
            ? "Task active Attempt duration expired."
            : "Task active Attempt duration expired and the Fresh Executor could not be safely retired.",
          workerTerminated: retired,
        });
        return;
      }
      const completionContract = parsed(task.completionContract);
      const gates = localGatesFromContract(completionContract);
      // A contract without an explicit local criterion remains under the
      // #50 Supervisor seam; it must not turn executor prose into completion.
      if (gates.length === 0) return;
      assertTaskWorktreeIdentity(task);
      const initialStatus = git(task.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (initialStatus) {
        if (parsed(task.completionContract)?.allowResidualChanges === false)
          throw new Error("Task residual changes are not allowed by its completion contract.");
        this.checkpoint(task, active);
      }
      const fencedBeforeCandidate = this.#supervisorState(active);
      if (!fencedBeforeCandidate) return;
      assertTaskWorktreeIdentity(fencedBeforeCandidate.task);
      const cleanStatus = git(task.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (cleanStatus)
        throw new Error("Task worktree remained dirty after checkpoint.");
      observedCandidateSha = this.currentBranchHead(task.taskWorktree);
      if (!/^[0-9a-f]{40}$/i.test(observedCandidateSha ?? ""))
        throw new Error("Exact Task candidate commit SHA is unavailable.");
      const candidate = this.#recordCandidate(
        active,
        task,
        observedCandidateSha,
      );
      candidateEvidenceIds = candidate.evidenceIds;
      recordedCandidateSha = candidate.identity.candidateSha;
      for (const gate of gates) {
        if (!this.#supervisorState(active) || active.stopRequested) return;
        let gateEvidenceIsNew = false;
        const gateResult = await this.#runLocalGate(
          active,
          task,
          recordedCandidateSha,
          gate,
        );

        if (this.active !== active || !this.#supervisorState(active) || active.stopRequested)
          return;
        this.db.exec("BEGIN");
        try {
          const gateEvidence = this.#recordLocalGateEvidence(active, gateResult);
          gateEvidenceIsNew = gateEvidence.isNew;
          localGateEvidenceIds.push(gateEvidence.evidenceId);
          this.#linkEvidence(active, [gateEvidence.evidenceId]);
          this.db.exec("COMMIT");
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {}
          throw error;
        }
        if (!gateResult.passed) {
          const gateRetired =
            gateResult.processTerminated === true ||
            this.#cancelLocalGate(active);
          if (gateResult.processTerminated !== true || !gateRetired) {
            const retired = await this.retireWorker(
              active.worker,
              active.workerMetadata,
            );
            if (this.active !== active || active.stopRequested) return;
            this.#verificationFailure(active, {
              state: "blocked",
              reason: "gate_termination_ambiguous",
              detail: "Required local gate failed and its process could not be safely retired.",
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: retired,
            });
            return;
          }

          // Evaluate failure fingerprint against budget
          const fp = localGateFailureFingerprint({
            candidateSha: recordedCandidateSha,
            criterion: gateResult.criterion,
            exitCategory: gateResult.exitCategory,
            exitCode: gateResult.exitCode,
            stderr: gateResult.stderr,
            error: gateResult.error,
          });
          const history = this.#getTaskLocalGateFailureHistory(task.id);
          let consecutiveCount = 0;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].fingerprint === fp) consecutiveCount++;
            else break;
          }
          let noProgressIterations = 0;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].candidateSha === recordedCandidateSha) noProgressIterations++;
            else break;
          }

          const nowTime = new Date(this.attemptClock()).getTime();
          const acceptedTime = new Date(task.acceptedAt || task.createdAt).getTime();
          const wallClockDuration = nowTime - acceptedTime;

          if (wallClockDuration >= budget.totalCommitmentWallClockDeadlineMs) {
            const retired = await this.retireWorker(active.worker, active.workerMetadata);
            if (this.active !== active || active.stopRequested) return;
            this.#verificationFailure(active, {
              reason: "external_timeout",
              detail: "Task total commitment wall-clock deadline expired.",
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead: gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: retired,
            });
            return;
          }

          if (
            consecutiveCount + (gateEvidenceIsNew ? 0 : 1) >= budget.maxSameFailureFingerprint ||
            noProgressIterations + (gateEvidenceIsNew ? 0 : 1) >= budget.maxNoProgressSupervisorIterations
          ) {
            const retired = await this.retireWorker(active.worker, active.workerMetadata);
            if (this.active !== active || active.stopRequested) return;
            this.#verificationFailure(active, {
              reason: "stalled",
              detail: `Task local repair stalled on repeated failure fingerprint (${gateResult.criterion}).`,
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead: gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: retired,
            });
            return;
          }

          // Check if current worker is healthy & eligible for same-attempt re-prompt (#53)
          let canRepairSameAttempt = false;
          try {
            if (
              active.worker &&
              typeof active.worker.prompt === "function" &&
              active.runSequence < budget.maxPiRunsPerAttempt &&
              !active.stopRequested &&
              active.rpcCoherent &&
              !active.promptAmbiguous &&
              typeof active.sessionId === "string" &&
              active.sessionId.length > 0 &&
              snapshotsEqual(active.executionSnapshot, active.worker.executionSnapshot) &&
              (!active.workerMetadata || (
                processGroupStatus(active.workerMetadata.workerPgid) === "alive" &&
                recordedWorkerIsOwned(active.workerMetadata, this.bootId)
              ))
            ) {
              canRepairSameAttempt = true;
            }
          } catch {
            canRepairSameAttempt = false;
          }

          if (canRepairSameAttempt) {
            const attemptsCount = this.#getTaskAttemptsCount(task.id);
            const ciRepairsCount = this.#getTaskCiRepairsCount(task.id);
            const maxPubs = effectiveMaxPublications(task.authority, budget);
            const remainingBudget = {
              remainingRunsInAttempt: Math.max(0, budget.maxPiRunsPerAttempt - (active.runSequence + 1)),
              remainingAttempts: Math.max(0, budget.maxTotalAttempts - attemptsCount),
              remainingCiRepairCycles: Math.max(0, budget.maxCiRepairCycles - ciRepairsCount),
              remainingPublications: Math.max(0, maxPubs - (task.publicationCount ?? 0)),
            };

            const repairPrompt = buildRepairPrompt({
              taskId: task.id,
              attemptNumber: active.attemptNumber,
              goal: task.goal,
              taskBranch: task.taskBranch,
              taskWorktree: task.taskWorktree,
              baseCommit: task.baseCommit,
              candidateSha: recordedCandidateSha,
              completionContract: parsed(task.completionContract),
              failingGate: gateResult,
              priorFailureDetail: `Local gate '${gateResult.criterion}' failed (${gateResult.exitCategory}, exit code ${gateResult.exitCode}).`,
              remainingBudget,
            });

            const nextSequence = active.runSequence + 1;
            this.#allocateContinuationRun(active, repairPrompt, nextSequence, "local_repair");
            let acknowledgement;
            let rejectedSameAttemptRepair = false;
            try {
              acknowledgement = await active.worker.prompt(repairPrompt);
            } catch (error) {
              if (error?.code === "PROMPT_REJECTED") {
                // A known rejection is not ambiguous, but it is still a repair
                // failure. Retire this worker and use the fresh-Attempt path
                // below rather than leaving the Task running on the restored
                // settled run forever.
                this.#abortContinuationRun(active, error.message);
                rejectedSameAttemptRepair = true;
              } else {
                await this.#handleAmbiguousContinuation(active, error);
                return;
              }
            }

            const ackStatus = rejectedSameAttemptRepair
              ? "rejected"
              : continuationAcknowledgementStatus(acknowledgement);
            if (ackStatus === "accepted") {
              if (this.#acceptContinuationRun(active, nextSequence)) {
                // The old supervisor owns finalization while the prompt is in
                // flight. Release that boundary before draining events so a
                // same-turn agent_start/message_end/agent_settled sequence can
                // schedule the new run's settlement.
                active.finalizing = false;
                const pending = active.pendingEvents;
                active.pendingEvents = [];
                for (const item of pending)
                  this.handleWorkerEvent(active, item?.event ?? item, item?.metadata);
                active.previousRun = null;
                return;
              }
            } else if (ackStatus === "rejected") {
              if (!rejectedSameAttemptRepair)
                this.#abortContinuationRun(active, "Fresh Executor rejected the repair prompt.");
            } else {
              await this.#handleAmbiguousContinuation(
                active,
                new Error("Fresh Executor repair prompt acknowledgement was not explicit."),
              );
              return;
            }
          }

          const retired = await this.retireWorker(
            active.worker,
            active.workerMetadata,
          );
          if (this.active !== active || active.stopRequested) return;
          if (!retired) {
            this.#verificationFailure(active, {
              state: "blocked",
              reason: "worker_retirement_ambiguous",
              detail: "Required local gate failed and the Fresh Executor could not be safely retired.",
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: false,
            });
            return;
          }
          const attemptsCount = this.#getTaskAttemptsCount(task.id);
          const codeAttemptsCount = this.#getTaskCodeAttemptsCount(task.id);
          const startupFailuresCount = this.#getTaskStartupFailuresCount(task.id);
          const freshRepairEligible =
            !["working_tree_changed", "candidate_changed"].includes(
              gateResult.exitCategory,
            );
          if (!freshRepairEligible) {
            this.#verificationFailure(active, {
              reason: "local_gate_failed",
              detail: `Required local gate failed: ${gateResult.criterion} (${gateResult.exitCategory}).`,
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: true,
            });
            return;
          }
          if (
            attemptsCount >= budget.maxTotalAttempts ||
            codeAttemptsCount >= budget.maxCodeProducingAttempts ||
            startupFailuresCount >= budget.maxStartupFailures
          ) {
            let detail = `Task startup failure budget (${budget.maxStartupFailures}) exhausted.`;
            if (attemptsCount >= budget.maxTotalAttempts)
              detail = `Task total attempt budget (${budget.maxTotalAttempts}) exhausted.`;
            else if (codeAttemptsCount >= budget.maxCodeProducingAttempts)
              detail = `Task code-producing attempt budget (${budget.maxCodeProducingAttempts}) exhausted.`;
            this.#verificationFailure(active, {
              reason: "budget_exhausted",
              detail,
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: true,
            });
            return;
          }
          const freshRepairStarted = await this.#startFreshLocalRepair(
            active,
            task,
            gateResult,
            recordedCandidateSha,
            [...candidateEvidenceIds, ...localGateEvidenceIds],
          );
          if (!freshRepairStarted) {
            this.#verificationFailure(active, {
              reason: "budget_exhausted",
              detail: `Task fresh repair Attempt budget is exhausted.`,
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: true,
            });
          }
          return;
        }
      }
      if (this.active !== active || !this.#supervisorState(active) || active.stopRequested)
        return;
      assertTaskWorktreeIdentity(task);
      if (this.currentBranchHead(task.taskWorktree) !== recordedCandidateSha)
        throw new Error("Task candidate commit changed during local verification.");
      const finalStatus = git(task.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (finalStatus)
        throw new Error("Task worktree changed during local verification.");

      const acceptedAt = new Date(task.acceptedAt || task.createdAt).getTime();
      const commitmentNow = new Date(this.attemptClock()).getTime();
      if (
        Number.isFinite(acceptedAt) &&
        Number.isFinite(commitmentNow) &&
        commitmentNow - acceptedAt >= budget.totalCommitmentWallClockDeadlineMs
      ) {
        const retired = await this.retireWorker(active.worker, active.workerMetadata);
        if (this.active !== active || active.stopRequested) return;
        this.#verificationFailure(active, {
          state: retired ? "failed" : "blocked",
          reason: retired ? "external_timeout" : "worker_retirement_ambiguous",
          detail: retired
            ? "Task total commitment wall-clock deadline expired."
            : "Task total commitment wall-clock deadline expired and the Fresh Executor could not be safely retired.",
          observedCandidateSha,
          recordedCandidateSha,
          workerTerminated: retired,
        });
        return;
      }

      // A local pass is only a rung in the ladder when the accepted contract
      // also requires remote CI. Publish this exact candidate and park the
      // Task on an exact-SHA wait; never emit verified_local in that case.
      const requiredChecks = requiredChecksFromContract(completionContract);
      if (requiredChecks.length > 0) {
        await this.publishTask({ id: task.id, candidateSha: recordedCandidateSha });
        await this.registerWaitSubscription({
          taskId: task.id,
          revisionSha: recordedCandidateSha,
          requiredChecks,
          acceptedConclusions: acceptedConclusionsFromContract(completionContract),
        });
        return;
      }

      const retired = await this.retireWorker(
        active.worker,
        active.workerMetadata,
      );
      if (this.active !== active || active.stopRequested) return;
      if (!retired) {
        this.#verificationFailure(active, {
          state: "blocked",
          reason: "worker_retirement_ambiguous",
          detail: "Required local gates passed but the Fresh Executor could not be safely retired.",
          observedCandidateSha,
          recordedCandidateSha,
          workerTerminated: false,
        });
        return;
      }
      this.#completeVerified(active, recordedCandidateSha, [
        ...candidateEvidenceIds,
        ...localGateEvidenceIds,
      ]);
    } catch (error) {
      if (this.active !== active || active.stopRequested) return;
      let retired = false;
      try {
        retired = await this.retireWorker(active.worker, active.workerMetadata);
      } catch {}
      if (this.active !== active || active.stopRequested) return;
      try {
        this.#verificationFailure(active, {
          state: retired ? "failed" : "blocked",
          reason: retired ? "local_verification_failed" : "worker_retirement_ambiguous",
          detail: `Task local verification failed: ${commandError(error)}`,
          observedCandidateSha,
          recordedCandidateSha,
          workerTerminated: retired,
        });
      } catch (failureError) {
        // If the terminal Result write itself fails, keep completion and
        // delivery all-or-nothing and fence the retained worktree closed.
        if (this.active === active && !active.stopRequested) {
          try {
            this.markBlocked(
              active.taskId,
              active.attemptId,
              `Task terminal Result could not be persisted: ${commandError(failureError)}`,
            );
          } catch {}
          this.active = null;
        }
      }
    } finally {
      const watchdogDue = active.attemptWatchdogDue;
      active.attemptWatchdogDue = false;
      active.finalizing = false;
      if (watchdogDue && this.active === active && !active.stopRequested)
        void this.#failActiveForBudget(
          active,
          "Task active Attempt duration expired.",
          "external_timeout",
        );
    }
  }

  #currentWorkerIsSafe(active, task) {
    if (!active.worker || !active.rpcCoherent || active.promptAmbiguous)
      throw new Error("Fresh Executor Attempt is not healthy/current.");
    if (
      task.taskWorktree !== active.taskWorktree ||
      task.sourceRepoRoot !== active.sourceRepoRoot ||
      task.taskBranch !== active.taskBranch ||
      task.baseCommit !== active.baseCommit
    )
      throw new Error("Task worktree/environment identity changed.");
    const recorded = active.workerMetadata;
    if (recorded) {
      if (processGroupStatus(recorded.workerPgid) !== "alive")
        throw new Error("Fresh Executor process identity is no longer alive.");
      if (!recordedWorkerIsOwned(recorded, this.bootId))
        throw new Error("Fresh Executor process ownership is no longer proven.");
      const durable = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ? AND task_id = ?`)
        .get(active.attemptId, active.taskId);
      if (
        !durable ||
        durable.workerPid !== recorded.workerPid ||
        durable.workerPgid !== recorded.workerPgid ||
        durable.workerStartIdentity !== recorded.workerStartIdentity ||
        durable.workerBootId !== recorded.workerBootId ||
        durable.provider !== active.provider ||
        durable.modelId !== active.modelId ||
        durable.thinkingLevel !== active.thinkingLevel
      )
        throw new Error("Fresh Executor process/model identity changed.");
    }
    if (typeof active.sessionId !== "string" || active.sessionId.length === 0)
      throw new Error("Fresh Executor session identity is unavailable; reuse is refused.");
    if (active.worker.sessionIdentityChanged === true)
      throw new Error("Fresh Executor session identity changed.");
    const capturedSnapshot = active.executionSnapshot;
    const currentSnapshot = active.worker.executionSnapshot;
    if (
      !capturedSnapshot ||
      typeof capturedSnapshot !== "object" ||
      Array.isArray(capturedSnapshot) ||
      !currentSnapshot ||
      typeof currentSnapshot !== "object" ||
      Array.isArray(currentSnapshot)
    )
      throw new Error("Fresh Executor session/capability snapshot is unavailable; reuse is refused.");
    if (
      typeof capturedSnapshot.sessionId !== "string" ||
      capturedSnapshot.sessionId.length === 0 ||
      typeof currentSnapshot.sessionId !== "string" ||
      currentSnapshot.sessionId.length === 0
    )
      throw new Error("Fresh Executor session identity snapshot is unavailable; reuse is refused.");
    if (
      capturedSnapshot.sessionId !== active.sessionId ||
      currentSnapshot.sessionId !== active.sessionId
    )
      throw new Error("Fresh Executor session identity changed.");
    const currentSessionId = active.worker.sessionId ?? currentSnapshot.sessionId;
    if (
      typeof currentSessionId !== "string" ||
      currentSessionId.length === 0 ||
      currentSessionId !== active.sessionId
    )
      throw new Error("Fresh Executor session identity changed.");
    if (!snapshotsEqual(capturedSnapshot, currentSnapshot))
      throw new Error("Fresh Executor capability/environment snapshot changed.");
  }

  #assertContinuationSafe(active, options) {
    if (
      this.active !== active ||
      active.stopRequested ||
      active.promptAmbiguous ||
      active.runPromptInFlight ||
      !active.runAccepted ||
      !active.runSettled ||
      !active.settled ||
      !active.rpcCoherent
    )
      throw new Error("Fresh Executor Attempt is not eligible for a continuation prompt.");
    const current = this.#supervisorState(active);
    if (!current)
      throw new Error("Fresh Executor Attempt is stale or its versions are no longer current.");
    const { task } = current;
    assertTaskWorktreeIdentity(task);
    this.#currentWorkerIsSafe(active, task);
    const requestedModel = options.model ?? (
      options.provider || options.modelId
        ? { provider: options.provider, id: options.modelId }
        : null
    );
    if (
      requestedModel &&
      (requestedModel.provider !== active.provider || requestedModel.id !== active.modelId)
    )
      throw new Error("Fresh Executor model identity changed; the Attempt cannot be reused.");
    if (options.thinkingLevel != null && options.thinkingLevel !== active.thinkingLevel)
      throw new Error("Fresh Executor thinking level changed; the Attempt cannot be reused.");
    const requestedControlVersion = options.controlVersion ?? options.control_version;
    if (
      requestedControlVersion != null &&
      Number(requestedControlVersion) !== Number(active.controlVersion)
    )
      throw new Error("Fresh Executor control version is no longer current.");
    const requestedContractVersion = options.contractVersion ?? options.contract_version;
    if (
      requestedContractVersion != null &&
      Number(requestedContractVersion) !== Number(active.contractVersion)
    )
      throw new Error("Fresh Executor contract version is no longer current.");
    const requestedCapabilities =
      options.capabilitySnapshot ?? options.capabilities ?? options.capabilityPolicy;
    const currentCapabilities =
      active.executionSnapshot?.capabilities ?? active.worker.capabilitySnapshot;
    if (
      requestedCapabilities !== undefined &&
      !snapshotsEqual(requestedCapabilities, currentCapabilities)
    )
      throw new Error("Fresh Executor capability snapshot changed; the Attempt cannot be reused.");
    const requestedEnvironment =
      options.environmentSnapshot ??
      options.environmentGeneration ??
      options.environment;
    const currentEnvironment =
      active.executionSnapshot?.environment ??
      active.executionSnapshot?.environmentGeneration ??
      active.worker.environmentSnapshot ??
      active.worker.environmentGeneration;
    if (
      requestedEnvironment !== undefined &&
      !snapshotsEqual(requestedEnvironment, currentEnvironment)
    )
      throw new Error("Task worktree/environment generation changed; the Attempt cannot be reused.");
    const requestedWorktree = options.taskWorktree ?? options.worktree;
    if (
      requestedWorktree != null &&
      requestedWorktree !== task.taskWorktree
    )
      throw new Error("Task worktree/environment identity changed.");
    const latestRun = this.db
      .prepare("SELECT MAX(sequence) AS sequence FROM attempt_runs WHERE attempt_id = ?")
      .get(active.attemptId);
    const nextSequence = Number(latestRun?.sequence ?? current.run.sequence) + 1;
    if (nextSequence > attemptRunLimit(task))
      throw new Error("Fresh Executor Attempt run budget is exhausted.");
    if (typeof options.prompt !== "string" || !options.prompt.trim())
      throw new Error("Continuation prompt is required.");
    if (Buffer.byteLength(options.prompt, "utf8") > MAX_CONTINUATION_PROMPT_LENGTH)
      throw new Error("Continuation prompt exceeds the bounded size limit.");
    if (typeof active.worker.prompt !== "function")
      throw new Error("Fresh Executor does not expose an acknowledged continuation prompt.");
    return { task, current, nextSequence };
  }

  #allocateContinuationRun(active, prompt, sequence, kind = "continue") {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      const current = this.#supervisorState(active);
      const latestRun = this.db
        .prepare("SELECT MAX(sequence) AS sequence FROM attempt_runs WHERE attempt_id = ?")
        .get(active.attemptId);
      if (!current || Number(latestRun?.sequence ?? 0) + 1 !== sequence)
        throw new Error("Fresh Executor Attempt changed before continuation allocation.");
      this.db
        .prepare(`INSERT INTO attempt_runs (
          attempt_id, sequence, kind, control_version, contract_version,
          prompt_digest, state, evidence_refs, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', ?)`)
        .run(
          active.attemptId,
          sequence,
          kind,
          active.controlVersion,
          active.contractVersion,
          promptDigest(prompt),
          timestamp,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    active.previousRun = {
      runSequence: active.runSequence,
      finalAssistant: active.finalAssistant,
      settled: active.settled,
      awaitingAgentStart: active.awaitingAgentStart,
      runAccepted: active.runAccepted,
      runSettled: active.runSettled,
    };
    active.runSequence = sequence;
    active.runPromptInFlight = true;
    active.runAccepted = false;
    active.runSettled = false;
    active.settled = false;
    active.finalAssistant = null;
    active.settlementPromise = null;
    active.pendingEvents = [];
  }

  #acceptContinuationRun(active, sequence) {
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(`UPDATE attempt_runs SET state = 'accepted'
          WHERE attempt_id = ? AND sequence = ? AND state = 'pending'
          AND control_version = ? AND contract_version = ?
          AND EXISTS (
            SELECT 1 FROM attempts AS a JOIN tasks AS t ON t.id = a.task_id
            WHERE a.id = attempt_runs.attempt_id AND a.id = ?
              AND a.state = 'running' AND t.latest_attempt_id = a.id
              AND t.state IN ('accepted', 'running')
              AND t.control_version = ? AND t.contract_version = ?
          )`)
        .run(
          active.attemptId,
          sequence,
          active.controlVersion,
          active.contractVersion,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
        );
      this.db.exec("COMMIT");
      if (result.changes !== 1) return false;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    active.runPromptInFlight = false;
    active.runAccepted = true;
    // The acknowledgement only proves prompt acceptance. Ordinary Pi events
    // have no run id, so a fresh agent_start must open the new run before any
    // buffered message_end or agent_settled can be observed.
    active.awaitingAgentStart = true;
    return true;
  }

  #restorePreviousRun(active) {
    const previous = active.previousRun;
    if (!previous) return;
    active.runSequence = previous.runSequence;
    active.finalAssistant = previous.finalAssistant;
    active.settled = previous.settled;
    active.awaitingAgentStart = previous.awaitingAgentStart;
    active.runAccepted = previous.runAccepted;
    active.runSettled = previous.runSettled;
    active.runPromptInFlight = false;
    active.settlementPromise = null;
    active.pendingEvents = [];
    active.previousRun = null;
  }

  #abortContinuationRun(active, detail) {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'aborted', settled_outcome = ?, settled_at = ?
          WHERE attempt_id = ? AND sequence = ? AND state = 'pending'`)
        .run(boundedDetail(detail), timestamp, active.attemptId, active.runSequence);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    this.#restorePreviousRun(active);
  }

  async #handleAmbiguousContinuation(active, error) {
    if (active.ambiguousHandlingPromise) return active.ambiguousHandlingPromise;
    active.ambiguousHandlingPromise = (async () => {
      active.promptAmbiguous = true;
      active.runPromptInFlight = false;
      active.rpcCoherent = false;
      const detail = boundedDetail(
        `Fresh Executor continuation prompt outcome is ambiguous; it was not replayed: ${commandError(error)}`,
      );
      let retired = false;
      try {
        retired = await this.retireWorker(active.worker, active.workerMetadata);
      } catch {}
      if (this.active !== active) return;
      const timestamp = now();
      const finalResult = active.previousRun?.finalAssistant?.result ?? null;
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(`UPDATE attempt_runs SET state = 'ambiguous', settled_outcome = COALESCE(settled_outcome, ?), settled_at = COALESCE(settled_at, ?)
            WHERE attempt_id = ? AND sequence = ? AND state = 'pending'`)
          .run(detail, timestamp, active.attemptId, active.runSequence);
        this.db
          .prepare(`UPDATE attempts SET state = ?, finished_at = ?, worker_terminated = ?, final_result = ?, terminal_detail = ?
            WHERE id = ? AND task_id = ? AND state = 'running'`)
          .run(
            retired ? "failed" : "orphaned",
            timestamp,
            retired ? 1 : 0,
            finalResult,
            detail,
            active.attemptId,
            active.taskId,
          );
        const taskUpdate = this.db
          .prepare(`UPDATE tasks SET state = ?, updated_at = ?, final_result = ?, terminal_detail = ?, terminal_reason = ?
            WHERE id = ? AND latest_attempt_id = ? AND state IN ('accepted', 'running')
              AND control_version = ? AND contract_version = ?`)
          .run(
            retired ? "failed" : "blocked",
            timestamp,
            finalResult,
            detail,
            "continuation_prompt_ambiguous",
            active.taskId,
            active.attemptId,
            active.controlVersion,
            active.contractVersion,
          );
        if (taskUpdate.changes === 1 && retired) {
          const resultId = this.#insertResultDelivery({
            task: this.#taskRow(active.taskId),
            outcome: "failed",
            finalResult,
            terminalDetail: detail,
            terminalReason: "continuation_prompt_ambiguous",
          });
          if (!resultId) throw new Error("Failed Task did not produce a Result delivery.");
        }
        this.db.exec("COMMIT");
      } catch (transactionError) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw transactionError;
      }
      this.#clearAttemptWatchdog(active);
      this.active = null;
    })();
    try {
      await active.ambiguousHandlingPromise;
    } finally {
      active.ambiguousHandlingPromise = null;
    }
  }

  /** Request one explicitly supervised continuation in the current Attempt. */
  async continueAttempt(options = {}) {
    const id = options.id ?? options.taskId;
    if (typeof id !== "string" || !id.trim())
      throw new Error("Continuation requires a Task id.");
    if (this.active?.finalizing && this.active.settlementPromise) {
      await this.active.settlementPromise.catch(() => {});
    }
    const active = this.active;
    if (!active || active.taskId !== id.trim())
      throw new Error("Fresh Executor Attempt is not eligible for a continuation prompt.");
    this.open();
    const prompt = options.prompt ?? options.message;
    const { task, nextSequence } = this.#assertContinuationSafe(active, {
      ...options,
      prompt,
    });
    this.#allocateContinuationRun(active, prompt, nextSequence);
    try {
      this.#currentWorkerIsSafe(active, task);
    } catch (error) {
      this.#abortContinuationRun(active, error.message);
      throw error;
    }
    let acknowledgement;
    try {
      acknowledgement = await active.worker.prompt(prompt);
    } catch (error) {
      if (error?.code === "PROMPT_REJECTED") {
        this.#abortContinuationRun(active, error.message);
      } else {
        await this.#handleAmbiguousContinuation(active, error);
      }
      throw error;
    }
    const acknowledgementStatus =
      continuationAcknowledgementStatus(acknowledgement);
    if (acknowledgementStatus === "rejected") {
      const rejection = Object.assign(
        new Error("Fresh Executor rejected the continuation prompt."),
        { code: "PROMPT_REJECTED", phase: "prompt" },
      );
      this.#abortContinuationRun(active, rejection.message);
      throw rejection;
    }
    if (acknowledgementStatus !== "accepted") {
      const ambiguous = new Error(
        "Fresh Executor continuation prompt acknowledgement was not explicit; transmission outcome is ambiguous and will not be replayed.",
      );
      ambiguous.code = "PROMPT_ACKNOWLEDGEMENT_AMBIGUOUS";
      ambiguous.phase = "prompt";
      await this.#handleAmbiguousContinuation(active, ambiguous);
      throw ambiguous;
    }
    const promptBoundary = continuationBoundary(acknowledgement);
    if (
      promptBoundary !== null &&
      (!Number.isInteger(promptBoundary) || promptBoundary !== nextSequence)
    ) {
      const mismatch = new Error("Fresh Executor prompt acknowledgement was not correlated to the allocated AttemptRun.");
      mismatch.code = "RPC_CORRELATION_FAILED";
      await this.#handleAmbiguousContinuation(active, mismatch);
      throw mismatch;
    }
    if (!this.#acceptContinuationRun(active, nextSequence)) {
      const stale = new Error("Fresh Executor continuation acknowledgement arrived after the Attempt versions changed.");
      stale.code = "STALE_ATTEMPT";
      await this.#handleAmbiguousContinuation(active, stale);
      throw stale;
    }
    active.finalizing = false;
    const pending = active.pendingEvents;
    active.pendingEvents = [];
    for (const item of pending)
      this.handleWorkerEvent(active, item?.event ?? item, item?.metadata);
    active.previousRun = null;
    return this.getTask(id.trim());
  }

  #cancelLocalGate(active) {
    if (!active?.gateCancellation) return true;
    try {
      return active.gateCancellation();
    } catch {
      return false;
    }
  }

  async retireWorker(worker, metadata) {
    const recorded = metadata ?? workerMetadata(worker);
    if (!worker && !recorded) return true;
    if (!recorded) return !worker.pid && !worker.processGroupId;
    if (recordedWorkerIsGone(recorded)) return true;
    // Preserve #42's zero-timeout retirement boundary: it deliberately keeps
    // an unretired worker fenced instead of escalating immediately to KILL.
    if (this.workerRetireTimeoutMs === 0) return false;
    return stopOwnedProcessGroupSync(recorded, {
      timeoutMs: this.workerRetireTimeoutMs,
      currentBootId: this.bootId,
    });
  }

  currentBranchHead(taskWorktree) {
    try {
      return git(taskWorktree, ["rev-parse", "HEAD"]);
    } catch {
      return null;
    }
  }

  checkpoint(task, active) {
    assertTaskWorktreeIdentity(task);
    const worktree = task.taskWorktree;
    const dirty = git(worktree, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (dirty) {
      execFileSync("git", ["add", "-A"], {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(
        "git",
        ["commit", "-m", `pi-sand: checkpoint completed Task ${active.taskId}`],
        {
          cwd: worktree,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "pi-sand",
            GIT_AUTHOR_EMAIL: "pi-sand@localhost",
            GIT_COMMITTER_NAME: "pi-sand",
            GIT_COMMITTER_EMAIL: "pi-sand@localhost",
          },
        },
      );
    }
    return git(worktree, ["rev-parse", "HEAD"]);
  }

  async settle(
    active,
    { success, result, detail, checkpoint, terminalReason = null },
  ) {
    if (this.active !== active || active.finalizing) return;
    active.finalizing = true;
    this.#clearAttemptWatchdog(active);
    const task = this.getTask(active.taskId);
    if (!task) return;
    const finalResult =
      result == null ? null : bounded(result, MAX_TASK_RESULT_LENGTH);
    let finalDetail = bounded(detail, MAX_TASK_DETAIL_LENGTH);
    let finalBranchHead = null;
    let terminalState = success ? "completed" : "failed";
    let attemptState = terminalState;

    try {
      assertTaskWorktreeIdentity(task);
      finalBranchHead = this.currentBranchHead(task.taskWorktree);
      if (success && checkpoint)
        finalBranchHead = this.checkpoint(task, active);
    } catch (error) {
      terminalState = "failed";
      attemptState = "failed";
      finalDetail = bounded(
        `Task Git finalization failed: ${commandError(error)}`,
        MAX_TASK_DETAIL_LENGTH,
      );
    }

    const retired = await this.retireWorker(
      active.worker,
      active.workerMetadata,
    );
    if (this.active !== active || active.stopRequested) {
      active.finalizing = false;
      return;
    }
    if (!retired) {
      terminalState = "blocked";
      attemptState = "orphaned";
      finalDetail = bounded(
        `${finalDetail} Fresh Executor could not be safely retired; executor capacity remains blocked.`,
        MAX_TASK_DETAIL_LENGTH,
      );
    }

    const timestamp = now();
    let runState = "ambiguous";
    if (retired)
      runState =
        active.runAccepted && active.settled && active.finalAssistant
          ? "settled"
          : "aborted";
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE tasks SET state = ?, updated_at = ?, final_result = ?, terminal_detail = ?,
          final_branch_head = ?, final_revision = ?, terminal_reason = ? WHERE id = ?`,
        )
        .run(
          terminalState,
          timestamp,
          finalResult,
          finalDetail,
          finalBranchHead,
          finalBranchHead,
          terminalReason ?? finalDetail,
          active.taskId,
        );
      this.db
        .prepare(
          `UPDATE attempts SET state = ?, finished_at = ?, worker_terminated = ?, final_result = ?, terminal_detail = ?, final_branch_head = ? WHERE id = ?`,
        )
        .run(
          attemptState,
          timestamp,
          retired ? 1 : 0,
          finalResult,
          finalDetail,
          finalBranchHead,
          active.attemptId,
        );
      this.db
        .prepare(`UPDATE attempt_runs SET state = ?, settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND sequence = ?
          AND state IN ('pending', 'accepted')`)
        .run(
          runState,
          finalResult,
          timestamp,
          active.attemptId,
          active.runSequence,
        );
      const outcome = ["completed", "failed"].includes(terminalState)
        ? terminalState
        : null;
      if (outcome) {
        const resultId = this.#insertResultDelivery({
          task: this.#taskRow(active.taskId),
          outcome,
          finalResult,
          terminalDetail: finalDetail,
          terminalReason: terminalReason ?? finalDetail,
          finalRevision: finalBranchHead,
          finalBranchHead,
        });
        if (!resultId) throw new Error("Terminal Task did not produce a Result delivery.");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      active.finalizing = false;
      throw error;
    }
    if (retired) this.active = null;
  }

  async terminateOwnedWorker(worker) {
    return stopOwnedProcessGroupSync(worker, {
      timeoutMs: this.workerStopTimeoutMs,
      currentBootId: this.bootId,
    });
  }

  markBlocked(taskId, attemptId, detail) {
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE attempts SET state = 'orphaned', finished_at = ?, terminal_detail = ?, worker_terminated = 0 WHERE id = ? AND state IN ('starting', 'running', 'parked_wait', 'failed', 'stopped', 'interrupted')",
        )
        .run(timestamp, boundedDetail(detail), attemptId);
      this.db
        .prepare(
          "UPDATE tasks SET state = 'blocked', updated_at = ?, terminal_detail = ?, terminal_reason = ? WHERE id = ? AND state IN ('accepted', 'running', 'waiting', 'failed', 'stopped', 'interrupted')",
        )
        .run(timestamp, boundedDetail(detail), boundedDetail(detail), taskId);
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'ambiguous', settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND state IN ('pending', 'accepted')`)
        .run(boundedDetail(detail), timestamp, attemptId);
      this.db
        .prepare("UPDATE wait_subscriptions SET status = 'cancelled' WHERE task_id = ? AND status = 'active'")
        .run(taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    if (
      this.active?.attemptId === attemptId &&
      !this.active.gateProcess
    )
      this.active = null;
  }

  async stopTask(id) {
    this.ensureSupported();
    if (typeof id !== "string" || !id.trim())
      throw new Error("/task-stop requires a Task id");
    this.open();
    const task = this.getTask(id.trim());
    if (!task) throw new Error(`Task ${id} was not found.`);
    if (!["accepted", "running", "waiting"].includes(task.state))
      throw new Error(
        `Task ${id} is already terminal (${task.state}); it is not active.`,
      );
    const attempt = task.attempts.find(
      ({ id: attemptId }) => attemptId === task.latestAttemptId,
    );
    if (!attempt || (!ACTIVE_ATTEMPT_STATES.has(attempt.state) && attempt.state !== "parked_wait"))
      throw new Error(`Task ${id} has no active Attempt to stop.`);
    const worker = attempt;
    const active =
      this.active?.attemptId === attempt.id ? this.active : null;
    if (active) active.stopRequested = true;
    const gateStopped = active
      ? this.#cancelLocalGate(active)
      : this.#reconcileGate(attempt) !== "ambiguous";
    const stopped = attempt.state === "parked_wait" && attempt.workerTerminated
      ? true
      : await this.terminateOwnedWorker(worker);
    if (!stopped || !gateStopped) {
      const detail = !gateStopped
        ? `Task ${id} local gate could not be safely terminated; ownership or group liveness was not proven.`
        : `Task ${id} worker could not be safely terminated; ownership or group liveness was not proven.`;
      this.markBlocked(task.id, attempt.id, detail);
      throw new Error(
        `${detail} No stopped outcome was recorded.`,
      );
    }
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      const taskUpdate = this.db
        .prepare(
          "UPDATE tasks SET state = 'stopped', terminal_detail = ?, terminal_reason = ?, updated_at = ? WHERE id = ? AND state IN ('accepted', 'running', 'waiting')",
        )
        .run(
          "The Task was intentionally stopped by the user.",
          "user_stopped",
          timestamp,
          task.id,
        );
      if (taskUpdate.changes === 1) {
        const attemptUpdate = this.db
          .prepare(
            "UPDATE attempts SET state = 'stopped', finished_at = ?, worker_terminated = 1, terminal_detail = ? WHERE id = ? AND state IN ('starting', 'running', 'parked_wait') AND gate_terminated = 1",
          )
          .run(
            timestamp,
            "The Task was intentionally stopped by the user.",
            attempt.id,
          );
        if (attemptUpdate.changes !== 1)
          throw new Error("Stopped Task Attempt transition was not recorded.");
        this.db
          .prepare(`UPDATE attempt_runs SET state = 'aborted', settled_outcome = COALESCE(settled_outcome, ?),
            settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND state IN ('pending', 'accepted')`)
          .run(
            "The Task was intentionally stopped by the user.",
            timestamp,
            attempt.id,
          );
        this.db
          .prepare("UPDATE wait_subscriptions SET status = 'cancelled' WHERE task_id = ? AND status = 'active'")
          .run(task.id);
        const resultId = this.#insertResultDelivery({
          task: this.#taskRow(task.id),
          outcome: "cancelled",
          terminalDetail: "The Task was intentionally stopped by the user.",
          terminalReason: "user_stopped",
        });
        if (!resultId) throw new Error("Stopped Task did not produce a Result delivery.");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    if (this.active?.attemptId === attempt.id) this.active = null;
    return this.getTask(task.id);
  }

  async retryTask({ id, trusted, model, thinkingLevel }) {
    this.ensureSupported();
    if (typeof id !== "string" || !id.trim())
      throw new Error("/task-retry requires a Task id");
    if (trusted !== true)
      throw new Error("/task-retry requires a trusted Pi project.");
    if (!model?.provider || !model?.id)
      throw new Error("/task-retry requires a selected provider and model.");
    if (!thinkingLevel)
      throw new Error("/task-retry requires a selected thinking level.");
    this.open();
    const task = this.getTask(id.trim());
    if (!task) throw new Error(`Task ${id} was not found.`);
    if (!RETRYABLE_TASK_STATES.has(task.state))
      throw new Error(
        `Task ${id} is ${task.state} and cannot be retried in v0.3.`,
      );
    if (this.hasCapacityConflict())
      throw new Error(
        "A Fresh Executor is already active; v0.3 does not queue Tasks.",
      );
    try {
      assertTaskWorktreeIdentity(task);
    } catch (error) {
      throw new Error(
        `Task ${id} worktree or branch identity is unavailable; retry was not started.`,
        { cause: error },
      );
    }
    const prior = task.attempts.find(
      ({ id: attemptId }) => attemptId === task.latestAttemptId,
    );
    if (!prior || !RETRYABLE_TASK_STATES.has(prior.state))
      throw new Error(`Task ${id} previous Attempt is not terminal.`);
    if (
      prior.workerTerminated !== true &&
      !(
        (prior.workerPid == null && prior.workerPgid == null) ||
        recordedWorkerIsGone(prior)
      )
    ) {
      if (!(await this.terminateOwnedWorker(prior))) {
        this.markBlocked(
          task.id,
          prior.id,
          `Task ${id} previous worker is not safely gone; retry was not started.`,
        );
        throw new Error(
          `Task ${id} previous worker is not safely gone; retry was not started.`,
        );
      }
    }
    this.#assertFreshAttemptBudget(task.id, model, thinkingLevel);
    const compatibility = checkFreshExecutorCompatibility({
      command: this.piCommand,
      cwd: task.taskWorktree,
      env: this.workerEnv,
    });
    if (!compatibility.compatible)
      throw new Error(
        "/task-retry requires an installed Pi 0.84.4 executable.",
      );
    const attemptId = randomUUID();
    const number = prior.number + 1;
    const retryTask = {
      id: task.id,
      sourceRepoRoot: task.sourceRepoRoot,
      baseCommit: task.baseCommit,
      taskBranch: task.taskBranch,
      taskWorktree: task.taskWorktree,
      goal: task.goal,
      contractVersion: task.contractVersion ?? COMMITMENT_CONTRACT_VERSION,
      controlVersion: task.controlVersion ?? COMMITMENT_CONTROL_VERSION,
    };
    const retryPacket = buildTaskPacket({
      taskId: retryTask.id,
      attemptNumber: number,
      goal: retryTask.goal,
      taskBranch: retryTask.taskBranch,
      taskWorktree: retryTask.taskWorktree,
      baseCommit: retryTask.baseCommit,
      priorState: prior.state,
      priorDetail: prior.terminalDetail,
    });
    const timestamp = now();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.#assertFreshAttemptBudget(task.id, model, thinkingLevel);
      this.db
        .prepare(
          "INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated, cause) VALUES (?, ?, ?, NULL, NULL, NULL, 'starting', ?, 0, 'retry')",
        )
        .run(attemptId, task.id, number, timestamp);
      this.db
        .prepare(`INSERT INTO attempt_runs (
          attempt_id, sequence, kind, control_version, contract_version,
          prompt_digest, state, evidence_refs, started_at
        ) VALUES (?, ?, 'initial', ?, ?, ?, 'pending', '[]', ?)`)
        .run(
          attemptId,
          INITIAL_ATTEMPT_RUN_SEQUENCE,
          retryTask.controlVersion,
          retryTask.contractVersion,
          promptDigest(retryPacket),
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE tasks SET state = 'accepted', latest_attempt_id = ?, terminal_detail = NULL,
          final_result = NULL, final_branch_head = NULL, final_revision = NULL,
          completion_evidence_ref = NULL, terminal_reason = NULL, updated_at = ?
          WHERE id = ? AND state IN ('failed', 'stopped', 'interrupted')`,
        )
        .run(attemptId, timestamp, task.id);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return this.launchAttempt({
      task: retryTask,
      attemptId,
      number,
      model,
      thinkingLevel,
      packet: retryPacket,
      priorState: prior.state,
      priorDetail: prior.terminalDetail,
    });
  }

  /** Stop the active daemon-owned worker before releasing DB/socket ownership. */
  async shutdown(reason = DAEMON_SHUTDOWN_REASON) {
    this.open();
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const active = this.active;
    if (active) {
      active.stopRequested = true;
      this.#clearAttemptWatchdog(active);
      let gateStopped = this.#cancelLocalGate(active);
      const attempt = this.db
        .prepare(`${ATTEMPT_SELECT} WHERE id = ?`)
        .get(active.attemptId);
      if (attempt && !gateStopped)
        gateStopped = this.#reconcileGate(attempt) !== "ambiguous";
      let outcome =
        attempt && ["starting", "running"].includes(attempt.state)
          ? this.reconcileAttempt(attempt, { reason })
          : "orphaned";
      if (attempt && !gateStopped) {
        this.#markGateBlocked(attempt, { reason });
        outcome = "orphaned";
      }
      // FreshExecutor.close() is itself a signal operation. Never invoke it
      // after an uncertain ownership result; the orphan path leaves durable
      // metadata and any surviving worker untouched for next startup.
      this.active = null;
      return outcome;
    }
    // This also handles a graceful boundary after the in-memory handle was
    // lost: reconcile durable metadata rather than declaring capacity free.
    this.reconcilePriorGates({ reason });
    this.reconcilePriorAttempts({ reason });
  }

  release() {
    if (this.closed) return;
    this.stopWaitReactor();
    const active = this.active;
    try {
      if (active) {
        active.stopRequested = true;
        this.#clearAttemptWatchdog(active);
        this.#cancelLocalGate(active);
      }
      // A direct release is also a durable ownership boundary. Reconcile any
      // gate whose in-memory callback was already lost before closing the DB.
      if (this.db) this.reconcilePriorGates({ reason: "release" });
    } catch {}
    this.closed = true;
    try {
      active?.worker?.close?.();
    } catch {}
    this.active = null;
    try {
      this.db?.close();
    } finally {
      this.db = null;
      try {
        this.databaseLock?.release();
      } finally {
        this.databaseLock = null;
      }
    }
  }

  close() {
    this.release();
  }
}

export class TaskRuntime extends RuntimeStore {}

export {
  linuxBootIdentity,
  processGroupIdentity,
  processGroupIsAlive,
  processStartIdentity,
  recordedWorkerIsGone,
  recordedWorkerIsOwned,
};
