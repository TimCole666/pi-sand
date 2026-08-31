import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { processGroupIsAlive, stopOwnedProcessGroup, stopOwnedProcessGroupSync, workerProcessMetadata, WORKER_STOP_TIMEOUT_MS } from "./process-group.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDatabaseLock } from "./database-lock.js";
import { checkPiCompatibility, spawnFreshExecutor } from "./pi.js";

export const TASK_RUNTIME_OWNERSHIP_ERROR = "The pi-sand Task Runtime is already owned by another Pi process.";
export const FRESH_EXECUTOR_UNSUPPORTED_ERROR = "Fresh Executor Tasks are supported only on Linux.";
export const TASK_RUNTIME_DB_ENV = "PI_SAND_RUNTIME_DB";
export const MAX_TASK_GOAL_LENGTH = 4_000;
export const MAX_TASK_RESULT_LENGTH = 4_000;
export const MAX_TASK_DETAIL_LENGTH = 2_000;
export const TASK_TERMINAL_STATES = Object.freeze(["completed", "failed", "stopped", "interrupted"]);
export const TASK_SHUTDOWN_REASONS = Object.freeze(["quit", "reload", "new", "resume", "fork"]);

const ACTIVE_STATES = "('starting', 'running')";
const SHUTDOWN_REASON_SQL = "('quit', 'reload', 'new', 'resume', 'fork')";
const now = () => new Date().toISOString();
const errorText = (error) => String(error?.stderr || error?.message || "command failed").trim();
function bounded(value, limit) { return String(value ?? "").slice(0, limit); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function canonical(path) { return realpathSync.native(resolve(path)); }
function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

export function defaultTaskRuntimeDatabasePath() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-sand", "task-runtime.sqlite");
}

export function buildTaskPacket({ taskId, attemptNumber, goal, taskBranch, taskWorktree, baseCommit, priorState, priorDetail }) {
  const packet = [
    "pi-sand Task Packet",
    `Task id: ${taskId}`,
    `Attempt: ${attemptNumber}`,
    `Goal: ${goal}`,
    `Task branch: ${taskBranch}`,
    `Task worktree: ${taskWorktree}`,
    `Base commit: ${baseCommit}`,
  ];
  if (priorState) packet.push(`Previous attempt outcome: ${priorState}`);
  if (priorDetail) packet.push(`Previous attempt detail: ${bounded(priorDetail, MAX_TASK_DETAIL_LENGTH)}`);
  packet.push(
    "Execution rules:",
    "- Work only in the task worktree identified above.",
    "- This is a fresh executor; inspect the current filesystem instead of expecting conversation history.",
    "- Existing filesystem changes from earlier Attempts may remain; do not reset or clean them.",
    "- Use Pi's normal built-in tools, Skills, and context discovery as needed.",
    "- Do not create, enqueue, or run another pi-sand Task. You are not the foreground Manager.",
  );
  return packet.join("\n");
}

export function preflightGitWorkspace(cwd) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("workspace is not a Git worktree");
    const sourceRepoRoot = canonical(git(cwd, ["rev-parse", "--show-toplevel"]));
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);
    if (git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("the source Git worktree must be clean (including untracked files)");
    if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new Error("source HEAD is unavailable");
    return { sourceRepoRoot, baseCommit };
  } catch (error) {
    throw new Error(`Task Git preflight failed: ${errorText(error)}`, { cause: error });
  }
}

function attemptView(row) {
  return {
    id: row.id, taskId: row.taskId, number: row.number, provider: row.provider, modelId: row.modelId,
    thinkingLevel: row.thinkingLevel, state: row.state, startedAt: row.startedAt, finishedAt: row.finishedAt ?? null,
    shutdownReason: row.shutdownReason ?? null,
    workerPid: row.workerPid ?? null, workerPgid: row.workerPgid ?? null,
    workerStartIdentity: row.workerStartIdentity ?? null, workerBootId: row.workerBootId ?? null,
    workerTerminated: row.workerTerminated === 1,
    finalResult: row.finalResult ?? null, terminalDetail: row.terminalDetail ?? null,
    finalBranchHead: row.finalBranchHead ?? null,
  };
}

