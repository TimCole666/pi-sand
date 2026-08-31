import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDatabaseLock } from "./database-lock.js";
import { checkPiCompatibility, spawnFreshExecutor } from "./pi.js";

export const TASK_RUNTIME_OWNERSHIP_ERROR = "The pi-sand Task Runtime is already owned by another Pi process.";
export const FRESH_EXECUTOR_UNSUPPORTED_ERROR = "Fresh Executor Tasks are supported only on Linux.";
export const TASK_RUNTIME_DB_ENV = "PI_SAND_RUNTIME_DB";
export const MAX_TASK_GOAL_LENGTH = 4_000;

const ACTIVE_STATES = "('starting', 'running')";
const now = () => new Date().toISOString();
const errorText = (error) => String(error?.stderr || error?.message || "command failed").trim();
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function canonical(path) { return realpathSync.native(resolve(path)); }

export function defaultTaskRuntimeDatabasePath() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-sand", "task-runtime.sqlite");
}

export function buildTaskPacket({ taskId, attemptNumber, goal, taskBranch, taskWorktree, baseCommit }) {
  return [
    "pi-sand Task Packet",
    `Task id: ${taskId}`,
    `Attempt: ${attemptNumber}`,
    `Goal: ${goal}`,
    `Task branch: ${taskBranch}`,
    `Task worktree: ${taskWorktree}`,
    `Base commit: ${baseCommit}`,
    "Execution rules:",
    "- Work only in the task worktree identified above.",
    "- This is a fresh executor; inspect the current filesystem instead of expecting conversation history.",
    "- Use Pi's normal built-in tools, Skills, and context discovery as needed.",
    "- Do not create, enqueue, or run another pi-sand Task. You are not the foreground Manager.",
  ].join("\n");
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
    workerPid: row.workerPid ?? null, workerPgid: row.workerPgid ?? null,
  };
}

export class TaskRuntime {
  constructor({ dbPath = process.env[TASK_RUNTIME_DB_ENV] ?? defaultTaskRuntimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = spawnFreshExecutor, workerEnv, worktreeRoot } = {}) {
    this.dbPath = dbPath; this.piCommand = piCommand; this.workerFactory = workerFactory; this.workerEnv = workerEnv; this.worktreeRoot = worktreeRoot;
    this.db = null; this.lock = null; this.active = null; this.closed = false;
  }

  ensureSupported() { if (process.platform !== "linux") throw new Error(FRESH_EXECUTOR_UNSUPPORTED_ERROR); }

  ensureOwner() {
    this.ensureSupported();
    if (this.closed) throw new Error("The pi-sand Task Runtime is closed.");
    if (this.db) return this.db;
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      this.lock = acquireDatabaseLock(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
          task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('accepted','running')), latest_attempt_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
          provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('starting','running')), started_at TEXT NOT NULL,
          finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, UNIQUE(task_id, number)
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

  taskRow(id) {
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?`).get(id);
  }

  taskWithAttempts(row) {
    if (!row) return null;
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId, thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt, worker_pid AS workerPid, worker_pgid AS workerPgid FROM attempts WHERE task_id = ? ORDER BY number`).all(row.id).map(attemptView);
    return { ...row, attempts };
  }

  listTasks() {
    this.ensureOwner();
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt FROM tasks ORDER BY created_at, id`).all().map((row) => this.taskWithAttempts(row));
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
    const packet = buildTaskPacket({ taskId, attemptNumber: 1, goal: goal.trim(), taskBranch, taskWorktree, baseCommit: preflight.baseCommit });
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
    try {
      const worker = this.workerFactory({ cwd: taskWorktree, command: this.piCommand, env: this.workerEnv, provider: model.provider, modelId: model.id, thinkingLevel, onEvent: () => {}, onClose: () => {} });
      db.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=?").run(now(), taskId);
      db.prepare("UPDATE attempts SET state='running',worker_pid=?,worker_pgid=? WHERE id=?").run(Number.isInteger(worker?.pid) ? worker.pid : null, Number.isInteger(worker?.processGroupId) ? worker.processGroupId : null, attemptId);
      this.active = { taskId, attemptId, worker, packet };
      worker.setModel?.({ provider: model.provider, modelId: model.id });
      worker.setThinkingLevel?.(thinkingLevel);
      worker.prompt({ id: `task-${attemptId}`, message: packet });
    } catch (error) { throw new Error(`Fresh Executor could not start: ${errorText(error)}`, { cause: error }); }
    return this.getTask(taskId);
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
