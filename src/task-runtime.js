import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDatabaseLock } from "./database-lock.js";
import { checkPiCompatibility, spawnFreshExecutor } from "./pi.js";
import { stopOwnedProcessGroup, workerProcessMetadata } from "./process-group.js";

export const TASK_RUNTIME_OWNERSHIP_ERROR = "The pi-sand Task Runtime is already owned by another Pi process.";
export const FRESH_EXECUTOR_UNSUPPORTED_ERROR = "Fresh Executor Tasks are supported only on Linux.";
export const TASK_RUNTIME_DB_ENV = "PI_SAND_RUNTIME_DB";
export const MAX_TASK_GOAL_LENGTH = 4_000;
export const TASK_SHUTDOWN_REASONS = Object.freeze(["quit", "reload", "new", "resume", "fork"]);

const ACTIVE_STATES = "('starting', 'running')";
const SHUTDOWN_REASON_SQL = "('quit', 'reload', 'new', 'resume', 'fork')";
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
    shutdownReason: row.shutdownReason ?? null,
    workerPid: row.workerPid ?? null, workerPgid: row.workerPgid ?? null,
    workerStartIdentity: row.workerStartIdentity ?? null, workerBootId: row.workerBootId ?? null,
    workerTerminated: row.workerTerminated === 1,
  };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
      task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('accepted','running','interrupted')), latest_attempt_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL})
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
      provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('starting','running','interrupted')), started_at TEXT NOT NULL,
      finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT,
      worker_boot_id TEXT, worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1)),
      shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL}),
      UNIQUE(task_id, number)
    );
    CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
    CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);
  `);
}

function migrateSchema(db) {
  const taskSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()?.sql || "";
  const attemptSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'").get()?.sql || "";
  const current = taskSql.includes("'interrupted'") && attemptSql.includes("'interrupted'")
    && hasColumn(db, "tasks", "shutdown_reason")
    && hasColumn(db, "attempts", "worker_start_identity")
    && hasColumn(db, "attempts", "worker_terminated")
    && hasColumn(db, "attempts", "shutdown_reason");
  if (current) return;

  db.exec("PRAGMA foreign_keys = OFF; BEGIN");
  try {
    db.exec(`
      CREATE TABLE tasks_v33 (
        id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
        task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','interrupted')), latest_attempt_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL})
      );
      CREATE TABLE attempts_v33 (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_v33(id), number INTEGER NOT NULL,
        provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','running','interrupted')), started_at TEXT NOT NULL,
        finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT,
        worker_boot_id TEXT, worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1)),
        shutdown_reason TEXT CHECK(shutdown_reason IS NULL OR shutdown_reason IN ${SHUTDOWN_REASON_SQL}),
        UNIQUE(task_id, number)
      );
      INSERT INTO tasks_v33 (id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at)
        SELECT id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at FROM tasks;
      INSERT INTO attempts_v33 (id, task_id, number, provider, model_id, thinking_level, state, started_at, finished_at, worker_pid, worker_pgid, worker_terminated)
        SELECT id, task_id, number, provider, model_id, thinking_level, state, started_at, finished_at, worker_pid, worker_pgid,
          CASE WHEN worker_pid IS NULL AND worker_pgid IS NULL THEN 1 ELSE 0 END FROM attempts;
      DROP TABLE attempts;
      DROP TABLE tasks;
      ALTER TABLE tasks_v33 RENAME TO tasks;
      ALTER TABLE attempts_v33 RENAME TO attempts;
      CREATE INDEX tasks_created ON tasks(created_at, id);
      CREATE INDEX attempts_task ON attempts(task_id, number);
    `);
    db.exec("COMMIT; PRAGMA foreign_keys = ON");
  } catch (error) {
    try { db.exec("ROLLBACK; PRAGMA foreign_keys = ON"); } catch {}
    throw error;
  }
}

export class TaskRuntime {
  constructor({ dbPath = process.env[TASK_RUNTIME_DB_ENV] ?? defaultTaskRuntimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = spawnFreshExecutor, workerEnv, worktreeRoot } = {}) {
    this.dbPath = dbPath; this.piCommand = piCommand; this.workerFactory = workerFactory; this.workerEnv = workerEnv; this.worktreeRoot = worktreeRoot;
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
      createSchema(this.db);
      migrateSchema(this.db);
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
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt, shutdown_reason AS shutdownReason FROM tasks WHERE id = ?`).get(id);
  }

  taskWithAttempts(row) {
    if (!row) return null;
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId, thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt, shutdown_reason AS shutdownReason, worker_pid AS workerPid, worker_pgid AS workerPgid, worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId, worker_terminated AS workerTerminated FROM attempts WHERE task_id = ? ORDER BY number`).all(row.id).map(attemptView);
    return { ...row, attempts };
  }

  listTasks() {
    this.ensureOwner();
    return this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit, task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state, latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt, shutdown_reason AS shutdownReason FROM tasks ORDER BY created_at, id`).all().map((row) => this.taskWithAttempts(row));
  }

  getTask(id) { this.ensureOwner(); return this.taskWithAttempts(this.taskRow(id)); }

  createWorktree(repoRoot, baseCommit, taskId) {
    const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks");
    const worktree = join(root, taskId);
    const taskBranch = `pi-sand/task-${taskId}`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
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
      const processMetadata = workerProcessMetadata(worker);
      db.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=?").run(now(), taskId);
      db.prepare("UPDATE attempts SET state='running',worker_pid=?,worker_pgid=?,worker_start_identity=?,worker_boot_id=?,worker_terminated=? WHERE id=?").run(
        processMetadata?.workerPid ?? null, processMetadata?.workerPgid ?? null, processMetadata?.workerStartIdentity ?? null, processMetadata?.workerBootId ?? null,
        processMetadata ? 0 : 1, attemptId,
      );
      this.active = { taskId, attemptId, worker, packet, processMetadata };
      worker.setModel?.({ provider: model.provider, modelId: model.id });
      worker.setThinkingLevel?.(thinkingLevel);
      worker.prompt({ id: `task-${attemptId}`, message: packet });
    } catch (error) { throw new Error(`Fresh Executor could not start: ${errorText(error)}`, { cause: error }); }
    return this.getTask(taskId);
  }

  async shutdown(reason = "quit") {
    if (!TASK_SHUTDOWN_REASONS.includes(reason)) throw new Error(`Unsupported Task Runtime shutdown reason: ${reason}`);
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.closed) return;
      this.shuttingDown = true;
      const active = this.active;
      if (active) {
        const row = this.db?.prepare(`SELECT worker_pid AS workerPid, worker_pgid AS workerPgid, worker_start_identity AS workerStartIdentity, worker_boot_id AS workerBootId FROM attempts WHERE id = ?`).get(active.attemptId);
        const worker = row ? { ...row } : active.processMetadata;
        const hasRecordedProcess = Number.isInteger(worker?.workerPid) || Number.isInteger(worker?.workerPgid);
        const terminated = hasRecordedProcess ? await stopOwnedProcessGroup(worker) : true;
        // The production adapter's close() sends a signal. Only invoke it
        // after group termination was proven; an unresolved worker must retain
        // its unsafe metadata for later reconciliation rather than receiving
        // an unverified second signal.
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
    // Synchronous close is retained for non-lifecycle teardown callers. The
    // Extension uses shutdown(), which waits for TERM/KILL verification before
    // releasing ownership and recording the typed interruption.
    this.closed = true;
    try { this.active?.worker?.close?.(); } catch {}
    this.active = null;
    try { this.db?.close(); } catch {}
    this.db = null;
    try { this.lock?.release(); } catch {}
    this.lock = null;
  }
}
