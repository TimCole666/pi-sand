import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { acquireDatabaseLock } from "./database-lock.js";
import { runtimeDatabasePath } from "./runtime-ipc.js";

export const RUNTIME_OWNERSHIP_ERROR = "The pi-sand runtime is already owned by another daemon.";

function ensureParent(path) {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function taskSnapshot(row) {
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
    shutdownReason: row.shutdownReason ?? null,
  };
}

export class RuntimeStore {
  constructor({ dbPath = runtimeDatabasePath() } = {}) {
    this.dbPath = dbPath;
    this.databaseLock = null;
    this.db = null;
    this.closed = false;
  }

  open() {
    if (this.db) return this;
    ensureParent(this.dbPath);
    try {
      this.databaseLock = acquireDatabaseLock(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      if (this.dbPath !== ":memory:") chmodSync(this.dbPath, 0o600);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          source_repo_root TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          task_branch TEXT NOT NULL UNIQUE,
          task_worktree TEXT NOT NULL UNIQUE,
          goal TEXT NOT NULL,
          state TEXT NOT NULL,
          latest_attempt_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          final_result TEXT,
          terminal_detail TEXT,
          final_branch_head TEXT,
          shutdown_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at, id);
      `);
      return this;
    } catch (error) {
      this.release();
      if (/already running for this database/i.test(error.message)) {
        throw new Error(RUNTIME_OWNERSHIP_ERROR, { cause: error });
      }
      throw error;
    }
  }

  listTasks() {
    if (!this.db || this.closed) throw new Error("The pi-sand runtime is closed.");
    const rows = this.db.prepare(`
      SELECT id, source_repo_root AS sourceRepoRoot, base_commit AS baseCommit,
             task_branch AS taskBranch, task_worktree AS taskWorktree, goal, state,
             latest_attempt_id AS latestAttemptId, created_at AS createdAt,
             updated_at AS updatedAt, final_result AS finalResult,
             terminal_detail AS terminalDetail, final_branch_head AS finalBranchHead,
             shutdown_reason AS shutdownReason
      FROM tasks ORDER BY created_at, id
    `).all();
    return rows.map(taskSnapshot);
  }

  release() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } finally {
      this.db = null;
      try { this.databaseLock?.release(); } finally { this.databaseLock = null; }
    }
  }
}
