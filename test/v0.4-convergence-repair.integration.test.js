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

async function fixture({ budget, waitClock, waitTimer, configureRuntime } = {}) {
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
    waitClock,
    waitTimer,
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
  configureRuntime?.(runtime);
  const task = await runtime.createTask({
    goal: "verify and wait",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority,
    budget,
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
    const triggeredResults = await value.runtime.startWaitReactor({ observer: value.adapter });
    const triggered = triggeredResults.find((result) => result.waitSubscription?.id === waiting.waitSubscriptions[0].id);
    assert.equal(triggered.classification, "success");
    assert.equal(value.runtime.getTask(value.task.id).terminalReason, "verified_ci");
  } finally {
    await closeFixture(value);
  }
});

test("direct wait triggering cannot supply authority or evidence", async () => {
  const value = await fixture();
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const waitId = waiting.waitSubscriptions[0].id;
    await assert.rejects(
      () => value.runtime.triggerWaitSubscription(waitId, {
        classification: "success",
        evidenceId: "forged-evidence",
      }),
      (error) => error.code === "wait_trigger_internal_only",
    );
    assert.equal(value.runtime.getTask(value.task.id).state, "waiting");
    assert.equal(value.runtime.getWaitSubscription(waitId).status, "active");
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

test("public wait reconciliation ignores caller future time and remains an observation", async () => {
  const value = await fixture();
  let daemon;
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const dbPath = value.runtime.dbPath;
    const socketPath = join(value.parent, "runtime-future-now.sock");
    value.runtime.close();
    const restarted = new RuntimeStore({
      dbPath,
      piCommand: value.piCommand,
      worktreeRoot: join(value.parent, "worktrees"),
      gitHubAdapter: value.adapter,
    });
    daemon = await startRuntimeDaemon({ dbPath, socketPath, store: restarted });
    const client = new RuntimeClient({ socketPath, dbPath });
    const response = await client.requestSocket(
      "wait.reconcile",
      { id: waiting.waitSubscriptions[0].id, now: "2999-01-01T00:00:00.000Z" },
      PROTOCOL_VERSION,
    );
    assert.equal(response.success, true);
    assert.equal(restarted.getTask(value.task.id).state, "waiting");
    assert.equal(restarted.getWaitSubscription(waiting.waitSubscriptions[0].id).status, "active");
  } finally {
    await daemon?.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("public IPC timeout leaves the wait active until the daemon reactor owns the timeout", async () => {
  const value = await fixture();
  let daemon;
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const waitId = waiting.waitSubscriptions[0].id;
    const dbPath = value.runtime.dbPath;
    const socketPath = join(value.parent, "runtime-public-timeout.sock");
    value.runtime.close();
    const restarted = new RuntimeStore({
      dbPath,
      piCommand: value.piCommand,
      worktreeRoot: join(value.parent, "worktrees"),
      gitHubAdapter: value.adapter,
    });
    daemon = await startRuntimeDaemon({ dbPath, socketPath, store: restarted });
    restarted.db
      .prepare("UPDATE wait_subscriptions SET deadline_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", waitId);
    const client = new RuntimeClient({ socketPath, dbPath });
    const response = await client.requestSocket(
      "wait.reconcile",
      {
        id: waitId,
        now: "2999-01-01T00:00:00.000Z",
        classification: "success",
        evidenceId: "caller-forged-evidence",
        trigger: true,
      },
      PROTOCOL_VERSION,
    );
    assert.equal(response.success, true);
    assert.equal(response.data.task.state, "waiting");
    assert.equal(response.data.waitSubscription.status, "active");
    const timedOut = await eventually(
      () => restarted.getTask(value.task.id),
      (task) => task.state === "failed",
    );
    assert.equal(timedOut.terminalReason, "external_timeout");
    assert.equal(restarted.getWaitSubscription(waitId).status, "timed_out");
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

test("due reactor persists exact ci_not_observable control evidence and terminalizes once", async () => {
  let clock = Date.now();
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
  const value = await fixture({
    budget: { ciCheckAppearanceGraceMs: 60_000 },
    waitClock: () => clock,
    waitTimer: timer,
  });
  try {
    const waiting = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "waiting");
    const waitId = waiting.waitSubscriptions[0].id;
    await value.runtime.startWaitReactor({ observer: value.adapter });
    const firstDue = timers.shift();
    assert.ok(firstDue);
    const firstNext = value.runtime.getWaitSubscription(waitId).nextReconcileAt;

    clock += firstDue.delay + 1;
    await firstDue.callback();
    await value.runtime.waitForWaitReactorIdle();
    const afterFirst = value.runtime.getWaitSubscription(waitId);
    assert.notEqual(afterFirst.nextReconcileAt, firstNext);
    const graceDue = timers.shift();
    assert.ok(graceDue);
    clock = Math.max(
      Date.parse(waiting.waitSubscriptions[0].createdAt) + 60_000,
      Date.parse(afterFirst.nextReconcileAt),
    ) + 1;
    await graceDue.callback();
    await value.runtime.waitForWaitReactorIdle();
    const blocked = value.runtime.getTask(value.task.id);
    assert.equal(blocked.state, "blocked");
    const waitAfter = value.runtime.getWaitSubscription(waitId);
    assert.equal(waitAfter.status, "triggered");
    assert.equal(waitAfter.continuationAttemptId, null);
    assert.equal(blocked.terminalReason, "ci_not_observable");
    assert.equal(blocked.finalRevision, waiting.finalRevision);

    const controlEvidence = blocked.evidence.filter(
      (e) => e.kind === "github_ci_control_observation",
    );
    assert.equal(controlEvidence.length, 2);
    for (const evidence of controlEvidence) {
      assert.deepEqual(
        {
          taskId: evidence.payload.taskId,
          waitSubscriptionId: evidence.payload.waitSubscriptionId,
          generation: evidence.payload.generation,
          controlVersion: evidence.payload.controlVersion,
          contractVersion: evidence.payload.contractVersion,
          repository: evidence.payload.repository,
          ref: evidence.payload.ref,
          sha: evidence.payload.sha,
          selector: evidence.payload.selector,
          normalizedState: evidence.payload.normalizedState,
        },
        {
          taskId: value.task.id,
          waitSubscriptionId: waitId,
          generation: waitAfter.generation,
          controlVersion: waitAfter.controlVersion,
          contractVersion: waitAfter.contractVersion,
          repository: waitAfter.repositoryId,
          ref: waitAfter.publishedRef,
          sha: waitAfter.revisionSha,
          selector: evidence.payload.selector,
          normalizedState: "ci_not_observable",
        },
      );
      assert.match(evidence.dedupeKey, /^github_ci_control_observation:/);
    }
    const deliveries = value.runtime.db
      .prepare("SELECT * FROM result_deliveries WHERE task_id = ?")
      .all(value.task.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].outcome, "failed");
    assert.match(deliveries[0].payload, /ci_not_observable/);
    assert.equal(blocked.attempts.length, 1);
    assert.equal(blocked.attempts[0].state, "failed");
    assert.equal(blocked.attempts[0].workerTerminated, true);
  } finally {
    value.runtime.stopWaitReactor();
    await closeFixture(value);
  }
});

test("retirement after control race fail-closes a running Task with no false wait", async () => {
  let injected = false;
  const value = await fixture({
    configureRuntime(runtime) {
      const originalRetire = runtime.retireWorker.bind(runtime);
      runtime.retireWorker = async (...args) => {
        const retired = await originalRetire(...args);
        if (retired && !injected) {
          injected = true;
          runtime.db
            .prepare("UPDATE tasks SET control_version = control_version + 1")
            .run();
        }
        return retired;
      };
    },
  });
  try {
    const reconciled = await eventually(
      () => value.runtime.getTask(value.task.id),
      (task) => task.state !== "running",
    );
    assert.equal(injected, true);
    assert.notEqual(reconciled.state, "running");
    assert.equal(reconciled.waitSubscriptions.filter((wait) => wait.status === "active").length, 0);
    assert.equal(reconciled.attempts[0].workerTerminated, true);
    assert.notEqual(reconciled.attempts[0].state, "running");
    assert.equal(value.runtime.active, null);
    assert.equal(
      value.runtime.db
        .prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ?")
        .get(value.task.id).count,
      1,
    );
    assert.equal(
      value.runtime.db
        .prepare("SELECT control_version FROM result_deliveries WHERE task_id = ?")
        .get(value.task.id).control_version,
      reconciled.controlVersion,
    );
  } finally {
    await closeFixture(value);
  }
});

test("retirement/version fence does not reconcile a changed Task or cancel its wait", async () => {
  const value = await fixture();
  try {
    const waiting = await eventually(
      () => value.runtime.getTask(value.task.id),
      (task) => task.state === "waiting",
    );
    const candidate = waiting.finalRevision;
    const retireWorker = value.runtime.retireWorker.bind(value.runtime);
    value.runtime.retireWorker = async (...args) => {
      const retired = await retireWorker(...args);
      if (retired) {
        value.runtime.db
          .prepare("UPDATE tasks SET control_version = control_version + 1 WHERE id = ?")
          .run(value.task.id);
      }
      return retired;
    };

    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidate,
        requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
      }),
      (error) => error.code === "stale_wait_registration",
    );

    const reconciled = value.runtime.getTask(value.task.id);
    assert.equal(reconciled.state, "waiting");
    assert.equal(reconciled.attempts[0].state, "parked_wait");
    assert.equal(reconciled.attempts[0].workerTerminated, true);
    assert.equal(value.runtime.active, null);
    assert.equal(
      reconciled.waitSubscriptions.filter((subscription) => subscription.status === "active").length,
      1,
    );
    assert.equal(value.runtime.hasCapacityConflict(), true);
    assert.equal(
      value.runtime.db
        .prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ? AND outcome = 'failed'")
        .get(value.task.id).count,
      0,
    );
  } finally {
    await closeFixture(value);
  }
});

test("retirement compensation cannot interrupt Task or cancel a newer wait", async () => {
  const value = await fixture();
  try {
    const waiting = await eventually(
      () => value.runtime.getTask(value.task.id),
      (task) => task.state === "waiting",
    );
    const priorWait = waiting.waitSubscriptions.find(
      (subscription) => subscription.status === "active",
    );
    const candidate = waiting.finalRevision;
    const originalRetire = value.runtime.retireWorker.bind(value.runtime);
    let injected = false;
    let failRegistration = false;
    let newerRegistration;

    const originalPrepare = value.runtime.db.prepare.bind(value.runtime.db);
    value.runtime.db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (failRegistration && sql.startsWith("UPDATE tasks SET state = 'waiting'")) {
        failRegistration = false;
        return {
          run() {
            throw Object.assign(new Error("deterministic registration barrier"), {
              code: "registration_barrier",
            });
          },
        };
      }
      return statement;
    };
    value.runtime.retireWorker = async (...args) => {
      const retired = await originalRetire(...args);
      if (retired && !injected) {
        injected = true;
        newerRegistration = await value.runtime.registerWaitSubscription({
          taskId: value.task.id,
          revisionSha: candidate,
          requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
        });
        // Registration A resumes only after B has committed its newer wait.
        failRegistration = true;
      }
      return retired;
    };

    await assert.rejects(
      () => value.runtime.registerWaitSubscription({
        taskId: value.task.id,
        revisionSha: candidate,
        requiredChecks: ["check_run:github-actions/ci", "commit_status:build"],
      }),
      (error) => error.code === "registration_barrier",
    );

    const reconciled = value.runtime.getTask(value.task.id);
    const newerWait = value.runtime.getWaitSubscription(
      newerRegistration.waitSubscription.id,
    );
    assert.equal(priorWait.status, "active");
    assert.equal(newerRegistration.waitSubscription.generation, priorWait.generation + 1);
    assert.equal(newerWait.status, "active");
    assert.equal(reconciled.state, "waiting");
    assert.equal(reconciled.attempts[0].state, "parked_wait");
    assert.equal(reconciled.attempts[0].workerTerminated, true);
    assert.equal(
      reconciled.waitSubscriptions.filter((subscription) => subscription.status === "active").length,
      1,
    );
    assert.equal(
      value.runtime.db
        .prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ? AND outcome = 'failed'")
        .get(value.task.id).count,
      0,
    );
  } finally {
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
