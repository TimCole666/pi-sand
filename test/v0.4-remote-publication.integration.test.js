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
  throw new Error("timed out waiting for the AttemptRun settlement");
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

function makeTransport(
  expectedEndpoint,
  { throwAfterPush = false, leaveUnchanged = false, afterPush } = {},
) {
  let pushCount = 0;
  const endpoints = [];
  const transport = {
    endpoints,
    get pushCount() {
      return pushCount;
    },
    readRef: ({ endpoint, ref }) => {
      endpoints.push(endpoint);
      assert.equal(endpoint, expectedEndpoint);
      return remoteRef(endpoint, ref);
    },
    push: ({ cwd, endpoint, ref, expectedOldOid, newOid }) => {
      endpoints.push(endpoint);
      assert.equal(endpoint, expectedEndpoint);
      pushCount += 1;
      if (leaveUnchanged) {
        const error = new Error("simulated transport ambiguity");
        error.code = "transport";
        throw error;
      }
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
      afterPush?.({ cwd, endpoint, ref, expectedOldOid, newOid });
      if (throwAfterPush) {
        const error = new Error("simulated post-transmit transport ambiguity");
        error.code = "transport";
        throw error;
      }
    },
  };
  return transport;
}

async function fixture({
  remoteTransport,
  beforeRemotePush,
  taskAuthority = authority,
  workerFactory,
  awaitSettlement = true,
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-publication-"));
  const { source, remote, base } = await repository(parent);
  const dbPath = join(parent, "runtime.sqlite");
  const piCommand = await versionCommand(parent);
  const worktreeRoot = join(parent, "worktrees");
  const runtime = new RuntimeStore({
    dbPath,
    piCommand,
    worktreeRoot,
    remoteTransport,
    beforeRemotePush,
    workerFactory: workerFactory ?? (async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    }),
  });
  const task = await runtime.createTask({
    goal: "publish one exact candidate",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority: taskAuthority,
  });
  if (awaitSettlement) {
    await eventually(
      () => runtime.getTask(task.id),
      (current) => current.attempts[0]?.attemptRuns[0]?.state === "settled",
    );
  }
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

function taskRef(task) {
  return `refs/heads/pi-sand/${task.id}`;
}

function authorityWithBudget(maxPublications) {
  return {
    remotePublication: {
      ...authority.remotePublication,
      maxPublications,
    },
  };
}

test("first publication creates only the dedicated ref with the exact candidate SHA", async () => {
  const value = await fixture();
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  try {
    const sourceHead = git(value.source, ["rev-parse", "HEAD"]);
    const candidate = await commitCandidate(
      value.task.taskWorktree,
      "candidate.txt",
      "candidate\n",
      "candidate",
    );
    const published = await value.runtime.publishTask({
      id: value.task.id,
      candidateSha: candidate,
    });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(published.remoteEffect.newOid, candidate);
    assert.equal(published.remoteEffect.expectedOldOid, null);
    assert.equal(published.remoteEffect.controlVersion, 1);
    assert.equal(published.remoteEffect.contractVersion, 1);
    assert.match(published.remoteEffect.actionDigest, /^[0-9a-f]{64}$/);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), candidate);
    assert.deepEqual(
      git(value.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/pi-sand/"])
        .split("\n")
        .filter(Boolean),
      [taskRef(value.task)],
    );
    assert.equal(git(value.source, ["rev-parse", "HEAD"]), sourceHead);
    assert.equal(git(value.source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(published.task.remoteEffects.length, 1);
    assert.ok(transport.endpoints.length >= 3);
    assert.ok(transport.endpoints.every((endpoint) => endpoint === value.remote));
    assert.equal(published.task.authority.remotePublication.repositoryId, "fixture/repository");
    assert.match(published.task.authority.remotePublication.remoteUrlDigest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(published.task.authority).includes(value.remote), false);
    assert.equal(published.remoteEffect.repository, "fixture/repository");
    assert.equal(published.remoteEffect.endpoint, undefined);
  } finally {
    await closeFixture(value);
  }
});

test("second publication is a fast-forward from the confirmed SHA", async () => {
  const value = await fixture();
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  try {
    const first = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: first });
    const second = await commitCandidate(value.task.taskWorktree, "two.txt", "two\n", "two");
    const published = await value.runtime.publishTask({ id: value.task.id, candidateSha: second });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(published.remoteEffect.expectedOldOid, first);
    assert.equal(published.remoteEffect.newOid, second);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), second);
    assert.deepEqual(
      published.task.remoteEffects.map((effect) => effect.state),
      ["confirmed", "confirmed"],
    );
    assert.ok(transport.endpoints.every((endpoint) => endpoint === value.remote));
  } finally {
    await closeFixture(value);
  }
});

