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
  return { source, remote };
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

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-remote-publication-"));
  const { source, remote } = await repository(parent);
  const runtime = new RuntimeStore({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    worktreeRoot: join(parent, "worktrees"),
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
  return { parent, source, remote, runtime, task: runtime.getTask(task.id) };
}

function commitCandidate(taskWorktree, filename, contents, message) {
  writeFile(join(taskWorktree, filename), contents);
  execFileSync("git", ["-C", taskWorktree, "add", filename]);
  execFileSync("git", ["-C", taskWorktree, "commit", "-qm", message]);
  return git(taskWorktree, ["rev-parse", "HEAD"]);
}

test("public RuntimeStore publication creates the dedicated ref with the exact candidate SHA", async () => {
  const fixtureValue = await fixture();
  try {
    const candidate = commitCandidate(
      fixtureValue.task.taskWorktree,
      "candidate.txt",
      "candidate\n",
      "candidate",
    );
    const published = await fixtureValue.runtime.publishTask({
      id: fixtureValue.task.id,
      candidateSha: candidate,
    });

    assert.equal(published.remoteEffect.state, "confirmed");
    assert.equal(published.remoteEffect.newOid, candidate);
    assert.equal(published.remoteEffect.expectedOldOid, null);
    assert.equal(
      published.remoteEffect.ref,
      `refs/heads/pi-sand/${fixtureValue.task.id}`,
    );
    assert.equal(
      git(fixtureValue.remote, ["rev-parse", `refs/heads/pi-sand/${fixtureValue.task.id}`]),
      candidate,
    );
    assert.equal(git(fixtureValue.source, ["rev-parse", "HEAD"]), fixtureValue.task.baseCommit);
    assert.equal(git(fixtureValue.source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(published.task.remoteEffects.length, 1);
    assert.equal(published.task.remoteEffects[0].state, "confirmed");
  } finally {
    fixtureValue.runtime.close();
    await rm(fixtureValue.parent, { recursive: true, force: true });
  }
});
