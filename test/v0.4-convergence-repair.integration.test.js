import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRuntimeDaemon } from "../src/daemon.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { PROTOCOL_VERSION } from "../src/runtime-ipc.js";
import { RuntimeStore } from "../src/runtime-store.js";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const eventually = async (read, predicate) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for deterministic runtime state");
};

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-convergence-"));
  const source = join(parent, "source");
  const remote = join(parent, "fixture", "repository.git");
  await mkdir(join(parent, "fixture"), { recursive: true });
  await mkdir(join(parent, "worktrees"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote]);
  const piCommand = join(parent, "pi-version");
  await writeFile(piCommand, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(piCommand, 0o755);
  const checks = [];
  const statuses = [];
  const adapter = {
    async fetchCheckRuns({ sha }) {
      return checks.filter((check) => check.head_sha === sha);
    },
    async fetchCommitStatuses({ sha }) {
      return statuses.filter((status) => status.sha === sha);
    },
  };
  const authority = {
    remotePublication: {
      remote: "origin",
      repositoryId: "fixture/repository",
      githubHost: "github.com",
      allowedRefPrefix: "refs/heads/pi-sand/",
      allowCreateOrFastForward: true,
      allowRewrite: false,
      allowDelete: false,
      allowPr: false,
      allowMerge: false,
      maxPublications: 3,
    },
  };
  let publishedSha = null;
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand,
    worktreeRoot: join(parent, "worktrees"),
    gitHubAdapter: adapter,
    remoteTransport: {
      readRef: () => publishedSha,
      push: ({ newOid }) => {
        publishedSha = newOid;
      },
    },
    workerFactory: async ({ cwd, onEvent }) => {
      await writeFile(join(cwd, "candidate.txt"), "candidate\n");
      execFileSync("git", ["add", "candidate.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "candidate"], { cwd });
      onEvent({ type: "message_end", message: { role: "assistant", content: "done", stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  const task = await runtime.createTask({
    goal: "verify and wait",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority,
    completionContract: {
      objective: "verify and wait",
      localGates: [{ id: "build", command: [process.execPath, "-e", "process.exit(0)"] }],
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
  return { parent, source, runtime, task, checks, statuses, adapter, piCommand, authority };
}

async function closeFixture(value) {
  value.runtime.close();
  await rm(value.parent, { recursive: true, force: true });
}

test("supervisor keeps exact candidate R waiting when local gates pass but CI is required", async () => {
  const value = await fixture();
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const candidate = git(waiting.taskWorktree, ["rev-parse", "HEAD"]);
    assert.equal(waiting.finalRevision, candidate);
    assert.equal(waiting.terminalReason, null);
    assert.equal(waiting.waitSubscriptions[0].status, "active");
    assert.equal(waiting.remoteEffects[0].state, "confirmed");
    assert.notEqual(waiting.terminalReason, "verified_local");

    value.checks.push({ id: 101, name: "ci", head_sha: candidate, status: "completed", conclusion: "success", app: { slug: "github-actions" } });
    value.statuses.push({ id: 201, context: "build", sha: candidate, state: "success" });
    const triggered = await value.runtime.reconcileWaitSubscription(waiting.waitSubscriptions[0].id, { trigger: true });
    assert.equal(triggered.classification, "success");
    assert.equal(value.runtime.getTask(value.task.id).terminalReason, "verified_ci");
  } finally {
    await closeFixture(value);
  }
});

test("public JSONL IPC cannot turn a waiting Task into CI success", async () => {
  const value = await fixture();
  let daemon;
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const waitId = waiting.waitSubscriptions[0].id;
    const dbPath = value.runtime.dbPath;
    value.runtime.close();
    const socketPath = join(value.parent, "runtime.sock");
    const restarted = new RuntimeStore({
      dbPath,
      piCommand: value.piCommand,
      worktreeRoot: join(value.parent, "worktrees"),
      gitHubAdapter: value.adapter,
    });
    daemon = await startRuntimeDaemon({ dbPath, socketPath, store: restarted });
    const client = new RuntimeClient({ socketPath, dbPath });
    const response = await client.requestSocket(
      "wait.trigger",
      { id: waitId, classification: "success" },
      PROTOCOL_VERSION,
    );
    assert.equal(response.success, false);
    assert.equal(response.error.code, "unknown_method");
    assert.equal(restarted.getTask(value.task.id).state, "waiting");
  } finally {
    await daemon?.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("daemon-owned wait reactor reconciles a due CI change without a user request", async () => {
  const value = await fixture();
  let nowValue = Date.now();
  const timers = [];
  const timer = {
    setTimeout(callback, delay) {
      const entry = { callback, delay, unref() {} };
      timers.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      const index = timers.indexOf(entry);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    value.runtime.waitClock = () => nowValue;
    value.runtime.waitTimer = timer;
    await value.runtime.startWaitReactor();
    const scheduled = timers.shift();
    assert.ok(scheduled);
    const candidate = waiting.finalRevision;
    value.checks.push({ id: 102, name: "ci", head_sha: candidate, status: "completed", conclusion: "success", app: { slug: "github-actions" } });
    value.statuses.push({ id: 202, context: "build", sha: candidate, state: "success" });
    nowValue += scheduled.delay + 1;
    scheduled.callback();
    const completed = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "completed");
    assert.equal(completed.terminalReason, "verified_ci");
  } finally {
    value.runtime.stopWaitReactor();
    await closeFixture(value);
  }
});

test("wait registration rejects selector, conclusion, repository, and host retargeting", async () => {
  const value = await fixture();
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const base = { taskId: value.task.id, revisionSha: waiting.finalRevision };
    await assert.rejects(() => value.runtime.registerWaitSubscription({ ...base, requiredChecks: ["check_run:github-actions/ci"] }), (error) => error.code === "wait_authority_mismatch");
    await assert.rejects(() => value.runtime.registerWaitSubscription({ ...base, acceptedConclusions: ["failure"] }), (error) => error.code === "wait_authority_mismatch");
    await assert.rejects(() => value.runtime.registerWaitSubscription({ ...base, repositoryId: "other/repository" }), (error) => error.code === "wait_authority_mismatch");
    await assert.rejects(() => value.runtime.registerWaitSubscription({ ...base, githubHost: "ghe.example" }), (error) => error.code === "wait_authority_mismatch");
  } finally {
    await closeFixture(value);
  }
});
