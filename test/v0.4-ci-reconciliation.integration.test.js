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

async function fixture({
  workerFactory,
  workerRetireTimeoutMs,
  taskAuthority = authority,
  gitHubAdapter,
  completionContract,
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-ci-reconcile-"));
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
  const adapter = gitHubAdapter ?? makeFakeGitHubAdapter();
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot,
    workerRetireTimeoutMs,
    remoteTransport: makeTransport(remote),
    gitHubAdapter: adapter,
    workerFactory: workerFactory ?? defaultWorkerFactory,
  });
  const task = await runtime.createTask({
    goal: "reconcile task on CI wait",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority: taskAuthority,
    completionContract: completionContract ?? {
      objective: "reconcile task on CI wait",
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
    gitHubAdapter: adapter,
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

test("1. exact R has all required checks success -> normalized success", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
  try {
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
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    });

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1001,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { id: 1, slug: "github-actions", name: "GitHub Actions" },
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([
      {
        id: 2001,
        context: "build",
        state: "success",
        description: "build passed",
        sha: candidateR,
      },
    ]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "success");
    assert.equal(result.waitSubscription.status, "active");
    assert.ok(result.waitSubscription.lastReconciledAt);
    assert.equal(result.waitSubscription.nextReconcileAt, null);

    const checkObs = result.task.evidence.find(
      (e) => e.kind === "github_check_observation",
    );
    assert.ok(checkObs);
    assert.equal(checkObs.subject, candidateR);
    assert.equal(checkObs.payload.normalizedState, "success");
    assert.equal(checkObs.payload.conclusion, "success");
    assert.equal(checkObs.payload.runId, 1001);
    assert.equal(checkObs.payload.selector, "check_run:github-actions/ci");

    const statusObs = result.task.evidence.find(
      (e) => e.kind === "github_status_observation",
    );
    assert.ok(statusObs);
    assert.equal(statusObs.subject, candidateR);
    assert.equal(statusObs.payload.normalizedState, "success");
    assert.equal(statusObs.payload.conclusion, "success");
    assert.equal(statusObs.payload.statusId, 2001);
    assert.equal(statusObs.payload.selector, "commit_status:build");
  } finally {
    await closeFixture(value);
  }
});

test("2. wrong SHA is green but R pending -> R remains pending", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
  try {
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
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    });

    const wrongSha = "0123456789abcdef0123456789abcdef01234567";
    value.gitHubAdapter.setCheckRuns([
      {
        id: 1002,
        name: "ci",
        head_sha: wrongSha,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([
      {
        id: 2002,
        context: "build",
        state: "success",
        sha: wrongSha,
      },
    ]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "pending");
    assert.ok(result.waitSubscription.lastReconciledAt);
    assert.ok(result.waitSubscription.nextReconcileAt);

    const observations = result.task.evidence.filter(
      (e) =>
        e.kind === "github_check_observation" ||
        e.kind === "github_status_observation",
    );
    assert.equal(observations.length, 0);
  } finally {
    await closeFixture(value);
  }
});

test("2a. commit status with missing or mismatched SHA stays pending and cannot trigger", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["commit_status:build"],
    },
  });
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test2a');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });
    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["commit_status:build"],
    });

    const wrongSha = "0123456789abcdef0123456789abcdef01234567";
    value.gitHubAdapter.setHooks({
      checkRunsHook: async () => [],
      commitStatusesHook: async () => [
        { id: 2003, context: "build", state: "success", sha: wrongSha },
        { id: 2004, context: "build", state: "success" },
      ],
    });

    const results = await value.runtime.startWaitReactor({
      observer: value.gitHubAdapter,
    });
    assert.equal(results[0].classification, "pending");
    assert.equal(results[0].triggered, undefined);
    assert.equal(value.runtime.getTask(value.task.id).state, "waiting");
    assert.equal(value.runtime.getWaitSubscription(registered.waitSubscription.id).status, "active");
    assert.equal(
      value.runtime.getTask(value.task.id).evidence.filter(
        (e) => e.kind === "github_status_observation",
      ).length,
      0,
    );
  } finally {
    value.runtime.stopWaitReactor();
    await closeFixture(value);
  }
});

test("3. one required selector missing -> pending", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:coverage"],
    },
  });
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
      requiredChecks: ["check_run:github-actions/ci", "commit_status:coverage"],
    });

    // Check run is green, but commit_status:coverage is missing
    value.gitHubAdapter.setCheckRuns([
      {
        id: 1003,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "pending");
    const checkResult = result.selectorResults.find(
      (s) => s.selector === "check_run:github-actions/ci",
    );
    assert.equal(checkResult.matched, true);
    assert.equal(checkResult.normalizedState, "success");

    const statusResult = result.selectorResults.find(
      (s) => s.selector === "commit_status:coverage",
    );
    assert.equal(statusResult.matched, false);
    assert.equal(statusResult.normalizedState, "pending");
  } finally {
    await closeFixture(value);
  }
});

