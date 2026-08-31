import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
export const MAX_TASK_RESULT_LENGTH = 4 * 1024;
export const MAX_TASK_DETAIL_LENGTH = 2 * 1024;

const WORKER_RETIRE_TIMEOUT_MS = 2_000;
const now = () => new Date().toISOString();
const commandError = (error) => String(error?.stderr || error?.message || "command failed").trim();
const git = (cwd, args, options = {}) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  ...options,
}).trim();
const canonicalPath = (path) => realpathSync.native(resolve(path));
const bounded = (value, limit) => String(value ?? "").slice(0, limit);

function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function assistantOutcome(event) {
  if (event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  return {
    result: assistantText(event.message),
    stopReason: String(event.message.stopReason ?? "").toLowerCase(),
    hasError: Boolean(event.message.error || event.message.errorMessage),
  };
}

function processGroupGone(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return true;
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return false;
  }
  let uncertain = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 0) { uncertain = true; continue; }
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      if (Number(fields[2]) === processGroupId && fields[0] !== "Z") return false;
    } catch (error) {
      if (error.code !== "ENOENT") uncertain = true;
    }
  }
  return !uncertain;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForProcessGroupGone(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!processGroupGone(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

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
    workerPid: row.workerPid ?? null,
    workerPgid: row.workerPgid ?? null,
    finalResult: row.finalResult ?? null,
    terminalDetail: row.terminalDetail ?? null,
    finalBranchHead: row.finalBranchHead ?? null,
    workerTerminated: row.workerTerminated === 1,
  };
}

function taskSnapshot(row, attempts = []) {
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
    finalResult: row.finalResult ?? null,
    terminalDetail: row.terminalDetail ?? null,
    finalBranchHead: row.finalBranchHead ?? null,
    attempts,
  };
}

export function buildTaskPacket({ taskId, attemptNumber, goal, taskBranch, taskWorktree, baseCommit }) {
  const packet = [
    "pi-sand Task Packet",
    `Task id: ${taskId}`,
    `Attempt: ${attemptNumber}`,
    `Goal: ${goal}`,
    `Task branch: ${taskBranch}`,
    `Task worktree: ${taskWorktree}`,
    `Base commit: ${baseCommit}`,
    "Execution rules:",
    "- Work only in the task worktree identified above.",
    "- Inspect the current filesystem; this executor has no Manager conversation.",
    "- Use Pi's normal tools, Skills, and context discovery as needed.",
    "- Do not create or enqueue another pi-sand Task. You are not the foreground Manager.",
  ].join("\n");
  if (Buffer.byteLength(packet, "utf8") > MAX_TASK_PACKET_LENGTH) throw new Error("Task Packet exceeds its bounded size.");
  return packet;
}

export class RuntimeStore {
  constructor({ dbPath = runtimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = startFreshExecutor, workerEnv = process.env, worktreeRoot, workerRetireTimeoutMs = WORKER_RETIRE_TIMEOUT_MS } = {}) {
    this.dbPath = dbPath;
    this.piCommand = piCommand;
    this.workerFactory = workerFactory;
    this.workerEnv = workerEnv;
    this.worktreeRoot = worktreeRoot;
    this.workerRetireTimeoutMs = Math.max(0, Number(workerRetireTimeoutMs) || 0);
    this.databaseLock = null;
    this.db = null;
    this.active = null;
    this.closed = false;
  }

  ensureSupported() {
    if (process.platform !== "linux") throw new Error(TASK_RUNTIME_UNSUPPORTED_ERROR);
  }

