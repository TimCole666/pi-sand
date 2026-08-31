import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRuntime } from "../src/task-runtime.js";

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

async function piCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

function liveWorker() {
  return spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

function factoryFor(worker) {
  return () => ({ pid: worker.pid, processGroupId: worker.pid, prompt() {}, close() {} });
}

function killGroup(pid, signal = "SIGKILL") {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function setup(parent, worker) {
  const source = await repository(parent);
  const command = await piCommand(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const runtime = new TaskRuntime({
    dbPath,
    piCommand: command,
    workerFactory: factoryFor(worker),
    worktreeRoot: join(parent, "worktrees"),
    bootId: "boot-A",
  });
  const task = runtime.startTask({
    goal: "recover safely",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
  });
  return { runtime, task, dbPath, source, command };
}

const startOptions = (cwd) => ({ goal: "recover safely", cwd, trusted: true, model: { provider: "provider", id: "model" }, thinkingLevel: "high" });

test("Task Runtime persists worker identity and reconciles a gone group without replay", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-task-gone-"));
  const worker = liveWorker();
  try {
    const { runtime, task, dbPath, command } = await setup(parent, worker);
    const stored = runtime.db.prepare("SELECT worker_pid AS pid, worker_pgid AS pgid, worker_start_identity AS startIdentity, worker_boot_id AS bootId FROM attempts").get();
    assert.equal(stored.pid, worker.pid);
    assert.equal(stored.pgid, worker.pid);
    assert.ok(stored.startIdentity);
    assert.equal(stored.bootId, "boot-A");
    runtime.close();
    killGroup(worker.pid);
    await waitForExit(worker);

    const replacement = new TaskRuntime({ dbPath, piCommand: command, workerFactory: factoryFor(worker), worktreeRoot: join(parent, "worktrees"), bootId: "boot-A" });
    try {
      const restored = replacement.getTask(task.id);
      assert.equal(restored.state, "interrupted");
      assert.equal(restored.attempts[0].state, "interrupted");
      assert.match(restored.attempts[0].terminalDetail, /not resumed|replayed/);
      assert.equal(restored.attempts[0].workerPid, worker.pid);
      assert.equal(replacement.listTasks()[0].id, task.id);
    } finally { replacement.close(); }
  } finally {
    if (worker.exitCode === null) killGroup(worker.pid);
    await waitForExit(worker).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("a prior boot interrupts a live Task without signalling a reused process group", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-task-boot-"));
  const worker = liveWorker();
  try {
    const { runtime, task, dbPath, command } = await setup(parent, worker);
    runtime.close();
    const replacement = new TaskRuntime({ dbPath, piCommand: command, workerFactory: factoryFor(worker), worktreeRoot: join(parent, "worktrees"), bootId: "boot-B" });
    try {
      const restored = replacement.getTask(task.id);
      assert.equal(restored.state, "interrupted");
      assert.equal(restored.attempts[0].state, "interrupted");
      assert.doesNotThrow(() => process.kill(worker.pid, 0));
    } finally { replacement.close(); }
  } finally {
    if (worker.exitCode === null) killGroup(worker.pid);
    await waitForExit(worker).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("an identity mismatch creates an orphaned blocked Task without signalling", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-task-identity-"));
  const worker = liveWorker();
  try {
    const { runtime, task, dbPath, command } = await setup(parent, worker);
    runtime.db.prepare("UPDATE attempts SET worker_start_identity = 'not-this-process'").run();
    runtime.close();
    const replacement = new TaskRuntime({ dbPath, piCommand: command, workerFactory: factoryFor(worker), worktreeRoot: join(parent, "worktrees"), bootId: "boot-A" });
    try {
      const restored = replacement.getTask(task.id);
      assert.equal(restored.state, "blocked");
      assert.equal(restored.attempts[0].state, "orphaned");
      assert.match(restored.attempts[0].terminalDetail, /could not be safely/);
      assert.doesNotThrow(() => process.kill(worker.pid, 0));
      assert.throws(() => replacement.startTask(startOptions(restored.sourceRepoRoot)), /unresolved|capacity/);
    } finally { replacement.close(); }
  } finally {
    if (worker.exitCode === null) killGroup(worker.pid);
    await waitForExit(worker).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("a kill failure leaves the Task orphaned and globally blocks executor capacity", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-task-kill-failure-"));
  const worker = liveWorker();
  const originalKill = process.kill;
  const signals = [];
  try {
    const { runtime, task, dbPath, command } = await setup(parent, worker);
    runtime.close();
    process.kill = (pid, signal) => {
      if (pid === -worker.pid && (signal === "SIGTERM" || signal === "SIGKILL")) signals.push(signal);
      if (pid === -worker.pid && signal === "SIGKILL") {
        const error = new Error("injected KILL failure");
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    };
    const replacement = new TaskRuntime({ dbPath, piCommand: command, workerFactory: factoryFor(worker), worktreeRoot: join(parent, "worktrees"), bootId: "boot-A", workerStopTimeoutMs: 20 });
    try {
      const restored = replacement.getTask(task.id);
      assert.equal(restored.state, "blocked");
      assert.equal(restored.attempts[0].state, "orphaned");
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.doesNotThrow(() => originalKill(worker.pid, 0));
      assert.throws(() => replacement.startTask(startOptions(restored.sourceRepoRoot)), /unresolved|capacity/);
    } finally { replacement.close(); }
  } finally {
    process.kill = originalKill;
    if (worker.exitCode === null) killGroup(worker.pid);
    await waitForExit(worker).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});
