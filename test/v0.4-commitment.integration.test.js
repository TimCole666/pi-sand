import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../src/runtime-store.js";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function repository(parent) {
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "fixture.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  return source;
}

async function versionCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

async function eventually(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await wait(10);
  }
  throw new Error("timed out waiting for AttemptRun settlement");
}

const model = { provider: "provider", id: "model" };

function taskOptions(source) {
  return {
    goal: "persist the commitment seam",
    cwd: source,
    trusted: true,
    model,
    thinkingLevel: "high",
  };
}

test("existing v0.3 Task rows migrate to the Task-backed Commitment without a destructive rewrite", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-migration-"));
  const dbPath = join(parent, "runtime.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
      task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
      state TEXT NOT NULL, latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      final_result TEXT, terminal_detail TEXT, final_branch_head TEXT, shutdown_reason TEXT
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
      provider TEXT, model_id TEXT, thinking_level TEXT, state TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
      worker_terminated INTEGER NOT NULL DEFAULT 1, final_result TEXT, terminal_detail TEXT,
      final_branch_head TEXT, shutdown_reason TEXT, applied_provider TEXT,
      applied_model_id TEXT, applied_thinking_level TEXT, UNIQUE(task_id, number)
    );
    INSERT INTO tasks (id, source_repo_root, base_commit, task_branch, task_worktree, goal,
      state, latest_attempt_id, created_at, updated_at, final_result, terminal_detail,
      final_branch_head, shutdown_reason)
    VALUES ('task-1', '/source', 'base', 'pi-sand/task-1', '/worktree', 'legacy goal',
      'completed', 'attempt-1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z',
      'legacy result', 'legacy completion', 'deadbeef', NULL);
    INSERT INTO attempts (id, task_id, number, state, started_at, finished_at, final_result)
    VALUES ('attempt-1', 'task-1', 1, 'completed', '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:01.000Z', 'legacy result');
  `);
  db.close();

  const runtime = new RuntimeStore({ dbPath, bootId: "boot" });
  try {
    const task = runtime.getTask("task-1");
    assert.equal(task.contractVersion, 1);
    assert.equal(task.controlVersion, 1);
    assert.equal(task.acceptedAt, "2020-01-01T00:00:00.000Z");
    assert.deepEqual(task.completionContract, { objective: "legacy goal" });
    assert.deepEqual(task.authority, { owner: "pi-sandd" });
    assert.deepEqual(task.budget, {});
    assert.deepEqual(task.returnRoute, { kind: "manager" });
    assert.equal(task.finalRevision, "deadbeef");
    assert.equal(task.attempts[0].attemptRuns.length, 1);
    assert.deepEqual(task.attempts[0].attemptRuns[0], {
      attemptId: "attempt-1",
      sequence: 1,
      kind: "initial",
      controlVersion: 1,
      contractVersion: 1,
      promptDigest: null,
      state: "settled",
      settledOutcome: "legacy result",
      evidenceRefs: [],
      startedAt: "2020-01-01T00:00:00.000Z",
      settledAt: "2020-01-01T00:00:01.000Z",
    });
    assert.equal(
      runtime.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commitments'")
        .get(),
      undefined,
    );
    assert.equal(
      runtime.db.prepare("SELECT COUNT(*) AS count FROM attempt_runs").get().count,
      1,
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("healthy initial settlement persists one AttemptRun without completing the Task", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-commitment-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  let emit;
  let observedBeforeWorker;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ taskPrompt, onEvent }) => {
      emit = onEvent;
      observedBeforeWorker = runtime.listTasks()[0];
      assert.match(taskPrompt, /^pi-sand Task Packet/m);
      return { callbacksAttached: true, close() {} };
    },
  });

  try {
    const started = await runtime.createTask(taskOptions(source));
    assert.equal(observedBeforeWorker.state, "accepted");
    assert.equal(observedBeforeWorker.contractVersion, 1);
    assert.equal(observedBeforeWorker.controlVersion, 1);
    assert.deepEqual(observedBeforeWorker.completionContract, {
      objective: "persist the commitment seam",
    });
    assert.deepEqual(observedBeforeWorker.authority, { owner: "pi-sandd" });
    assert.deepEqual(observedBeforeWorker.budget, {});
    assert.deepEqual(observedBeforeWorker.returnRoute, { kind: "manager" });
    assert.ok(observedBeforeWorker.acceptedAt);
    assert.equal(observedBeforeWorker.finalRevision, null);
    assert.equal(observedBeforeWorker.completionEvidenceRef, null);
    assert.equal(observedBeforeWorker.terminalReason, null);
    assert.equal(observedBeforeWorker.attempts.length, 1);
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns.length, 1);
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns[0].sequence, 1);
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns[0].kind, "initial");
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns[0].controlVersion, 1);
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns[0].contractVersion, 1);
    assert.match(
      observedBeforeWorker.attempts[0].attemptRuns[0].promptDigest,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(observedBeforeWorker.attempts[0].attemptRuns[0].state, "pending");

    const accepted = runtime.getTask(started.id);
    assert.equal(accepted.state, "running");
    assert.equal(accepted.attempts[0].attemptRuns[0].state, "accepted");

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "candidate is ready" }],
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });

    const settled = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    assert.equal(settled.state, "running");
    assert.equal(settled.attempts[0].state, "running");
    assert.equal(
      settled.attempts[0].attemptRuns[0].settledOutcome,
      "candidate is ready",
    );
    assert.deepEqual(settled.attempts[0].attemptRuns[0].evidenceRefs, []);
    assert.ok(settled.attempts[0].attemptRuns[0].settledAt);

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "candidate is ready" }],
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });
    await wait(25);

    const afterDuplicate = runtime.getTask(started.id);
    assert.equal(afterDuplicate.attempts[0].attemptRuns.length, 1);
    assert.equal(afterDuplicate.state, "running");
    assert.equal(
      afterDuplicate.attempts.filter(({ state }) => state === "completed").length,
      0,
    );
    assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});
