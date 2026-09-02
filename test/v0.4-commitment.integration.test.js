import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_EVIDENCE_OUTPUT_LENGTH,
  MAX_EVIDENCE_PAYLOAD_LENGTH,
  RuntimeStore,
} from "../src/runtime-store.js";
import { processGroupStatus } from "../src/process.js";

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

function taskOptions(source, completionContract) {
  return {
    goal: "persist the commitment seam",
    cwd: source,
    trusted: true,
    model,
    thinkingLevel: "high",
    ...(completionContract ? { completionContract } : {}),
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
    const attemptSchema = runtime.db.prepare("PRAGMA table_info(attempts)").all();
    for (const name of [
      "gate_pid",
      "gate_pgid",
      "gate_start_identity",
      "gate_boot_id",
      "gate_state",
      "gate_terminated",
    ])
      assert.ok(attemptSchema.some((column) => column.name === name));
    assert.equal(task.attempts[0].gateState, "none");
    assert.equal(task.attempts[0].gateTerminated, true);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("expired total commitment fences explicit correction and retry without allocating an Attempt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-commitment-expired-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  let clock = Date.now();
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    attemptClock: () => clock,
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  try {
    const started = await runtime.createTask({
      ...taskOptions(source),
      budget: { totalCommitmentWallClockDeadlineMs: 1 },
    });
    const accepted = runtime.getTask(started.id);
    clock = Date.parse(accepted.acceptedAt) + 2;
    await assert.rejects(
      () => runtime.correctTask({ id: started.id, objective: "late correction", model, thinkingLevel: "high" }),
      (error) => error.code === "commitment_expired",
    );
    assert.equal(runtime.getTask(started.id).attempts.length, 1);
    await runtime.stopTask(started.id);
    const stopped = runtime.getTask(started.id);
    await assert.rejects(
      () => runtime.retryTask({ id: started.id, trusted: true, model, thinkingLevel: "high" }),
      (error) => error.code === "commitment_expired",
    );
    const afterRetry = runtime.getTask(started.id);
    assert.equal(afterRetry.attempts.length, 1);
    assert.equal(afterRetry.controlVersion, stopped.controlVersion);
    assert.equal(afterRetry.state, "stopped");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("correction rechecks the total commitment deadline after retiring the prior Attempt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-commitment-race-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  let clock = Date.now();
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    attemptClock: () => clock,
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  try {
    const started = await runtime.createTask({
      ...taskOptions(source),
      budget: { totalCommitmentWallClockDeadlineMs: 1 },
    });
    const accepted = runtime.getTask(started.id);
    runtime.terminateOwnedWorker = async () => {
      clock = Date.parse(accepted.acceptedAt) + 2;
      return true;
    };

    await assert.rejects(
      () => runtime.correctTask({ id: started.id, objective: "late after retirement", model, thinkingLevel: "high" }),
      (error) => error.code === "commitment_expired",
    );
    const after = runtime.getTask(started.id);
    assert.equal(after.state, "blocked");
    assert.equal(after.attempts.length, 1);
    assert.equal(after.latestAttemptId, after.attempts[0].id);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a crash after correction fencing resumes the durable replacement Attempt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-commitment-recovery-"));
  const source = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  let releaseTermination;
  const terminationGate = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  let terminationStarted;
  const terminationStartedPromise = new Promise((resolve) => {
    terminationStarted = resolve;
  });
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  let restarted;
  let correction;
  try {
    const started = await runtime.createTask({ ...taskOptions(source) });
    runtime.terminateOwnedWorker = async () => {
      terminationStarted();
      await terminationGate;
      return true;
    };
    correction = runtime.correctTask({
      id: started.id,
      objective: "resume the corrected commitment",
      model,
      thinkingLevel: "high",
    });
    await terminationStartedPromise;
    const pending = runtime.db
      .prepare("SELECT pending_attempt AS pendingAttempt FROM tasks WHERE id = ?")
      .get(started.id);
    assert.ok(pending.pendingAttempt);
    const priorAttempt = runtime.getTask(started.id).attempts[0];
    assert.equal(runtime.getTask(started.id).attempts.length, 1);

    // Model the recorded prior worker belonging to the crashed boot. The
    // pending control marker is the only durable replacement intent; no
    // replacement Attempt has been inserted yet.
    runtime.db
      .prepare("UPDATE attempts SET worker_pid = 999999, worker_pgid = 999999, worker_boot_id = 'prior-boot', worker_terminated = 0 WHERE id = ?")
      .run(priorAttempt.id);
    runtime.release();

    restarted = new RuntimeStore({
      dbPath,
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    });
    restarted.open();
    const recovered = await restarted.recoverPersistedAttempts();
    assert.equal(recovered.length, 1);
    const task = restarted.getTask(started.id);
    assert.equal(task.state, "running");
    assert.equal(task.attempts.length, 2);
    assert.equal(task.latestAttemptId, task.attempts[1].id);
    assert.equal(task.attempts[0].state, "superseded");
    assert.equal(task.attempts[0].workerTerminated, true);
    assert.equal(task.attempts[1].launchPhase, "recorded");
    assert.equal(
      restarted.db.prepare("SELECT pending_attempt FROM tasks WHERE id = ?").get(started.id).pending_attempt,
      null,
    );
  } finally {
    releaseTermination?.();
    await correction?.catch(() => {});
    restarted?.close();
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a crash after retry fencing resumes the durable replacement Attempt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-retry-recovery-"));
  const source = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  let releaseTermination;
  const terminationGate = new Promise((resolveTermination) => {
    releaseTermination = resolveTermination;
  });
  let terminationStarted;
  const terminationStartedPromise = new Promise((resolveStarted) => {
    terminationStarted = resolveStarted;
  });
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  let restarted;
  let retry;
  try {
    const started = await runtime.createTask({ ...taskOptions(source) });
    const stopped = await runtime.stopTask(started.id);
    const priorId = stopped.attempts[0].id;
    runtime.db
      .prepare("UPDATE attempts SET worker_pid = 999999, worker_pgid = 999999, worker_boot_id = 'prior-boot', worker_terminated = 0 WHERE id = ?")
      .run(priorId);
    runtime.terminateOwnedWorker = async () => {
      terminationStarted();
      await terminationGate;
      return true;
    };

    retry = runtime.retryTask({
      id: started.id,
      trusted: true,
      model,
      thinkingLevel: "high",
    });
    await terminationStartedPromise;
    const pendingTask = runtime.getTask(started.id);
    assert.equal(pendingTask.state, "accepted");
    assert.equal(pendingTask.attempts.length, 1);
    assert.ok(
      runtime.db.prepare("SELECT pending_attempt FROM tasks WHERE id = ?").get(started.id)
        .pending_attempt,
    );

    runtime.release();
    restarted = new RuntimeStore({
      dbPath,
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    });
    restarted.open();
    const recovered = await restarted.recoverPersistedAttempts();
    assert.equal(recovered.length, 1);
    const task = restarted.getTask(started.id);
    assert.equal(task.state, "running");
    assert.equal(task.attempts.length, 2);
    assert.equal(task.attempts[0].state, "stopped");
    assert.equal(task.attempts[0].workerTerminated, true);
    assert.equal(task.latestAttemptId, task.attempts[1].id);
    assert.equal(task.attempts[1].launchPhase, "recorded");
    assert.equal(
      restarted.db.prepare("SELECT pending_attempt FROM tasks WHERE id = ?").get(started.id)
        .pending_attempt,
      null,
    );
  } finally {
    releaseTermination?.();
    await retry?.catch(() => {});
    restarted?.close();
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("failed correction retirement retains its recovery marker across restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-correction-retirement-"));
  const source = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  let restarted;
  try {
    const started = await runtime.createTask({ ...taskOptions(source) });
    const priorId = started.attempts[0].id;
    runtime.db
      .prepare("UPDATE attempts SET worker_pid = 999999, worker_pgid = 999999, worker_boot_id = 'prior-boot', worker_terminated = 0 WHERE id = ?")
      .run(priorId);
    runtime.terminateOwnedWorker = async () => false;

    await assert.rejects(
      () => runtime.correctTask({
        id: started.id,
        objective: "retain the failed retirement proof",
        model,
        thinkingLevel: "high",
      }),
      /correction fence was committed/,
    );
    const blocked = runtime.getTask(started.id);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.attempts.length, 1);
    assert.equal(blocked.attempts[0].state, "orphaned");
    assert.equal(blocked.attempts[0].workerTerminated, false);
    assert.ok(
      runtime.db.prepare("SELECT pending_attempt FROM tasks WHERE id = ?").get(started.id)
        .pending_attempt,
    );

    runtime.release();
    restarted = new RuntimeStore({
      dbPath,
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    });
    restarted.open();
    const recovered = await restarted.recoverPersistedAttempts();
    assert.deepEqual(recovered, []);
    const after = restarted.getTask(started.id);
    assert.equal(after.state, "blocked");
    assert.equal(after.attempts.length, 1);
    assert.equal(after.attempts[0].state, "superseded");
    assert.equal(after.attempts[0].workerTerminated, true);
    assert.equal(
      restarted.db.prepare("SELECT pending_attempt FROM tasks WHERE id = ?").get(started.id)
        .pending_attempt,
      null,
    );
  } finally {
    restarted?.close();
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

test("Supervisor records the exact candidate and failed local gate without completing", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-fail-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ cwd, onEvent }) => {
      await writeFile(join(cwd, "worker.txt"), "worker\\n");
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "done is not authority",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        objective: "verify the candidate",
        localGates: [
          {
            id: "required-test",
            command: [
              process.execPath,
              "-e",
              "process.stderr.write('gate failed\\\\n'); process.exit(7)",
            ],
          },
        ],
      }),
    );
    const failed = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.state !== "running",
    );
    const candidate = git(failed.taskWorktree, ["rev-parse", "HEAD"]);
    assert.equal(failed.state, "failed");
    assert.equal(failed.finalRevision, candidate);
    assert.equal(failed.finalBranchHead, candidate);
    assert.equal(failed.finalResult, "done is not authority");
    assert.equal(git(source, ["rev-parse", "HEAD"]), failed.baseCommit);
    assert.equal(
      git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
    );
    assert.equal(
      git(failed.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      "",
    );
    const evidence = runtime.db
      .prepare(
        "SELECT kind, subject, payload, payload_digest FROM evidence WHERE task_id = ? ORDER BY observed_at, id",
      )
      .all(failed.id);
    assert.deepEqual(
      evidence.map(({ kind, subject }) => ({ kind, subject })),
      [
        { kind: "git_identity", subject: candidate },
        { kind: "local_gate_result", subject: candidate },
      ],
    );
    const gate = JSON.parse(evidence[1].payload);
    assert.equal(gate.candidateSha, candidate);
    assert.equal(gate.criterion, "required-test");
    assert.equal(gate.exitCategory, "nonzero");
    assert.equal(gate.exitCode, 7);
    assert.equal(gate.stdout, "");
    assert.equal(gate.stderr, "gate failed\\n");
    assert.match(evidence[1].payload_digest, /^[0-9a-f]{64}$/);
    assert.equal(
      failed.attempts[0].attemptRuns[0].evidenceRefs.length,
      2,
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Supervisor preserves worker commits, checkpoints residual changes, and completes after a passing gate", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-pass-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ cwd, onEvent }) => {
      await writeFile(join(cwd, "worker.txt"), "worker\\n");
      execFileSync("git", ["add", "worker.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "worker commit"], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "worker",
          GIT_AUTHOR_EMAIL: "worker@example.com",
          GIT_COMMITTER_NAME: "worker",
          GIT_COMMITTER_EMAIL: "worker@example.com",
        },
      });
      await writeFile(join(cwd, "residual.txt"), "residual\\n");
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "executor says done",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        objective: "verify the candidate",
        localGates: [
          {
            id: "required-test",
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('gate passed\\\\n')",
            ],
          },
        ],
      }),
    );
    const completed = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.state === "completed",
    );
    const candidate = git(completed.taskWorktree, ["rev-parse", "HEAD"]);
    assert.equal(completed.finalRevision, candidate);
    assert.equal(completed.finalBranchHead, candidate);
    assert.equal(completed.terminalReason, "verified_local");
    assert.deepEqual(
      git(completed.taskWorktree, ["log", "--format=%s", "-3"]).split("\n"),
      [
        "pi-sand: checkpoint completed Task " + completed.id,
        "worker commit",
        "base",
      ],
    );
    assert.equal(
      git(completed.taskWorktree, ["log", "-1", "--format=%an <%ae>"]),
      "pi-sand <pi-sand@localhost>",
    );
    assert.equal(
      git(completed.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      "",
    );
    assert.equal(
      JSON.parse(completed.completionEvidenceRef).length,
      2,
    );
    assert.equal(completed.attempts[0].state, "completed");
    assert.equal(completed.attempts[0].workerTerminated, true);
    assert.equal(completed.attempts[0].attemptRuns[0].state, "settled");
    assert.equal(completed.attempts[0].attemptRuns[0].evidenceRefs.length, 2);
    assert.equal(git(source, ["rev-parse", "HEAD"]), completed.baseCommit);
    assert.equal(
      git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Supervisor rejects a gate that changes the candidate worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-mutation-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "done",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        objective: "verify the candidate",
        localGates: [
          {
            id: "mutating-check",
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync('after-gate.txt', 'changed\\\\n')",
            ],
          },
        ],
      }),
    );
    const failed = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.state !== "running",
    );
    const candidate = git(failed.taskWorktree, ["rev-parse", "HEAD"]);
    assert.notEqual(failed.state, "completed");
    assert.equal(failed.finalRevision, candidate);
    assert.equal(
      git(failed.taskWorktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      "?? after-gate.txt",
    );
    const gate = runtime.db
      .prepare(
        "SELECT payload FROM evidence WHERE task_id = ? AND kind = 'local_gate_result'",
      )
      .get(failed.id);
    assert.equal(JSON.parse(gate.payload).exitCategory, "working_tree_changed");
    assert.equal(JSON.parse(gate.payload).candidateSha, candidate);
    assert.equal(git(source, ["rev-parse", "HEAD"]), failed.baseCommit);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("local gate commands reject an actual NUL argument before Task acceptance", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-nul-"));
  const source = await repository(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  try {
    await assert.rejects(
      runtime.createTask(
        taskOptions(source, {
          localGates: [
            {
              command: [process.execPath, "-e", "process.exit(0)", "bad\0arg"],
            },
          ],
        }),
      ),
      /non-empty executable command array/,
    );
    assert.deepEqual(runtime.listTasks(), []);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("candidate recording failure ends the Attempt durably without requiring an unrecorded SHA", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-candidate-record-fail-"));
  const source = await repository(parent);
  let emit;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        localGates: [
          {
            id: "required-test",
            command: [process.execPath, "-e", "process.exit(0)"],
          },
        ],
      }),
    );
    runtime.db.exec(`CREATE TRIGGER fail_candidate_record
      BEFORE UPDATE OF final_revision ON tasks
      WHEN NEW.state IN ('accepted', 'running') AND NEW.final_revision IS NOT OLD.final_revision
      BEGIN SELECT RAISE(ABORT, 'injected candidate recording failure'); END`);
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "candidate could not be recorded",
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });

    const failed = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.state !== "running",
      2_000,
    );
    assert.equal(failed.state, "failed");
    assert.equal(failed.finalRevision, null);
    assert.equal(
      failed.finalBranchHead,
      git(failed.taskWorktree, ["rev-parse", "HEAD"]),
    );
    assert.equal(failed.attempts[0].state, "failed");
    assert.equal(failed.attempts[0].attemptRuns[0].state, "settled");
    await wait(50);
    assert.equal(runtime.getTask(started.id).state, "failed");
    assert.equal(
      runtime.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE task_id = ?").get(started.id).count,
      0,
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Stop wins while a local gate is running and does not replay the gate", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-stop-"));
  const source = await repository(parent);
  const marker = join(parent, "gate-started");
  let gatePid = null;
  let workerPid = null;
  let emit;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent, onWorkerSpawn }) => {
      const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        detached: true,
        stdio: "ignore",
      });
      workerPid = worker.pid;
      const handle = { pid: worker.pid, processGroupId: worker.pid, close() {} };
      onWorkerSpawn(handle);
      emit = onEvent;
      return handle;
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        localGates: [
          {
            id: "slow-test",
            timeoutMs: 5_000,
            command: [
              process.execPath,
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1_000);`,
            ],
          },
        ],
      }),
    );
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "candidate ready",
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });
    await eventually(() => existsSync(marker), Boolean, 2_000);
    gatePid = Number(readFileSync(marker, "utf8"));
    const stopStartedAt = Date.now();
    const stopped = await runtime.stopTask(started.id);
    assert.equal(stopped.state, "stopped");
    const gateState = runtime.db
      .prepare("SELECT gate_state AS gateState, gate_terminated AS gateTerminated FROM attempts WHERE id = ?")
      .get(stopped.latestAttemptId);
    assert.equal(gateState.gateState, "terminated");
    assert.equal(gateState.gateTerminated, 1);
    assert.ok(Date.now() - stopStartedAt < 1_500);
    await wait(100);
    assert.equal(runtime.getTask(started.id).state, "stopped");
    assert.equal(runtime.getTask(started.id).completionEvidenceRef, null);
  } finally {
    for (const pid of [gatePid, workerPid]) {
      if (!pid) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("bounded local gate stdout and stderr persist in one evidence receipt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-output-"));
  const source = await repository(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "candidate ready",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const completed = await runtime.createTask(
      taskOptions(source, {
        localGates: [
          {
            id: "bounded-output",
            command: [
              process.execPath,
              "-e",
              `process.stdout.write("o".repeat(${MAX_EVIDENCE_OUTPUT_LENGTH})); process.stderr.write("e".repeat(${MAX_EVIDENCE_OUTPUT_LENGTH}));`,
            ],
          },
        ],
      }),
    );
    const settled = await eventually(
      () => runtime.getTask(completed.id),
      (task) => task.state === "completed",
      2_000,
    );
    const gate = settled.evidence.find(
      ({ kind }) => kind === "local_gate_result",
    );
    assert.ok(gate);
    assert.equal(gate.subject, settled.finalRevision);
    assert.equal(gate.payload.stdout.length, MAX_EVIDENCE_OUTPUT_LENGTH);
    assert.equal(gate.payload.stderr.length, MAX_EVIDENCE_OUTPUT_LENGTH);
    assert.equal(settled.attempts[0].attemptRuns[0].evidenceRefs.length, 2);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a zero-exit gate leader cannot pass while an unref'd group descendant can mutate the Task worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-descendant-"));
  const source = await repository(parent);
  const descendantPidFile = join(parent, "gate-descendant-pid");
  const gateGroupPidFile = join(parent, "gate-group-pid");
  const lateMutation = "late-gate-mutation.txt";
  let gateGroupPid = null;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "gate leader says done",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  try {
    const started = await runtime.createTask(
      taskOptions(source, {
        localGates: [
          {
            id: "detached-descendant-check",
            timeoutMs: 2_000,
            command: [
              process.execPath,
              "-e",
              `const { spawn } = require("node:child_process"); const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(gateGroupPidFile)}, String(process.pid)); const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); setTimeout(() => { try { fs.writeFileSync(${JSON.stringify(lateMutation)}, "late\\n"); } catch {} }, 250); setTimeout(() => {}, 1_000);`)}], { cwd: process.cwd(), stdio: "ignore" }); descendant.unref(); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid)); setTimeout(() => process.exit(0), 100);`,
            ],
          },
        ],
      }),
    );
    await eventually(() => existsSync(gateGroupPidFile), Boolean, 2_000);
    gateGroupPid = Number(readFileSync(gateGroupPidFile, "utf8"));
    await eventually(() => existsSync(descendantPidFile), Boolean, 2_000);
    assert.equal(processGroupStatus(gateGroupPid), "alive");

    const outcome = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.state !== "running",
      2_000,
    );
    assert.equal(outcome.state, "blocked");
    assert.equal(outcome.completionEvidenceRef, null);
    const gate = outcome.evidence.find(
      ({ kind }) => kind === "local_gate_result",
    );
    assert.ok(gate);
    assert.equal(gate.payload.exitCode, 0);
    assert.equal(gate.payload.exitCategory, "gate_termination_ambiguous");
    assert.equal(gate.payload.processTerminated, false);
    assert.ok(
      Buffer.byteLength(JSON.stringify(gate.payload), "utf8") <=
        MAX_EVIDENCE_PAYLOAD_LENGTH,
    );

    await eventually(
      () => existsSync(join(outcome.taskWorktree, "late-gate-mutation.txt")),
      Boolean,
      2_000,
    );
    assert.notEqual(runtime.getTask(started.id).state, "completed");
  } finally {
    if (gateGroupPid) {
      try {
        process.kill(-gateGroupPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("restart fences a durable local gate after its leader exits with an unref'd descendant", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-local-gate-restart-"));
  const source = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const worktreeRoot = join(parent, "worktrees");
  const piCommand = await versionCommand(parent);
  const taskIdFile = join(parent, "task-id");
  const workerExitFile = join(parent, "worker-exit");
  const gateGroupPidFile = join(parent, "gate-group-pid");
  const gateLeaderExitFile = join(parent, "gate-leader-exit");
  const descendantPidFile = join(parent, "gate-descendant-pid");
  const lateMutation = "late-restart-gate-mutation.txt";
  let daemon;
  let replacement;
  let gateGroupPid = null;
  const waitForExit = (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolveExit) => child.once("close", resolveExit));
  try {
    const runtimeUrl = new URL("../src/runtime-store.js", import.meta.url).href;
    const workerExitCode = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(workerExitFile)}, "exited"); process.exit(0); }); setTimeout(() => { fs.writeFileSync(${JSON.stringify(workerExitFile)}, "exited"); process.exit(0); }, 250);`;
    const daemonCode = `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { RuntimeStore } from ${JSON.stringify(runtimeUrl)};
      const runtime = new RuntimeStore({
        dbPath: ${JSON.stringify(dbPath)},
        piCommand: ${JSON.stringify(piCommand)},
        worktreeRoot: ${JSON.stringify(worktreeRoot)},
        workerFactory: ({ onEvent, onWorkerSpawn }) => {
          const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerExitCode)}], { detached: true, stdio: "ignore" });
          onWorkerSpawn({ pid: worker.pid, processGroupId: worker.pid });
          onEvent({ type: "message_end", message: { role: "assistant", content: "done", stopReason: "stop" } });
          onEvent({ type: "agent_settled" });
          return { pid: worker.pid, processGroupId: worker.pid, close() {} };
        },
      });
      const task = await runtime.createTask({
        goal: "survive gate daemon loss",
        cwd: ${JSON.stringify(source)},
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
        completionContract: {
          localGates: [{
            id: "restart-descendant-check",
            timeoutMs: 2_000,
            command: [process.execPath, "-e", ${JSON.stringify(`const { spawn } = require("node:child_process"); const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(gateGroupPidFile)}, String(process.pid)); const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); setTimeout(() => { try { fs.writeFileSync(${JSON.stringify(lateMutation)}, "late\\n"); } catch {} }, 1_000); setInterval(() => {}, 10_000);`)}], { cwd: process.cwd(), stdio: "ignore" }); descendant.unref(); process.on("exit", () => fs.writeFileSync(${JSON.stringify(gateLeaderExitFile)}, "exited")); setTimeout(() => process.exit(0), 150);`)}]
          }],
        },
      });
      writeFileSync(${JSON.stringify(taskIdFile)}, task.id);
      setInterval(() => {}, 10_000);
    `;
    daemon = spawn(process.execPath, ["--input-type=module", "-e", daemonCode], {
      cwd: parent,
      stdio: "ignore",
    });

    await eventually(() => existsSync(taskIdFile), Boolean, 3_000);
    await eventually(() => existsSync(gateGroupPidFile), Boolean, 3_000);
    await eventually(() => existsSync(descendantPidFile), Boolean, 3_000);
    await eventually(() => existsSync(gateLeaderExitFile), Boolean, 3_000);
    await eventually(() => existsSync(workerExitFile), Boolean, 3_000);
    gateGroupPid = Number(readFileSync(gateGroupPidFile, "utf8"));
    const taskId = readFileSync(taskIdFile, "utf8");
    assert.equal(processGroupStatus(gateGroupPid), "alive");

    daemon.kill("SIGKILL");
    await waitForExit(daemon);

    const database = new DatabaseSync(dbPath);
    const durableGate = database
      .prepare(`SELECT gate_pid AS gatePid, gate_pgid AS gatePgid,
        gate_start_identity AS gateStartIdentity, gate_boot_id AS gateBootId,
        gate_state AS gateState, gate_terminated AS gateTerminated
        FROM attempts WHERE task_id = ?`)
      .get(taskId);
    database.close();
    assert.ok(durableGate?.gatePid);
    assert.equal(durableGate.gatePgid, gateGroupPid);
    assert.ok(durableGate.gateStartIdentity);
    assert.ok(durableGate.gateBootId);
    assert.equal(durableGate.gateTerminated, 0);

    replacement = new RuntimeStore({
      dbPath,
      piCommand,
      worktreeRoot,
    });
    const restored = replacement.getTask(taskId);
    assert.equal(restored.state, "blocked");
    assert.equal(restored.attempts[0].gateState, "ambiguous");
    assert.equal(restored.attempts[0].gateTerminated, false);
    assert.equal(processGroupStatus(gateGroupPid), "alive");
    await assert.rejects(
      replacement.createTask({
        goal: "must remain fenced",
        cwd: source,
        trusted: true,
        model,
        thinkingLevel: "high",
      }),
      /already active or unresolved/,
    );

    await eventually(
      () => existsSync(join(restored.taskWorktree, lateMutation)),
      Boolean,
      3_000,
    );
    const afterLateMutation = replacement.getTask(taskId);
    assert.equal(afterLateMutation.state, "blocked");
    assert.equal(afterLateMutation.completionEvidenceRef, null);
  } finally {
    replacement?.release();
    if (daemon?.exitCode === null && daemon?.signalCode === null)
      daemon.kill("SIGKILL");
    await waitForExit(daemon).catch(() => {});
    for (const pid of [gateGroupPid]) {
      if (!pid) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(parent, { recursive: true, force: true });
  }
});
