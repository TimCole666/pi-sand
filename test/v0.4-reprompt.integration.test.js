import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FreshExecutorError, startFreshExecutor } from "../src/fresh-executor.js";
import { RuntimeStore } from "../src/runtime-store.js";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function eventually(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(10);
  }
  throw new Error("timed out waiting for deterministic re-prompt state");
}

async function fakePi(parent) {
  const command = join(parent, "fake-pi.cjs");
  const log = join(parent, "rpc.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const behavior = JSON.parse(process.env.FAKE_PI_BEHAVIOR || "{}");
const logPath = process.env.FAKE_PI_LOG;
const record = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const waitForGate = (gate, callback) => {
  if (!gate) return callback();
  const timer = setInterval(() => {
    if (!fs.existsSync(gate)) return;
    clearInterval(timer);
    callback();
  }, 5);
};
if (process.argv.includes("--version")) {
  process.stdout.write("0.84.4\\n");
  process.exit(0);
}
record({ type: "spawn", pid: process.pid, cwd: process.cwd() });
let buffer = "";
let promptNumber = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    record(request);
    if (request.type === "set_model") {
      send({ type: "response", command: request.type, success: true, id: request.id, data: { provider: request.provider, id: request.modelId } });
    } else if (request.type === "set_thinking_level") {
      send({ type: "response", command: request.type, success: true, id: request.id });
    } else if (request.type === "get_state") {
      send({ type: "response", command: request.type, success: true, id: request.id, data: { model: { provider: "provider", id: "model" }, thinkingLevel: "high", sessionId: "session-1" } });
    } else if (request.type === "prompt") {
      promptNumber += 1;
      const currentPrompt = promptNumber;
      const rejected = behavior.rejectPrompt === currentPrompt;
      const gate = behavior.ackGates?.[String(currentPrompt)];
      waitForGate(gate, () => {
        if (behavior.closePrompt === currentPrompt) {
          process.exit(0);
          return;
        }
        send({ type: "response", command: request.type, success: !rejected, id: request.id });
        if (rejected) return;
        send({ type: "agent_start", promptNumber: currentPrompt });
        send({ type: "message_end", message: { role: "assistant", content: "settled " + currentPrompt, stopReason: "stop" }, promptNumber: currentPrompt });
        send({ type: "agent_settled", promptNumber: currentPrompt });
      });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { command, log };
}

async function readCommands(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function stopHandle(handle) {
  handle?.close?.();
  if (!handle?.pid) return;
  await eventually(
    () => {
      try {
        process.kill(handle.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    },
    Boolean,
    500,
  ).catch(() => {
    try {
      process.kill(-handle.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
}

async function startFake(fake, cwd, behavior = {}, { timeoutMs = 500 } = {}) {
  return startFreshExecutor({
    command: fake.command,
    cwd,
    env: {
      ...process.env,
      FAKE_PI_BEHAVIOR: JSON.stringify(behavior),
      FAKE_PI_LOG: fake.log,
    },
    provider: "provider",
    modelId: "model",
    thinkingLevel: "high",
    taskPrompt: "initial task packet",
    timeoutMs,
  });
}

async function withFreshExecutor(callback) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-reprompt-rpc-"));
  const cwd = join(parent, "task-worktree");
  await mkdir(cwd);
  const fake = await fakePi(parent);
  let handle;
  try {
    handle = await callback({ parent, cwd, fake, setHandle: (value) => { handle = value; } });
  } finally {
    await stopHandle(handle);
    await rm(parent, { recursive: true, force: true });
  }
}

function repository(parent) {
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base", "--allow-empty"]);
  return source;
}

async function versionCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

function taskOptions(source, piCommand) {
  return {
    goal: "continue one healthy Attempt",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    piCommand,
  };
}

test("Fresh Executor re-prompts the same process only after an acknowledged settlement", async () => {
  await withFreshExecutor(async ({ cwd, fake, setHandle }) => {
    const handle = await startFake(fake, cwd);
    setHandle(handle);
    const events = [];
    handle.onEvent((event, metadata) => events.push({ event, metadata }));
    await eventually(() => events, (value) => value.some(({ event }) => event.type === "agent_settled"));
    const firstPid = handle.pid;
    const prompt = handle.prompt("continue the bounded task");
    const second = await prompt;
    assert.equal(second.accepted, true);
    assert.equal(handle.pid, firstPid);
    assert.equal(handle.processGroupId, firstPid);
    const commands = await readCommands(fake.log);
    assert.deepEqual(commands.filter(({ type }) => type === "prompt").map(({ message }) => message), [
      "initial task packet",
      "continue the bounded task",
    ]);
    return handle;
  });
});

test("Fresh Executor keeps a delayed re-prompt acknowledgement pending and never sends it twice", async () => {
  await withFreshExecutor(async ({ parent, cwd, fake, setHandle }) => {
    const gate = join(parent, "ack-second");
    const handle = await startFake(fake, cwd, { ackGates: { "2": gate } });
    setHandle(handle);
    const settled = [];
    handle.onEvent((event) => settled.push(event));
    await eventually(() => settled, (value) => value.some((event) => event.type === "agent_settled"));
    let accepted = false;
    const pending = handle.prompt("delayed continuation").then(() => {
      accepted = true;
    });
    await eventually(() => readCommands(fake.log), (commands) => commands.filter(({ type }) => type === "prompt").length === 2);
    await wait(40);
    assert.equal(accepted, false);
    await writeFile(gate, "release\n");
    await pending;
    assert.equal(accepted, true);
    assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 2);
    return handle;
  });
});

test("Fresh Executor reports a known re-prompt rejection without changing process identity", async () => {
  await withFreshExecutor(async ({ cwd, fake, setHandle }) => {
    const handle = await startFake(fake, cwd, { rejectPrompt: 2 });
    setHandle(handle);
    const events = [];
    handle.onEvent((event) => events.push(event));
    await eventually(() => events, (value) => value.some((event) => event.type === "agent_settled"));
    const firstPid = handle.pid;
    await assert.rejects(handle.prompt("rejected continuation"), (error) => {
      assert.equal(error.code, "PROMPT_REJECTED");
      assert.equal(error.phase, "prompt");
      return true;
    });
    assert.equal(handle.pid, firstPid);
    assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 2);
    return handle;
  });
});

test("Fresh Executor closes an unacknowledged re-prompt without replaying the mutation", async () => {
  await withFreshExecutor(async ({ cwd, fake, setHandle }) => {
    const handle = await startFake(fake, cwd, { closePrompt: 2 });
    setHandle(handle);
    const events = [];
    handle.onEvent((event) => events.push(event));
    await eventually(() => events, (value) => value.some((event) => event.type === "agent_settled"));
    await assert.rejects(handle.prompt("ambiguous continuation"), (error) => {
      assert.equal(error.code, "WORKER_CLOSED");
      return true;
    });
    assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 2);
    return handle;
  });
});

test("Fresh Executor times out an unacknowledged re-prompt without replaying it", async () => {
  await withFreshExecutor(async ({ cwd, fake, setHandle }) => {
    const handle = await startFake(fake, cwd, { ackGates: { "2": join(cwd, "never") } }, { timeoutMs: 250 });
    setHandle(handle);
    const events = [];
    handle.onEvent((event) => events.push(event));
    await eventually(() => events, (value) => value.some((event) => event.type === "agent_settled"));
    await assert.rejects(handle.prompt("timed out continuation"), (error) => {
      assert.equal(error.code, "RPC_TIMEOUT");
      return true;
    });
    assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 2);
    return handle;
  });
});

test("RuntimeStore allocates and settles a second AttemptRun on the same healthy worker", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-reprompt-runtime-"));
  const source = repository(parent);
  const piCommand = await versionCommand(parent);
  const prompts = [];
  let emit;
  let resolvePrompt;
  const worker = {
    callbacksAttached: true,
    pid: null,
    processGroupId: null,
    executionSnapshot: { sessionId: "session-1", capability: "fixed" },
    prompt(message) {
      prompts.push(message);
      return new Promise((resolvePromptResult) => {
        resolvePrompt = () => {
          emit({ type: "message_end", message: { role: "assistant", content: "buffered stale run 1", stopReason: "stop" } }, { promptAcknowledged: true });
          emit({ type: "agent_settled", promptNumber: 1 }, { promptAcknowledged: true });
          resolvePromptResult({ accepted: true });
        };
      });
    },
    close() {},
  };
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
      onEvent({ type: "agent_settled", promptNumber: 1 });
      return worker;
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source, piCommand));
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
    assert.deepEqual(prompts, []);
    const pending = runtime.continueAttempt({ id: started.id, prompt: "run 2" });
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns.length === 2 && task.attempts[0].attemptRuns[1].state === "pending");
    assert.deepEqual(prompts, ["run 2"]);
    resolvePrompt();
    await pending;
    const accepted = runtime.getTask(started.id);
    assert.equal(accepted.attempts.length, 1);
    assert.equal(accepted.attempts[0].attemptRuns[1].state, "accepted");

    emit({ type: "message_end", message: { role: "assistant", content: "stale run 1", stopReason: "stop" } });
    emit({ type: "agent_settled", promptNumber: 1 });
    assert.equal(runtime.getTask(started.id).attempts[0].attemptRuns[1].state, "accepted");

    emit({ type: "agent_start" });
    assert.equal(runtime.getTask(started.id).attempts[0].attemptRuns[1].state, "accepted");
    emit({ type: "message_end", message: { role: "assistant", content: "run 2", stopReason: "stop" } });
    emit({ type: "agent_settled", promptNumber: 2 });
    const settled = await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[1].state === "settled");
    assert.equal(settled.attempts[0].attemptRuns[1].settledOutcome, "run 2");
    assert.equal(settled.attempts[0].attemptRuns[1].sequence, 2);
    assert.equal(settled.attempts[0].id, started.attempts[0].id);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("RuntimeStore keeps a delayed continuation pending and known rejection does not allocate an Attempt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-reprompt-reject-"));
  const source = repository(parent);
  const piCommand = await versionCommand(parent);
  let emit;
  let rejectPrompt;
  let promptCalls = 0;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1" },
        prompt() {
          promptCalls += 1;
          if (promptCalls > 1) return { accepted: true };
          return new Promise((_, reject) => {
            rejectPrompt = () => reject(new FreshExecutorError("rejected", { code: "PROMPT_REJECTED", phase: "prompt" }));
          });
        },
        close() {},
      };
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source, piCommand));
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
    const pending = runtime.continueAttempt({ id: started.id, prompt: "known rejection" });
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns.length === 2 && task.attempts[0].attemptRuns[1].state === "pending");
    rejectPrompt();
    await assert.rejects(pending, (error) => error.code === "PROMPT_REJECTED");
    const rejected = runtime.getTask(started.id);
    assert.equal(rejected.attempts.length, 1);
    assert.equal(rejected.attempts[0].attemptRuns.length, 2);
    assert.equal(rejected.attempts[0].attemptRuns[1].state, "aborted");
    assert.equal(rejected.attempts[0].attemptRuns[0].state, "settled");

    const resumed = await runtime.continueAttempt({ id: started.id, prompt: "after rejection" });
    assert.equal(resumed.attempts[0].attemptRuns[1].state, "aborted");
    assert.equal(resumed.attempts[0].attemptRuns[2].state, "accepted");
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content: "run after rejection", stopReason: "stop" } });
    emit({ type: "agent_settled" });
    const resumedSettled = await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[2]?.state === "settled",
    );
    assert.equal(resumedSettled.attempts[0].attemptRuns[2].settledOutcome, "run after rejection");
    void emit;
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("RuntimeStore marks transmitted continuation ambiguity and never replays it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-reprompt-ambiguous-"));
  const source = repository(parent);
  const piCommand = await versionCommand(parent);
  let emit;
  let rejectPrompt;
  let promptCount = 0;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      emit = onEvent;
      onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      return {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1" },
        prompt() {
          promptCount += 1;
          return new Promise((_, reject) => {
            rejectPrompt = () => reject(Object.assign(new Error("ack timed out"), { code: "RPC_TIMEOUT" }));
          });
        },
        close() {},
      };
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source, piCommand));
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
    const pending = runtime.continueAttempt({ id: started.id, prompt: "ambiguous" });
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[1]?.state === "pending");
    rejectPrompt();
    await assert.rejects(pending, (error) => error.code === "RPC_TIMEOUT");
    const ambiguous = await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[1]?.state === "ambiguous");
    assert.equal(promptCount, 1);
    assert.equal(ambiguous.attempts.length, 1);
    assert.equal(ambiguous.attempts[0].attemptRuns[1].state, "ambiguous");
    await assert.rejects(runtime.continueAttempt({ id: started.id, prompt: "must not replay" }), /cannot be reused|not eligible|ambiguous/i);
    assert.equal(promptCount, 1);
    void emit;
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("RuntimeStore treats an implicit continuation acknowledgement as transmitted ambiguity", async () => {
  for (const [name, acknowledgement] of [
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
  ]) {
    const parent = await mkdtemp(join(tmpdir(), `pi-sand-v04-reprompt-ack-${name}-`));
    const source = repository(parent);
    const piCommand = await versionCommand(parent);
    let prompts = 0;
    const runtime = new RuntimeStore({
      dbPath: join(parent, "runtime.sqlite"),
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async ({ onEvent }) => {
        onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
        return {
          callbacksAttached: true,
          executionSnapshot: { sessionId: "session-1" },
          prompt() {
            prompts += 1;
            return acknowledgement;
          },
          close() {},
        };
      },
    });
    try {
      const started = await runtime.createTask(taskOptions(source, piCommand));
      await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
      await assert.rejects(
        runtime.continueAttempt({ id: started.id, prompt: "implicit acknowledgement" }),
        (error) => error.code === "PROMPT_ACKNOWLEDGEMENT_AMBIGUOUS",
      );
      const ambiguous = runtime.getTask(started.id);
      assert.equal(ambiguous.state, "failed");
      assert.equal(ambiguous.attempts[0].attemptRuns[1].state, "ambiguous");
      assert.equal(prompts, 1);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("RuntimeStore refuses continuation without a stable captured/current session snapshot", async () => {
  for (const scenario of ["missing", "changed"]) {
    const parent = await mkdtemp(join(tmpdir(), `pi-sand-v04-reprompt-session-${scenario}-`));
    const source = repository(parent);
    const piCommand = await versionCommand(parent);
    let worker;
    let prompts = 0;
    const runtime = new RuntimeStore({
      dbPath: join(parent, "runtime.sqlite"),
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async ({ onEvent }) => {
        onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
        worker = {
          callbacksAttached: true,
          executionSnapshot:
            scenario === "missing"
              ? { capability: "fixed" }
              : { sessionId: "session-1", capability: "fixed" },
          prompt() {
            prompts += 1;
            return { accepted: true };
          },
          close() {},
        };
        return worker;
      },
    });
    try {
      const started = await runtime.createTask(taskOptions(source, piCommand));
      await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
      if (scenario === "changed")
        worker.executionSnapshot = { sessionId: "session-2", capability: "fixed" };
      await assert.rejects(
        runtime.continueAttempt({ id: started.id, prompt: "blocked" }),
        scenario === "missing"
          ? /session identity.*unavailable/i
          : /session identity changed/i,
      );
      const refused = runtime.getTask(started.id);
      assert.equal(refused.attempts[0].attemptRuns.length, 1);
      assert.equal(prompts, 0);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("RuntimeStore refuses continuation after the frozen capability snapshot changes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-reprompt-capability-"));
  const source = repository(parent);
  const piCommand = await versionCommand(parent);
  let worker;
  let prompts = 0;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    workerFactory: async ({ onEvent }) => {
      onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      worker = {
        callbacksAttached: true,
        executionSnapshot: { sessionId: "session-1", capability: "fixed" },
        prompt() {
          prompts += 1;
          return { accepted: true };
        },
        close() {},
      };
      return worker;
    },
  });
  try {
    const started = await runtime.createTask(taskOptions(source, piCommand));
    await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
    worker.executionSnapshot = { sessionId: "session-1", capability: "changed" };
    await assert.rejects(runtime.continueAttempt({ id: started.id, prompt: "blocked" }), /capability\/environment snapshot changed/i);
    assert.equal(runtime.getTask(started.id).attempts[0].attemptRuns.length, 1);
    assert.equal(prompts, 0);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("RuntimeStore refuses continuation on a version or model mismatch before allocating a run", async () => {
  const cases = [
    { name: "version", mutate: (runtime) => runtime.db.exec("UPDATE tasks SET control_version = control_version + 1"), options: {} },
    { name: "model", mutate: () => {}, options: { model: { provider: "other", id: "model" } } },
    { name: "thinking", mutate: () => {}, options: { thinkingLevel: "low" } },
  ];
  for (const scenario of cases) {
    const parent = await mkdtemp(join(tmpdir(), `pi-sand-v04-reprompt-${scenario.name}-`));
    const source = repository(parent);
    const piCommand = await versionCommand(parent);
    let emit;
    let prompts = 0;
    const runtime = new RuntimeStore({
      dbPath: join(parent, "runtime.sqlite"),
      piCommand,
      worktreeRoot: join(parent, "worktrees"),
      workerFactory: async ({ onEvent }) => {
        emit = onEvent;
        onEvent({ type: "message_end", message: { role: "assistant", content: "run 1", stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
        return {
          callbacksAttached: true,
          executionSnapshot: { sessionId: "session-1" },
          prompt() { prompts += 1; },
          close() {},
        };
      },
    });
    try {
      const started = await runtime.createTask(taskOptions(source, piCommand));
      await eventually(() => runtime.getTask(started.id), (task) => task.attempts[0].attemptRuns[0].state === "settled");
      scenario.mutate(runtime);
      await assert.rejects(runtime.continueAttempt({ id: started.id, prompt: "blocked", ...scenario.options }), /cannot be reused|not eligible|version|model|thinking/i);
      const refused = runtime.getTask(started.id);
      assert.equal(refused.attempts[0].attemptRuns.length, 1);
      assert.equal(prompts, 0);
      void emit;
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
});
