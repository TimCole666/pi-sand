import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../src/runtime-store.js";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

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
  return {
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
}

function makeFakeGitHubAdapter(initial = {}) {
  let checkRuns = Array.isArray(initial.checkRuns) ? [...initial.checkRuns] : [];
  let commitStatuses = Array.isArray(initial.commitStatuses)
    ? [...initial.commitStatuses]
    : [];
  let checkRunsHook = initial.checkRunsHook ?? null;
  let commitStatusesHook = initial.commitStatusesHook ?? null;
  const calls = [];

  return {
    get calls() {
      return calls;
    },
    setCheckRuns(runs) {
      checkRuns = [...runs];
    },
    setCommitStatuses(statuses) {
      commitStatuses = [...statuses];
    },
    setHooks({ checkRunsHook: crh, commitStatusesHook: csh }) {
      checkRunsHook = crh;
      commitStatusesHook = csh;
    },
    async fetchCheckRuns({ repository, sha, githubHost }) {
      calls.push({ method: "fetchCheckRuns", repository, sha, githubHost });
      if (checkRunsHook) return await checkRunsHook({ repository, sha, githubHost });
      return checkRuns.filter((r) => r.head_sha == null || r.head_sha === sha);
    },
    async fetchCommitStatuses({ repository, sha, githubHost }) {
      calls.push({ method: "fetchCommitStatuses", repository, sha, githubHost });
      if (commitStatusesHook)
        return await commitStatusesHook({ repository, sha, githubHost });
      return commitStatuses.filter((s) => s.sha == null || s.sha === sha);
    },
  };
}

async function commitCandidate(worktree, file, content, message) {
  await writeFile(join(worktree, file), content);
  execFileSync("git", ["-C", worktree, "add", file]);
  execFileSync("git", ["-C", worktree, "commit", "-qm", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

async function fixture({
  workerFactory,
  workerRetireTimeoutMs,
  taskAuthority = authority,
  gitHubAdapter,
  completionContract,
  budget,
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-wake-"));
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
  const transport = makeTransport(remote);
  const fakeGitHub = gitHubAdapter ?? makeFakeGitHubAdapter();
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    workerFactory: workerFactory ?? defaultWorkerFactory,
    worktreeRoot,
    workerRetireTimeoutMs: workerRetireTimeoutMs ?? 50,
    remoteTransport: transport,
    gitHubAdapter: fakeGitHub,
  });
  const task = await runtime.createTask({
    cwd: source,
    goal: "implement feature",
    trusted: true,
    authority: taskAuthority,
    completionContract,
    budget,
    model: { provider: "anthropic", id: "claude-3-5-sonnet" },
    thinkingLevel: "low",
  });
  return {
    parent,
    source,
    remote,
    base,
    dbPath,
    piCommand,
    worktreeRoot,
    runtime,
    transport,
    gitHubAdapter: fakeGitHub,
    task,
  };
}

async function closeFixture(value) {
  if (!value) return;
  try {
    if (value.runtime && !value.runtime.closed) {
      await value.runtime.shutdown();
      value.runtime.release();
    }
  } catch {}
  try {
    await rm(value.parent, { recursive: true, force: true });
  } catch {}
}

test("1. Success observation completes Task deterministically, marks wait triggered, creates pending ResultDelivery without starting Pi", async () => {
  let workerSpawnCount = 0;
  const workerFactory = async ({ onEvent }) => {
    workerSpawnCount += 1;
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, close() {} };
  };

  const value = await fixture({ workerFactory });
  try {
    assert.equal(workerSpawnCount, 1); // Attempt 1 spawn
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test1');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    assert.equal(registered.waitSubscription.status, "active");
    const taskWaiting = value.runtime.getTask(value.task.id);
    assert.equal(taskWaiting.state, "waiting");
    assert.equal(taskWaiting.attempts[0].state, "parked_wait");

    // Reset spawn counter
    workerSpawnCount = 0;

    // Provide passing CI check run
    value.gitHubAdapter.setCheckRuns([
      {
        id: 1001,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);

    // Reconcile and trigger wait
    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
      { trigger: true },
    );

    assert.equal(result.classification, "success");
    assert.equal(result.triggered, true);

    // Verify task is completed
    const taskAfter = value.runtime.getTask(value.task.id);
    assert.equal(taskAfter.state, "completed");
    assert.equal(taskAfter.terminalReason, "verified_ci");
    assert.equal(taskAfter.finalRevision, candidateR);
    assert.equal(taskAfter.finalBranchHead, candidateR);

    // Verify wait subscription is triggered
    const waitAfter = value.runtime.getWaitSubscription(registered.waitSubscription.id);
    assert.equal(waitAfter.status, "triggered");
    assert.ok(waitAfter.triggerEvidenceId);
    assert.equal(waitAfter.continuationAttemptId, null);

    // Verify parked attempt was marked completed
    assert.equal(taskAfter.attempts[0].state, "completed");

    // Verify pending ResultDelivery was created
    const deliveryRows = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].outcome, "completed");
    assert.equal(deliveryRows[0].state, "pending");

    // Verify Pi worker was NOT spawned
    assert.equal(workerSpawnCount, 0);
  } finally {
    await closeFixture(value);
  }
});

