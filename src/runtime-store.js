import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { acquireDatabaseLock } from "./database-lock.js";
import { checkFreshExecutorCompatibility, startFreshExecutor } from "./fresh-executor.js";
import { runtimeDatabasePath } from "./runtime-ipc.js";

export const RUNTIME_OWNERSHIP_ERROR = "The pi-sand runtime is already owned by another daemon.";
export const TASK_RUNTIME_UNSUPPORTED_ERROR = "Fresh Executor Tasks are supported only on Linux.";
export const MAX_TASK_GOAL_LENGTH = 8 * 1024;
export const MAX_TASK_PACKET_LENGTH = 16 * 1024;

const now = () => new Date().toISOString();
const commandError = (error) => String(error?.stderr || error?.message || "command failed").trim();
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const canonicalPath = (path) => realpathSync.native(resolve(path));

export function preflightGitWorkspace(cwd) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("workspace is not a Git worktree");
    const sourceRepoRoot = canonicalPath(git(cwd, ["rev-parse", "--show-toplevel"]));
    if (git(sourceRepoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("the source Git worktree must be clean (including untracked files)");
    const baseCommit = git(sourceRepoRoot, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) throw new Error("source HEAD is unavailable");
    return { sourceRepoRoot, baseCommit };
  } catch (error) {
    if (/clean \(including untracked files\)/.test(error.message)) throw error;
    throw new Error(`Task Git preflight failed: ${commandError(error)}`, { cause: error });
  }
}

function attemptSnapshot(row) {
  return { id: row.id, taskId: row.taskId, number: row.number, provider: row.provider, modelId: row.modelId, thinkingLevel: row.thinkingLevel, state: row.state, startedAt: row.startedAt, finishedAt: row.finishedAt ?? null, workerPid: row.workerPid ?? null, workerPgid: row.workerPgid ?? null };
}
function taskSnapshot(row, attempts = []) {
  return { id: row.id, sourceRepoRoot: row.sourceRepoRoot, baseCommit: row.baseCommit, taskBranch: row.taskBranch, taskWorktree: row.taskWorktree, goal: row.goal, state: row.state, latestAttemptId: row.latestAttemptId ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt, attempts };
}

export function buildTaskPacket({ taskId, attemptNumber, goal, taskBranch, taskWorktree, baseCommit }) {
  const packet = ["pi-sand Task Packet", `Task id: ${taskId}`, `Attempt: ${attemptNumber}`, `Goal: ${goal}`, `Task branch: ${taskBranch}`, `Task worktree: ${taskWorktree}`, `Base commit: ${baseCommit}`, "Execution rules:", "- Work only in the task worktree identified above.", "- Inspect the current filesystem; this executor has no Manager conversation.", "- Use Pi's normal tools, Skills, and context discovery as needed.", "- Do not create or enqueue another pi-sand Task. You are not the foreground Manager."].join("\n");
  if (Buffer.byteLength(packet, "utf8") > MAX_TASK_PACKET_LENGTH) throw new Error("Task Packet exceeds its bounded size.");
  return packet;
}

