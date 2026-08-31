import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/runtime-store.js";
import {
  processGroupStatus,
  readProcessIdentity,
} from "../src/process.js";

const linuxOnly = { skip: process.platform === "linux" ? false : "Linux-only process-group coverage" };

async function makeRepository(parent) {
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

function worker({ ignoreTerm = false } = {}) {
  const code = ignoreTerm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : "setInterval(() => {}, 1000)";
  return spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
}

function workerFactory(child) {
  return () => ({ pid: child.pid, processGroupId: child.pid, close() {} });
}

function taskOptions(source) {
  return { goal: "recover daemon-owned work", cwd: source, trusted: true, model: { provider: "provider", id: "model" }, thinkingLevel: "high" };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

function killGroup(pid, signal = "SIGKILL") {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function setup(parent, options = {}) {
  const source = await makeRepository(parent);
  const command = await versionCommand(parent);
  const child = worker(options);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: command,
    workerFactory: workerFactory(child),
    worktreeRoot: join(parent, "worktrees"),
    bootId: options.bootId ?? "boot-A",
    workerStopTimeoutMs: options.workerStopTimeoutMs ?? 100,
  });
  const task = await runtime.createTask(taskOptions(source));
  return { source, command, child, runtime, task, dbPath: join(parent, "runtime.sqlite") };
}

async function cleanup(parent, child, runtime) {
  runtime?.release();
  if (child?.pid) killGroup(child.pid);
  await waitForExit(child).catch(() => {});
  await rm(parent, { recursive: true, force: true });
}

test("canonical Linux process identity includes pid, pgid, start identity, and boot id", linuxOnly, () => {
  const identity = readProcessIdentity(process.pid);
  assert.deepEqual(Object.keys(identity).sort(), ["bootId", "pid", "processGroupId", "processStartIdentity"]);
  assert.equal(identity.pid, process.pid);
  assert.equal(Number.isInteger(identity.processGroupId), true);
  assert.match(identity.processStartIdentity, /^\d+$/);
  assert.match(identity.bootId, /^[0-9a-f-]+$/i);
});

test("graceful daemon shutdown terminates the proven worker before persisting daemon-shutdown interruption", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-graceful-"));
  let fixture;
  try {
    fixture = await setup(parent);
    const worktree = fixture.task.taskWorktree;
    const workerPid = fixture.task.attempts[0].workerPid;
    assert.equal(processGroupStatus(workerPid), "alive");
    await fixture.runtime.shutdown("daemon-shutdown");
    const task = fixture.runtime.getTask(fixture.task.id);
    assert.equal(task.state, "interrupted");
    assert.equal(task.shutdownReason, "daemon-shutdown");
    assert.equal(task.attempts[0].state, "interrupted");
    assert.equal(task.attempts[0].shutdownReason, "daemon-shutdown");
    assert.equal(task.attempts[0].workerTerminated, true);
    assert.equal(processGroupStatus(workerPid), "gone");
    assert.equal((await readFile(join(worktree, "fixture.txt"), "utf8")), "base\n");
  } finally {
    await cleanup(parent, fixture?.child, fixture?.runtime);
  }
});

test("abnormal restart reconciles a same-boot live owned group without adopting or replaying it", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-restart-"));
  let fixture;
  let replacement;
  try {
    fixture = await setup(parent);
    const taskId = fixture.task.id;
    const workerPid = fixture.child.pid;
    fixture.runtime.release();
    replacement = new RuntimeStore({ dbPath: fixture.dbPath, piCommand: fixture.command, worktreeRoot: join(parent, "worktrees"), bootId: "boot-A", workerStopTimeoutMs: 100 });
    const restored = replacement.getTask(taskId);
    assert.equal(restored.state, "interrupted");
    assert.equal(restored.attempts[0].state, "interrupted");
    assert.equal(restored.attempts[0].workerTerminated, true);
    assert.equal(processGroupStatus(workerPid), "gone");
    assert.equal(restored.attempts[0].workerPid, workerPid);
    assert.equal(restored.attempts[0].terminalDetail.includes("not resumed or replayed"), true);
  } finally {
    replacement?.release();
    await cleanup(parent, fixture?.child, null);
  }
});