test("4. one required selector fails -> failure", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test4');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    });

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1004,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([
      {
        id: 2004,
        context: "build",
        state: "failure",
        sha: candidateR,
      },
    ]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "failure");

    const failedObs = result.task.evidence.find(
      (e) =>
        e.kind === "github_status_observation" &&
        e.payload.selector === "commit_status:build",
    );
    assert.ok(failedObs);
    assert.equal(failedObs.payload.normalizedState, "failure");
    assert.equal(failedObs.payload.conclusion, "failure");
  } finally {
    await closeFixture(value);
  }
});

test("5. unrelated green check does not satisfy required selector", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/required-gate"],
    },
  });
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
      requiredChecks: ["check_run:github-actions/required-gate"],
    });

    // Unrelated green checks
    value.gitHubAdapter.setCheckRuns([
      {
        id: 1005,
        name: "unrelated-linter",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
      {
        id: 1006,
        name: "required-gate",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "travis-ci" }, // Different app
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([
      {
        id: 2005,
        context: "other-status",
        state: "success",
        sha: candidateR,
      },
    ]);

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "pending");
    assert.equal(result.selectorResults[0].matched, false);
  } finally {
    await closeFixture(value);
  }
});

test("6. neutral/skipped rejected by default and accepted only when contract allows", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci"],
    },
  });
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test6');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    // 6a: Default acceptedConclusions: ["success"]
    const defaultWait = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1007,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "neutral",
        app: { slug: "github-actions" },
      },
    ]);

    const resNeutral = await value.runtime.reconcileWaitSubscription(
      defaultWait.waitSubscription.id,
    );
    assert.equal(resNeutral.classification, "failure");
    assert.equal(resNeutral.selectorResults[0].normalizedState, "failure");

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1008,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "skipped",
        app: { slug: "github-actions" },
      },
    ]);

    const resSkipped = await value.runtime.reconcileWaitSubscription(
      defaultWait.waitSubscription.id,
    );
    assert.equal(resSkipped.classification, "failure");

    // 6b: A caller cannot widen the accepted conclusion policy.
    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidateR,
        requiredChecks: ["check_run:github-actions/ci"],
        acceptedConclusions: ["success", "neutral", "skipped"],
      }),
      (error) => error.code === "wait_authority_mismatch",
    );
  } finally {
    await closeFixture(value);
  }
});

test("7. duplicate polling does not create unbounded duplicate Evidence", async () => {
  const value = await fixture({
    completionContract: {
      objective: "reconcile task on CI wait",
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    },
  });
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
      requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
    });

    value.gitHubAdapter.setCheckRuns([
      {
        id: 1009,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);
    value.gitHubAdapter.setCommitStatuses([
      {
        id: 2009,
        context: "build",
        state: "success",
        sha: candidateR,
      },
    ]);

    // Poll 5 times
    for (let i = 0; i < 5; i++) {
      await value.runtime.reconcileWaitSubscription(
        registered.waitSubscription.id,
      );
    }

    const task = value.runtime.getTask(value.task.id);
    const observationEvidence = task.evidence.filter(
      (e) =>
        e.kind === "github_check_observation" ||
        e.kind === "github_status_observation",
    );

    // Exactly 2 observation rows (1 for check run, 1 for commit status)
    assert.equal(observationEvidence.length, 2);
  } finally {
    await closeFixture(value);
  }
});