test("a publication after correction fast-forwards from the prior confirmed SHA", async () => {
  const value = await fixture({
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    awaitSettlement: false,
  });
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  try {
    const first = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: first });
    await value.runtime.correctTask({ id: value.task.id, objective: "publish the corrected candidate" });
    const second = await commitCandidate(value.task.taskWorktree, "two.txt", "two\n", "two");
    const published = await value.runtime.publishTask({ id: value.task.id, candidateSha: second });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(published.remoteEffect.expectedOldOid, first);
    assert.equal(published.remoteEffect.newOid, second);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), second);
  } finally {
    await closeFixture(value);
  }
});

test("publication admitted after a correction fence is rejected until the new Attempt exists", async () => {
  const value = await fixture({
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    awaitSettlement: false,
  });
  let releaseTermination;
  const terminationGate = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  let terminationStarted;
  const terminationStartedPromise = new Promise((resolve) => {
    terminationStarted = resolve;
  });
  value.runtime.terminateOwnedWorker = async () => {
    terminationStarted();
    await terminationGate;
    return true;
  };
  let correction;
  try {
    correction = value.runtime.correctTask({
      id: value.task.id,
      objective: "publish only after correction",
    });
    await terminationStartedPromise;
    await eventually(
      () => value.runtime.getTask(value.task.id),
      (current) => current.controlVersion === 2 && current.attempts[0].state === "superseded",
    );
    const candidate = await commitCandidate(
      value.task.taskWorktree,
      "during-correction.txt",
      "during correction\n",
      "during correction",
    );
    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "remote_task_ineligible",
    );
    assert.equal(remoteRef(value.remote, taskRef(value.task)), null);
    releaseTermination();
    await correction;
    assert.equal(value.runtime.getTask(value.task.id).attempts.length, 2);
  } finally {
    releaseTermination?.();
    await correction?.catch(() => {});
    await closeFixture(value);
  }
});

test("correction reconciles remote ambiguity before allocating another Attempt", async () => {
  const value = await fixture({
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
    awaitSettlement: false,
  });
  let pushed = false;
  value.runtime.remoteTransport = {
    readRef: ({ endpoint }) => {
      assert.equal(endpoint, value.remote);
      if (!pushed) return null;
      const error = new Error("exact readback unavailable");
      error.code = "transport";
      throw error;
    },
    push: () => {
      pushed = true;
      const error = new Error("post-transmit outcome is unknown");
      error.code = "transport";
      throw error;
    },
  };
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "remote_readback_unknown",
    );
    assert.equal(value.runtime.getTask(value.task.id).remoteEffects[0].state, "transmitted_unknown");

    await assert.rejects(
      () => value.runtime.correctTask({ id: value.task.id, objective: "corrected objective" }),
      (error) => error.code === "remote_readback_unknown",
    );
    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.state, "blocked");
    assert.equal(task.attempts.length, 1);
    assert.equal(task.attempts[0].state, "superseded");
  } finally {
    await closeFixture(value);
  }
});

test("non-fast-forward candidates are rejected without rewriting the dedicated ref", async () => {
  const value = await fixture();
  try {
    const first = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: first });
    const nonFastForward = git(
      value.task.taskWorktree,
      ["commit-tree", `${value.base}^{tree}`, "-m", "unrelated"],
    );
    execFileSync("git", ["-C", value.task.taskWorktree, "reset", "--hard", nonFastForward], {
      stdio: "ignore",
    });

    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: nonFastForward }),
      (error) => error.code === "remote_non_fast_forward",
    );
    assert.equal(remoteRef(value.remote, taskRef(value.task)), first);
    assert.equal(value.runtime.getTask(value.task.id).remoteEffects.length, 1);
  } finally {
    await closeFixture(value);
  }
});

