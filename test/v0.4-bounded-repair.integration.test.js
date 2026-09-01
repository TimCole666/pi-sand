import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_BUDGET,
  RuntimeStore,
  buildRepairPrompt,
  localGateFailureFingerprint,
  ciFailureFingerprint,
  normalizeBudget,
} from "../src/runtime-store.js";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function eventually(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(15);
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
    async fetchCheckRuns({ repository, sha, githubHost }) {
      calls.push({ method: "fetchCheckRuns", repository, sha, githubHost });
      return checkRuns.filter((r) => r.head_sha == null || r.head_sha === sha);
    },
    async fetchCommitStatuses({ repository, sha, githubHost }) {
      calls.push({ method: "fetchCommitStatuses", repository, sha, githubHost });
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
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-bounded-repair-"));
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
    goal: "implement bounded repair test",
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

// -----------------------------------------------------------------------------
// Scenario 1: local gate fail → same Attempt repair run → gate pass → completion
// -----------------------------------------------------------------------------
test("1. local gate fail -> same Attempt repair run -> gate pass -> completion", async () => {
  let promptReceived = null;
  let emitEvent = null;
  let workerCwd = null;

  const workerFactory = async ({ cwd, onEvent }) => {
    workerCwd = cwd;
    emitEvent = onEvent;
    // Initial run: create a failing state (missing pass.txt)
    await writeFile(join(cwd, "candidate.txt"), "run 1 candidate\n");
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "initial candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });

    return {
      callbacksAttached: true,
      executionSnapshot: { sessionId: "sess-repair-1" },
      sessionId: "sess-repair-1",
      async prompt(message) {
        promptReceived = message;
        // Fix the issue in the worktree
        await writeFile(join(workerCwd, "pass.txt"), "gate pass!\n");
        // Emit events for run 2 after prompt acknowledgement
        setTimeout(() => {
          emitEvent({ type: "agent_start" });
          emitEvent({
            type: "message_end",
            message: { role: "assistant", content: "repaired candidate ready", stopReason: "stop" },
          });
          emitEvent({ type: "agent_settled" });
        }, 15);
        return { accepted: true };
      },
      close() {},
    };
  };

  const gateScript = `const fs = require("node:fs"); if (!fs.existsSync("pass.txt")) { process.stderr.write("missing pass.txt\\n"); process.exit(1); }`;

  const value = await fixture({
    workerFactory,
    completionContract: {
      objective: "pass local gate after repair",
      localGates: [
        {
          id: "check-pass-gate",
          command: [process.execPath, "-e", gateScript],
        },
      ],
    },
  });

  try {
    const completedTask = await eventually(
      () => value.runtime.getTask(value.task.id),
      (t) => t.state === "completed",
    );

    assert.equal(completedTask.state, "completed");
    assert.equal(completedTask.terminalReason, "verified_local");
    assert.equal(completedTask.attempts.length, 1);
    assert.equal(completedTask.attempts[0].attemptRuns.length, 2);
    assert.equal(completedTask.attempts[0].attemptRuns[0].kind, "initial");
    assert.equal(completedTask.attempts[0].attemptRuns[0].state, "settled");
    assert.equal(completedTask.attempts[0].attemptRuns[1].kind, "local_repair");
    assert.equal(completedTask.attempts[0].attemptRuns[1].state, "settled");
    assert.ok(promptReceived, "Worker received repair prompt");
    assert.match(promptReceived, /pi-sand Verification Repair Request/);
    assert.match(promptReceived, /check-pass-gate/);

    const deliveryRows = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].outcome, "completed");
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 2: local repair hits same fingerprint twice/no progress → stops with stalled/failed
// -----------------------------------------------------------------------------
test("2. local repair hits same fingerprint twice/no progress -> stops with stalled/failed instead of infinite re-prompt", async () => {
  let promptCalls = 0;
  let emitEvent = null;

  const workerFactory = async ({ onEvent }) => {
    emitEvent = onEvent;
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "attempt 1 result", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });

    return {
      callbacksAttached: true,
      executionSnapshot: { sessionId: "sess-stall-1" },
      sessionId: "sess-stall-1",
      async prompt(message) {
        promptCalls += 1;
        // Settle again without fixing anything
        setTimeout(() => {
          emitEvent({ type: "agent_start" });
          emitEvent({
            type: "message_end",
            message: { role: "assistant", content: "attempt 2 same result", stopReason: "stop" },
          });
          emitEvent({ type: "agent_settled" });
        }, 15);
        return { accepted: true };
      },
      close() {},
    };
  };

  const failingGateScript = `process.stderr.write("deterministic syntax error\\n"); process.exit(42);`;

  const value = await fixture({
    workerFactory,
    budget: {
      maxSameFailureFingerprint: 2,
      maxNoProgressSupervisorIterations: 2,
    },
    completionContract: {
      objective: "trigger stall",
      localGates: [
        {
          id: "failing-gate",
          command: [process.execPath, "-e", failingGateScript],
        },
      ],
    },
  });

  try {
    const failedTask = await eventually(
      () => value.runtime.getTask(value.task.id),
      (t) => t.state === "failed",
    );

    assert.equal(failedTask.state, "failed");
    assert.equal(failedTask.terminalReason, "stalled");
    assert.equal(failedTask.attempts.length, 1);
    assert.equal(failedTask.attempts[0].attemptRuns.length, 2);
    assert.equal(promptCalls, 1, "Prompt called exactly once before stalling on second failure");

    const deliveryRows = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].outcome, "failed");
    assert.equal(deliveryRows[0].payload.includes('"terminalReason":"stalled"'), true);
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 3: CI R fails → fresh repair Attempt → R2 → fast-forward publish → exact R2 green → completion
// -----------------------------------------------------------------------------
test("3. CI R fails -> fresh repair Attempt -> R2 -> fast-forward publish -> exact R2 green -> completion", async () => {
  let attemptSpawns = [];
  const workerFactory = async ({ onEvent, taskPrompt }) => {
    attemptSpawns.push(taskPrompt);
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, close() {} };
  };

  const value = await fixture({
    workerFactory,
    completionContract: {
      objective: "pass required CI checks",
      requiredChecks: ["check_run:github-actions/ci"],
      acceptedConclusions: ["success"],
    },
  });
  try {
    assert.equal(attemptSpawns.length, 1);
    const candidateR1 = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('v1');\n",
      "feat: v1",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR1 });

    const wait1 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR1,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Provide failing CI on R1
    value.gitHubAdapter.setCheckRuns([
      {
        id: 101,
        name: "ci",
        head_sha: candidateR1,
        status: "completed",
        conclusion: "failure",
        app: { slug: "github-actions" },
      },
    ]);

    const [res1] = await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();
    assert.equal(res1.classification, "failure");
    assert.equal(res1.triggered, true);

    const taskRunning = value.runtime.getTask(value.task.id);
    assert.equal(taskRunning.state, "running");
    assert.equal(taskRunning.attempts.length, 2);
    assert.equal(taskRunning.attempts[1].cause, "repair");
    assert.equal(taskRunning.attempts[1].resumeWaitId, wait1.waitSubscription.id);

    // Attempt 2 produces R2 on top of R1
    const candidateR2 = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('v2-fixed');\n",
      "fix: v2",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR2 });

    const wait2 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR2,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    // Provide green CI on R2
    value.gitHubAdapter.setCheckRuns([
      {
        id: 102,
        name: "ci",
        head_sha: candidateR2,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);

    const [res2] = await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();
    assert.equal(res2.classification, "success");

    const completed = value.runtime.getTask(value.task.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.terminalReason, "verified_ci");
    assert.equal(completed.publicationCount, 2);
    assert.equal(completed.finalRevision, candidateR2);
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 4: R1 fail → R2 fail → R3 fail reaches CI repair/publication budget and no R4 is created
// -----------------------------------------------------------------------------
test("4. R1 fail -> R2 fail -> R3 fail reaches CI repair/publication budget and no R4 is created", async () => {
  const workerFactory = async ({ onEvent }) => {
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, close() {} };
  };

  const value = await fixture({
    workerFactory,
    completionContract: {
      objective: "pass required CI checks",
      requiredChecks: ["check_run:github-actions/ci"],
      acceptedConclusions: ["success"],
    },
    budget: {
      maxCiRepairCycles: 2,
      maxRemotePublications: 3,
      maxSameFailureFingerprint: 10,
    },
  });

  try {
    // Attempt 1 -> Publish R1 -> Fail CI
    const r1 = await commitCandidate(value.task.taskWorktree, "app.js", "v1\n", "v1");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: r1 });
    const wait1 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: r1,
      requiredChecks: ["check_run:github-actions/ci"],
    });
    value.gitHubAdapter.setCheckRuns([
      { id: 201, name: "ci", head_sha: r1, status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
    ]);
    await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();

    // Attempt 2 (CI Repair Cycle 1) -> Publish R2 -> Fail CI
    const r2 = await commitCandidate(value.task.taskWorktree, "app.js", "v2\n", "v2");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: r2 });
    const wait2 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: r2,
      requiredChecks: ["check_run:github-actions/ci"],
    });
    value.gitHubAdapter.setCheckRuns([
      { id: 202, name: "ci", head_sha: r2, status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
    ]);
    await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();

    // Attempt 3 (CI Repair Cycle 2) -> Publish R3 -> Fail CI
    const r3 = await commitCandidate(value.task.taskWorktree, "app.js", "v3\n", "v3");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: r3 });
    const wait3 = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: r3,
      requiredChecks: ["check_run:github-actions/ci"],
    });
    value.gitHubAdapter.setCheckRuns([
      { id: 203, name: "ci", head_sha: r3, status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
    ]);

    // Reconciling wait3 hits the budget ceiling (2 CI repair cycles done, 3 publications done)
    const [res3] = await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();
    assert.equal(res3.triggered, true);

    const taskFinal = value.runtime.getTask(value.task.id);
    assert.equal(taskFinal.state, "failed");
    assert.equal(taskFinal.terminalReason, "budget_exhausted");
    assert.equal(taskFinal.attempts.length, 3, "Exactly 3 attempts (1 initial + 2 repair cycles), no 4th attempt");
    assert.equal(taskFinal.publicationCount, 3, "Publication count capped at 3");

    const deliveryRows = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].outcome, "failed");
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 5: startup failures consume startup/total Attempt budget but not CI repair cycle
// -----------------------------------------------------------------------------
test("5. startup failures consume startup/total Attempt budget but not CI repair cycle", async () => {
  let spawnCount = 0;
  const workerFactory = async () => {
    spawnCount += 1;
    throw new Error("Pi spawn binary execution failed");
  };

  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-startup-"));
  const { source } = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  const worktreeRoot = join(parent, "worktrees");

  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    workerFactory,
    worktreeRoot,
  });

  try {
    await assert.rejects(
      runtime.createTask({
        cwd: source,
        goal: "startup failure test",
        trusted: true,
        model: { provider: "anthropic", id: "claude-3-5-sonnet" },
        thinkingLevel: "low",
        budget: {
          maxStartupFailures: 2,
          maxTotalAttempts: 5,
        },
      }),
      /Pi spawn binary execution failed/,
    );

    const taskAfterSpawnFail = runtime.listTasks()[0];
    assert.ok(taskAfterSpawnFail);

    // Attempt 1 failed at startup
    assert.equal(taskAfterSpawnFail.attempts.length, 1);
    assert.equal(taskAfterSpawnFail.attempts[0].state, "failed");

    // Total attempts count is 1, startup failures count is 1, CI repair count is 0
    const attemptsCount = runtime.db
      .prepare("SELECT COUNT(*) AS c FROM attempts WHERE task_id = ?")
      .get(taskAfterSpawnFail.id).c;
    assert.equal(attemptsCount, 1);

    const ciRepairCount = runtime.db
      .prepare("SELECT COUNT(*) AS c FROM attempts WHERE task_id = ? AND cause = 'repair'")
      .get(taskAfterSpawnFail.id).c;
    assert.equal(ciRepairCount, 0, "Startup failure does not consume CI repair cycle");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Scenario 6: daemon restart preserves budget counters/fingerprints
// -----------------------------------------------------------------------------
test("6. daemon restart preserves budget counters/fingerprints", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-restart-budget-"));
  const { source } = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  const worktreeRoot = join(parent, "worktrees");

  let emitEvent = null;
  const workerFactory = async ({ onEvent }) => {
    emitEvent = onEvent;
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "initial result", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return {
      callbacksAttached: true,
      executionSnapshot: { sessionId: "sess-restart-1" },
      sessionId: "sess-restart-1",
      async prompt() {
        setTimeout(() => {
          emitEvent({ type: "agent_start" });
          emitEvent({
            type: "message_end",
            message: { role: "assistant", content: "reprompt result", stopReason: "stop" },
          });
          emitEvent({ type: "agent_settled" });
        }, 15);
        return { accepted: true };
      },
      close() {},
    };
  };

  const gateScript = `process.stderr.write("persisted failure error\\n"); process.exit(9);`;

  let runtime1 = new RuntimeStore({
    dbPath,
    piCommand,
    workerFactory,
    worktreeRoot,
  });

  let taskId = null;
  try {
    const started = await runtime1.createTask({
      cwd: source,
      goal: "restart test",
      trusted: true,
      model: { provider: "anthropic", id: "claude-3-5-sonnet" },
      thinkingLevel: "low",
      budget: {
        maxSameFailureFingerprint: 2,
      },
      completionContract: {
        objective: "test gate",
        localGates: [{ id: "failing-gate", command: [process.execPath, "-e", gateScript] }],
      },
    });
    taskId = started.id;

    // Wait for run 1 to settle and prompt run 2
    await eventually(
      () => runtime1.getTask(taskId),
      (t) => t.attempts[0].attemptRuns.length === 2 && t.attempts[0].attemptRuns[1].state === "accepted",
    );

    // Verify 1 local_gate_result evidence was recorded
    const evidenceRows1 = runtime1.db
      .prepare("SELECT * FROM evidence WHERE task_id = ? AND kind = 'local_gate_result'")
      .all(taskId);
    assert.equal(evidenceRows1.length, 1);

    // Shutdown / close runtime1 (simulating daemon downtime)
    await runtime1.shutdown();
    runtime1.release();

    // Start fresh runtime2 on the same sqlite database
    const runtime2 = new RuntimeStore({
      dbPath,
      piCommand,
      workerFactory,
      worktreeRoot,
    });
    runtime1 = runtime2;
    runtime2.open();

    // Check that evidence history was preserved across restart
    const evidenceRows2 = runtime2.db
      .prepare("SELECT * FROM evidence WHERE task_id = ? AND kind = 'local_gate_result'")
      .all(taskId);
    assert.equal(evidenceRows2.length, 1, "Evidence persisted in SQLite across restart");

    // The failure fingerprint matches and consecutiveCount reaches 2 -> stalled
    const parsedPayload = JSON.parse(evidenceRows2[0].payload);
    const failureFp = localGateFailureFingerprint({
      candidateSha: parsedPayload.candidateSha,
      criterion: "failing-gate",
      exitCategory: "nonzero",
      exitCode: 9,
      stderr: "persisted failure error\n",
    });
    assert.equal(localGateFailureFingerprint(parsedPayload), failureFp);
  } finally {
    runtime1.close();
    await rm(parent, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Scenario 7: wall-clock/CI deadline expiry performs final reconciliation first (if green offline, completes)
// -----------------------------------------------------------------------------
test("7. wall-clock/CI deadline expiry performs final reconciliation first (if green offline, completes)", async () => {
  const value = await fixture({
    completionContract: {
      objective: "pass required CI checks",
      requiredChecks: ["check_run:github-actions/ci"],
      acceptedConclusions: ["success"],
    },
  });
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('offline green');\n",
      "feat: offline green",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
      timeoutMs: 60_000,
    });

    // Simulate time passing beyond deadline (e.g. +120 seconds after creation)
    const afterDeadlineIso = new Date(
      new Date(registered.waitSubscription.createdAt).getTime() + 120_000,
    ).toISOString();

    // While offline, GitHub CI actually completed successfully
    value.gitHubAdapter.setCheckRuns([
      {
        id: 701,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);

    // Reconcile wait subscription after deadline
    value.runtime.waitClock = () => afterDeadlineIso;
    const [res] = await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();

    // Because GitHub CI was green, it completes the task instead of failing/timing out
    assert.equal(res.classification, "success");

    const taskCompleted = value.runtime.getTask(value.task.id);
    assert.equal(taskCompleted.state, "completed");
    assert.equal(taskCompleted.terminalReason, "verified_ci");

    const deliveryRows = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].outcome, "completed");
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 8: unsafe same-Attempt context gets a bounded fresh local repair
// -----------------------------------------------------------------------------
test("8. unsafe same-Attempt context allocates one fresh local repair Attempt", async () => {
  let workerCount = 0;
  const workerFactory = async ({ cwd, onEvent }) => {
    workerCount += 1;
    if (workerCount === 2) await writeFile(join(cwd, "pass.txt"), "pass\\n");
    onEvent({
      type: "message_end",
      message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
    });
    onEvent({ type: "agent_settled" });
    return {
      callbacksAttached: true,
      sessionId: `fresh-local-repair-${workerCount}`,
      executionSnapshot: { sessionId: `fresh-local-repair-${workerCount}` },
      close() {},
    };
  };
  const value = await fixture({
    workerFactory,
    completionContract: {
      objective: "recover from an unsafe local repair context",
      localGates: [{
        id: "pass-after-fresh-repair",
        command: [
          process.execPath,
          "-e",
          "if (!require('node:fs').existsSync('pass.txt')) process.exit(1)",
        ],
      }],
    },
  });
  try {
    const completed = await eventually(
      () => value.runtime.getTask(value.task.id),
      (task) => task.state === "completed",
    );
    assert.equal(workerCount, 2);
    assert.equal(completed.attempts.length, 2);
    assert.equal(completed.attempts[1].cause, "repair");
    assert.equal(completed.attempts[0].state, "failed");
    assert.equal(completed.terminalReason, "verified_local");
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 9: expired CI wait fails only after the final exact reconciliation
// -----------------------------------------------------------------------------
test("9. expired CI wait produces one durable external-timeout Result after final reconciliation", async () => {
  const value = await fixture({
    completionContract: {
      objective: "observe required CI",
      requiredChecks: ["check_run:github-actions/ci"],
      acceptedConclusions: ["success"],
    },
  });
  try {
    const candidate = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('timeout');\\n",
      "feat: timeout",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });
    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidate,
      requiredChecks: ["check_run:github-actions/ci"],
      timeoutMs: 1,
    });
    const afterDeadline = new Date(
      new Date(registered.waitSubscription.createdAt).getTime() + 2_000,
    ).toISOString();
    value.runtime.waitClock = () => afterDeadline;
    const [result] = await value.runtime.startWaitReactor();
    value.runtime.stopWaitReactor();

    assert.equal(result.classification, "timed_out");
    assert.equal(result.triggered, true);
    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.state, "failed");
    assert.equal(task.terminalReason, "external_timeout");
    assert.equal(
      value.runtime.db
        .prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ?")
        .get(value.task.id).count,
      1,
    );
  } finally {
    await closeFixture(value);
  }
});

// -----------------------------------------------------------------------------
// Scenario 10: worker/model cannot mutate/increase its own budget
// -----------------------------------------------------------------------------
test("10. worker/model cannot mutate/increase its own budget", async () => {
  const initialBudget = {
    maxTotalAttempts: 2,
    maxCodeProducingAttempts: 2,
    maxRemotePublications: 1,
    maxPiRunsPerAttempt: 2,
  };

  const value = await fixture({
    budget: initialBudget,
  });

  try {
    assert.equal(normalizeBudget({ maxTotalAttempts: 99 }).maxTotalAttempts, DEFAULT_BUDGET.maxTotalAttempts);
    const task = value.runtime.getTask(value.task.id);
    const storedBudget = normalizeBudget(task.budget);
    assert.equal(storedBudget.maxTotalAttempts, 2);
    assert.equal(storedBudget.maxRemotePublications, 1);
    assert.equal(storedBudget.maxPiRunsPerAttempt, 2);

    // Verify task row in sqlite has immutable frozen budget
    const rawBudget = value.runtime.db
      .prepare("SELECT budget FROM tasks WHERE id = ?")
      .get(value.task.id).budget;
    const parsedRaw = JSON.parse(rawBudget);
    assert.equal(parsedRaw.maxTotalAttempts, 2);
    assert.equal(parsedRaw.maxRemotePublications, 1);

    // Publish candidate 1 (allowed by budget = 1)
    const r1 = await commitCandidate(value.task.taskWorktree, "app.js", "v1\n", "v1");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: r1 });

    // Publish candidate 2 should be rejected because maxRemotePublications = 1
    const r2 = await commitCandidate(value.task.taskWorktree, "app.js", "v2\n", "v2");
    await assert.rejects(
      value.runtime.publishTask({ id: value.task.id, candidateSha: r2 }),
      /Remote publication budget exhausted/i,
    );
  } finally {
    await closeFixture(value);
  }
});
