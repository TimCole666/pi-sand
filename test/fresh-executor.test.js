import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFreshExecutor, FRESH_EXECUTOR_ARGS } from "../src/fresh-executor.js";

const FAKE_PI_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const behavior = JSON.parse(process.env.FAKE_PI_BEHAVIOR || "{}");
const logPath = process.env.FAKE_PI_LOG;
const record = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");
if (process.argv.includes("--version")) {
  process.stdout.write((process.env.FAKE_PI_VERSION || "0.84.4") + "\\n");
  process.exit(0);
}
record({ type: "spawn", args: process.argv.slice(2), cwd: process.cwd() });
let buffer = "";
const send = (value, delay = 0) => setTimeout(() => process.stdout.write(JSON.stringify(value) + "\\n"), delay);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    record(command);
    if (behavior.closeOn === command.type) {
      process.exit(0);
    }
    if (command.type === "set_model") {
      const response = behavior.modelFailure
        ? { type: "response", command: "set_model", success: false, id: command.id }
        : { type: "response", command: "set_model", success: true, id: command.id, data: behavior.model || { provider: command.provider, id: command.modelId } };
      send(response, Number(behavior.modelDelay || 0));
    } else if (command.type === "set_thinking_level") {
      const response = behavior.thinkingFailure
        ? { type: "response", command: "set_thinking_level", success: false, id: command.id }
        : { type: "response", command: "set_thinking_level", success: true, id: command.id };
      send(response, Number(behavior.thinkingDelay || 0));
    } else if (command.type === "get_state") {
      const model = behavior.stateModel || behavior.model || { provider: behavior.provider || "test-provider", id: behavior.modelId || "test-model" };
      send({ type: "response", command: "get_state", success: true, id: command.id, data: {
        model,
        thinkingLevel: behavior.stateThinkingLevel || behavior.thinkingLevel || "medium",
      } }, Number(behavior.stateDelay || 0));
    } else if (command.type === "prompt") {
      if (behavior.promptRejected) {
        send({ type: "response", command: "prompt", success: false, id: command.id });
      } else {
        send({ type: "response", command: "prompt", success: true, id: command.id });
        send({ type: "agent_settled", result: "fake settled" }, 5);
      }
    }
  }
});
if (behavior.stderr) process.stderr.write("fake diagnostic\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function fakePi(parent, behavior = {}, version = "0.84.4") {
  const command = join(parent, "fake-pi.cjs");
  const log = join(parent, "rpc.jsonl");
  await writeFile(command, FAKE_PI_SOURCE);
  await chmod(command, 0o755);
  return { command, log, env: { FAKE_PI_BEHAVIOR: JSON.stringify(behavior), FAKE_PI_VERSION: version, FAKE_PI_LOG: log } };
}

async function readCommands(log) {
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for fake Pi");
}

