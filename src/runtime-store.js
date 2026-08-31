import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
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
export const WORKER_STOP_TIMEOUT_MS = 2_000;
export const COMMITMENT_CONTRACT_VERSION = 1;
export const COMMITMENT_CONTROL_VERSION = 1;
const INITIAL_ATTEMPT_RUN_SEQUENCE = 1;
const ACTIVE_ATTEMPT_STATES = new Set(["starting", "running"]);
const ACTIVE_GATE_STATES = new Set(["running", "ambiguous"]);
const RETRYABLE_TASK_STATES = new Set(["failed", "stopped", "interrupted"]);
const WORKER_RETIRE_TIMEOUT_MS = 2_000;
const now = () => new Date().toISOString();
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
const DEFAULT_AUTHORITY = { owner: "pi-sandd" };
const DEFAULT_BUDGET = {};
const DEFAULT_RETURN_ROUTE = { kind: "manager" };
const TASK_SELECT = `SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit,
  task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state,
  latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt,
  final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead,
  shutdown_reason AS shutdownReason, completion_contract AS completionContract,
  contract_version AS contractVersion, control_version AS controlVersion, authority,
  budget, return_route AS returnRoute, accepted_at AS acceptedAt,
  final_revision AS finalRevision, completion_evidence_ref AS completionEvidenceRef,
  terminal_reason AS terminalReason
  FROM tasks`;
