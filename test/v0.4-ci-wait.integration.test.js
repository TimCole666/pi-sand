import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../src/runtime-store.js";
import { AgentService } from "../src/service.js";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function eventually(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(10);
  }
  throw new Error("timed out waiting for condition");
}

async function repository(parent) {
  const source = join(parent, "source");
  const remote = join(parent, "fixture", "repository.git");
  await mkdir(join(parent, "fixture"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "fixture.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote]);
  return { source, remote, base: git(source, ["rev-parse", "HEAD"]) };
}

async function versionCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

const authority = {
  remotePublication: {
    remote: "origin",
    repositoryId: "fixture/repository",
    allowedRefPrefix: "refs/heads/pi-sand/",
    allowCreateOrFastForward: true,
    allowRewrite: false,
    allowDelete: false,
    allowPr: false,
    allowMerge: false,
    maxPublications: 3,
  },
};

function remoteRef(remote, ref) {
  try {
    const output = execFileSync(
      "git",
      ["ls-remote", "--exit-code", "--refs", remote, ref],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return output ? output.split("\t")[0] : null;
  } catch {
    return null;
  }
}

function makeTransport(expectedEndpoint) {
  let pushCount = 0;
  const transport = {
    get pushCount() {
      return pushCount;
    },
    readRef: ({ endpoint, ref }) => {
      return remoteRef(endpoint, ref);
    },
    push: ({ cwd, endpoint, ref, expectedOldOid, newOid }) => {
      pushCount += 1;
      execFileSync(
        "git",
        [
          "-C",
          cwd,
          "push",
          "--porcelain",
          endpoint,
          `${newOid}:${ref}`,
          `--force-with-lease=${ref}:${expectedOldOid ?? ""}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    },
  };
  return transport;
}

async function fixture({ workerFactory, workerRetireTimeoutMs, taskAuthority = authority, completionContract } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-ci-wait-"));
  const { source, remote, base } = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  const worktreeRoot = join(parent, "worktrees");
  const defaultWorkerFactory = async ({ onEvent }) => {
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, close() {} };
  };
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot,
    workerRetireTimeoutMs,
    remoteTransport: makeTransport(remote),
    workerFactory: workerFactory ?? defaultWorkerFactory,
  });
  const task = await runtime.createTask({
    goal: "park task on CI wait",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority: taskAuthority,
    completionContract: completionContract ?? {
      objective: "park task on CI wait",
      requiredChecks: ["check_run:github-actions/ci"],
    },
  });
  await eventually(
    () => runtime.getTask(task.id),
    (current) => current.attempts[0]?.attemptRuns[0]?.state === "settled",
  );
  return {
    parent,
    source,
    remote,
    base,
    dbPath,
    piCommand,
    worktreeRoot,
    runtime,
    task: runtime.getTask(task.id),
  };
}

async function commitCandidate(taskWorktree, filename, contents, message) {
  await writeFile(join(taskWorktree, filename), contents);
  execFileSync("git", ["-C", taskWorktree, "add", filename]);
  execFileSync("git", ["-C", taskWorktree, "commit", "-qm", message]);
  return git(taskWorktree, ["rev-parse", "HEAD"]);
}

async function closeFixture(fixtureValue) {
  fixtureValue.runtime.close();
  await rm(fixtureValue.parent, { recursive: true, force: true });
}

test("1. exact R + required selectors -> one active wait, Task waiting, Attempt parked, worker retired", async () => {
  const value = await fixture({
    completionContract: {
      objective: "park task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
  try {
    const candidateR = await commitCandidate(value.task.taskWorktree, "app.js", "console.log(1);\n", "feat: app");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    });

    assert.equal(registered.task.state, "waiting");
    assert.equal(registered.task.attempts.length, 1);
    assert.equal(registered.task.attempts[0].state, "parked_wait");
    assert.equal(registered.task.attempts[0].workerTerminated, true);
    assert.equal(value.runtime.active, null);

    assert.equal(registered.waitSubscription.status, "active");
    assert.equal(registered.waitSubscription.generation, 1);
    assert.equal(registered.waitSubscription.revisionSha, candidateR);
    assert.equal(registered.waitSubscription.kind, "github_ci");
    assert.equal(registered.waitSubscription.repositoryId, "fixture/repository");
    assert.equal(registered.waitSubscription.publishedRef, `refs/heads/pi-sand/${value.task.id}`);
    assert.deepEqual(registered.waitSubscription.requiredChecks, ["check_run:github-actions/ci", "commit_status:build"]);
    assert.deepEqual(registered.waitSubscription.acceptedConclusions, ["success"]);

    assert.equal(registered.task.waitSubscriptions.length, 1);
    assert.equal(registered.task.waitSubscriptions[0].id, registered.waitSubscription.id);
    assert.equal(registered.task.waitSubscriptions[0].status, "active");

    const waitEvidence = registered.task.evidence.find((e) => e.kind === "wait_subscription");
    assert.ok(waitEvidence);
    assert.equal(waitEvidence.subject, candidateR);
  } finally {
    await closeFixture(value);
  }
});

test("2. daemon restart reconstructs the same active wait and still has no Pi worker alive", async () => {
  const value = await fixture();
  let candidateR;
  try {
    candidateR = await commitCandidate(value.task.taskWorktree, "app.js", "console.log(1);\n", "feat: app");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });
    await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });
  } finally {
    value.runtime.close();
  }

  // Simulate fresh daemon start on the same database
  const restartedRuntime = new RuntimeStore({
    dbPath: value.dbPath,
    piCommand: value.piCommand,
    worktreeRoot: value.worktreeRoot,
    remoteTransport: makeTransport(value.remote),
  });

  try {
    const task = restartedRuntime.getTask(value.task.id);
    assert.equal(task.state, "waiting");
    assert.equal(task.attempts[0].state, "parked_wait");
    assert.equal(task.attempts[0].workerTerminated, true);
    assert.equal(restartedRuntime.active, null);

    assert.equal(task.waitSubscriptions.length, 1);
    assert.equal(task.waitSubscriptions[0].status, "active");
    assert.equal(task.waitSubscriptions[0].generation, 1);
    assert.equal(task.waitSubscriptions[0].revisionSha, candidateR);
  } finally {
    restartedRuntime.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("3. wrong/missing confirmed remote SHA cannot register the wait", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(value.task.taskWorktree, "app.js", "console.log(1);\n", "feat: app");
    // Not published yet!

    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: ["check_run:ci/test"],
      }),
      (error) => error.code === "unconfirmed_remote_publication",
    );

    // Invalid SHA format
    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: "HEAD",
        requiredChecks: ["check_run:ci/test"],
      }),
      (error) => error.code === "invalid_revision_sha",
    );

    // Publish candidateR
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    // Invalid check selector format (missing check_run: or commit_status: prefix)
    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: ["bare-check-name"],
      }),
      (error) => error.code === "invalid_check_selector",
    );

    // Invalid check selector format without app-slug slash
    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: ["check_run:bare_name_without_slash"],
      }),
      (error) => error.code === "invalid_check_selector",
    );

    // Empty required checks
    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: [],
      }),
      (error) => error.code === "invalid_required_checks",
    );

    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.state, "running");
    assert.equal(task.waitSubscriptions.length, 0);
  } finally {
    await closeFixture(value);
  }
});

test("4. registering generation N+1 supersedes N atomically; only N+1 remains active", async () => {
  const value = await fixture();
  try {
    const firstCandidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: firstCandidate });

    const secondCandidate = await commitCandidate(value.task.taskWorktree, "two.txt", "two\n", "two");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: secondCandidate });

    const gen1 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: firstCandidate,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    assert.equal(gen1.waitSubscription.generation, 1);
    assert.equal(gen1.waitSubscription.status, "active");

    const gen2 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: secondCandidate,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    assert.equal(gen2.waitSubscription.generation, 2);
    assert.equal(gen2.waitSubscription.status, "active");

    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.state, "waiting");
    assert.equal(task.waitSubscriptions.length, 2);

    const [firstWait, secondWait] = task.waitSubscriptions;
    assert.equal(firstWait.generation, 1);
    assert.equal(firstWait.status, "superseded");
    assert.equal(firstWait.revisionSha, firstCandidate);

    assert.equal(secondWait.generation, 2);
    assert.equal(secondWait.status, "active");
    assert.equal(secondWait.revisionSha, secondCandidate);

    const activeSubscriptions = task.waitSubscriptions.filter((w) => w.status === "active");
    assert.equal(activeSubscriptions.length, 1);
    assert.equal(activeSubscriptions[0].generation, 2);
  } finally {
    await closeFixture(value);
  }
});

test("5. waiting frees executor process capacity but second autonomous Commitment is still rejected", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(value.task.taskWorktree, "app.js", "console.log(1);\n", "feat: app");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    assert.equal(value.runtime.active, null);
    assert.equal(value.runtime.hasCapacityConflict(), true);

    await assert.rejects(
      () => value.runtime.createTask({
        goal: "second task while first is waiting",
        cwd: value.source,
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
      }),
      /already active or unresolved/,
    );

    // Ordinary foreground Pi service remains usable
    const agentService = new AgentService({
      dbPath: join(value.parent, "agent-service.sqlite"),
      piFactory: () => ({
        prompt() {},
        abort() {},
        close() {},
      }),
    });
    try {
      const agent = agentService.createAgent({ name: "Foreground Agent", workspace: value.source });
      assert.ok(agent.agent.id);
    } finally {
      agentService.close();
    }
  } finally {
    await closeFixture(value);
  }
});

test("6. unsafe/unproven worker retirement does not expose free executor capacity", async () => {
  const { spawn } = await import("node:child_process");
  const lingering = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );

  const value = await fixture({
    workerFactory: async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
      });
      onEvent({ type: "agent_settled" });
      return {
        pid: lingering.pid,
        processGroupId: lingering.pid,
        callbacksAttached: true,
        close() {},
      };
    },
    workerRetireTimeoutMs: 0,
  });

  try {
    const candidateR = await commitCandidate(value.task.taskWorktree, "app.js", "console.log(1);\n", "feat: app");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: ["check_run:github-actions/ci"],
      }),
      (error) => error.code === "worker_retirement_unproven",
    );

    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.state, "blocked");
    assert.equal(task.attempts[0].state, "orphaned");
    assert.equal(task.attempts[0].workerTerminated, false);
    assert.equal(value.runtime.hasCapacityConflict(), true);

    await assert.rejects(
      () => value.runtime.createTask({
        goal: "second task while first is blocked",
        cwd: value.source,
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
      }),
      /already active or unresolved/,
    );
  } finally {
    try {
      process.kill(-lingering.pid, "SIGKILL");
    } catch {}
    await closeFixture(value);
  }
});
