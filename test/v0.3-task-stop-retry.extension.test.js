import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";

async function repository(parent, name) {
  const path = join(parent, name);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", path, "commit", "--allow-empty", "-qm", "base"]);
  return path;
}

test("Extension routes Stop over IPC and gates Retry on the reconnecting Manager source repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-extension-stop-retry-"));
  const source = await repository(parent, "source");
  const other = await repository(parent, "other");
  const calls = [];
  const client = {
    createTask: async () => ({ id: "task-1" }),
    listTasks: async () => [],
    getTask: async () => ({ id: "task-1", sourceRepoRoot: source, state: "stopped" }),
    stopTask: async (id) => { calls.push(["task.stop", id]); return { id, state: "stopped" }; },
    retryTask: async (params) => { calls.push(["task.retry", params]); return { id: params.id, state: "running" }; },
  };
  const harness = createExtensionHarness({ cwd: () => source });
  registerPiSandExtension(harness.pi, { runtimeClientFactory: () => client });
  const context = (cwd) => ({
    ...harness.context("manager"), cwd, model: { provider: "p", id: "m" }, thinkingLevel: "high",
    isProjectTrusted: () => true, modelRegistry: { hasConfiguredAuth: () => true },
  });
  try {
    const stopped = await harness.commands.get("task-stop").handler("task-1", context(source));
    assert.deepEqual(stopped, { ok: true, task: { id: "task-1", state: "stopped" } });
    assert.deepEqual(calls, [["task.stop", "task-1"]]);

    const wrongProject = await harness.commands.get("task-retry").handler("task-1", context(other));
    assert.equal(wrongProject.ok, false);
    assert.match(wrongProject.error, /source repository/);
    assert.equal(calls.length, 1, "wrong-project retry must not send mutating IPC");

    const retried = await harness.commands.get("task-retry").handler("task-1", context(source));
    assert.equal(retried.ok, true);
    assert.deepEqual(calls[1], ["task.retry", { id: "task-1", trusted: true, model: { provider: "p", id: "m" }, thinkingLevel: "high" }]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
