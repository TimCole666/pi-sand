import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRuntimeDaemon } from "../src/daemon.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeStore } from "../src/runtime-store.js";
import { processGroupIsAlive } from "../src/process.js";

const model = { provider: "provider", id: "model" };

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

function taskOptions(source) {
  return {
    goal: "fence one Task",
    cwd: source,
    trusted: true,
    model,
    thinkingLevel: "high",
  };
}

async function eventually(read, predicate, turns = 100) {
  for (let turn = 0; turn < turns; turn += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error("timed out waiting for deterministic runtime state");
}

function settledWorker(onEvent) {
  onEvent({
    type: "message_end",
    message: { role: "assistant", content: "done", stopReason: "stop" },
  });
  onEvent({ type: "agent_settled" });
  return {
    callbacksAttached: true,
    executionSnapshot: { sessionId: "session-1", capability: "fixed" },
    prompt() {
      return new Promise(() => {});
    },
    close() {},
  };
}

function hangingWorker() {
  return {
    callbacksAttached: true,
    executionSnapshot: { sessionId: "session-1", capability: "fixed" },
    prompt() {
      return new Promise(() => {});
    },
    close() {},
  };
}

function seedEvidence(runtime, taskId, attemptId, payload) {
  const id = randomUUID();
  const serialized = JSON.stringify(payload);
  runtime.db.prepare(`INSERT INTO evidence (
    id, task_id, attempt_id, attempt_run_id, kind, source, subject,
    subject_digest, payload, payload_digest, dedupe_key, observed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      taskId,
      attemptId,
      `${attemptId}:1`,
      "control_test",
      "runtime",
      "control_test",
      "subject-digest",
      serialized,
      "payload-digest",
      `control-test:${id}`,
      new Date().toISOString(),
    );
  return id;
}

test("malformed public correction is side-effect free and the active Attempt can settle afterward", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-correction-validation-"));
  const source = await repository(parent);
  let emit;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1", capability: "fixed" },
        prompt() {
          return Promise.resolve({ accepted: true });
        },
        close() {},
      };
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source));
    const before = runtime.getTask(started.id);
    await assert.rejects(
      runtime.correctTask({ id: started.id, model: {} }),
      /current or an explicit model and thinking level/,
    );
    const after = runtime.getTask(started.id);
    assert.equal(after.controlVersion, before.controlVersion);
    assert.equal(after.contractVersion, before.contractVersion);
    assert.equal(after.state, "running");
    assert.equal(after.attempts.length, 1);
    assert.equal(after.attempts[0].state, "running");
    assert.equal(after.attempts[0].workerTerminated, false);
    assert.equal(runtime.active.stopRequested, false);

    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: { role: "assistant", content: "settled after rejected correction", stopReason: "stop" },
    });
    emit({ type: "agent_settled" });
    const settled = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    assert.equal(settled.state, "running");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("invalid thinking correction over daemon IPC is side-effect free and later settlement remains possible", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-correction-ipc-"));
  const source = await repository(parent);
  let emit;
  const store = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1", capability: "fixed" },
        prompt() {
          return Promise.resolve({ accepted: true });
        },
        close() {},
      };
    },
  });
  const socketPath = join(parent, "runtime", "pi-sand.sock");
  let daemon;
  try {
    daemon = await startRuntimeDaemon({
      dbPath: join(parent, "runtime.sqlite"),
      socketPath,
      store,
    });
    const client = new RuntimeClient({ socketPath, dbPath: join(parent, "runtime.sqlite") });
    const started = await client.createTask(taskOptions(source));
    const before = await client.getTask(started.id);
    await assert.rejects(
      client.correctTask({ id: started.id, thinkingLevel: "" }),
      /current or an explicit model and thinking level/,
    );
    const after = await client.getTask(started.id);
    assert.equal(after.controlVersion, before.controlVersion);
    assert.equal(after.contractVersion, before.contractVersion);
    assert.equal(after.state, "running");
    assert.equal(after.attempts[0].state, "running");
    assert.equal(after.attempts[0].workerTerminated, false);
    assert.equal(store.active.stopRequested, false);

    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: { role: "assistant", content: "settled after rejected thinking", stopReason: "stop" },
    });
    emit({ type: "agent_settled" });
    const settled = await eventually(
      () => client.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    assert.equal(settled.state, "running");
  } finally {
    await daemon?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("task.stop commits the control fence before retiring work and stale settlement cannot complete", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-stop-"));
  const source = await repository(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => settledWorker(onEvent),
  });
  try {
    const accepted = await runtime.createTask(taskOptions(source));
    const stopped = await runtime.stopTask(accepted.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.controlVersion, 2);
    assert.equal(stopped.attempts[0].controlVersion, 1);
    assert.equal(stopped.attempts[0].attemptRuns[0].state, "settled");
    assert.equal(stopped.remoteEffects.length, 0);
    assert.equal((await runtime.stopTask(accepted.id)).state, "stopped");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("restart preserves captured Attempt, AttemptRun, and Evidence versions after stop advances Task control", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-restart-"));
  const source = await repository(parent);
  const options = {
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => settledWorker(onEvent),
  };
  let runtime = new RuntimeStore(options);
  try {
    const accepted = await runtime.createTask({
      ...taskOptions(source),
      completionContract: {
        objective: "fence one Task",
        localGates: [{
          id: "failing-gate",
          command: [process.execPath, "-e", "process.exit(1)"],
        }],
      },
      budget: { maxTotalAttempts: 2 },
    });
    await eventually(
      () => runtime.getTask(accepted.id),
      (task) => task.evidence.length > 0 && ["accepted", "running"].includes(task.state),
    );
    const stopped = await runtime.stopTask(accepted.id);
    const priorEvidence = stopped.evidence.map((evidence) => ({
      id: evidence.id,
      controlVersion: evidence.payload.controlVersion,
      contractVersion: evidence.payload.contractVersion,
    }));
    assert.ok(priorEvidence.length > 0);
    assert.ok(priorEvidence.every(({ controlVersion, contractVersion }) =>
      controlVersion === 1 && contractVersion === 1));
    runtime.close();
    runtime = new RuntimeStore(options);
    const reopened = runtime.getTask(accepted.id);
    assert.equal(reopened.controlVersion, 2);
    assert.equal(reopened.contractVersion, 1);
    assert.equal(reopened.attempts[0].controlVersion, 1);
    assert.equal(reopened.attempts[0].contractVersion, 1);
    assert.equal(reopened.attempts[0].attemptRuns[0].controlVersion, 1);
    assert.equal(reopened.attempts[0].attemptRuns[0].contractVersion, 1);
    assert.deepEqual(
      reopened.evidence.map((evidence) => ({
        id: evidence.id,
        controlVersion: evidence.payload.controlVersion,
        contractVersion: evidence.payload.contractVersion,
      })),
      priorEvidence,
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("explicit retry advances a stopped Task fence and captures version 3 across restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-retry-restart-"));
  const source = await repository(parent);
  const options = {
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => hangingWorker(),
  };
  let runtime = new RuntimeStore(options);
  try {
    const started = await runtime.createTask(taskOptions(source));
    const stopped = await runtime.stopTask(started.id);
    assert.equal(stopped.controlVersion, 2);
    assert.equal(stopped.attempts[0].controlVersion, 1);
    runtime.close();

    runtime = new RuntimeStore({ ...options, workerFactory: async ({ onEvent }) => settledWorker(onEvent) });
    const retried = await runtime.retryTask({
      id: started.id,
      trusted: true,
      model,
      thinkingLevel: "high",
    });
    assert.equal(retried.controlVersion, 3);
    assert.equal(retried.attempts.length, 2);
    assert.equal(retried.attempts[0].state, "stopped");
    assert.equal(retried.attempts[0].controlVersion, 1);
    assert.equal(retried.attempts[0].attemptRuns[0].controlVersion, 1);
    assert.equal(retried.attempts[1].controlVersion, 3);
    assert.equal(retried.attempts[1].attemptRuns[0].controlVersion, 3);
    assert.equal(retried.latestAttemptId, retried.attempts[1].id);
    assert.equal(
      runtime.db.prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ?").get(started.id).count,
      1,
      "retry preserves the stopped terminal delivery history",
    );
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("restart preserves captured versions and Evidence after correction advances Task control and contract", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-correction-restart-"));
  const source = await repository(parent);
  const options = {
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async () => hangingWorker(),
  };
  let runtime = new RuntimeStore(options);
  try {
    const accepted = await runtime.createTask(taskOptions(source));
    const before = runtime.getTask(accepted.id);
    const oldAttempt = before.attempts[0];
    const evidenceId = seedEvidence(runtime, accepted.id, oldAttempt.id, {
      controlVersion: 1,
      contractVersion: 1,
      note: "historical control evidence",
    });
    const corrected = await runtime.correctTask({
      id: accepted.id,
      objective: "corrected objective",
    });
    assert.equal(corrected.controlVersion, 2);
    assert.equal(corrected.contractVersion, 2);
    runtime.close();
    runtime = new RuntimeStore(options);
    const reopened = runtime.getTask(accepted.id);
    const historicalAttempt = reopened.attempts.find(({ id }) => id === oldAttempt.id);
    const historicalEvidence = reopened.evidence.find(({ id }) => id === evidenceId);
    assert.equal(reopened.controlVersion, 2);
    assert.equal(reopened.contractVersion, 2);
    assert.equal(historicalAttempt.controlVersion, 1);
    assert.equal(historicalAttempt.contractVersion, 1);
    assert.equal(historicalAttempt.attemptRuns[0].controlVersion, 1);
    assert.equal(historicalAttempt.attemptRuns[0].contractVersion, 1);
    assert.equal(historicalAttempt.state, "superseded");
    assert.deepEqual(historicalEvidence.payload, {
      controlVersion: 1,
      contractVersion: 1,
      note: "historical control evidence",
    });
    const currentAttempt = reopened.attempts.find(({ id }) => id === reopened.latestAttemptId);
    assert.equal(currentAttempt.controlVersion, 2);
    assert.equal(currentAttempt.contractVersion, 2);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("cancel after continuation acceptance retires the exact Attempt and rejects late settlement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-cancel-accepted-"));
  const source = await repository(parent);
  let emit;
  let resolvePrompt;
  let promptCalls = 0;
  let workerProcess;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent, onWorkerSpawn }) => {
      emit = onEvent;
      workerProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      onWorkerSpawn({ pid: workerProcess.pid, processGroupId: workerProcess.pid });
      onEvent({
        type: "message_end",
        message: { role: "assistant", content: "initial", stopReason: "stop" },
      });
      onEvent({ type: "agent_settled" });
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1", capability: "fixed" },
        pid: workerProcess.pid,
        processGroupId: workerProcess.pid,
        prompt() {
          promptCalls += 1;
          return new Promise((resolvePromptResult) => {
            resolvePrompt = () => resolvePromptResult({ accepted: true });
          });
        },
        close() {},
      };
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source));
    await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    const continuation = runtime.continueAttempt({
      id: started.id,
      prompt: "accepted continuation",
    });
    await eventually(() => promptCalls, (calls) => calls === 1);
    resolvePrompt();
    await continuation;
    assert.equal(runtime.getTask(started.id).attempts[0].attemptRuns[1].state, "accepted");

    const stopped = await runtime.stopTask(started.id);
    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: { role: "assistant", content: "late result", stopReason: "stop" },
    });
    emit({ type: "agent_settled" });
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.attempts[0].state, "stopped");
    assert.equal(stopped.attempts[0].attemptRuns[1].state, "aborted");
    assert.equal(stopped.attempts[0].workerPid, workerProcess.pid);
    assert.equal(stopped.attempts[0].workerPgid, workerProcess.pid);
    assert.ok(stopped.attempts[0].workerStartIdentity);
    assert.equal(stopped.attempts[0].workerBootId, runtime.bootId);
    assert.equal(processGroupIsAlive(workerProcess.pid), false);
    assert.equal(runtime.getTask(started.id).state, "stopped");
  } finally {
    try {
      if (workerProcess?.pid && processGroupIsAlive(workerProcess.pid))
        process.kill(-workerProcess.pid, "SIGKILL");
    } catch {}
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("correction after an accepted old result fences that result from the new contract", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-correction-accepted-"));
  const source = await repository(parent);
  let oldEmit;
  let resolvePrompt;
  let workerCount = 0;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      workerCount += 1;
      if (workerCount === 1) {
        oldEmit = onEvent;
        onEvent({
          type: "message_end",
          message: { role: "assistant", content: "old result", stopReason: "stop" },
        });
        onEvent({ type: "agent_settled" });
      }
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: `session-${workerCount}`, capability: "fixed" },
        prompt() {
          if (workerCount !== 1) return new Promise(() => {});
          return new Promise((resolvePromptResult) => {
            resolvePrompt = () => resolvePromptResult({ accepted: true });
          });
        },
        close() {},
      };
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source));
    await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    const continuation = runtime.continueAttempt({ id: started.id, prompt: "old follow-up" });
    resolvePrompt();
    await continuation;
    oldEmit({ type: "agent_start" });
    oldEmit({
      type: "message_end",
      message: { role: "assistant", content: "accepted old result", stopReason: "stop" },
    });
    oldEmit({ type: "agent_settled" });
    await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[1].state === "settled",
    );

    const corrected = await runtime.correctTask({
      id: started.id,
      objective: "new contract objective",
    });
    assert.equal(corrected.goal, "new contract objective");
    assert.equal(corrected.controlVersion, 2);
    assert.equal(corrected.contractVersion, 2);
    oldEmit({ type: "agent_start" });
    oldEmit({
      type: "message_end",
      message: { role: "assistant", content: "late old completion", stopReason: "stop" },
    });
    oldEmit({ type: "agent_settled" });
    const current = runtime.getTask(started.id);
    assert.equal(current.state, "running");
    assert.equal(current.attempts[0].state, "superseded");
    assert.equal(current.attempts[0].attemptRuns[1].settledOutcome, "accepted old result");
    assert.equal(current.attempts[1].controlVersion, 2);
    assert.equal(current.attempts[1].contractVersion, 2);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a correction committed at the continuation boundary supersedes the pending run before prompt transmission", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-control-correction-"));
  const source = await repository(parent);
  let runtime;
  let workerCount = 0;
  let promptCalls = 0;
  runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    beforeContinuationPrompt: async () => {
      await runtime.correctTask({ id: taskId, objective: "corrected objective" });
    },
    workerFactory: async ({ onEvent }) => {
      workerCount += 1;
      if (workerCount === 1) {
        onEvent({
          type: "message_end",
          message: { role: "assistant", content: "initial", stopReason: "stop" },
        });
        onEvent({ type: "agent_settled" });
      }
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: `session-${workerCount}`, capability: "fixed" },
        prompt() {
          promptCalls += 1;
          return Promise.resolve({ accepted: true });
        },
        close() {},
      };
    },
  });
  let taskId;
  try {
    const accepted = await runtime.createTask(taskOptions(source));
    taskId = accepted.id;
    const settled = runtime.getTask(taskId);
    assert.equal(settled.attempts[0].attemptRuns[0].state, "settled");
    await assert.rejects(
      runtime.continueAttempt({ id: taskId, prompt: "stale continuation" }),
      /stale|superseded|healthy\/current/i,
    );
    const corrected = runtime.getTask(taskId);
    assert.equal(workerCount, 2);
    assert.equal(promptCalls, 0);
    assert.equal(corrected.goal, "corrected objective");
    assert.equal(corrected.controlVersion, 2);
    assert.equal(corrected.contractVersion, 2);
    assert.equal(corrected.attempts[0].state, "superseded");
    assert.equal(corrected.attempts[0].attemptRuns[1].state, "aborted");
    assert.equal(corrected.attempts[1].controlVersion, 2);
    assert.equal(corrected.attempts[1].contractVersion, 2);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});