test("prior-boot identity interrupts without signalling the reused pid or process group", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-prior-boot-"));
  let fixture;
  let replacement;
  try {
    fixture = await setup(parent);
    const workerPid = fixture.child.pid;
    fixture.runtime.release();
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("UPDATE attempts SET worker_boot_id = 'prior-boot'").run();
    db.close();
    replacement = new RuntimeStore({ dbPath: fixture.dbPath, piCommand: fixture.command, worktreeRoot: join(parent, "worktrees"), bootId: "current-boot" });
    const restored = replacement.getTask(fixture.task.id);
    assert.equal(restored.state, "interrupted");
    assert.equal(restored.attempts[0].workerTerminated, true);
    assert.equal(processGroupStatus(workerPid), "alive");
  } finally {
    replacement?.release();
    await cleanup(parent, fixture?.child, null);
  }
});

test("identity mismatch is orphaned and blocks capacity without signalling the foreign group", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-mismatch-"));
  let fixture;
  let replacement;
  try {
    fixture = await setup(parent, { ignoreTerm: true });
    const workerPid = fixture.child.pid;
    fixture.runtime.release();
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("UPDATE attempts SET worker_start_identity = 'not-the-recorded-process'").run();
    db.close();
    replacement = new RuntimeStore({ dbPath: fixture.dbPath, piCommand: fixture.command, worktreeRoot: join(parent, "worktrees"), bootId: "boot-A" });
    const restored = replacement.getTask(fixture.task.id);
    assert.equal(restored.state, "blocked");
    assert.equal(restored.attempts[0].state, "orphaned");
    assert.equal(restored.attempts[0].workerTerminated, false);
    assert.equal(processGroupStatus(workerPid), "alive");
    assert.equal(replacement.getTask(fixture.task.id).taskWorktree, fixture.task.taskWorktree);
    await assert.rejects(replacement.createTask(taskOptions(fixture.source)), /active or unresolved/);
  } finally {
    replacement?.release();
    await cleanup(parent, fixture?.child, null);
  }
});

test("TERM/KILL failure remains orphaned and keeps the global worker capacity blocked", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-kill-failure-"));
  let fixture;
  let replacement;
  const originalKill = process.kill;
  const signals = [];
  try {
    fixture = await setup(parent, { ignoreTerm: true, workerStopTimeoutMs: 20 });
    const workerPid = fixture.child.pid;
    fixture.runtime.release();
    process.kill = (pid, signal) => {
      if (pid === -workerPid && (signal === "SIGTERM" || signal === "SIGKILL")) signals.push(signal);
      if (pid === -workerPid && signal === "SIGKILL") {
        const error = new Error("injected KILL failure");
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    };
    replacement = new RuntimeStore({ dbPath: fixture.dbPath, piCommand: fixture.command, worktreeRoot: join(parent, "worktrees"), bootId: "boot-A", workerStopTimeoutMs: 20 });
    const restored = replacement.getTask(fixture.task.id);
    assert.equal(restored.state, "blocked");
    assert.equal(restored.attempts[0].state, "orphaned");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(processGroupStatus(workerPid), "alive");
  } finally {
    process.kill = originalKill;
    replacement?.release();
    await cleanup(parent, fixture?.child, null);
  }
});

test("a zombie-only process group is not reported as executable when the kernel exposes it", linuxOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-daemon-zombie-"));
  const leader = spawn(process.execPath, ["-e", "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 1000)"], { detached: true, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processGroupStatus(leader.pid), "alive");
    killGroup(leader.pid, "SIGKILL");
    await waitForExit(leader);
    // Once the leader is gone, kernels that retain its child as a zombie
    // expose a non-executable group; otherwise the group is simply gone.
    assert.equal(["gone", "unknown"].includes(processGroupStatus(leader.pid)), true);
  } finally {
    if (leader.exitCode === null) killGroup(leader.pid);
    await waitForExit(leader).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});