test("2. Failure observation triggers wait, allocates exactly one fresh Attempt with resume_wait_id, and transitions Task to running", async () => {
  let workerSpawnCount = 0;
  let spawnedPackets = [];
  const workerFactory = async ({ onEvent, taskPrompt }) => {
    workerSpawnCount += 1;
    spawnedPackets.push(taskPrompt);
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "fixed or ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, close() {} };
  };

  const value = await fixture({ workerFactory });
  try {
    assert.equal(workerSpawnCount, 1); // Attempt 1
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test2');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    assert.equal(registered.waitSubscription.status, "active");

    // Reset spawn counter
    workerSpawnCount = 0;
    spawnedPackets = [];

    // Provide failing CI check run
    value.gitHubAdapter.setCheckRuns([
      {
        id: 1002,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "failure",
        app: { slug: "github-actions" },
      },
    ]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
      { trigger: true },
    );

    assert.equal(result.classification, "failure");
    assert.equal(result.triggered, true);

    const taskAfter = value.runtime.getTask(value.task.id);
    assert.equal(taskAfter.state, "running");
    assert.equal(taskAfter.attempts.length, 2);

    const waitAfter = value.runtime.getWaitSubscription(registered.waitSubscription.id);
    assert.equal(waitAfter.status, "triggered");
    assert.ok(waitAfter.triggerEvidenceId);
    assert.ok(waitAfter.continuationAttemptId);

    const attempt2 = taskAfter.attempts.find((a) => a.id === waitAfter.continuationAttemptId);
    assert.ok(attempt2);
    assert.equal(attempt2.number, 2);
    assert.equal(attempt2.cause, "repair");
    assert.equal(attempt2.resumeWaitId, registered.waitSubscription.id);
    assert.equal(attempt2.state, "running");
    assert.equal(taskAfter.latestAttemptId, attempt2.id);

    // Verify AttemptRun
    assert.ok(attempt2.attemptRuns.length >= 1);
    assert.equal(attempt2.attemptRuns[0].kind, "local_repair");
    assert.ok(["accepted", "settled"].includes(attempt2.attemptRuns[0].state));

    // Verify worker for Attempt 2 was spawned
    assert.equal(workerSpawnCount, 1);
    assert.ok(spawnedPackets[0].includes("Attempt: 2"));
    assert.ok(spawnedPackets[0].includes("Previous attempt outcome: ci_failed"));
  } finally {
    await closeFixture(value);
  }
});

test("3. Duplicate observation is idempotent: second trigger on same wait/observation is a no-op, creates no duplicate Attempt or Result", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test3');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1003,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "failure",
        app: { slug: "github-actions" },
      },
    ]);

    // First trigger
    const res1 = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure" },
    );
    assert.equal(res1.triggered, true);

    const task1 = value.runtime.getTask(value.task.id);
    const attemptCount1 = task1.attempts.length;

    // Second trigger on same wait
    const res2 = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure" },
    );
    assert.equal(res2.triggered, false);
    assert.equal(res2.alreadyTriggered, true);

    const task2 = value.runtime.getTask(value.task.id);
    assert.equal(task2.attempts.length, attemptCount1); // No new Attempt

    // Verify no duplicate Result deliveries
    const deliveries = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveries.length, 0); // Failure continuation doesn't create final Result delivery
  } finally {
    await closeFixture(value);
  }
});