export class TaskRuntime {
  constructor({ dbPath = process.env[TASK_RUNTIME_DB_ENV] ?? defaultTaskRuntimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = spawnFreshExecutor, workerEnv, worktreeRoot, workerStopTimeoutMs = WORKER_STOP_TIMEOUT_MS } = {}) {
    this.dbPath = dbPath; this.piCommand = piCommand; this.workerFactory = workerFactory; this.workerEnv = workerEnv; this.worktreeRoot = worktreeRoot; this.workerStopTimeoutMs = workerStopTimeoutMs;
    this.db = null; this.lock = null; this.active = null; this.closed = false; this.shuttingDown = false; this.shutdownPromise = null;
  }

  ensureSupported() { if (process.platform !== "linux") throw new Error(FRESH_EXECUTOR_UNSUPPORTED_ERROR); }

  ensureOwner() {
    this.ensureSupported();
    if (this.closed || this.shuttingDown) throw new Error("The pi-sand Task Runtime is closed.");
    if (this.db) return this.db;
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      this.lock = acquireDatabaseLock(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrateCompletionSchema();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
          task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','interrupted')), latest_attempt_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_result TEXT,
          terminal_detail TEXT, final_branch_head TEXT,
          shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL})
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
          provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('starting','running','completed','failed','interrupted')), started_at TEXT NOT NULL,
          finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT,
          worker_boot_id TEXT, worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1)),
          final_result TEXT, terminal_detail TEXT, final_branch_head TEXT,
          shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL}), UNIQUE(task_id, number)
        );
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
        CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);
      `);
      return this.db;
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null;
      try { this.lock?.release(); } catch {}
      this.lock = null;
      if (/already running for this database/i.test(error.message)) throw new Error(TASK_RUNTIME_OWNERSHIP_ERROR, { cause: error });
      throw error;
    }
  }

  migrateCompletionSchema() {
    const tasksSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()?.sql ?? "";
    const attemptsSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'").get()?.sql ?? "";
    const complete = tasksSql.includes("'interrupted'") && attemptsSql.includes("'interrupted'")
      && tasksSql.includes("shutdown_reason") && attemptsSql.includes("worker_start_identity");
    if (!tasksSql || !attemptsSql || complete) return;
    this.db.exec("PRAGMA foreign_keys = OFF; BEGIN; ALTER TABLE attempts RENAME TO attempts_legacy; ALTER TABLE tasks RENAME TO tasks_legacy; DROP INDEX IF EXISTS tasks_created; DROP INDEX IF EXISTS attempts_task;");
    this.db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
        task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','interrupted')), latest_attempt_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_result TEXT, terminal_detail TEXT, final_branch_head TEXT,
        shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL})
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
        provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','running','completed','failed','interrupted')), started_at TEXT NOT NULL,
        finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT, worker_boot_id TEXT,
        worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1)), final_result TEXT, terminal_detail TEXT, final_branch_head TEXT,
        shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL}), UNIQUE(task_id, number)
      );
      INSERT INTO tasks (id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at, final_result, terminal_detail, final_branch_head)
        SELECT id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at,
          ${tasksSql.includes("final_result") ? "final_result" : "NULL"}, ${tasksSql.includes("terminal_detail") ? "terminal_detail" : "NULL"}, ${tasksSql.includes("final_branch_head") ? "final_branch_head" : "NULL"} FROM tasks_legacy;
      INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, finished_at, worker_pid, worker_pgid, worker_terminated, final_result, terminal_detail, final_branch_head)
        SELECT id, task_id, number, provider, model_id, thinking_level, state, started_at, finished_at, worker_pid, worker_pgid,
          CASE WHEN worker_pid IS NULL AND worker_pgid IS NULL THEN 1 ELSE 0 END,
          ${attemptsSql.includes("final_result") ? "final_result" : "NULL"}, ${attemptsSql.includes("terminal_detail") ? "terminal_detail" : "NULL"}, ${attemptsSql.includes("final_branch_head") ? "final_branch_head" : "NULL"} FROM attempts_legacy;
    `);
    this.db.exec("DROP TABLE attempts_legacy; DROP TABLE tasks_legacy; COMMIT; PRAGMA foreign_keys = ON");
  }

  taskRow(id) {
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt, final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead, shutdown_reason AS shutdownReason FROM tasks WHERE id = ?`).get(id);
  }

  taskWithAttempts(row) {
    if (!row) return null;
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId, thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt, shutdown_reason AS shutdownReason, worker_pid AS workerPid, worker_pgid AS workerPgid, worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId, worker_terminated AS workerTerminated, final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead FROM attempts WHERE task_id = ? ORDER BY number`).all(row.id).map(attemptView);
    return { ...row, attempts };
  }

  listTasks() {
    this.ensureOwner();
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt, final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead, shutdown_reason AS shutdownReason FROM tasks ORDER BY created_at, id`).all().map((row) => this.taskWithAttempts(row));
  }

  getTask(id) { this.ensureOwner(); return this.taskWithAttempts(this.taskRow(id)); }

  createWorktree(repoRoot, baseCommit, taskId) {
    const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks");
    const worktree = join(root, taskId);
    const taskBranch = `pi-sand/task-${taskId}`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      // Resolve the revision in the source repository explicitly. This keeps
      // worktree creation tied to the exact preflight HEAD, not ambient cwd.
      execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", taskBranch, worktree, baseCommit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { taskBranch, taskWorktree: canonical(worktree) };
    } catch (error) { throw new Error(`Task worktree creation failed: ${errorText(error)}`, { cause: error }); }
  }

  launchAttempt(task, attemptId, number, model, thinkingLevel, priorState, priorDetail) {
    const packet = buildTaskPacket({ taskId: task.id, attemptNumber: number, goal: task.goal, taskBranch: task.taskBranch, taskWorktree: task.taskWorktree, baseCommit: task.baseCommit, priorState, priorDetail });
    try {
      const lifecycle = { events: [], closed: false, close: null };
      const worker = this.workerFactory({
        cwd: task.taskWorktree, command: this.piCommand, env: this.workerEnv,
        provider: model.provider, modelId: model.id, thinkingLevel,
        onEvent: (event) => {
          if (this.active?.attemptId === attemptId) this.handleWorkerEvent(task.id, attemptId, event);
          else lifecycle.events.push(event);
        },
        onClose: (result) => {
          if (this.active?.attemptId === attemptId) this.handleWorkerClose(task.id, attemptId, result);
          else { lifecycle.closed = true; lifecycle.close = result; }
        },
      });
      this.db.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=?").run(now(), task.id);
      const recordedProcess = workerProcessMetadata(worker);
      this.db.prepare("UPDATE attempts SET state='running',worker_pid=?,worker_pgid=?,worker_start_identity=?,worker_boot_id=?,worker_terminated=? WHERE id=?").run(
        recordedProcess?.workerPid ?? null, recordedProcess?.workerPgid ?? null,
        recordedProcess?.workerStartIdentity ?? null, recordedProcess?.workerBootId ?? null,
        recordedProcess ? 0 : 1, attemptId,
      );
      this.active = { taskId: task.id, attemptId, worker, packet, processMetadata: recordedProcess, settled: false, closed: false, finalizing: false, finalAssistant: null };
      worker.setModel?.({ provider: model.provider, modelId: model.id });
      worker.setThinkingLevel?.(thinkingLevel);
      for (const event of lifecycle.events) this.handleWorkerEvent(task.id, attemptId, event);
      if (lifecycle.closed) this.handleWorkerClose(task.id, attemptId, lifecycle.close ?? {});
      else worker.prompt({ id: `task-${attemptId}`, message: packet });
    } catch (error) {
      this.failAttempt(task.id, attemptId, `Fresh Executor could not start: ${errorText(error)}`);
      throw new Error(`Fresh Executor could not start: ${errorText(error)}`, { cause: error });
    }
  }

  startTask({ goal, cwd, trusted, model, thinkingLevel }) {
    this.ensureSupported();
    if (typeof goal !== "string" || !goal.trim()) throw new Error("/task requires a goal");
    if (goal.trim().length > MAX_TASK_GOAL_LENGTH) throw new Error(`/task goal must be ${MAX_TASK_GOAL_LENGTH} characters or fewer.`);
    if (!trusted) throw new Error("/task requires a trusted Pi project.");
    if (!model?.provider || !model?.id) throw new Error("/task requires a selected provider and model.");
    if (!thinkingLevel) throw new Error("/task requires a selected thinking level.");
    const preflight = preflightGitWorkspace(cwd);
    const compatibility = checkPiCompatibility({ command: this.piCommand, cwd: preflight.sourceRepoRoot });
    if (!compatibility.compatible || compatibility.version !== "0.84.4") throw new Error("/task requires an installed Pi 0.84.4 executable.");
    const db = this.ensureOwner();
    if (this.active || db.prepare(`SELECT id FROM attempts WHERE state IN ${ACTIVE_STATES} LIMIT 1`).get()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks.");
    const taskId = randomUUID();
    const { taskBranch, taskWorktree } = this.createWorktree(preflight.sourceRepoRoot, preflight.baseCommit, taskId);
    const attemptId = randomUUID(); const timestamp = now();
    try {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO tasks (id,source_repo_root,base_commit,task_branch,task_worktree,goal,state,latest_attempt_id,created_at,updated_at) VALUES (?,?,?,?,?,?, 'accepted',?,?,?)`).run(taskId, preflight.sourceRepoRoot, preflight.baseCommit, taskBranch, taskWorktree, goal.trim(), attemptId, timestamp, timestamp);
      db.prepare(`INSERT INTO attempts (id,task_id,number,provider,model_id,thinking_level,state,started_at) VALUES (?,?,1,?,?,?,'starting',?)`).run(attemptId, taskId, model.provider, model.id, thinkingLevel, timestamp);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      try { execFileSync("git", ["-C", preflight.sourceRepoRoot, "worktree", "remove", "--force", taskWorktree], { stdio: "ignore" }); } catch {}
      throw error;
    }
    this.launchAttempt({ id: taskId, goal: goal.trim(), taskBranch, taskWorktree, baseCommit: preflight.baseCommit }, attemptId, 1, model, thinkingLevel);
    return this.getTask(taskId);
  }

  handleWorkerEvent(taskId, attemptId, event) {
    const active = this.active;
    if (this.closed || !active || active.taskId !== taskId || active.attemptId !== attemptId || active.closed) return;
    if (event?.type === "response" && event.command === "prompt" && event.success === false) {
      this.failAttempt(taskId, attemptId, `Fresh Executor rejected the prompt: ${bounded(errorText(event.error || event.message), MAX_TASK_DETAIL_LENGTH)}`);
      return;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      active.finalAssistant = {
        result: bounded(assistantText(event.message), MAX_TASK_RESULT_LENGTH),
        stopReason: event.message.stopReason ?? null,
        errorMessage: event.message.errorMessage ?? null,
      };
    }
    if (event?.type === "agent_settled") active.settled = true;
    this.maybeFinalize(taskId, attemptId);
  }

  handleWorkerClose(taskId, attemptId, { code = null, signal = null, error } = {}) {
    const active = this.active;
    if (this.closed || !active || active.taskId !== taskId || active.attemptId !== attemptId) return;
    active.closed = true;
    this.maybeFinalize(taskId, attemptId);
    if (this.active === active) {
      const detail = error ? errorText(error) : signal ? `Pi exited with ${signal}` : `Pi exited with code ${code}`;
      this.failAttempt(taskId, attemptId, `Fresh Executor closed before successful settlement: ${detail}`, active.finalAssistant?.result ?? "");
    }
  }

  maybeFinalize(taskId, attemptId) {
    const active = this.active;
    if (!active || active.taskId !== taskId || active.attemptId !== attemptId || active.finalizing || !active.settled) return;
    if (!active.finalAssistant) return;
    active.finalizing = true;
    const outcome = active.finalAssistant;
    if (outcome.stopReason === "error" || outcome.stopReason === "aborted" || outcome.errorMessage) {
      const detail = outcome.stopReason === "aborted"
        ? "Fresh Executor assistant run was aborted."
        : outcome.errorMessage ? `Fresh Executor assistant error: ${bounded(outcome.errorMessage, MAX_TASK_DETAIL_LENGTH)}` : "Fresh Executor assistant ended with an error.";
      this.failAttempt(taskId, attemptId, detail, outcome.result);
      return;
    }
    try {
      const task = this.taskRow(taskId);
      const finalBranchHead = this.checkpointTask(task);
      this.persistTerminal(taskId, attemptId, "completed", outcome.result, "Fresh Executor settled successfully.", finalBranchHead);
      this.clearActive(active);
    } catch (error) {
      this.failAttempt(taskId, attemptId, `Task completion failed: ${bounded(errorText(error), MAX_TASK_DETAIL_LENGTH)}`, outcome.result);
    }
  }

  checkpointTask(task) {
    try {
      const dirty = git(task.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (dirty) {
        execFileSync("git", ["add", "-A"], { cwd: task.taskWorktree, stdio: ["ignore", "pipe", "pipe"] });
        execFileSync("git", ["commit", "-m", `pi-sand: checkpoint completed Task ${task.id}`], {
          cwd: task.taskWorktree,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "pi-sand",
            GIT_AUTHOR_EMAIL: "pi-sand@localhost",
            GIT_COMMITTER_NAME: "pi-sand",
            GIT_COMMITTER_EMAIL: "pi-sand@localhost",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      return git(task.taskWorktree, ["rev-parse", "HEAD"]);
    } catch (error) {
      throw new Error(`Git checkpoint failed: ${errorText(error)}`, { cause: error });
    }
  }

  persistTerminal(taskId, attemptId, state, finalResult, terminalDetail, finalBranchHead) {
    const timestamp = now();
    const result = bounded(finalResult, MAX_TASK_RESULT_LENGTH);
    const detail = bounded(terminalDetail, MAX_TASK_DETAIL_LENGTH);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE attempts SET state=?,finished_at=?,final_result=?,terminal_detail=?,final_branch_head=? WHERE id=? AND state IN ('starting','running')").run(state, timestamp, result, detail, finalBranchHead, attemptId);
      this.db.prepare("UPDATE tasks SET state=?,updated_at=?,final_result=?,terminal_detail=?,final_branch_head=? WHERE id=?").run(state, timestamp, result, detail, finalBranchHead, taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  failAttempt(taskId, attemptId, terminalDetail, finalResult = "") {
    if (!this.db) return false;
    const attempt = this.db.prepare("SELECT state FROM attempts WHERE id=? AND task_id=?").get(attemptId, taskId);
    if (!attempt || !["starting", "running"].includes(attempt.state)) {
      if (this.active?.attemptId === attemptId) this.clearActive(this.active);
      return false;
    }
    this.persistTerminal(taskId, attemptId, "failed", finalResult, terminalDetail, null);
    if (this.active?.attemptId === attemptId) this.clearActive(this.active);
    return true;
  }

  clearActive(active) {
    if (this.active !== active) return;
    this.active = null;
    try { active.worker?.close?.(); } catch {}
  }

  stopTask(id) {
    this.ensureSupported();
    if (typeof id !== "string" || !id.trim()) throw new Error("/task-stop requires a Task id");
    const db = this.ensureOwner();
    const task = this.taskRow(id.trim());
    if (!task) throw new Error(`Task ${id} was not found.`);
    if (task.state !== "running") throw new Error(`Task ${id} is already terminal (${task.state}); it is not active.`);
    const attempt = db.prepare("SELECT id,task_id AS taskId,state,worker_pid AS workerPid,worker_pgid AS workerPgid,worker_start_identity AS workerStartIdentity,worker_boot_id AS workerBootId FROM attempts WHERE id=? AND task_id=?").get(task.latestAttemptId, task.id);
    if (!attempt || !["starting", "running"].includes(attempt.state)) throw new Error(`Task ${id} has no active Attempt to stop.`);
    const active = this.active?.attemptId === attempt.id ? this.active : null;
    if (active) active.closed = true;
    let terminated = false;
    if (Number.isInteger(attempt.workerPid) && Number.isInteger(attempt.workerPgid)) {
      terminated = stopOwnedProcessGroupSync(attempt, { timeoutMs: this.workerStopTimeoutMs });
    } else if (active?.worker?.close) {
      active.worker.close();
      terminated = true;
    }
    if (!terminated || (Number.isInteger(attempt.workerPgid) && processGroupIsAlive(attempt.workerPgid))) {
      if (active) active.closed = false;
      throw new Error(`Task ${id} worker could not be safely terminated; no outcome was recorded.`);
    }
    const timestamp = now();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE attempts SET state='stopped',finished_at=?,terminal_detail=? WHERE id=? AND state IN ('starting','running')").run(timestamp, "The Task was intentionally stopped by the user.", attempt.id);
      db.prepare("UPDATE tasks SET state='stopped',updated_at=? WHERE id=? AND state='running'").run(timestamp, task.id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (active) active.closed = false;
      throw error;
    }
    if (this.active?.attemptId === attempt.id) this.active = null;
    return this.getTask(task.id);
  }

  retryTask({ id, trusted, model, thinkingLevel }) {
    this.ensureSupported();
    if (typeof id !== "string" || !id.trim()) throw new Error("/task-retry requires a Task id");
    if (!trusted) throw new Error("/task-retry requires a trusted Pi project.");
    if (!model?.provider || !model?.id) throw new Error("/task-retry requires a selected provider and model.");
    if (!thinkingLevel) throw new Error("/task-retry requires a selected thinking level.");
    const db = this.ensureOwner();
    const task = this.taskRow(id.trim());
    if (!task) throw new Error(`Task ${id} was not found.`);
    if (task.state === "completed" || task.state === "blocked") throw new Error(`Task ${id} is ${task.state} and cannot be retried in v0.3.`);
    if (!(TASK_TERMINAL_STATES.includes(task.state) && task.state !== "completed")) throw new Error(`Task ${id} is not retryable (${task.state}).`);
    if (this.active || db.prepare(`SELECT id FROM attempts WHERE state IN ${ACTIVE_STATES} LIMIT 1`).get()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks.");
    try {
      if (canonical(task.taskWorktree) !== task.taskWorktree) throw new Error("worktree identity changed");
    } catch (error) {
      throw new Error(`Task ${id} worktree is unavailable; retry was not started.`, { cause: error });
    }
    const previous = db.prepare("SELECT id,state,number,terminal_detail AS terminalDetail,worker_pid AS workerPid,worker_pgid AS workerPgid,worker_start_identity AS workerStartIdentity,worker_boot_id AS workerBootId FROM attempts WHERE id=? AND task_id=?").get(task.latestAttemptId, task.id);
    if (!previous || !TASK_TERMINAL_STATES.includes(previous.state)) throw new Error(`Task ${id} previous Attempt is not terminal.`);
    if (Number.isInteger(previous.workerPgid) && processGroupIsAlive(previous.workerPgid)) throw new Error(`Task ${id} previous worker is not safely gone; retry was not started.`);
    const attemptId = randomUUID();
    const timestamp = now();
    try {
      db.exec("BEGIN");
      db.prepare("INSERT INTO attempts (id,task_id,number,provider,model_id,thinking_level,state,started_at) VALUES (?,?,?,?,?,?, 'starting',?)").run(attemptId, task.id, previous.number + 1, model.provider, model.id, thinkingLevel, timestamp);
      db.prepare("UPDATE tasks SET state='running',latest_attempt_id=?,updated_at=? WHERE id=? AND state IN ('failed','stopped','interrupted')").run(attemptId, timestamp, task.id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    this.launchAttempt(task, attemptId, previous.number + 1, model, thinkingLevel, previous.state, previous.terminalDetail);
    return this.getTask(task.id);
  }

  async shutdown(reason = "quit") {
    if (!TASK_SHUTDOWN_REASONS.includes(reason)) throw new Error(`Unsupported Task Runtime shutdown reason: ${reason}`);
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.closed) return;
      this.shuttingDown = true;
      const active = this.active;
      if (active) {
        const row = this.db?.prepare("SELECT worker_pid AS workerPid, worker_pgid AS workerPgid, worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId FROM attempts WHERE id = ?").get(active.attemptId);
        const worker = row ?? active.processMetadata;
        const hasRecordedProcess = Number.isInteger(worker?.workerPid) || Number.isInteger(worker?.workerPgid);
        const terminated = hasRecordedProcess ? await stopOwnedProcessGroup(worker) : true;
        if (terminated) {
          try { active.worker?.close?.(); } catch {}
        }
        if (this.db) {
          const timestamp = now();
          this.db.exec("BEGIN");
          try {
            this.db.prepare(`UPDATE attempts SET state='interrupted',finished_at=?,shutdown_reason=?,worker_terminated=? WHERE id=? AND state IN ${ACTIVE_STATES}`).run(timestamp, reason, terminated ? 1 : 0, active.attemptId);
            this.db.prepare("UPDATE tasks SET state='interrupted',updated_at=?,shutdown_reason=? WHERE id=? AND latest_attempt_id=?").run(timestamp, reason, active.taskId, active.attemptId);
            this.db.exec("COMMIT");
          } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch {}
            throw error;
          }
        }
        this.active = null;
      }
      this.releaseResources();
    })();
    return this.shutdownPromise;
  }

  releaseResources() {
    this.closed = true;
    this.shuttingDown = false;
    this.active = null;
    try { this.db?.close(); } catch {}
    this.db = null;
    try { this.lock?.release(); } catch {}
    this.lock = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.active?.worker?.close?.(); } catch {}
    this.active = null;
    try { this.db?.close(); } catch {}
    this.db = null;
    try { this.lock?.release(); } catch {}
    this.lock = null;
  }
}
