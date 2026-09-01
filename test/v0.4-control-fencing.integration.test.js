import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../src/runtime-store.js";

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
      return settledWorker(onEvent);
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