test("4. Stale observation for old SHA / old generation / cancelled / completed Task does not revive work", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test4');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const candidate2 = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test4b');\n",
      "feat: app 2",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate2 });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // 4a. Wrong SHA observation
    const wrongSha = "0123456789abcdef0123456789abcdef01234567";
    const resWrongSha = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      {
        classification: "failure",
        observation: { sha: wrongSha },
      },
    );
    assert.equal(resWrongSha.triggered, false);
    assert.equal(resWrongSha.stale, true);
    assert.equal(value.runtime.getTask(value.task.id).state, "waiting");
    assert.equal(value.runtime.getWaitSubscription(registered.waitSubscription.id).status, "active");

    // 4b. Superseded generation
    const registered2 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidate2,
      requiredChecks: ["check_run:github-actions/ci"],
    });
    assert.equal(registered2.waitSubscription.generation, 2);
    assert.equal(value.runtime.getWaitSubscription(registered.waitSubscription.id).status, "superseded");

    // Trigger on superseded wait 1
    const resSuperseded = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure" },
    );
    assert.equal(resSuperseded.triggered, false);
    assert.equal(resSuperseded.stale, true);

    // 4c. Cancelled/Stopped task
    await value.runtime.stopTask(value.task.id);
    const stoppedTask = value.runtime.getTask(value.task.id);
    assert.equal(stoppedTask.state, "stopped");

    const resStopped = await value.runtime.triggerWaitSubscription(
      registered2.waitSubscription.id,
      { classification: "failure" },
    );
    assert.equal(resStopped.triggered, false);
    assert.equal(resStopped.stale, true);
    assert.equal(value.runtime.getTask(value.task.id).state, "stopped");
  } finally {
    await closeFixture(value);
  }
});

test("5. Crash during transaction: all-or-nothing rollback; wait is not half-triggered", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test5');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Mock an internal failure by making DB throw inside triggerWaitSubscription
    const origPrepare = value.runtime.db.prepare.bind(value.runtime.db);
    let injectFail = true;
    value.runtime.db.prepare = (sql) => {
      if (injectFail && sql.includes("UPDATE tasks SET state = 'running'")) {
        throw new Error("Simulated SQLite failure during transaction");
      }
      return origPrepare(sql);
    };

    await assert.rejects(
      async () => {
        await value.runtime.triggerWaitSubscription(
          registered.waitSubscription.id,
          { classification: "failure" },
        );
      },
      /Simulated SQLite failure during transaction/,
    );

    // Restore prepare
    injectFail = false;
    value.runtime.db.prepare = origPrepare;

    // Verify rollback: wait is still active, task is still waiting, attempts count is 1
    const waitRow = value.runtime.getWaitSubscription(registered.waitSubscription.id);
    assert.equal(waitRow.status, "active");
    assert.equal(waitRow.triggerEvidenceId, null);
    assert.equal(waitRow.continuationAttemptId, null);

    const taskRow = value.runtime.getTask(value.task.id);
    assert.equal(taskRow.state, "waiting");
    assert.equal(taskRow.attempts.length, 1);
  } finally {
    await closeFixture(value);
  }
});

test("6. Crash after transaction commit before worker spawn: persisted Attempt with resume_wait_id remains startable / resumeable", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test6');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Trigger with skipSpawn = true (simulating crash before worker launch)
    const result = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure", skipSpawn: true },
    );

    assert.equal(result.triggered, true);
    assert.ok(result.continuationAttemptId);

    // Simulate daemon crash & restart before spawn
    value.runtime.release();

    const restarted = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      bootId: "fresh-boot-after-crash-before-spawn",
    });
    restarted.open();

    const taskRestarted = restarted.getTask(value.task.id);
    assert.equal(taskRestarted.state, "running");
    assert.equal(taskRestarted.latestAttemptId, result.continuationAttemptId);

    const attempt2 = taskRestarted.attempts.find((a) => a.id === result.continuationAttemptId);
    assert.ok(attempt2);
    assert.equal(attempt2.state, "starting");
    assert.equal(attempt2.workerPid, null);
    assert.equal(attempt2.resumeWaitId, registered.waitSubscription.id);
    assert.equal(attempt2.cause, "repair");

    const waitSub = restarted.getWaitSubscription(registered.waitSubscription.id);
    assert.equal(waitSub.status, "triggered");
    assert.equal(waitSub.continuationAttemptId, attempt2.id);

    // Second trigger is a no-op
    const secondTrigger = await restarted.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure" },
    );
    assert.equal(secondTrigger.alreadyTriggered, true);
    assert.equal(restarted.getTask(value.task.id).attempts.length, 2);

    restarted.release();
  } finally {
    await closeFixture(value);
  }
});

