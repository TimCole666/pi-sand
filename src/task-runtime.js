import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDatabaseLock } from "./database-lock.js";
import { checkPiCompatibility, spawnFreshExecutor } from "./pi.js";

export const TASK_RUNTIME_OWNERSHIP_ERROR = "The pi-sand Task Runtime is already owned by another Pi process.";
export const FRESH_EXECUTOR_UNSUPPORTED_ERROR = "Fresh Executor Tasks are supported only on Linux.";
export const TASK_RUNTIME_DB_ENV = "PI_SAND_RUNTIME_DB";
export const MAX_TASK_GOAL_LENGTH = 4_000;
export const MAX_TERMINAL_DETAIL_LENGTH = 1_000;
const ACTIVE_STATES = "('starting', 'running')";
const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "interrupted"]);
const WORKER_STOP_TIMEOUT_MS = 2_000;
const WORKER_STOP_POLL_MS = 25;
const now = () => new Date().toISOString();
const errorText = (error) => String(error?.stderr || error?.message || "command failed").trim();
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function canonical(path) { return realpathSync.native(resolve(path)); }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function procStat(pid) { return readFileSync(`/proc/${pid}/stat`, "utf8"); }
function startIdentity(pid) { try { const s = procStat(pid); const p = s.lastIndexOf(")"); return p < 0 ? null : s.slice(p + 2).trim().split(/\s+/)[19] ?? null; } catch { return null; } }
function groupIdentity(pid) { try { const s = procStat(pid); const p = s.lastIndexOf(")"); return p < 0 ? null : Number(s.slice(p + 2).trim().split(/\s+/)[2]) || null; } catch { return null; } }
function bootIdentity() { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; } catch { return null; } }
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try { const s = procStat(Number(entry)); const p = s.lastIndexOf(")"); const f = s.slice(p + 2).trim().split(/\s+/); if (Number(f[2]) === pgid && f[0] !== "Z") return true; } catch {}
    }
    return false;
  } catch { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
}
function workerGone(w) { return !groupAlive(w.workerPgid); }
function owned(w) { return Number.isInteger(w.workerPid) && Number.isInteger(w.workerPgid) && Boolean(w.workerStartIdentity) && startIdentity(w.workerPid) === w.workerStartIdentity && groupIdentity(w.workerPid) === w.workerPgid && (!w.workerBootId || w.workerBootId === bootIdentity()); }
function metadata(worker) {
  const pid = Number(worker?.pid); const pgid = Number(worker?.processGroupId ?? pid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || pgid <= 0) return null;
  return { workerPid: pid, workerPgid: pgid, workerStartIdentity: worker.startIdentity ?? startIdentity(pid), workerBootId: worker.bootId ?? bootIdentity() };
}
function signalOwned(w, signal) { if (!owned(w)) return false; try { process.kill(-w.workerPgid, signal); return true; } catch (error) { return error.code === "ESRCH"; } }
function stopGroup(w, timeoutMs) {
  if (!Number.isInteger(w.workerPid) || !Number.isInteger(w.workerPgid)) return false;
  if (workerGone(w)) return true;
  if (!signalOwned(w, "SIGTERM")) return false;
  const term = Date.now() + timeoutMs;
  while (Date.now() < term) { if (workerGone(w)) return true; sleepSync(WORKER_STOP_POLL_MS); }
  if (!signalOwned(w, "SIGKILL")) return false;
  const kill = Date.now() + timeoutMs;
  while (Date.now() < kill) { if (workerGone(w)) return true; sleepSync(WORKER_STOP_POLL_MS); }
  return workerGone(w);
}