test("out-of-band remote drift is a conflict and is never overwritten", async () => {
  const value = await fixture();
  try {
    const first = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: first });
    const second = await commitCandidate(value.task.taskWorktree, "two.txt", "two\n", "two");
    execFileSync("git", ["--git-dir", value.remote, "update-ref", taskRef(value.task), value.base]);

    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: second }),
      (error) => error.code === "remote_conflict",
    );
    assert.equal(remoteRef(value.remote, taskRef(value.task)), value.base);
  } finally {
    await closeFixture(value);
  }
});

test("post-transmit ambiguity keeps the authorized exact endpoint for readback", async () => {
  const value = await fixture();
  const unauthorized = join(value.parent, "unauthorized", "fixture", "repository.git");
  await mkdir(join(value.parent, "unauthorized", "fixture"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", unauthorized]);
  const transport = makeTransport(value.remote, {
    throwAfterPush: true,
    afterPush: ({ cwd }) => {
      execFileSync("git", ["-C", cwd, "remote", "set-url", "origin", unauthorized]);
    },
  });
  value.runtime.remoteTransport = transport;
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    const published = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(transport.pushCount, 1);
    assert.equal(published.task.remoteEffects[0].attemptCount, 1);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), candidate);
    assert.equal(remoteRef(unauthorized, taskRef(value.task)), null);
    assert.ok(transport.endpoints.every((endpoint) => endpoint === value.remote));
  } finally {
    await closeFixture(value);
  }
});

