import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const remote = join(parent, "remote.git");
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

function makeTransport(remote, { throwAfterPush = false, leaveUnchanged = false } = {}) {
  let pushCount = 0;
  const transport = {
    get pushCount() {
      return pushCount;
    },
    readRef: ({ ref }) => remoteRef(remote, ref),
    push: ({ cwd, ref, expectedOldOid, newOid }) => {
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
          remote,
          `${newOid}:${ref}`,
          `--force-with-lease=${ref}:${expectedOldOid ?? ""}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (throwAfterPush) {
        const error = new Error("simulated post-transmit transport ambiguity");
        error.code = "transport";
        throw error;
      }
    },
  };
  return transport;
}

async function fixture({ remoteTransport, beforeRemotePush } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-publication-"));
  const { source, remote, base } = await repository(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
    remoteTransport,
    beforeRemotePush,
    workerFactory: async ({ onEvent }) => {
      onEvent({
        type: "message_end",
        message: { role: "assistant", content: "candidate ready", stopReason: "stop" },
      });
      onEvent({ type: "agent_settled" });
      return { callbacksAttached: true, close() {} };
    },
  });
  const task = await runtime.createTask({
    goal: "publish one exact candidate",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    authority,
  });
  await eventually(
    () => runtime.getTask(task.id),
    (current) => current.attempts[0]?.attemptRuns[0]?.state === "settled",
  );
  return { parent, source, remote, base, runtime, task: runtime.getTask(task.id) };
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

test("first publication creates only the dedicated ref with the exact candidate SHA", async () => {
  const value = await fixture();
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
  } finally {
    await closeFixture(value);
  }
});

test("second publication is a fast-forward from the confirmed SHA", async () => {
  const value = await fixture();
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

test("post-transmit ambiguity is confirmed by exact readback without a second push", async () => {
  const value = await fixture();
  const transport = makeTransport(value.remote, { throwAfterPush: true });
  value.runtime.remoteTransport = transport;
  try {
    const candidate = await commitCandidate(value.task.taskWorktree, "one.txt", "one\n", "one");
    const published = await value.runtime.publishTask({ id: value.task.id, candidateSha: candidate });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(transport.pushCount, 1);
    assert.equal(published.task.remoteEffects[0].attemptCount, 1);
  } finally {
    await closeFixture(value);
  }
});

test("unchanged ambiguous publication retries the same prepared effect within its budget", async () => {
  const value = await fixture();
  let pushCount = 0;
  let firstPush = true;
  value.runtime.remoteTransport = {
    readRef: ({ ref }) => remoteRef(value.remote, ref),
    push: ({ cwd, ref, expectedOldOid, newOid }) => {
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
          value.remote,
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
    readRef: ({ ref }) => remoteRef(value.remote, ref),
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