async function stop(handle) {
  handle?.close();
  if (handle?.pid) {
    const stopped = await waitFor(() => {
      try {
        process.kill(handle.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }, 250).catch(() => false);
    if (!stopped) {
      try { process.kill(handle.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      try { process.kill(-handle.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

async function withExecutor(behavior, callback, version = "0.84.4") {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-fresh-executor-"));
  const taskCwd = join(directory, "task-worktree");
  await mkdir(taskCwd);
  const fake = await fakePi(directory, behavior, version);
  let handle;
  try {
    handle = await callback({ directory, taskCwd, fake });
  } finally {
    await stop(handle);
    await rm(directory, { recursive: true, force: true });
  }
}

function start(fake, taskCwd, extra = {}) {
  return startFreshExecutor({
    command: fake.command,
    cwd: taskCwd,
    env: { ...process.env, ...fake.env },
    provider: "test-provider",
    modelId: "test-model",
    thinkingLevel: "medium",
    taskPrompt: "bounded task packet",
    timeoutMs: 500,
    ...extra,
  });
}

test("Fresh Executor gates the exact Pi 0.84.4 version before spawn", async () => {
  await withExecutor({}, async ({ fake, taskCwd }) => {
    await assert.rejects(start(fake, taskCwd), (error) => error.code === "INCOMPATIBLE_PI_VERSION");
    assert.equal(existsSync(fake.log), false, "an incompatible version must not spawn a worker");
  }, "0.84.3");
});

test("Fresh Executor uses the controlled profile, caller cwd, and detached process metadata", async () => {
  await withExecutor({}, async ({ fake, taskCwd }) => {
    const handle = await start(fake, taskCwd);
    const commands = await readCommands(fake.log);
    assert.deepEqual(commands[0], { type: "spawn", args: FRESH_EXECUTOR_ARGS, cwd: taskCwd });
    assert.deepEqual(commands.slice(1).map(({ type }) => type), ["set_model", "set_thinking_level", "get_state", "prompt"]);
    assert.equal(new Set(commands.slice(1).map(({ id }) => id)).size, 4, "each RPC request must have a unique correlation id");
    assert.equal(handle.pid > 0, true);
    assert.equal(handle.processGroupId, handle.pid);
    assert.equal(typeof handle.processStartIdentity, "string");
    assert.equal(typeof handle.bootId, "string");
    return handle;
  });
});

test("the acknowledged handshake is strictly sequential when set_model is delayed", async () => {
  await withExecutor({ modelDelay: 150 }, async ({ fake, taskCwd }) => {
    const pending = start(fake, taskCwd);
    await waitFor(async () => (await readCommands(fake.log)).length >= 2);
    assert.deepEqual((await readCommands(fake.log)).slice(1).map(({ type }) => type), ["set_model"]);
    const handle = await pending;
    assert.deepEqual((await readCommands(fake.log)).slice(1).map(({ type }) => type), ["set_model", "set_thinking_level", "get_state", "prompt"]);
    return handle;
  });
});

test("thinking setup and exact get_state verification precede prompt acceptance", async () => {
  await withExecutor({ thinkingDelay: 80, stateDelay: 80 }, async ({ fake, taskCwd }) => {
    const handle = await start(fake, taskCwd);
    assert.deepEqual((await readCommands(fake.log)).slice(1).map(({ type }) => type), ["set_model", "set_thinking_level", "get_state", "prompt"]);
    return handle;
  });
  await withExecutor({ stateModel: { provider: "other", id: "wrong" } }, async ({ fake, taskCwd }) => {
    await assert.rejects(start(fake, taskCwd), (error) => error.code === "STATE_MISMATCH");
    assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 0);
  });
});

test("model failure or acknowledgement mismatch fails before any prompt", async () => {
  for (const behavior of [{ modelFailure: true }, { model: { provider: "test-provider", id: "wrong" } }]) {
    await withExecutor(behavior, async ({ fake, taskCwd }) => {
      await assert.rejects(start(fake, taskCwd));
      assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 0);
    });
  }
});

test("thinking failure, worker close, and stderr during setup fail before inference", async () => {
  for (const behavior of [{ thinkingFailure: true }, { closeOn: "set_thinking_level" }, { stderr: true }]) {
    await withExecutor(behavior, async ({ fake, taskCwd }) => {
      await assert.rejects(start(fake, taskCwd));
      assert.equal((await readCommands(fake.log)).filter(({ type }) => type === "prompt").length, 0);
    });
  }
});

test("prompt rejection is distinct from configuration failure and does not report running", async () => {
  await withExecutor({ promptRejected: true }, async ({ fake, taskCwd }) => {
    await assert.rejects(start(fake, taskCwd), (error) => error.code === "PROMPT_REJECTED" && error.phase === "prompt");
    assert.deepEqual((await readCommands(fake.log)).slice(1).map(({ type }) => type), ["set_model", "set_thinking_level", "get_state", "prompt"]);
  });
});

test("accepted prompt returns an event-stream handle without serializing credentials", async () => {
  await withExecutor({}, async ({ fake, taskCwd }) => {
    const handle = await start(fake, taskCwd, { env: { ...process.env, ...fake.env, OPENAI_API_KEY: "secret-must-not-cross-rpc" } });
    const events = [];
    const unsubscribe = handle.onEvent((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "agent_settled"));
    unsubscribe();
    assert.equal(handle.events.some((event) => event.type === "agent_settled"), true);
    assert.equal((await readFile(fake.log, "utf8")).includes("secret-must-not-cross-rpc"), false);
    assert.equal(JSON.stringify(handle).includes("secret-must-not-cross-rpc"), false);
    return handle;
  });
});