export function defaultTaskRuntimeDatabasePath() { return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-sand", "task-runtime.sqlite"); }
export function buildTaskPacket({ taskId, attemptNumber, goal, taskBranch, taskWorktree, baseCommit, priorState, priorDetail }) {
  const lines = ["pi-sand Task Packet", `Task id: ${taskId}`, `Attempt: ${attemptNumber}`, `Goal: ${goal}`, `Task branch: ${taskBranch}`, `Task worktree: ${taskWorktree}`, `Base commit: ${baseCommit}`];
  if (priorState) lines.push(`Previous attempt outcome: ${priorState}`);
  if (priorDetail) lines.push(`Previous attempt detail: ${String(priorDetail).slice(0, MAX_TERMINAL_DETAIL_LENGTH)}`);
  lines.push("Execution rules:", "- Work only in the task worktree identified above.", "- This is a fresh executor; inspect the current filesystem instead of expecting conversation history.", "- Existing filesystem changes from earlier Attempts may remain; do not reset or clean them.", "- Use Pi's normal built-in tools, Skills, and context discovery as needed.", "- Do not create, enqueue, or run another pi-sand Task. You are not the foreground Manager.");
  return lines.join("\n");
}
export function preflightGitWorkspace(cwd) {
  try { if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("workspace is not a Git worktree"); const sourceRepoRoot = canonical(git(cwd, ["rev-parse", "--show-toplevel"])); const baseCommit = git(cwd, ["rev-parse", "HEAD"]); if (git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("the source Git worktree must be clean (including untracked files)"); if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new Error("source HEAD is unavailable"); return { sourceRepoRoot, baseCommit }; }
  catch (error) { throw new Error(`Task Git preflight failed: ${errorText(error)}`, { cause: error }); }
}
function attemptView(r) { return { id: r.id, taskId: r.taskId, number: r.number, provider: r.provider, modelId: r.modelId, thinkingLevel: r.thinkingLevel, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, terminalDetail: r.terminalDetail ?? null, workerPid: r.workerPid ?? null, workerPgid: r.workerPgid ?? null, workerStartIdentity: r.workerStartIdentity ?? null, workerBootId: r.workerBootId ?? null }; }

export class TaskRuntime {
  constructor({ dbPath = process.env[TASK_RUNTIME_DB_ENV] ?? defaultTaskRuntimeDatabasePath(), piCommand = process.env.PI_BIN ?? "pi", workerFactory = spawnFreshExecutor, workerEnv, worktreeRoot, workerStopTimeoutMs = WORKER_STOP_TIMEOUT_MS } = {}) { this.dbPath = dbPath; this.piCommand = piCommand; this.workerFactory = workerFactory; this.workerEnv = workerEnv; this.worktreeRoot = worktreeRoot; this.workerStopTimeoutMs = workerStopTimeoutMs; this.db = null; this.lock = null; this.active = null; this.closed = false; }
  ensureSupported() { if (process.platform !== "linux") throw new Error(FRESH_EXECUTOR_UNSUPPORTED_ERROR); }
  ensureOwner() {
    this.ensureSupported(); if (this.closed) throw new Error("The pi-sand Task Runtime is closed."); if (this.db) return this.db; if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try { this.lock = acquireDatabaseLock(this.dbPath); this.db = new DatabaseSync(this.dbPath); this.db.exec("PRAGMA foreign_keys=ON"); this.migrateSchema(); return this.db; }
    catch (error) { try { this.db?.close(); } catch {} this.db = null; try { this.lock?.release(); } catch {} this.lock = null; if (/already running for this database/i.test(error.message)) throw new Error(TASK_RUNTIME_OWNERSHIP_ERROR, { cause: error }); throw error; }
  }
  migrateSchema() {
    const taskSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql ?? "";
    const attemptSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempts'").get()?.sql ?? "";
    if (taskSql.includes("'stopped'") && attemptSql.includes("'stopped'") && this.db.prepare("PRAGMA table_info(attempts)").all().some((c) => c.name === "terminal_detail")) return;
    this.db.exec(`PRAGMA foreign_keys=OFF; BEGIN; CREATE TABLE tasks_v03 (id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL, task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','stopped','interrupted')), latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE attempts_v03 (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_v03(id), number INTEGER NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('starting','running','completed','failed','stopped','interrupted')), started_at TEXT NOT NULL, finished_at TEXT, terminal_detail TEXT, worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT, worker_boot_id TEXT, UNIQUE(task_id,number));`);
    try { if (taskSql) this.db.exec("INSERT INTO tasks_v03 SELECT id,source_repo_root,base_commit,task_branch,task_worktree,goal,state,latest_attempt_id,created_at,updated_at FROM tasks"); if (attemptSql) this.db.exec("INSERT INTO attempts_v03 (id,task_id,number,provider,model_id,thinking_level,state,started_at,finished_at,worker_pid,worker_pgid) SELECT id,task_id,number,provider,model_id,thinking_level,state,started_at,finished_at,worker_pid,worker_pgid FROM attempts"); if (attemptSql) this.db.exec("DROP TABLE attempts"); if (taskSql) this.db.exec("DROP TABLE tasks"); this.db.exec("ALTER TABLE tasks_v03 RENAME TO tasks; ALTER TABLE attempts_v03 RENAME TO attempts; CREATE INDEX tasks_created ON tasks(created_at,id); CREATE INDEX attempts_task ON attempts(task_id,number); COMMIT; PRAGMA foreign_keys=ON"); }
    catch (error) { try { this.db.exec("ROLLBACK; PRAGMA foreign_keys=ON"); } catch {} throw error; }
  }
  taskRow(id) { return this.db.prepare("SELECT id,source_repo_root AS sourceRepoRoot,base_commit AS baseCommit,task_branch AS taskBranch,task_worktree AS taskWorktree,goal,state,latest_attempt_id AS latestAttemptId,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE id=?").get(id); }
  taskWithAttempts(row) { if (!row) return null; const attempts = this.db.prepare("SELECT id,task_id AS taskId,number,provider,model_id AS modelId,thinking_level AS thinkingLevel,state,started_at AS startedAt,finished_at AS finishedAt,terminal_detail AS terminalDetail,worker_pid AS workerPid,worker_pgid AS workerPgid,worker_start_identity AS workerStartIdentity,worker_boot_id AS workerBootId FROM attempts WHERE task_id=? ORDER BY number").all(row.id).map(attemptView); return { ...row, attempts }; }
  listTasks() { this.ensureOwner(); return this.db.prepare("SELECT id,source_repo_root AS sourceRepoRoot,base_commit AS baseCommit,task_branch AS taskBranch,task_worktree AS taskWorktree,goal,state,latest_attempt_id AS latestAttemptId,created_at AS createdAt,updated_at AS updatedAt FROM tasks ORDER BY created_at,id").all().map((r) => this.taskWithAttempts(r)); }
  getTask(id) { this.ensureOwner(); return this.taskWithAttempts(this.taskRow(id)); }
  createWorktree(repoRoot, baseCommit, taskId) { const root = this.worktreeRoot ?? join(dirname(repoRoot), ".pi-sand-tasks"); const worktree = join(root, taskId); const taskBranch = `pi-sand/task-${taskId}`; mkdirSync(root, { recursive: true, mode: 0o700 }); try { execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", taskBranch, worktree, baseCommit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { taskBranch, taskWorktree: canonical(worktree) }; } catch (error) { throw new Error(`Task worktree creation failed: ${errorText(error)}`, { cause: error }); } }
  hasActive() { return Boolean(this.active || this.db.prepare(`SELECT id FROM attempts WHERE state IN ${ACTIVE_STATES} LIMIT 1`).get()); }
  launch(task, attemptId, number, model, thinkingLevel, priorState, priorDetail) {
    const packet = buildTaskPacket({ taskId: task.id, attemptNumber: number, goal: task.goal, taskBranch: task.taskBranch, taskWorktree: task.taskWorktree, baseCommit: task.baseCommit, priorState, priorDetail }); let worker;
    try { worker = this.workerFactory({ cwd: task.taskWorktree, command: this.piCommand, env: this.workerEnv, provider: model.provider, modelId: model.id, thinkingLevel, onEvent: () => {}, onClose: (result) => this.workerClosed(attemptId, result) }); const m = metadata(worker); const t = now(); this.db.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=?").run(t, task.id); this.db.prepare("UPDATE attempts SET state='running',worker_pid=?,worker_pgid=?,worker_start_identity=?,worker_boot_id=? WHERE id=?").run(m?.workerPid ?? null, m?.workerPgid ?? null, m?.workerStartIdentity ?? null, m?.workerBootId ?? null, attemptId); this.active = { taskId: task.id, attemptId, worker, packet }; worker.setModel?.({ provider: model.provider, modelId: model.id }); worker.setThinkingLevel?.(thinkingLevel); worker.prompt({ id: `task-${attemptId}`, message: packet }); }
    catch (error) { const t = now(); this.db.prepare("UPDATE attempts SET state='failed',finished_at=?,terminal_detail=? WHERE id=? AND state IN ('starting','running')").run(t, `Fresh Executor could not start: ${errorText(error)}`.slice(0, MAX_TERMINAL_DETAIL_LENGTH), attemptId); this.db.prepare("UPDATE tasks SET state='failed',updated_at=? WHERE id=? AND state IN ('accepted','running')").run(t, task.id); if (this.active?.attemptId === attemptId) this.active = null; throw new Error(`Fresh Executor could not start: ${errorText(error)}`, { cause: error }); }
  }
  workerClosed(attemptId, { code = null, signal = null, error } = {}) { if (this.closed || !this.db) return; const a = this.db.prepare("SELECT task_id AS taskId,state FROM attempts WHERE id=?").get(attemptId); if (!a || !["starting", "running"].includes(a.state)) return; const t = now(); const detail = (error ? `Fresh Executor failed: ${errorText(error)}` : signal ? `Fresh Executor exited with ${signal}.` : `Fresh Executor exited with code ${code}.`).slice(0, MAX_TERMINAL_DETAIL_LENGTH); this.db.prepare("UPDATE attempts SET state='failed',finished_at=?,terminal_detail=? WHERE id=? AND state IN ('starting','running')").run(t, detail, attemptId); this.db.prepare("UPDATE tasks SET state='failed',updated_at=? WHERE id=? AND state='running'").run(t, a.taskId); if (this.active?.attemptId === attemptId) this.active = null; }
  startTask({ goal, cwd, trusted, model, thinkingLevel }) { this.ensureSupported(); if (typeof goal !== "string" || !goal.trim()) throw new Error("/task requires a goal"); if (goal.trim().length > MAX_TASK_GOAL_LENGTH) throw new Error(`/task goal must be ${MAX_TASK_GOAL_LENGTH} characters or fewer.`); if (!trusted) throw new Error("/task requires a trusted Pi project."); if (!model?.provider || !model?.id) throw new Error("/task requires a selected provider and model."); if (!thinkingLevel) throw new Error("/task requires a selected thinking level."); const p = preflightGitWorkspace(cwd); const compatibility = checkPiCompatibility({ command: this.piCommand, cwd: p.sourceRepoRoot }); if (!compatibility.compatible || compatibility.version !== "0.84.4") throw new Error("/task requires an installed Pi 0.84.4 executable."); const db = this.ensureOwner(); if (this.hasActive()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks."); const id = randomUUID(); const w = this.createWorktree(p.sourceRepoRoot, p.baseCommit, id); const task = { id, sourceRepoRoot: p.sourceRepoRoot, baseCommit: p.baseCommit, taskBranch: w.taskBranch, taskWorktree: w.taskWorktree, goal: goal.trim() }; const aid = randomUUID(); const t = now(); try { db.exec("BEGIN"); db.prepare("INSERT INTO tasks (id,source_repo_root,base_commit,task_branch,task_worktree,goal,state,latest_attempt_id,created_at,updated_at) VALUES (?,?,?,?,?,?, 'accepted',?,?,?)").run(id,p.sourceRepoRoot,p.baseCommit,w.taskBranch,w.taskWorktree,task.goal,aid,t,t); db.prepare("INSERT INTO attempts (id,task_id,number,provider,model_id,thinking_level,state,started_at) VALUES (?,?,1,?,?,?,'starting',?)").run(aid,id,model.provider,model.id,thinkingLevel,t); db.exec("COMMIT"); } catch (error) { try { db.exec("ROLLBACK"); } catch {} try { execFileSync("git", ["-C", p.sourceRepoRoot, "worktree", "remove", "--force", w.taskWorktree], { stdio: "ignore" }); } catch {} throw error; } this.launch(task, aid, 1, model, thinkingLevel); return this.getTask(id); }
  safelyGone(a) { return !Number.isInteger(a.workerPid) || !Number.isInteger(a.workerPgid) || workerGone(a); }
  stopTask(id) { this.ensureSupported(); if (typeof id !== "string" || !id.trim()) throw new Error("/task-stop requires a Task id"); const db = this.ensureOwner(); const task = this.taskRow(id.trim()); if (!task) throw new Error(`Task ${id} was not found.`); if (task.state !== "running") throw new Error(`Task ${id} is already terminal (${task.state}); it is not active.`); const a = db.prepare("SELECT id,task_id AS taskId,state,worker_pid AS workerPid,worker_pgid AS workerPgid,worker_start_identity AS workerStartIdentity,worker_boot_id AS workerBootId FROM attempts WHERE id=? AND task_id=?").get(task.latestAttemptId, task.id); if (!a || !["starting", "running"].includes(a.state)) throw new Error(`Task ${id} has no active Attempt to stop.`); let stopped = false; if (Number.isInteger(a.workerPid) && Number.isInteger(a.workerPgid)) stopped = stopGroup(a, this.workerStopTimeoutMs); else if (this.active?.worker?.close) { this.active.worker.close(); stopped = true; } if (!stopped || !this.safelyGone(a)) throw new Error(`Task ${id} worker could not be safely terminated; no outcome was recorded.`); const t = now(); db.exec("BEGIN"); try { db.prepare("UPDATE attempts SET state='stopped',finished_at=?,terminal_detail=? WHERE id=? AND state IN ('starting','running')").run(t,"The Task was intentionally stopped by the user.",a.id); db.prepare("UPDATE tasks SET state='stopped',updated_at=? WHERE id=? AND state='running'").run(t,task.id); db.exec("COMMIT"); } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } if (this.active?.attemptId === a.id) this.active = null; return this.getTask(task.id); }
  retryTask({ id, trusted, model, thinkingLevel }) { this.ensureSupported(); if (typeof id !== "string" || !id.trim()) throw new Error("/task-retry requires a Task id"); if (!trusted) throw new Error("/task-retry requires a trusted Pi project."); if (!model?.provider || !model?.id) throw new Error("/task-retry requires a selected provider and model."); if (!thinkingLevel) throw new Error("/task-retry requires a selected thinking level."); const db = this.ensureOwner(); const task = this.taskRow(id.trim()); if (!task) throw new Error(`Task ${id} was not found.`); if (task.state === "completed" || task.state === "blocked") throw new Error(`Task ${id} is ${task.state} and cannot be retried in v0.3.`); if (!["failed", "stopped", "interrupted"].includes(task.state)) throw new Error(`Task ${id} is not retryable (${task.state}).`); if (this.hasActive()) throw new Error("A Fresh Executor is already active; v0.3 does not queue Tasks."); try { if (canonical(task.taskWorktree) !== task.taskWorktree) throw new Error("worktree identity changed"); } catch (error) { throw new Error(`Task ${id} worktree is unavailable; retry was not started.`, { cause: error }); } const prior = db.prepare("SELECT id,state,number,terminal_detail AS terminalDetail,worker_pid AS workerPid,worker_pgid AS workerPgid,worker_start_identity AS workerStartIdentity,worker_boot_id AS workerBootId FROM attempts WHERE id=? AND task_id=?").get(task.latestAttemptId,task.id); if (!prior || !TERMINAL_STATES.has(prior.state)) throw new Error(`Task ${id} previous Attempt is not terminal.`); if (!this.safelyGone(prior)) throw new Error(`Task ${id} previous worker is not safely gone; retry was not started.`); const aid = randomUUID(); const t = now(); try { db.exec("BEGIN"); db.prepare("INSERT INTO attempts (id,task_id,number,provider,model_id,thinking_level,state,started_at) VALUES (?,?,?,?,?,?, 'starting',?)").run(aid,task.id,prior.number+1,model.provider,model.id,thinkingLevel,t); db.prepare("UPDATE tasks SET state='running',latest_attempt_id=?,updated_at=? WHERE id=? AND state IN ('failed','stopped','interrupted')").run(aid,t,task.id); db.exec("COMMIT"); } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } this.launch(task,aid,prior.number+1,model,thinkingLevel,prior.state,prior.terminalDetail); return this.getTask(task.id); }
  close() { if (this.closed) return; this.closed = true; try { this.active?.worker?.close?.(); } catch {} this.active = null; try { this.db?.close(); } catch {} this.db = null; try { this.lock?.release(); } catch {} this.lock = null; }
}