const ATTEMPT_SELECT = `SELECT id, task_id AS taskId, number, applied_provider AS provider, applied_model_id AS modelId,
  applied_thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt,
  worker_pid AS workerPid, worker_pgid AS workerPgid, worker_terminated AS workerTerminated,
  worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId,
  gate_pid AS gatePid, gate_pgid AS gatePgid, gate_start_identity AS gateStartIdentity,
  gate_boot_id AS gateBootId, gate_state AS gateState, gate_terminated AS gateTerminated,
  final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead,
  shutdown_reason AS shutdownReason
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

function defaultCompletionContract(goal) {
  return { objective: goal };
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
    gatePid: row.gatePid ?? null,
    gatePgid: row.gatePgid ?? null,
    gateStartIdentity: row.gateStartIdentity ?? null,
    gateBootId: row.gateBootId ?? null,
    gateState:
      row.gateState ?? (row.gateTerminated === 1 ? "none" : "ambiguous"),
    gateTerminated: row.gateTerminated === 1,
    attemptRuns,
  };
}

function taskSnapshot(row, attempts = [], evidence = []) {
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
    evidence,
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
            gate_pid INTEGER, gate_pgid INTEGER, gate_start_identity TEXT, gate_boot_id TEXT,
            gate_state TEXT NOT NULL DEFAULT 'none' CHECK(gate_state IN ('none', 'running', 'terminated', 'ambiguous')),
            gate_terminated INTEGER NOT NULL DEFAULT 1,
            final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT,
            applied_provider TEXT, applied_model_id TEXT, applied_thinking_level TEXT,
            UNIQUE(task_id, number)
          );
          INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at,
            finished_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated,
            gate_pid, gate_pgid, gate_start_identity, gate_boot_id, gate_state, gate_terminated,
            final_result, terminal_detail, final_branch_head, shutdown_reason, applied_provider,
            applied_model_id, applied_thinking_level)
          SELECT id, task_id, number, provider, model_id, thinking_level, state, started_at,
            finished_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated,
            gate_pid, gate_pgid, gate_start_identity, gate_boot_id, gate_state, gate_terminated,
            final_result, terminal_detail, final_branch_head, shutdown_reason, applied_provider,
            applied_model_id, applied_thinking_level
          FROM attempts_legacy;
          DROP TABLE attempts_legacy;
          CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);`);
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
          JSON.stringify(DEFAULT_BUDGET),
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
          completion_evidence_ref TEXT, terminal_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
          provider TEXT, model_id TEXT, thinking_level TEXT, state TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
          worker_start_identity TEXT, worker_boot_id TEXT,
          worker_terminated INTEGER NOT NULL DEFAULT 1,
          gate_pid INTEGER, gate_pgid INTEGER, gate_start_identity TEXT, gate_boot_id TEXT,
          gate_state TEXT NOT NULL DEFAULT 'none' CHECK(gate_state IN ('none', 'running', 'terminated', 'ambiguous')),
          gate_terminated INTEGER NOT NULL DEFAULT 1,
          final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT,
          applied_provider TEXT, applied_model_id TEXT, applied_thinking_level TEXT,
          UNIQUE(task_id, number)
        );
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
        CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);`);
      this.ensureCompletionColumns();
      this.ensureCommitmentColumns();
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
      END;`);
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
      this.db
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
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  reconcileAttempt(attempt, { reason = null } = {}) {
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
    return taskSnapshot(row, attempts, evidence);
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
            `SELECT 1 FROM tasks WHERE state IN ('accepted', 'running', 'blocked') LIMIT 1`,
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

    const preflight = preflightGitWorkspace(cwd);
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
    const storedAuthority = serialized(authority, DEFAULT_AUTHORITY);
    const storedBudget = serialized(budget, DEFAULT_BUDGET);
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
        .prepare(`INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated)
        VALUES (?, ?, 1, NULL, NULL, NULL, 'starting', ?, 0)`)
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
      worker: null,
      packet: taskPacket,
      finalAssistant: null,
      settled: false,
      runAccepted: false,
      runSettled: false,
      rpcCoherent: true,
      finalizing: false,
      settlementPromise: null,
      pendingEvents: [],
      pendingClose: null,
      stopRequested: false,
      workerMetadata: null,
      gateProcess: null,
      gateCancellation: null,
    };
    this.active = active;
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
        onEvent: (event) => this.handleWorkerEvent(active, event),
        onClose: (details) => this.handleWorkerClose(active, details),
        workerStopTimeoutMs: this.workerStopTimeoutMs,
        onWorkerSpawn: (worker) => {
          active.workerMetadata = this.#recordAttemptWorker(attemptId, worker);
        },
      });
      if (this.active !== active) return this.getTask(task.id);
      active.worker = worker;
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
        worker?.onEvent?.((event) => this.handleWorkerEvent(active, event));
        worker?.onClose?.((details) => this.handleWorkerClose(active, details));
      }
      const replayed = new Set();
      for (const event of Array.isArray(worker?.events) ? worker.events : []) {
        replayed.add(event);
        this.handleWorkerEvent(active, event);
      }
      for (const event of active.pendingEvents) {
        if (!replayed.has(event)) this.handleWorkerEvent(active, event);
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

  handleWorkerEvent(active, event) {
    if (this.active !== active || active.finalizing || active.runSettled) return;
    if (!active.worker) {
      active.pendingEvents.push(event);
      return;
    }
    if (event?.type === "executor_error") {
      active.rpcCoherent = false;
      void this.settle(active, {
        success: false,
        result: active.finalAssistant?.result ?? null,
        detail:
          "Fresh Executor RPC lifecycle became incoherent before settlement.",
        checkpoint: false,
      });
      return;
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
      active.stopRequested
    )
      return;
    if (!active.worker) {
      active.pendingClose = details;
      return;
    }
    active.rpcCoherent = false;
    void this.settle(active, {
      success: false,
      result: active.finalAssistant?.result ?? null,
      detail: "Fresh Executor closed before a healthy settled outcome.",
      checkpoint: false,
    });
  }

  async settleInitialRun(active, outcome) {
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
          AND control_version = ? AND contract_version = ?
          AND (final_revision IS NULL OR final_revision = ?)`)
        .run(
          candidateSha,
          timestamp,
          active.taskId,
          active.attemptId,
          active.controlVersion,
          active.contractVersion,
          candidateSha,
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
          dedupeKey: `git_identity:${active.taskId}:${active.attemptId}:${active.runSequence}:${candidateSha}`,
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
    const evidenceId = this.#appendEvidence({
      taskId: active.taskId,
      attemptId: active.attemptId,
      attemptRunId: `${active.attemptId}:${active.runSequence}`,
      kind: "local_gate_result",
      subject: gateResult.candidateSha,
      payload,
      dedupeKey: `local_gate_result:${active.taskId}:${active.attemptId}:${active.runSequence}:${gateResult.candidateSha}:${gateResult.criterion}`,
    });
    return evidenceId;
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
    },
  ) {
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
      this.db.exec("COMMIT");
      if (this.active === active) this.active = null;
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
      const gates = localGatesFromContract(parsed(task.completionContract));
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
          const evidenceId = this.#recordLocalGateEvidence(active, gateResult);
          localGateEvidenceIds.push(evidenceId);
          this.#linkEvidence(active, [evidenceId]);
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
          const retired = await this.retireWorker(
            active.worker,
            active.workerMetadata,
          );
          if (this.active !== active || active.stopRequested) return;
          if (!retired || !gateRetired || gateResult.processTerminated !== true) {
            this.#verificationFailure(active, {
              state: "blocked",
              reason:
                gateResult.processTerminated !== true
                  ? "gate_termination_ambiguous"
                  : "worker_retirement_ambiguous",
              detail:
                gateResult.processTerminated !== true
                  ? "Required local gate failed and its process could not be safely retired."
                  : "Required local gate failed and the Fresh Executor could not be safely retired.",
              observedCandidateSha,
              recordedCandidateSha,
              finalBranchHead:
                gateResult.postCandidateSha ?? recordedCandidateSha,
              workerTerminated: false,
            });
            return;
          }
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
      this.#verificationFailure(active, {
        state: retired ? "failed" : "blocked",
        reason: retired ? "local_verification_failed" : "worker_retirement_ambiguous",
        detail: `Task local verification failed: ${commandError(error)}`,
        observedCandidateSha,
        recordedCandidateSha,
        workerTerminated: retired,
      });
    } finally {
      active.finalizing = false;
    }
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

  async settle(active, { success, result, detail, checkpoint }) {
    if (this.active !== active || active.finalizing) return;
    active.finalizing = true;
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
    if (retired) runState = active.runAccepted ? "settled" : "aborted";
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
          finalDetail,
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
          "UPDATE attempts SET state = 'orphaned', finished_at = ?, terminal_detail = ? WHERE id = ? AND state IN ('starting', 'running', 'failed', 'stopped', 'interrupted')",
        )
        .run(timestamp, boundedDetail(detail), attemptId);
      this.db
        .prepare(
          "UPDATE tasks SET state = 'blocked', updated_at = ?, terminal_detail = ?, terminal_reason = ? WHERE id = ? AND state IN ('accepted', 'running', 'failed', 'stopped', 'interrupted')",
        )
        .run(timestamp, boundedDetail(detail), boundedDetail(detail), taskId);
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'ambiguous', settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND state IN ('pending', 'accepted')`)
        .run(boundedDetail(detail), timestamp, attemptId);
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
    if (!["accepted", "running"].includes(task.state))
      throw new Error(
        `Task ${id} is already terminal (${task.state}); it is not active.`,
      );
    const attempt = task.attempts.find(
      ({ id: attemptId }) => attemptId === task.latestAttemptId,
    );
    if (!attempt || !ACTIVE_ATTEMPT_STATES.has(attempt.state))
      throw new Error(`Task ${id} has no active Attempt to stop.`);
    const worker = attempt;
    const active =
      this.active?.attemptId === attempt.id ? this.active : null;
    if (active) active.stopRequested = true;
    const gateStopped = active
      ? this.#cancelLocalGate(active)
      : this.#reconcileGate(attempt) !== "ambiguous";
    const stopped = await this.terminateOwnedWorker(worker);
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
      this.db
        .prepare(
          "UPDATE attempts SET state = 'stopped', finished_at = ?, worker_terminated = 1, terminal_detail = ? WHERE id = ? AND state IN ('starting', 'running') AND gate_terminated = 1",
        )
        .run(
          timestamp,
          "The Task was intentionally stopped by the user.",
          attempt.id,
        );
      this.db
        .prepare(
          "UPDATE tasks SET state = 'stopped', terminal_detail = ?, terminal_reason = ?, updated_at = ? WHERE id = ? AND state IN ('accepted', 'running')",
        )
        .run(
          "The Task was intentionally stopped by the user.",
          "user_stopped",
          timestamp,
          task.id,
        );
      this.db
        .prepare(`UPDATE attempt_runs SET state = 'aborted', settled_outcome = COALESCE(settled_outcome, ?),
          settled_at = COALESCE(settled_at, ?) WHERE attempt_id = ? AND state IN ('pending', 'accepted')`)
        .run(
          "The Task was intentionally stopped by the user.",
          timestamp,
          attempt.id,
        );
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
      this.db.exec("BEGIN");
      this.db
        .prepare(
          "INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated) VALUES (?, ?, ?, NULL, NULL, NULL, 'starting', ?, 0)",
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
    const active = this.active;
    try {
      if (active) {
        active.stopRequested = true;
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