export class RuntimeStore {
  constructor({ dbPath = runtimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = startFreshExecutor, workerEnv = process.env, worktreeRoot } = {}) {
    this.dbPath = dbPath; this.piCommand = piCommand; this.workerFactory = workerFactory; this.workerEnv = workerEnv; this.worktreeRoot = worktreeRoot;
    this.databaseLock = null; this.db = null; this.active = null; this.closed = false;
  }
  ensureSupported() { if (process.platform !== "linux") throw new Error(TASK_RUNTIME_UNSUPPORTED_ERROR); }
  open() {
    this.ensureSupported(); if (this.closed) throw new Error("The pi-sand runtime is closed."); if (this.db) return this;
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      this.databaseLock = acquireDatabaseLock(this.dbPath); this.db = new DatabaseSync(this.dbPath); if (this.dbPath !== ":memory:") chmodSync(this.dbPath, 0o600);
      this.db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL, task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, state TEXT NOT NULL, latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, UNIQUE(task_id, number));
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id); CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);`);
      return this;
    } catch (error) { this.release(); if (/already running for this database/i.test(error.message)) throw new Error(RUNTIME_OWNERSHIP_ERROR, { cause: error }); throw error; }
  }
  listTasks() {
    this.open();
    const rows = this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt FROM tasks ORDER BY created_at, id`).all();
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId, thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt, worker_pid AS workerPid, worker_pgid AS workerPgid FROM attempts ORDER BY task_id, number`).all();
    const grouped = new Map(); for (const attempt of attempts) grouped.set(attempt.taskId, [...(grouped.get(attempt.taskId) ?? []), attemptSnapshot(attempt)]);
    return rows.map((row) => taskSnapshot(row, grouped.get(row.id) ?? []));
  }
  getTask(id) {
    this.open(); const row = this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?`).get(id); if (!row) return null;
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId, thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt, worker_pid AS workerPid, worker_pgid AS workerPgid FROM attempts WHERE task_id = ? ORDER BY number`).all(id);
    return taskSnapshot(row, attempts.map(attemptSnapshot));
  }
  createWorktree({ repoRoot, baseCommit, taskId }) {
    const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks"); const worktree = join(root, taskId); const branch = `pi-sand/task-${taskId}`; mkdirSync(root, { recursive: true, mode: 0o700 });
    try { execFileSync("git", ["worktree", "add", "-b", branch, worktree, baseCommit], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { taskBranch: branch, taskWorktree: canonicalPath(worktree) }; } catch (error) { throw new Error(`Task worktree creation failed: ${commandError(error)}`, { cause: error }); }
  }
  async createTask({ goal, cwd, trusted, model, thinkingLevel }) {
    this.ensureSupported(); if (typeof goal !== "string" || !goal.trim()) throw new Error("/task requires a goal"); if (Buffer.byteLength(goal.trim(), "utf8") > MAX_TASK_GOAL_LENGTH) throw new Error("/task goal exceeds the bounded size limit."); if (trusted !== true) throw new Error("/task requires a trusted Pi project."); if (!model?.provider || !model?.id) throw new Error("/task requires a selected provider and model."); if (!thinkingLevel) throw new Error("/task requires a selected thinking level.");
    const preflight = preflightGitWorkspace(cwd); const compatibility = checkFreshExecutorCompatibility({ command: this.piCommand, cwd: preflight.sourceRepoRoot, env: this.workerEnv }); if (!compatibility.compatible) throw new Error("/task requires an installed Pi 0.84.4 executable.");
    this.open(); if (this.active || this.db.prepare("SELECT id FROM attempts WHERE state IN ('starting', 'running') LIMIT 1").get()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks.");
    const taskId = randomUUID(); const attemptId = randomUUID(); const timestamp = now(); const { taskBranch, taskWorktree } = this.createWorktree({ repoRoot: preflight.sourceRepoRoot, baseCommit: preflight.baseCommit, taskId }); const cleanGoal = goal.trim();
    let packet; try { packet = buildTaskPacket({ taskId, attemptNumber: 1, goal: cleanGoal, taskBranch, taskWorktree, baseCommit: preflight.baseCommit }); } catch (error) { try { execFileSync("git", ["worktree", "remove", "--force", taskWorktree], { cwd: preflight.sourceRepoRoot, stdio: "ignore" }); } catch {} throw error; }
    try { this.db.exec("BEGIN"); this.db.prepare(`INSERT INTO tasks (id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(taskId, preflight.sourceRepoRoot, preflight.baseCommit, taskBranch, taskWorktree, cleanGoal, attemptId, timestamp, timestamp); this.db.prepare(`INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at) VALUES (?, ?, 1, ?, ?, ?, 'starting', ?)`).run(attemptId, taskId, model.provider, model.id, thinkingLevel, timestamp); this.db.exec("COMMIT"); } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} try { execFileSync("git", ["worktree", "remove", "--force", taskWorktree], { cwd: preflight.sourceRepoRoot, stdio: "ignore" }); } catch {} throw error; }
    try { const worker = await this.workerFactory({ cwd: taskWorktree, command: this.piCommand, env: this.workerEnv, provider: model.provider, modelId: model.id, thinkingLevel, taskPrompt: packet, onEvent: () => {}, onClose: () => {} }); const pid = Number.isInteger(worker?.pid) ? worker.pid : null; const pgid = Number.isInteger(worker?.processGroupId) ? worker.processGroupId : null; this.db.prepare("UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ?").run(now(), taskId); this.db.prepare("UPDATE attempts SET state = 'running', worker_pid = ?, worker_pgid = ? WHERE id = ?").run(pid, pgid, attemptId); this.active = { taskId, attemptId, worker, packet }; return this.getTask(taskId); } catch (error) { this.db.prepare("UPDATE tasks SET state = 'failed', updated_at = ? WHERE id = ?").run(now(), taskId); this.db.prepare("UPDATE attempts SET state = 'failed', finished_at = ? WHERE id = ?").run(now(), attemptId); throw new Error(`Fresh Executor failed before prompt acceptance: ${commandError(error)}`, { cause: error }); }
  }
  release() { if (this.closed) return; this.closed = true; try { this.active?.worker?.close?.(); } catch {} this.active = null; try { this.db?.close(); } finally { this.db = null; try { this.databaseLock?.release(); } finally { this.databaseLock = null; } } }
  close() { this.release(); }
}
export class TaskRuntime extends RuntimeStore {}