test("7. Crash after process start before prompt: reconciles process group; no second Attempt is allocated for the same wait", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test7');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Trigger with skipSpawn: true to get Attempt 2 allocated
    const triggerRes = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure", skipSpawn: true },
    );

    const attemptId = triggerRes.continuationAttemptId;

    // Record worker process identity as if process was spawned
    value.runtime.db
      .prepare(
        `UPDATE attempts SET worker_pid = ?, worker_pgid = ?, worker_start_identity = 'pid:${process.pid}:1',
        worker_boot_id = ?, worker_terminated = 0, state = 'running' WHERE id = ?`,
      )
      .run(process.pid, process.pid, value.runtime.bootId, attemptId);

    // Close runtime to simulate crash before prompt
    value.runtime.release();

    // Reopen runtime with different boot or reconciliation
    const reopened = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      bootId: "reboot-new-boot-id",
    });
    reopened.open();

    const taskReconciled = reopened.getTask(value.task.id);
    assert.equal(taskReconciled.attempts.length, 2);
    const attempt2 = taskReconciled.attempts.find((a) => a.id === attemptId);
    assert.equal(attempt2.state, "interrupted");
    assert.equal(attempt2.workerTerminated, true);
    assert.equal(attempt2.resumeWaitId, registered.waitSubscription.id);

    // Ensure no third attempt was allocated for this wait
    assert.equal(taskReconciled.attempts.length, 2);

    reopened.release();
  } finally {
    await closeFixture(value);
  }
});

test("8. Ambiguous prompt transmission: marked ambiguous, no blind prompt replay", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test8');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    const triggerRes = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure", skipSpawn: true },
    );

    const attemptId = triggerRes.continuationAttemptId;

    // Simulate an ambiguous AttemptRun state
    value.runtime.db
      .prepare(
        "UPDATE attempt_runs SET state = 'ambiguous', settled_outcome = 'Prompt delivery timed out without acknowledgement' WHERE attempt_id = ?",
      )
      .run(attemptId);

    const task = value.runtime.getTask(value.task.id);
    const attempt2 = task.attempts.find((a) => a.id === attemptId);
    assert.equal(attempt2.attemptRuns[0].state, "ambiguous");
    assert.ok(attempt2.attemptRuns[0].settledOutcome.includes("timed out"));
  } finally {
    await closeFixture(value);
  }
});

test("9. Attempt uniqueness constraint: UNIQUE(resume_wait_id) prevents two Attempts for the same wait", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test9');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    const triggerRes = await value.runtime.triggerWaitSubscription(
      registered.waitSubscription.id,
      { classification: "failure", skipSpawn: true },
    );

    assert.ok(triggerRes.continuationAttemptId);

    // Try inserting a second Attempt directly with the same resume_wait_id
    assert.throws(
      () => {
        value.runtime.db
          .prepare(
            `INSERT INTO attempts (id, task_id, number, provider, model_id, thinking_level, state, started_at, worker_terminated, resume_wait_id, cause)
            VALUES ('duplicate-attempt-id', ?, 99, NULL, NULL, NULL, 'starting', '2026-09-01T00:00:00Z', 1, ?, 'repair')`,
          )
          .run(value.task.id, registered.waitSubscription.id);
      },
      (err) => {
        return (
          err.code === "ERR_SQLITE_ERROR" ||
          /UNIQUE constraint failed.*attempts\.resume_wait_id/i.test(err.message)
        );
      },
    );
  } finally {
    await closeFixture(value);
  }
});

test("10. Crash history A: observation seen, crash before DB transaction -> startup/reconciliation can observe it again", async () => {
  const fake = makeFakeGitHubAdapter({
    checkRuns: [
      {
        id: 101,
        name: "ci",
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
        head_sha: null,
      },
    ],
  });
  const value = await fixture({ gitHubAdapter: fake });
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test10');\n",
      "feat: app",
    );
    fake.setCheckRuns([
      {
        id: 101,
        name: "ci",
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
        head_sha: candidateR,
      },
    ]);
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Simulate crash before DB transaction by closing runtime while wait is active
    value.runtime.release();

    // Restart daemon / runtime: it immediately reconciles active wait and processes observation
    const restarted = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      gitHubAdapter: fake,
    });
    restarted.open();

    const recon = await restarted.reconcileWaitSubscription(registered.waitSubscription.id);
    assert.equal(recon.classification, "success");

    const triggered = await restarted.triggerWaitSubscription(registered.waitSubscription.id, {
      classification: recon.classification,
      selectorResults: recon.selectorResults,
      evidenceIds: recon.evidenceIds,
    });
    assert.equal(triggered.triggered, true);

    const task = restarted.getTask(value.task.id);
    assert.equal(task.state, "completed");
    assert.equal(task.terminalReason, "verified_ci");

    restarted.release();
  } finally {
    await closeFixture(value);
  }
});
