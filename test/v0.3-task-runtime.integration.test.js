import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRuntime, TASK_RUNTIME_OWNERSHIP_ERROR } from "../src/task-runtime.js";
import { processGroupIsAlive } from "../src/process-group.js";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";

async function repository(parent) {
  const path = join(parent, "source");
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "fixture.txt"), "base\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-qm", "base"]);
  return path;
}

async function fakePi(parent) {
  const command = join(parent, "fake-pi");
  const packet = join(parent, "packet.jsonl");
  const args = join(parent, "args.json");
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { process.stdout.write("0.84.4\\n"); process.exit(0); }
fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
process.stdin.on("data", (chunk) => fs.appendFileSync(process.env.PACKET_PATH, chunk));
setInterval(() => {}, 1000);
`);
  await chmod(command, 0o755);
  return { command, packet, args };
}

async function waitForPrompt(path) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      if (lines.some((line) => line.type === "prompt")) return lines;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for worker prompt");
}

function deterministicWorkerFactory({ change = false, workerCommit = false, result = "Completed result." } = {}) {
  return ({ cwd, onEvent }) => ({
    pid: null,
    processGroupId: null,
    setModel() {},
    setThinkingLevel() {},
    prompt() {
      onEvent({ type: "agent_end" });
      if (change) {
        writeFileSync(join(cwd, "worker-change.txt"), "worker change\n");
        if (workerCommit) {
          execFileSync("git", ["add", "worker-change.txt"], { cwd });
          execFileSync("git", ["commit", "-qm", "worker commit"], {
            cwd,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "worker",
              GIT_AUTHOR_EMAIL: "worker@localhost",
              GIT_COMMITTER_NAME: "worker",
              GIT_COMMITTER_EMAIL: "worker@localhost",
            },
          });
          writeFileSync(join(cwd, "checkpoint-me.txt"), "remaining change\n");
        }
      }
      onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: result }], stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
    },
    close() {},
  });
}

function gitOutput(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("one deterministic Task journey settles, checkpoints, and leaves the Manager worktree unchanged", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-journey-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const baseCommit = gitOutput(source, ["rev-parse", "HEAD"]);
  let release;
  let packet;
  const runtime = new TaskRuntime({
    dbPath: join(parent, "task-runtime.sqlite"),
    piCommand: fake.command,
    workerFactory: ({ cwd, onEvent }) => ({
      prompt({ message }) {
        packet = message;
        onEvent({ type: "agent_end" });
        release = () => {
          writeFileSync(join(cwd, "journey.txt"), "completed journey\n");
          onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Journey completed." }], stopReason: "stop" } });
          onEvent({ type: "agent_settled" });
        };
      },
      close() {},
    }),
    worktreeRoot: join(parent, "worktrees"),
  });
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { taskRuntimeFactory: () => runtime });
  const ctx = { ...harness.context("manager"), cwd: source, model: { provider: "provider", id: "model" }, thinkingLevel: "high", isProjectTrusted: () => true };
  try {
    const started = await harness.commands.get("task").handler("Complete the deterministic journey", ctx);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.task.state, "running");
    assert.equal(started.task.baseCommit, baseCommit);
    assert.notEqual(started.task.taskWorktree, source);
    assert.match(started.task.taskBranch, /^pi-sand\/task-/);
    assert.equal(started.task.attempts.length, 1);
    assert.equal(started.task.attempts[0].state, "running");
    assert.match(packet, new RegExp(started.task.id));
    assert.match(packet, /Attempt: 1/);
    assert.match(packet, /Goal: Complete the deterministic journey/);
    assert.match(packet, /Task worktree:/);
    assert.match(packet, /Base commit:/);
    assert.doesNotMatch(packet, /Manager transcript|prior conversation|previous worker/);
    assert.equal(gitOutput(source, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(gitOutput(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    release();
    const completed = runtime.getTask(started.task.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.finalResult, "Journey completed.");
    assert.equal(completed.attempts[0].state, "completed");
    assert.equal(completed.attempts[0].finalBranchHead, completed.finalBranchHead);
    assert.notEqual(completed.finalBranchHead, baseCommit);
    assert.equal(await readFile(join(completed.taskWorktree, "journey.txt"), "utf8"), "completed journey\n");
    assert.equal(gitOutput(completed.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.match(gitOutput(completed.taskWorktree, ["log", "-1", "--format=%s"]), new RegExp(`^pi-sand: checkpoint completed Task ${started.task.id}$`));
    assert.equal(gitOutput(source, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(gitOutput(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal((await harness.commands.get("task-show").handler(started.task.id, ctx)).task.finalResult, "Journey completed.");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Extension /task persists an isolated Task and sends one bounded fresh-worker packet", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const runtime = new TaskRuntime({ dbPath: join(parent, "task-runtime.sqlite"), piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet }, worktreeRoot: join(parent, "worktrees") });
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { taskRuntimeFactory: () => runtime });
  const ctx = { ...harness.context("manager"), cwd: source, model: { provider: "provider-a", id: "model-a" }, thinkingLevel: "high", isProjectTrusted: () => true };
  try {
    const result = await harness.commands.get("task").handler("Fix the fixture", ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.task.state, "running");
    assert.equal(result.task.attempts[0].provider, "provider-a");
    assert.equal(result.task.attempts[0].modelId, "model-a");
    assert.equal(result.task.attempts[0].thinkingLevel, "high");
    assert.equal(result.task.baseCommit, execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.notEqual(result.task.taskWorktree, source);
    assert.match(result.task.taskBranch, /^pi-sand\/task-/);
    const lines = await waitForPrompt(fake.packet);
    const prompts = lines.filter((line) => line.type === "prompt");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].message, new RegExp(result.task.id));
    assert.match(prompts[0].message, /Attempt: 1/);
    assert.match(prompts[0].message, /Task worktree:/);
    assert.match(prompts[0].message, /Base commit:/);
    assert.match(prompts[0].message, /Goal: Fix the fixture/);
    assert.doesNotMatch(prompts[0].message, /Manager transcript|prior conversation|previous worker/);
    for (const command of lines.filter((line) => line.type !== "prompt")) assert.ok(["set_model", "set_thinking_level"].includes(command.type));
    assert.deepEqual(JSON.parse(await readFile(fake.args, "utf8")), ["--mode", "rpc", "--no-session", "--approve", "--no-extensions"]);
    const listed = await harness.commands.get("tasks").handler("", ctx);
    assert.equal(listed.tasks[0].id, result.task.id);
    const shown = await harness.commands.get("task-show").handler(result.task.id, ctx);
    assert.equal(shown.ok, true);
    assert.equal(shown.task.taskWorktree, result.task.taskWorktree);
    const second = await harness.commands.get("task").handler("second", ctx);
    assert.equal(second.ok, false);
    assert.match(second.error, /already active/);
    assert.equal(runtime.listTasks().length, 1);
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("explicit stop and fresh retry preserve the task worktree and snapshot new model settings", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-stop-retry-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const runtime = new TaskRuntime({ dbPath: join(parent, "runtime.sqlite"), piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet }, worktreeRoot: join(parent, "worktrees") });
  try {
    const started = runtime.startTask({ goal: "preserve progress", cwd: source, trusted: true, model: { provider: "p1", id: "m1" }, thinkingLevel: "high" });
    const progress = join(started.taskWorktree, "progress.txt");
    await writeFile(progress, "keep\n");
    const stopped = runtime.stopTask(started.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.attempts[0].state, "stopped");
    assert.match(stopped.attempts[0].terminalDetail, /intentionally stopped/);
    assert.throws(() => runtime.stopTask(started.id), /already terminal/);
    const retried = runtime.retryTask({ id: started.id, trusted: true, model: { provider: "p2", id: "m2" }, thinkingLevel: "low" });
    assert.equal(retried.state, "running");
    assert.equal(retried.taskWorktree, started.taskWorktree);
    assert.equal(retried.taskBranch, started.taskBranch);
    assert.equal(retried.attempts.length, 2);
    assert.equal(retried.attempts[1].number, 2);
    assert.equal(retried.attempts[1].provider, "p2");
    assert.equal(retried.attempts[1].modelId, "m2");
    assert.equal(retried.attempts[1].thinkingLevel, "low");
    assert.notEqual(retried.attempts[0].workerPid, retried.attempts[1].workerPid);
    assert.equal(await readFile(progress, "utf8"), "keep\n");
    const packet = (await waitForPrompt(fake.packet)).filter((line) => line.type === "prompt").at(-1);
    assert.match(packet.message, /Attempt: 2/);
    assert.match(packet.message, /Previous attempt outcome: stopped/);
    assert.match(packet.message, /Existing filesystem changes/);
  } finally { runtime.close(); await rm(parent, { recursive: true, force: true }); }
});

test("Task Git preflight rejects dirty and non-Git sources before opening its store", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-preflight-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const runtime = new TaskRuntime({ dbPath: join(parent, "runtime.sqlite"), piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet } });
  try {
    await writeFile(join(source, "untracked.txt"), "dirty\n");
    assert.throws(() => runtime.startTask({ goal: "reject", cwd: source, trusted: true, model: { provider: "p", id: "m" }, thinkingLevel: "low" }), /clean.*untracked/i);
    assert.equal(runtime.db, null);
    assert.throws(() => runtime.startTask({ goal: "reject", cwd: parent, trusted: true, model: { provider: "p", id: "m" }, thinkingLevel: "low" }), /Git preflight/);
  } finally { runtime.close(); await rm(parent, { recursive: true, force: true }); }
});

test("settled changed Tasks preserve worker commits and checkpoint residual changes without touching Manager Git", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-complete-changed-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const baseCommit = gitOutput(source, ["rev-parse", "HEAD"]);
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"), piCommand: fake.command,
    workerFactory: deterministicWorkerFactory({ change: true, workerCommit: true, result: "A bounded completion result." }),
    worktreeRoot: join(parent, "worktrees"),
  });
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { taskRuntimeFactory: () => runtime });
  const ctx = { ...harness.context("manager"), cwd: source, model: { provider: "p", id: "m" }, thinkingLevel: "low", isProjectTrusted: () => true };
  try {
    const started = await harness.commands.get("task").handler("Implement the change", ctx);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.task.state, "completed");
    assert.equal(started.task.finalResult, "A bounded completion result.");
    assert.equal(started.task.attempts[0].state, "completed");
    assert.equal(started.task.attempts[0].finalBranchHead, started.task.finalBranchHead);
    assert.notEqual(started.task.finalBranchHead, baseCommit);
    assert.deepEqual(gitOutput(started.task.taskWorktree, ["log", "--format=%s", "-3"]).split("\n"), [
      `pi-sand: checkpoint completed Task ${started.task.id}`,
      "worker commit",
      "base",
    ]);
    assert.equal(gitOutput(source, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(gitOutput(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const shown = await harness.commands.get("task-show").handler(started.task.id, ctx);
    assert.equal(shown.ok, true);
    assert.equal(shown.task.goal, "Implement the change");
    assert.equal(shown.task.baseCommit, baseCommit);
    assert.equal(shown.task.taskBranch, started.task.taskBranch);
    assert.equal(shown.task.taskWorktree, started.task.taskWorktree);
    assert.equal(shown.task.finalBranchHead, started.task.finalBranchHead);
    assert.equal(shown.task.attempts[0].provider, "p");
    assert.equal(shown.task.attempts[0].modelId, "m");
    assert.equal(shown.task.attempts[0].thinkingLevel, "low");
    assert.equal(shown.task.attempts[0].finalResult, "A bounded completion result.");
    assert.equal(shown.task.attempts[0].terminalDetail, "Fresh Executor settled successfully.");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("settled no-change Tasks complete without an empty checkpoint commit", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-complete-clean-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const baseCommit = gitOutput(source, ["rev-parse", "HEAD"]);
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"), piCommand: fake.command,
    workerFactory: deterministicWorkerFactory({ result: "Research found no repository changes." }),
    worktreeRoot: join(parent, "worktrees"),
  });
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { taskRuntimeFactory: () => runtime });
  const ctx = { ...harness.context("manager"), cwd: source, model: { provider: "p", id: "m" }, thinkingLevel: "low", isProjectTrusted: () => true };
  try {
    const result = await harness.commands.get("task").handler("Research only", ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.task.state, "completed");
    assert.equal(result.task.finalBranchHead, baseCommit);
    assert.equal(gitOutput(result.task.taskWorktree, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(gitOutput(result.task.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal((await harness.commands.get("tasks").handler("", ctx)).tasks[0].state, "completed");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("an aborted settled assistant produces one durable failed Task and agent_end alone stays running", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-complete-failed-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  let emitLater;
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"), piCommand: fake.command,
    workerFactory: ({ onEvent }) => ({
      prompt() { onEvent({ type: "agent_end" }); emitLater = onEvent; },
      close() {},
    }),
    worktreeRoot: join(parent, "worktrees"),
  });
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { taskRuntimeFactory: () => runtime });
  const ctx = { ...harness.context("manager"), cwd: source, model: { provider: "p", id: "m" }, thinkingLevel: "low", isProjectTrusted: () => true };
  try {
    const running = await harness.commands.get("task").handler("May fail", ctx);
    assert.equal(running.task.state, "running");
    emitLater({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" } });
    emitLater({ type: "agent_settled" });
    const failed = runtime.getTask(running.task.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts[0].state, "failed");
    assert.equal(failed.attempts[0].finalResult, "partial");
    assert.match(failed.terminalDetail, /aborted/i);
    assert.equal(runtime.getTask(running.task.id).state, "failed");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("graceful reload and session replacement interrupt the owned worker before replacement ownership", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    const parent = await mkdtemp(join(tmpdir(), `pi-sand-v03-shutdown-${reason}-`));
    const source = await repository(parent);
    const fake = await fakePi(parent);
    const dbPath = join(parent, "task-runtime.sqlite");
    const runtime = new TaskRuntime({ dbPath, piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet }, worktreeRoot: join(parent, "worktrees") });
    let interrupted;
    const first = createExtensionHarness({ cwd: () => source });
    registerPiSandExtension(first.pi, { taskRuntimeFactory: () => runtime });
    const oldContext = { ...first.context("manager"), cwd: source, model: { provider: "provider-a", id: "model-a" }, thinkingLevel: "high", isProjectTrusted: () => true };
    try {
      await first.invoke("session_start", { type: "session_start", reason: "startup" }, oldContext);
      const started = await first.commands.get("task").handler(`Shutdown on ${reason}`, oldContext);
      assert.equal(started.ok, true, JSON.stringify(started));
      await waitForPrompt(fake.packet);
      const workerPid = started.task.attempts[0].workerPid;
      const worktree = started.task.taskWorktree;
      assert.equal(processGroupIsAlive(workerPid), true);
      await first.invoke("session_shutdown", { type: "session_shutdown", reason }, oldContext);
      await first.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" }, oldContext);
      assert.equal(processGroupIsAlive(workerPid), false, `${reason} must stop the recorded worker group`);
      assert.equal(existsSync(worktree), true, "interruption must preserve the task worktree");
      assert.equal(runtime.closed, true);
      interrupted = new TaskRuntime({ dbPath, piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet }, worktreeRoot: join(parent, "worktrees") });
      const second = createExtensionHarness({ cwd: () => source });
      registerPiSandExtension(second.pi, { taskRuntimeFactory: () => interrupted });
      const replacement = { ...second.context("replacement"), cwd: source };
      await second.invoke("session_start", { type: "session_start", reason }, replacement);
      const listed = await second.commands.get("tasks").handler("", replacement);
      assert.equal(listed.ok, true);
      assert.equal(listed.tasks[0].state, "interrupted");
      assert.equal(listed.tasks[0].shutdownReason, reason);
      assert.equal(listed.tasks[0].attempts.length, 1, "shutdown must record exactly one Attempt");
      assert.equal(listed.tasks[0].attempts[0].state, "interrupted");
      assert.equal(listed.tasks[0].attempts[0].shutdownReason, reason);
      assert.equal(listed.tasks[0].attempts[0].workerTerminated, true);
      assert.equal((await readFile(fake.packet, "utf8")).trim().split("\n").filter(Boolean).length, 3, "replacement must not replay the Task Packet");
    } finally {
      interrupted?.close();
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("an unprovable worker group stays interrupted and keeps its unsafe process metadata", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-unsafe-shutdown-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  let worker;
  const runtime = new TaskRuntime({
    dbPath: join(parent, "task-runtime.sqlite"), piCommand: fake.command,
    workerFactory: () => {
      worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      return { pid: worker.pid, processGroupId: foreign.pid, prompt() {}, close() {} };
    }, worktreeRoot: join(parent, "worktrees"),
  });
  try {
    const started = runtime.startTask({ goal: "Keep unsafe metadata", cwd: source, trusted: true, model: { provider: "p", id: "m" }, thinkingLevel: "low" });
    await runtime.shutdown("reload");
    assert.equal(processGroupIsAlive(foreign.pid), true, "an unproven group must not be signalled");
    const replacement = new TaskRuntime({ dbPath: join(parent, "task-runtime.sqlite") });
    try {
      const task = replacement.getTask(started.taskId ?? started.id);
      assert.equal(task.state, "interrupted");
      assert.equal(task.shutdownReason, "reload");
      assert.equal(task.attempts[0].workerTerminated, false);
      assert.equal(task.attempts[0].workerPid, worker.pid);
      assert.equal(task.attempts[0].workerPgid, foreign.pid);
    } finally { replacement.close(); }
  } finally {
    runtime.close();
    for (const child of [worker, foreign]) {
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("Task Runtime ownership is lazy, separate, and non-fatal to basic Extension loading", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-owner-"));
  const fake = await fakePi(parent);
  const path = join(parent, "task-runtime.sqlite");
  const first = new TaskRuntime({ dbPath: path, piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet } });
  const second = new TaskRuntime({ dbPath: path, piCommand: fake.command, workerEnv: { ...process.env, ARGS_PATH: fake.args, PACKET_PATH: fake.packet } });
  try {
    assert.equal(first.db, null);
    first.listTasks();
    assert.throws(() => second.listTasks(), new RegExp(TASK_RUNTIME_OWNERSHIP_ERROR));
    assert.match(first.dbPath, /task-runtime\.sqlite$/);
  } finally { first.close(); second.close(); await rm(parent, { recursive: true, force: true }); }
});