test("8. daemon restart causes immediate reconciliation of active wait", async () => {
  const value = await fixture();
  let candidateR;
  let waitId;
  try {
    candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test8');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const reg = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });
    waitId = reg.waitSubscription.id;
  } finally {
    value.runtime.close();
  }

  // Fresh restarted daemon runtime
  const restartedAdapter = makeFakeGitHubAdapter({
    checkRuns: [
      {
        id: 1010,
        name: "ci",
        head_sha: candidateR,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ],
  });

  const restartedRuntime = new RuntimeStore({
    dbPath: value.dbPath,
    piCommand: value.piCommand,
    worktreeRoot: value.worktreeRoot,
    remoteTransport: makeTransport(value.remote),
    gitHubAdapter: restartedAdapter,
  });

  try {
    const results = await restartedRuntime.reconcileActiveWaits();
    assert.equal(results.length, 1);
    assert.equal(results[0].classification, "success");
    assert.equal(results[0].waitSubscription.id, waitId);
    assert.ok(results[0].waitSubscription.lastReconciledAt);

    const task = restartedRuntime.getTask(value.task.id);
    const checkObs = task.evidence.find(
      (e) => e.kind === "github_check_observation",
    );
    assert.ok(checkObs);
    assert.equal(checkObs.payload.runId, 1010);
  } finally {
    restartedRuntime.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("9. rate-limit/network error leaves wait truth unchanged and schedules retry", async () => {
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

    // 9a: Rate limit error with retryAfterMs
    value.gitHubAdapter.setHooks({
      checkRunsHook: async () => {
        throw Object.assign(new Error("API rate limit exceeded"), {
          code: "rate_limited",
          retryAfterMs: 45_000,
        });
      },
    });

    const rateLimitRes = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(rateLimitRes.classification, "pending");
    assert.equal(rateLimitRes.transientError?.code, "rate_limited");
    assert.equal(rateLimitRes.task.state, "waiting");
    assert.equal(rateLimitRes.waitSubscription.status, "active");
    assert.ok(rateLimitRes.waitSubscription.lastReconciledAt);
    assert.ok(rateLimitRes.waitSubscription.nextReconcileAt);

    const scheduledDelay =
      new Date(rateLimitRes.waitSubscription.nextReconcileAt).getTime() -
      new Date(rateLimitRes.waitSubscription.lastReconciledAt).getTime();
    assert.ok(scheduledDelay >= 44_000 && scheduledDelay <= 46_000);

    // 9b: Network error
    value.gitHubAdapter.setHooks({
      checkRunsHook: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
          code: "network_error",
        });
      },
    });

    const networkRes = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(networkRes.classification, "pending");
    assert.equal(networkRes.transientError?.code, "network_error");
    assert.equal(networkRes.task.state, "waiting");
    assert.equal(networkRes.waitSubscription.status, "active");

    const obs = networkRes.task.evidence.filter((e) =>
      e.kind.includes("observation"),
    );
    assert.equal(obs.length, 0);
  } finally {
    await closeFixture(value);
  }
});

test("10. auth/permission failure becomes a bounded user/runtime block, not fake CI failure", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test10');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    value.gitHubAdapter.setHooks({
      checkRunsHook: async () => {
        throw Object.assign(new Error("Bad credentials token=ghp_SECRET_TOKEN_XYZ"), {
          code: "auth_failure",
        });
      },
    });

    const result = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
    );

    assert.equal(result.classification, "blocked_on_user");
    assert.equal(result.error?.code, "auth_failure");
    assert.equal(result.task.state, "blocked");

    // Must NOT record fake CI failure evidence
    const observations = result.task.evidence.filter((e) =>
      e.kind.includes("observation"),
    );
    assert.equal(observations.length, 0);

    // Secrets must NEVER be stored in Evidence payload
    for (const ev of result.task.evidence) {
      assert.ok(!JSON.stringify(ev.payload).includes("ghp_SECRET_TOKEN_XYZ"));
    }
  } finally {
    await closeFixture(value);
  }
});

test("11. grace window expiry if required check never appears -> ci_not_observable", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test11');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
    });

    value.gitHubAdapter.setCheckRuns([]);
    value.gitHubAdapter.setCommitStatuses([]);

    // Poll within grace window (e.g. at +1 minute) -> pending
    const withinGraceTime = new Date(
      new Date(registered.waitSubscription.createdAt).getTime() + 60_000,
    ).toISOString();
    const resWithin = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
      { now: withinGraceTime },
    );
    assert.equal(resWithin.classification, "pending");

    // Poll after grace window (default 10 min, so at +11 minutes) -> ci_not_observable
    const afterGraceTime = new Date(
      new Date(registered.waitSubscription.createdAt).getTime() + 11 * 60_000,
    ).toISOString();
    const resAfter = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
      { now: afterGraceTime },
    );
    assert.equal(resAfter.classification, "ci_not_observable");
    assert.equal(resAfter.selectorResults[0].normalizedState, "ci_not_observable");
  } finally {
    await closeFixture(value);
  }
});

test("12. wait subscription deadline expiry -> timed_out", async () => {
  const value = await fixture();
  try {
    const candidateR = await commitCandidate(
      value.task.taskWorktree,
      "app.js",
      "console.log('test12');\n",
      "feat: app",
    );
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });

    const registered = await value.runtime.registerWaitSubscription({
      taskId: value.task.id,
      revisionSha: candidateR,
      requiredChecks: ["check_run:github-actions/ci"],
      timeoutMs: 60_000,
    });

    // Poll after deadline (e.g. +65 seconds)
    const afterDeadline = new Date(
      new Date(registered.waitSubscription.createdAt).getTime() + 65_000,
    ).toISOString();
    const res = await value.runtime.reconcileWaitSubscription(
      registered.waitSubscription.id,
      { now: afterDeadline },
    );

    assert.equal(res.classification, "timed_out");
    assert.equal(res.waitSubscription.status, "timed_out");
  } finally {
    await closeFixture(value);
  }
});
