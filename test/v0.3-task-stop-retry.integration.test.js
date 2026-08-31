import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRuntime } from "../src/task-runtime.js";
import { processGroupIsAlive } from "../src/process-group.js";

function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }

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

async function fakePi(parent) {
  const command = join(parent, "fake-pi");
  await writeFile(command, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '0.84.4\\n'; fi\n");
  await chmod(command, 0o755);
  return command;
}

function workerFactory(workers, packets) {
  return ({ taskPrompt }) => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    workers.push(child);
    packets.push(taskPrompt);
    return { pid: child.pid, processGroupId: child.pid, close() {} };
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

const optionsFor = (source, model = { provider: "provider", id: "model" }) => ({
  goal: "preserve task progress",
  cwd: source,
  trusted: true,
  model,
  thinkingLevel: "high",
});

test("daemon Stop proves ownership, terminates TERM-resistant groups, and Retry reuses the Task worktree with a new Attempt", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-stop-retry-"));
  const source = await repository(parent);
  const workers = [];
  const packets = [];
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await fakePi(parent),
    workerFactory: workerFactory(workers, packets),
    worktreeRoot: join(parent, "worktrees"),
    workerStopTimeoutMs: 25,
  });
  try {
    const started = await runtime.createTask(optionsFor(source, { provider: "p1", id: "m1" }));
    const progress = join(started.taskWorktree, "progress.txt");
    await writeFile(progress, "keep\n");
    const stopped = await runtime.stopTask(started.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.attempts[0].state, "stopped");
    assert.equal(stopped.attempts[0].terminalDetail, "The Task was intentionally stopped by the user.");
    assert.equal(processGroupIsAlive(workers[0].pid), false);
    assert.equal(await readFile(progress, "utf8"), "keep\n");

    const retried = await runtime.retryTask({ id: started.id, trusted: true, model: { provider: "p2", id: "m2" }, thinkingLevel: "low" });
    assert.equal(retried.id, started.id);
    assert.equal(retried.taskWorktree, started.taskWorktree);
    assert.equal(retried.taskBranch, started.taskBranch);
    assert.equal(retried.attempts.length, 2);
    assert.equal(retried.attempts[1].number, 2);
    assert.equal(retried.attempts[1].provider, "p2");
    assert.equal(retried.attempts[1].modelId, "m2");
    assert.equal(retried.attempts[1].thinkingLevel, "low");
    assert.notEqual(retried.attempts[0].id, retried.attempts[1].id);
    assert.notEqual(retried.attempts[0].workerPid, retried.attempts[1].workerPid);
    assert.match(packets[1], /Attempt: 2/);
    assert.match(packets[1], /Previous attempt outcome: stopped/);
    assert.match(packets[1], /Existing filesystem changes/);
    assert.doesNotMatch(packets[1], /Manager transcript|previous worker transcript/);
    assert.equal(await readFile(progress, "utf8"), "keep\n");
  } finally {
    for (const worker of workers) killGroup(worker);
    for (const worker of workers) await waitForExit(worker).catch(() => {});
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("unsafe Stop fails closed, records a blocked orphan, and keeps global capacity fenced", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-stop-unsafe-"));
  const source = await repository(parent);
  const workers = [];
  const packets = [];
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await fakePi(parent),
    workerFactory: workerFactory(workers, packets),
    worktreeRoot: join(parent, "worktrees"),
    workerStopTimeoutMs: 25,
  });
  try {
    const started = await runtime.createTask(optionsFor(source));
    runtime.db.prepare("UPDATE attempts SET worker_start_identity = 'not-the-worker'").run();
    await assert.rejects(runtime.stopTask(started.id), /could not be safely terminated/);
    const blocked = runtime.getTask(started.id);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.attempts[0].state, "orphaned");
    assert.equal(processGroupIsAlive(workers[0].pid), true);
    await assert.rejects(runtime.retryTask({ id: started.id, ...optionsFor(source) }), /blocked|cannot be retried/);
    await assert.rejects(runtime.createTask({ ...optionsFor(source), goal: "another task" }), /already active/);
  } finally {
    for (const worker of workers) killGroup(worker);
    for (const worker of workers) await waitForExit(worker).catch(() => {});
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});