test("control mutation after transmission reconciles the exact ref without replay", async () => {
  const value = await fixture();
  let pushCount = 0;
  value.runtime.remoteTransport = {
    readRef: ({ endpoint, ref }) => {
      assert.equal(endpoint, value.remote);
      return remoteRef(endpoint, ref);
    },
    push: async ({ cwd, endpoint, ref, expectedOldOid, newOid }) => {
      pushCount += 1;
      execFileSync(
        "git",
        ["-C", cwd, "push", "--porcelain", endpoint, `${newOid}:${ref}`, `--force-with-lease=${ref}:${expectedOldOid ?? ""}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      await value.runtime.stopTask(value.task.id);
    },
  };
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "after-control.txt", "after control\n", "after control");
    const published = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });
    assert.equal(pushCount, 1);
    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(value.runtime.getTask(value.task.id).state, "stopped");
    assert.equal(remoteRef(value.remote, taskRef(value.task)), candidate);
  } finally {
    await closeFixture(value);
  }
});

test("unchanged ambiguous publication retries the same prepared effect within its budget", async () => {
  const value = await fixture();
  let pushCount = 0;
  let firstPush = true;
  value.runtime.remoteTransport = {
    readRef: ({ endpoint, ref }) => {
      assert.equal(endpoint, value.remote);
      return remoteRef(endpoint, ref);
    },
    push: ({ cwd, endpoint, ref, expectedOldOid, newOid }) => {
      assert.equal(endpoint, value.remote);
      pushCount += 1;
      if (firstPush) {
        firstPush = false;
        const error = new Error("simulated transport ambiguity");
        error.code = "transport";
        throw error;
      }
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
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    const unknown = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });
    assert.equal(unknown.remoteEffect.state, "transmitted_unknown");
    assert.equal(unknown.remoteEffect.attemptCount, 1);
    const preparedId = unknown.remoteEffect.id;
    const confirmed = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });

    assert.equal(confirmed.remoteEffect.id, preparedId);
    assert.equal(confirmed.remoteEffect.state, "confirmed");
    assert.equal(confirmed.remoteEffect.attemptCount, 2);
    assert.equal(pushCount, 2);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), candidate);
  } finally {
    await closeFixture(value);
  }
});

test("changed control_version immediately before transmission prevents the push", async () => {
  const value = await fixture();
  let pushes = 0;
  value.runtime.remoteTransport = {
    readRef: ({ endpoint, ref }) => {
      assert.equal(endpoint, value.remote);
      return remoteRef(endpoint, ref);
    },
    push: () => {
      pushes += 1;
    },
  };
  value.runtime.beforeRemotePush = () => {
    value.runtime.db.prepare("UPDATE tasks SET control_version = control_version + 1 WHERE id = ?").run(value.task.id);
  };
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "stale_remote_publication",
    );
    assert.equal(pushes, 0);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), null);
    assert.equal(value.runtime.getTask(value.task.id).remoteEffects[0].state, "failed");
  } finally {
    await closeFixture(value);
  }
});

test("string authority canonicalization persists only supported fields", async () => {
  const value = await fixture({
    taskAuthority: JSON.stringify({
      ...authority,
      metadata: { label: "ignored" },
    }),
  });
  try {
    const task = value.runtime.getTask(value.task.id);
    const storedAuthority = value.runtime.db
      .prepare("SELECT authority FROM tasks WHERE id = ?")
      .get(value.task.id).authority;

    assert.deepEqual(Object.keys(task.authority), ["remotePublication"]);
    assert.equal(task.authority.metadata, undefined);
    assert.equal(storedAuthority.includes("ignored"), false);
  } finally {
    await closeFixture(value);
  }
});

test("terminal Task state at initial publication preflight causes zero pushes", async () => {
  const value = await fixture();
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    value.runtime.db
      .prepare("UPDATE tasks SET state = 'stopped' WHERE id = ?")
      .run(value.task.id);

    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "remote_task_ineligible",
    );
    assert.equal(transport.pushCount, 0);
    assert.equal(value.runtime.getTask(value.task.id).publicationCount, 0);
    assert.equal(value.runtime.getTask(value.task.id).remoteEffects.length, 0);
  } finally {
    await closeFixture(value);
  }
});

test("terminal Task state at the pre-push barrier causes zero pushes", async () => {
  const value = await fixture();
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  value.runtime.beforeRemotePush = () => {
    value.runtime.db
      .prepare("UPDATE tasks SET state = 'stopped' WHERE id = ?")
      .run(value.task.id);
  };
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");

    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "stale_remote_publication",
    );
    const task = value.runtime.getTask(value.task.id);
    assert.equal(transport.pushCount, 0);
    assert.equal(task.publicationCount, 0);
    assert.equal(task.remoteEffects[0].state, "failed");
    assert.equal(task.remoteEffects[0].attemptCount, 0);
  } finally {
    await closeFixture(value);
  }
});

test("maxPublications is shared by distinct candidates and ambiguous retries", async () => {
  const value = await fixture({ taskAuthority: authorityWithBudget(3) });
  let pushCount = 0;
  let ambiguous = true;
  value.runtime.remoteTransport = {
    readRef: ({ endpoint, ref }) => {
      assert.equal(endpoint, value.remote);
      return remoteRef(endpoint, ref);
    },
    push: ({ cwd, endpoint, ref, expectedOldOid, newOid }) => {
      assert.equal(endpoint, value.remote);
      pushCount += 1;
      if (ambiguous) {
        ambiguous = false;
        const error = new Error("simulated transmitted ambiguity");
        error.code = "transport";
        throw error;
      }
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
  try {
    const candidateR = await commitCandidate(value.task.taskWorktree, "r.txt", "R\n", "R");
    const unknown = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });
    assert.equal(unknown.remoteEffect.state, "transmitted_unknown");
    assert.equal(unknown.task.publicationCount, 1);

    const confirmedR = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR });
    assert.equal(confirmedR.remoteEffect.state, "confirmed");
    assert.equal(confirmedR.remoteEffect.attemptCount, 2);
    assert.equal(confirmedR.task.publicationCount, 2);

    const candidateR2 = await commitCandidate(value.task.taskWorktree, "r2.txt", "R2\n", "R2");
    const confirmedR2 = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR2 });
    assert.equal(confirmedR2.remoteEffect.state, "confirmed");
    assert.equal(confirmedR2.task.publicationCount, 3);

    const candidateR3 = await commitCandidate(value.task.taskWorktree, "r3.txt", "R3\n", "R3");
    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidateR3 }),
      (error) => error.code === "remote_budget_exhausted",
    );

    const task = value.runtime.getTask(value.task.id);
    assert.equal(pushCount, 3);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), candidateR2);
    assert.equal(task.publicationCount, 3);
    assert.equal(task.remoteEffects.length, 3);
    assert.deepEqual(
      task.remoteEffects.map(({ state, attemptCount }) => ({ state, attemptCount })),
      [
        { state: "confirmed", attemptCount: 2 },
        { state: "confirmed", attemptCount: 1 },
        { state: "failed", attemptCount: 0 },
      ],
    );
  } finally {
    await closeFixture(value);
  }
});

test("concurrent publication reservations cannot exceed the Task budget", async () => {
  let arrivals = 0;
  let releaseBarrier;
  const barrier = new Promise((resolveBarrier) => {
    releaseBarrier = resolveBarrier;
  });
  const value = await fixture({
    taskAuthority: authorityWithBudget(1),
    beforeRemotePush: async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    },
  });
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    const outcomes = await Promise.allSettled([
      value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
    ]);

    assert.equal(arrivals, 2);
    assert.equal(transport.pushCount, 1);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(
      outcomes.find(({ status }) => status === "rejected").reason.code,
      "remote_budget_exhausted",
    );
    const task = value.runtime.getTask(value.task.id);
    assert.equal(task.publicationCount, 1);
    assert.equal(task.remoteEffects[0].attemptCount, 1);
    assert.equal(task.remoteEffects[0].state, "confirmed");
  } finally {
    await closeFixture(value);
  }
});

test("publication_count migration sums historic attempts and preserves nonzero counts", async () => {
  const value = await fixture({ taskAuthority: authorityWithBudget(3) });
  const transport = makeTransport(value.remote, { leaveUnchanged: true });
  value.runtime.remoteTransport = transport;
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });
    await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });
    value.runtime.db
      .prepare("UPDATE tasks SET publication_count = 0 WHERE id = ?")
      .run(value.task.id);
    value.runtime.close();

    value.runtime = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      remoteTransport: transport,
    });
    assert.equal(value.runtime.getTask(value.task.id).publicationCount, 2);

    value.runtime.db
      .prepare("UPDATE remote_effects SET attempt_count = 99 WHERE task_id = ?")
      .run(value.task.id);
    value.runtime.db
      .prepare("UPDATE tasks SET publication_count = 0 WHERE id = ?")
      .run(value.task.id);
    value.runtime.close();
    value.runtime = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      remoteTransport: transport,
    });
    assert.equal(value.runtime.getTask(value.task.id).publicationCount, 3);

    value.runtime.db
      .prepare("UPDATE tasks SET publication_count = 1 WHERE id = ?")
      .run(value.task.id);
    value.runtime.close();
    value.runtime = new RuntimeStore({
      dbPath: value.dbPath,
      piCommand: value.piCommand,
      worktreeRoot: value.worktreeRoot,
      remoteTransport: transport,
    });
    assert.equal(value.runtime.getTask(value.task.id).publicationCount, 1);
  } finally {
    await closeFixture(value);
  }
});

test("retargeting origin before transmission changes neither bare remote nor publication budget", async () => {
  const value = await fixture();
  const unauthorized = join(value.parent, "unauthorized", "fixture", "repository.git");
  await mkdir(join(value.parent, "unauthorized", "fixture"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", unauthorized]);
  execFileSync(
    "git",
    ["-C", value.source, "push", unauthorized, `${value.base}:${taskRef(value.task)}`],
    { stdio: "ignore" },
  );
  const transport = makeTransport(value.remote);
  value.runtime.remoteTransport = transport;
  value.runtime.beforeRemotePush = () => {
    execFileSync("git", ["-C", value.source, "remote", "set-url", "origin", unauthorized]);
  };
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");

    await assert.rejects(
      () => value.runtime.publishTask({ id: value.task.id, candidateSha: candidate }),
      (error) => error.code === "stale_remote_publication",
    );

    const task = value.runtime.getTask(value.task.id);
    assert.equal(transport.pushCount, 0);
    assert.equal(remoteRef(value.remote, taskRef(value.task)), null);
    assert.equal(remoteRef(unauthorized, taskRef(value.task)), value.base);
    assert.equal(task.publicationCount, 0);
    assert.equal(task.remoteEffects[0].attemptCount, 0);
    assert.equal(task.remoteEffects[0].state, "failed");
  } finally {
    await closeFixture(value);
  }
});

test("invalid URL-shaped repository IDs fail before persistence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-identity-"));
  try {
    const { source } = await repository(parent);
    const piCommand = await versionCommand(parent);
    const invalidRepositoryIds = [
      "https://github.com/fixture/repository",
      "https://token@github.com/fixture/repository",
      "fixture/repository?token=secret",
      "fixture/repository#fragment",
      " fixture/repository",
      "fixture/repo\nsitory",
      "fixture/../repository",
    ];

    for (const [index, repositoryId] of invalidRepositoryIds.entries()) {
      const runtime = new RuntimeStore({
        dbPath: join(parent, `${index}.sqlite`),
        piCommand,
      });
      await assert.rejects(
        () => runtime.createTask({
          goal: "reject invalid repository identity",
          cwd: source,
          trusted: true,
          model: { provider: "provider", id: "model" },
          thinkingLevel: "high",
          authority: {
            remotePublication: {
              ...authority.remotePublication,
              repositoryId,
            },
          },
        }),
        /repository identity|credentials/,
      );
      assert.equal(runtime.db, null);
      runtime.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("credential-named authority fields anywhere fail before persistence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-credentials-"));
  try {
    const { source } = await repository(parent);
    const piCommand = await versionCommand(parent);
    const invalidAuthorities = [
      { ...authority, token: "do-not-persist" },
      { ...authority, metadata: { password: "do-not-persist" } },
      JSON.stringify({
        ...authority,
        metadata: { endpoint: "https://token@github.com/fixture/repository" },
      }),
    ];

    for (const [index, taskAuthority] of invalidAuthorities.entries()) {
      const runtime = new RuntimeStore({
        dbPath: join(parent, `${index}.sqlite`),
        piCommand,
      });
      await assert.rejects(
        () => runtime.createTask({
          goal: "reject credentials",
          cwd: source,
          trusted: true,
          model: { provider: "provider", id: "model" },
          thinkingLevel: "high",
          authority: taskAuthority,
        }),
        /credential|embedded credentials/,
      );
      assert.equal(runtime.db, null);
      runtime.close();
    }

    execFileSync("git", [
      "-C",
      source,
      "remote",
      "set-url",
      "origin",
      "https://token@github.com/fixture/repository.git",
    ]);
    const runtime = new RuntimeStore({
      dbPath: join(parent, "credential-endpoint.sqlite"),
      piCommand,
    });
    await assert.rejects(
      () => runtime.createTask({
        goal: "reject credential endpoint",
        cwd: source,
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
        authority,
      }),
      /credential-free/,
    );
    assert.equal(runtime.db, null);
    runtime.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("remote authority and durable effects reject credentials and remain bounded", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-safety-"));
  try {
    const { source } = await repository(parent);
    const piCommand = await versionCommand(parent);
    const runtime = new RuntimeStore({ dbPath: join(parent, "runtime.sqlite"), piCommand });
    await assert.rejects(
      () => runtime.createTask({
        goal: "reject credentials",
        cwd: source,
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
        authority: {
          remotePublication: {
            ...authority.remotePublication,
            token: "do-not-persist",
          },
        },
      }),
      /credential field/,
    );
    await assert.rejects(
      () => runtime.createTask({
        goal: "reject oversized identity",
        cwd: source,
        trusted: true,
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
        authority: {
          remotePublication: {
            ...authority.remotePublication,
            repositoryId: "x".repeat(1_025),
          },
        },
      }),
      /bounded/,
    );
    assert.equal(runtime.db, null);
    runtime.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