  ensureCompletionColumns() {
    const columns = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const taskColumns = columns("tasks");
    const attemptColumns = columns("attempts");
    for (const [name, type] of [["final_result", "TEXT"], ["terminal_detail", "TEXT"], ["final_branch_head", "TEXT"]]) {
      if (!taskColumns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      if (!attemptColumns.has(name)) this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
    }
    if (!attemptColumns.has("worker_terminated")) this.db.exec("ALTER TABLE attempts ADD COLUMN worker_terminated INTEGER NOT NULL DEFAULT 1");
  }

  open() {
    this.ensureSupported();
    if (this.closed) throw new Error("The pi-sand runtime is closed.");
    if (this.db) return this;
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      this.databaseLock = acquireDatabaseLock(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      if (this.dbPath !== ":memory:") chmodSync(this.dbPath, 0o600);
      this.db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
          task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
          state TEXT NOT NULL, latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          final_result TEXT, terminal_detail TEXT, final_branch_head TEXT
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
          provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL, state TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
          worker_terminated INTEGER NOT NULL DEFAULT 1, final_result TEXT, terminal_detail TEXT,
          final_branch_head TEXT, UNIQUE(task_id, number)
        );
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
        CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id, number);`);
      this.ensureCompletionColumns();
      return this;
    } catch (error) {
      this.release();
      if (/already running for this database/i.test(error.message)) throw new Error(RUNTIME_OWNERSHIP_ERROR, { cause: error });
      throw error;
    }
  }

  listTasks() {
    this.open();
    const rows = this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit,
      task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state,
      latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt,
      final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead
      FROM tasks ORDER BY created_at, id`).all();
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId,
      thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt,
      worker_pid AS workerPid, worker_pgid AS workerPgid, worker_terminated AS workerTerminated,
      final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead
      FROM attempts ORDER BY task_id, number`).all();
    const grouped = new Map();
    for (const attempt of attempts) grouped.set(attempt.taskId, [...(grouped.get(attempt.taskId) ?? []), attemptSnapshot(attempt)]);
    return rows.map((row) => taskSnapshot(row, grouped.get(row.id) ?? []));
  }

  getTask(id) {
    this.open();
    const row = this.db.prepare(`SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit,
      task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state,
      latest_attempt_id AS latestAttemptId, created_at AS createdAt, updated_at AS updatedAt,
      final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead
      FROM tasks WHERE id = ?`).get(id);
    if (!row) return null;
    const attempts = this.db.prepare(`SELECT id, task_id AS taskId, number, provider, model_id AS modelId,
      thinking_level AS thinkingLevel, state, started_at AS startedAt, finished_at AS finishedAt,
      worker_pid AS workerPid, worker_pgid AS workerPgid, worker_terminated AS workerTerminated,
      final_result AS finalResult, terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead
      FROM attempts WHERE task_id = ? ORDER BY number`).all(id);
    return taskSnapshot(row, attempts.map(attemptSnapshot));
  }

  createWorktree({ repoRoot, baseCommit, taskId }) {
    const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks");
    const worktree = join(root, taskId);
    const branch = `pi-sand/task-${taskId}`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      execFileSync("git", ["worktree", "add", "-b", branch, worktree, baseCommit], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { taskBranch: branch, taskWorktree: canonicalPath(worktree) };
    } catch (error) {
      throw new Error(`Task worktree creation failed: ${commandError(error)}`, { cause: error });
    }
  }

  hasCapacityConflict() {
    return Boolean(this.active) || Boolean(this.db.prepare(`SELECT 1 FROM tasks WHERE state IN ('accepted', 'running', 'blocked') LIMIT 1`).get())
      || Boolean(this.db.prepare("SELECT 1 FROM attempts WHERE state IN ('starting', 'running', 'orphaned') LIMIT 1").get());
  }

  async createTask({ goal, cwd, trusted, model, thinkingLevel }) {
    this.ensureSupported();
    if (typeof goal !== "string" || !goal.trim()) throw new Error("/task requires a goal");
    if (Buffer.byteLength(goal.trim(), "utf8") > MAX_TASK_GOAL_LENGTH) throw new Error("/task goal exceeds the bounded size limit.");
    if (trusted !== true) throw new Error("/task requires a trusted Pi project.");
    if (!model?.provider || !model?.id) throw new Error("/task requires a selected provider and model.");
    if (!thinkingLevel) throw new Error("/task requires a selected thinking level.");

    const preflight = preflightGitWorkspace(cwd);
    const compatibility = checkFreshExecutorCompatibility({ command: this.piCommand, cwd: preflight.sourceRepoRoot, env: this.workerEnv });
    if (!compatibility.compatible) throw new Error("/task requires an installed Pi 0.84.4 executable.");

    this.open();
    if (this.hasCapacityConflict()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks.");
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const timestamp = now();
    const { taskBranch, taskWorktree } = this.createWorktree({ repoRoot: preflight.sourceRepoRoot, baseCommit: preflight.baseCommit, taskId });
    const cleanGoal = goal.trim();
    let packet;
    try {
      packet = buildTaskPacket({ taskId, attemptNumber: 1, goal: cleanGoal, taskBranch, taskWorktree, baseCommit: preflight.baseCommit });
    } catch (error) {
      try { execFileSync("git", ["worktree", "remove", "--force", taskWorktree], { cwd: preflight.sourceRepoRoot, stdio: "ignore" }); } catch {}
      throw error;
    }

    try {
      this.db.exec("BEGIN");
      this.db.prepare(`INSERT INTO tasks (id, source_repo_root, base_commit, task_branch, task_worktree, goal, state, latest_attempt_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(taskId, preflight.sourceRepoRoot, preflight.baseCommit, taskBranch, taskWorktree, cleanGoal, attemptId, timestamp, timestamp);
      this.db.prepare(`INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated)
        VALUES (?, ?, 1, ?, ?, ?, 'starting', ?, 0)`).run(attemptId, taskId, model.provider, model.id, thinkingLevel, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      try { execFileSync("git", ["worktree", "remove", "--force", taskWorktree], { cwd: preflight.sourceRepoRoot, stdio: "ignore" }); } catch {}
      throw error;
    }

    const active = {
      taskId,
      attemptId,
      worker: null,
      packet,
      finalAssistant: null,
      settled: false,
      rpcCoherent: true,
      finalizing: false,
      pendingEvents: [],
      pendingClose: null,
    };
    this.active = active;
    try {
      const worker = await this.workerFactory({
        cwd: taskWorktree,
        command: this.piCommand,
        env: this.workerEnv,
        provider: model.provider,
        modelId: model.id,
        thinkingLevel,
        taskPrompt: packet,
        onEvent: (event) => this.handleWorkerEvent(active, event),
        onClose: (details) => this.handleWorkerClose(active, details),
      });
      if (this.active !== active) return this.getTask(taskId);
      active.worker = worker;
      // FreshExecutorClient exposes its stream on the accepted handle rather
      // than accepting constructor callbacks. Replay its bounded event history
      // and then subscribe so settlement does not depend on a live client.
      if (Array.isArray(worker?.events)) for (const event of worker.events) this.handleWorkerEvent(active, event);
      worker?.onEvent?.((event) => this.handleWorkerEvent(active, event));
      worker?.onClose?.((details) => this.handleWorkerClose(active, details));
      const workerPid = Number.isInteger(worker?.pid) ? worker.pid : null;
      const workerPgid = Number.isInteger(worker?.processGroupId) ? worker.processGroupId : null;
      this.db.prepare("UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), taskId);
      this.db.prepare("UPDATE attempts SET state = 'running', worker_pid = ?, worker_pgid = ? WHERE id = ? AND state = 'starting'").run(workerPid, workerPgid, attemptId);
      // The production Fresh Executor has already accepted its packet before
      // returning. A small prompt method remains useful for deterministic
      // worker doubles without adding a second production transport path.
      if (typeof worker?.prompt === "function") await worker.prompt({ id: `${taskId}-prompt`, message: packet });
      for (const event of active.pendingEvents) this.handleWorkerEvent(active, event);
      active.pendingEvents = [];
      if (active.pendingClose) this.handleWorkerClose(active, active.pendingClose);
      active.pendingClose = null;
      return this.getTask(taskId);
    } catch (error) {
      if (this.active === active && !active.finalizing) {
        await this.settle(active, {
          success: false,
          result: null,
          detail: `Fresh Executor failed before prompt acceptance: ${commandError(error)}`,
          checkpoint: false,
        });
      }
      throw new Error(`Fresh Executor failed before prompt acceptance: ${commandError(error)}`, { cause: error });
    }
  }

  handleWorkerEvent(active, event) {
    if (this.active !== active || active.finalizing) return;
    if (!active.worker) {
      active.pendingEvents.push(event);
      return;
    }
    if (event?.type === "executor_error") {
      active.rpcCoherent = false;
      void this.settle(active, { success: false, result: active.finalAssistant?.result ?? null, detail: "Fresh Executor RPC lifecycle became incoherent before settlement.", checkpoint: false });
      return;
    }
    const outcome = assistantOutcome(event);
    if (outcome) active.finalAssistant = outcome;
    if (event?.type === "agent_settled") active.settled = true;
    if (active.settled && active.finalAssistant) void this.finishSettled(active);
  }

  handleWorkerClose(active, details) {
    if (this.active !== active || active.finalizing) return;
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

  async finishSettled(active) {
    if (this.active !== active || active.finalizing || !active.rpcCoherent || !active.settled || !active.finalAssistant) return;
    const outcome = active.finalAssistant;
    const healthy = !outcome.hasError && outcome.stopReason !== "error" && outcome.stopReason !== "aborted";
    if (!healthy) {
      await this.settle(active, {
        success: false,
        result: outcome.result,
        detail: `Fresh Executor reported an ${outcome.stopReason || "error"} assistant outcome.`,
        checkpoint: false,
      });
      return;
    }
    await this.settle(active, {
      success: true,
      result: outcome.result,
      detail: "Fresh Executor settled successfully.",
      checkpoint: true,
    });
  }

  async retireWorker(worker) {
    if (!worker) return true;
    try { worker.close?.(); } catch { return false; }
    const processGroupId = Number.isInteger(worker.processGroupId) ? worker.processGroupId : null;
    if (!processGroupId) return true;
    return waitForProcessGroupGone(processGroupId, this.workerRetireTimeoutMs);
  }

  currentBranchHead(taskWorktree) {
    try { return git(taskWorktree, ["rev-parse", "HEAD"]); } catch { return null; }
  }

  checkpoint(task, active) {
    const worktree = task.taskWorktree;
    const dirty = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty) {
      execFileSync("git", ["add", "-A"], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["commit", "-m", `pi-sand: checkpoint completed Task ${active.taskId}`], {
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
      });
    }
    return git(worktree, ["rev-parse", "HEAD"]);
  }

  async settle(active, { success, result, detail, checkpoint }) {
    if (this.active !== active || active.finalizing) return;
    active.finalizing = true;
    const task = this.getTask(active.taskId);
    if (!task) return;
    let finalResult = result == null ? null : bounded(result, MAX_TASK_RESULT_LENGTH);
    let finalDetail = bounded(detail, MAX_TASK_DETAIL_LENGTH);
    let finalBranchHead = this.currentBranchHead(task.taskWorktree);
    let terminalState = success ? "completed" : "failed";
    let attemptState = terminalState;

    if (success && checkpoint) {
      try {
        finalBranchHead = this.checkpoint(task, active);
      } catch (error) {
        terminalState = "failed";
        attemptState = "failed";
        finalDetail = bounded(`Task Git finalization failed: ${commandError(error)}`, MAX_TASK_DETAIL_LENGTH);
      }
    }

    const retired = await this.retireWorker(active.worker);
    if (!retired) {
      terminalState = "blocked";
      attemptState = "orphaned";
      finalDetail = bounded(`${finalDetail} Fresh Executor could not be safely retired; executor capacity remains blocked.`, MAX_TASK_DETAIL_LENGTH);
    }

    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE tasks SET state = ?, updated_at = ?, final_result = ?, terminal_detail = ?, final_branch_head = ? WHERE id = ?`).run(terminalState, timestamp, finalResult, finalDetail, finalBranchHead, active.taskId);
      this.db.prepare(`UPDATE attempts SET state = ?, finished_at = ?, worker_terminated = ?, final_result = ?, terminal_detail = ?, final_branch_head = ? WHERE id = ?`).run(attemptState, timestamp, retired ? 1 : 0, finalResult, finalDetail, finalBranchHead, active.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      active.finalizing = false;
      throw error;
    }
    if (retired) this.active = null;
  }

  release() {
    if (this.closed) return;
    this.closed = true;
    try { this.active?.worker?.close?.(); } catch {}
    this.active = null;
    try { this.db?.close(); } finally {
      this.db = null;
      try { this.databaseLock?.release(); } finally { this.databaseLock = null; }
    }
  }

  close() { this.release(); }
}

export class TaskRuntime extends RuntimeStore {}
