import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startRuntimeDaemon } from "../src/daemon.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeStore } from "../src/runtime-store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function repository(parent) {
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "fixture.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  return source;
}

async function fakePi(parent) {
  const command = join(parent, "fake-pi.cjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("0.84.4\\n");
  process.exit(0);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const response = { type: "response", command: request.type, id: request.id, success: true };
    if (request.type === "set_model") response.data = { provider: request.provider, id: request.modelId };
    if (request.type === "get_state") response.data = { model: { provider: "provider", id: "model" }, thinkingLevel: "high" };
    process.stdout.write(JSON.stringify(response) + "\\n");
    if (request.type === "prompt" && process.env.PI_SAND_FAKE_NO_SETTLE !== "1") {
      setTimeout(() => {
        fs.writeFileSync("result-artifact.txt", "result\\n");
        const message = { type: "message_end", message: { role: "assistant", content: "executor summary", stopReason: "stop" } };
        const settled = { type: "agent_settled" };
        process.stdout.write(JSON.stringify(message) + "\\n");
        process.stdout.write(JSON.stringify(settled) + "\\n");
        if (process.env.PI_SAND_FAKE_DUPLICATE === "1") {
          setTimeout(() => {
            process.stdout.write(JSON.stringify(message) + "\\n");
            process.stdout.write(JSON.stringify(settled) + "\\n");
          }, 50);
        }
      }, 20);
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  await chmod(command, 0o755);
  return command;
}

function environment(parent, piCommand, { leaseMs, duplicate = false, noSettle = false } = {}) {
  return {
    ...process.env,
    PI_BIN: piCommand,
    ...(leaseMs == null ? {} : { PI_SAND_RESULT_CLAIM_LEASE_MS: String(leaseMs) }),
    ...(duplicate ? { PI_SAND_FAKE_DUPLICATE: "1" } : {}),
    ...(noSettle ? { PI_SAND_FAKE_NO_SETTLE: "1" } : {}),
    XDG_RUNTIME_DIR: join(parent, "runtime"),
    PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite"),
    PI_SAND_TASK_WORKTREE_ROOT: join(parent, "worktrees"),
  };
}

async function runClient(env, method, params = {}) {
  const script = `import { RuntimeClient } from ${JSON.stringify(join(root, "src", "runtime-client.js"))}; const result = await new RuntimeClient().request(${JSON.stringify(method)}, ${JSON.stringify(params)}); process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolveClient, rejectClient) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectClient);
    child.once("close", (code, signal) => {
      if (code === 0) resolveClient(JSON.parse(stdout));
      else rejectClient(new Error(`client exited ${code}/${signal}: ${stderr}`));
    });
  });
}

async function waitForTask(env, id, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shown = await runClient(env, "task.get", { id });
    if (predicate(shown.task)) return shown.task;
    await wait(20);
  }
  throw new Error("timed out waiting for Task");
}

async function waitForPendingResult(dbPath, timeoutMs = 2_000) {
  const db = new DatabaseSync(dbPath);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const row = db
          .prepare("SELECT id FROM result_deliveries WHERE state = 'pending' ORDER BY created_at, id LIMIT 1")
          .get();
        if (row) return row.id;
      } catch {}
      await wait(20);
    }
  } finally {
    db.close();
  }
  throw new Error("timed out waiting for pending Result");
}

async function stopDaemon(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  for (let index = 0; index < 100; index += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
    }
    await wait(10);
  }
  try { process.kill(pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function completedFixture(options = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-result-fixture-"));
  const source = await repository(parent);
  const env = environment(parent, await fakePi(parent), options);
  const started = await runClient(env, "task.create", {
    goal: "deliver the durable result",
    cwd: source,
    trusted: true,
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    completionContract: {
      objective: "deliver the durable result",
      localGates: [{ id: "result-gate", command: [process.execPath, "-e", "process.exit(0)"] }],
    },
  });
  const daemonPid = (await runClient(env, "runtime.status")).daemonPid;
  const completed = await waitForTask(env, started.task.id, (task) => task.state === "completed");
  return { parent, source, env, started, completed, daemonPid };
}

class StopBarrierRuntimeStore extends RuntimeStore {
  constructor(options) {
    super(options);
    this.stopArrivals = 0;
    this.stopBarrier = new Promise((resolveBarrier) => {
      this.releaseStopBarrier = resolveBarrier;
    });
  }

  async terminateOwnedWorker() {
    this.stopArrivals += 1;
    if (this.stopArrivals === 2) this.releaseStopBarrier();
    await this.stopBarrier;
    return true;
  }
}

test("completion survives zero clients and daemon restart before a later public Result claim", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-result-restart-"));
  const source = await repository(parent);
  const env = environment(parent, await fakePi(parent));
  let daemonPid;
  try {
    const started = await runClient(env, "task.create", {
      goal: "deliver the durable result",
      cwd: source,
      trusted: true,
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
      completionContract: {
        objective: "deliver the durable result",
        localGates: [{ id: "result-gate", command: [process.execPath, "-e", "process.exit(0)"] }],
      },
    });
    daemonPid = (await runClient(env, "runtime.status")).daemonPid;
    const resultId = await waitForPendingResult(env.PI_SAND_RUNTIME_DB);
    await stopDaemon(daemonPid);
    daemonPid = (await runClient(env, "runtime.status")).daemonPid;
    const completed = (await runClient(env, "task.get", { id: started.task.id })).task;
    assert.equal(completed.state, "completed");
    assert.equal(completed.finalRevision, git(completed.taskWorktree, ["rev-parse", "HEAD"]));

    const claimed = await runClient(env, "result.claim", { clientInstanceId: "manager-a" });
    assert.equal(claimed.result.id, resultId);
    assert.equal(claimed.result.taskId, completed.id);
    assert.equal(claimed.result.outcome, "completed");
    assert.equal(claimed.result.state, "claimed");
    assert.equal(claimed.result.claimOwner, "manager-a");
    assert.equal(claimed.result.payload.taskBranch, completed.taskBranch);
    assert.equal(claimed.result.payload.finalRevision, completed.finalRevision);
    assert.match(claimed.result.id, /^[0-9a-f-]{36}$/);
    assert.match(claimed.result.payloadDigest, /^[0-9a-f]{64}$/);
  } finally {
    await stopDaemon(daemonPid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("live Result claims are exclusive and expiry redelivers the same stable Result ID", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const fixture = await completedFixture({ leaseMs: 500 });
  try {
    const first = await runClient(fixture.env, "result.claim", { clientInstanceId: "manager-a" });
    const second = await runClient(fixture.env, "result.claim", { clientInstanceId: "manager-b" });
    assert.equal(second.result, null);

    let redelivered = null;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      redelivered = await runClient(fixture.env, "result.claim", { clientInstanceId: "manager-b" });
      if (redelivered.result) break;
      await wait(20);
    }
    assert.equal(redelivered.result.id, first.result.id);
    assert.notEqual(redelivered.result.claimHandle, first.result.claimHandle);
    assert.equal(redelivered.result.claimOwner, "manager-b");
  } finally {
    await stopDaemon(fixture.daemonPid).catch(() => {});
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("acknowledging a claimed Result removes only delivery state and preserves terminal task truth", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const fixture = await completedFixture();
  try {
    const claimed = await runClient(fixture.env, "result.claim", { clientInstanceId: "manager-a" });
    await assert.rejects(
      runClient(fixture.env, "result.ack", {
        resultId: claimed.result.id,
        claimHandle: "wrong-claim-handle",
      }),
      /missing, expired, or does not match/i,
    );
    const acknowledged = await runClient(fixture.env, "result.ack", {
      resultId: claimed.result.id,
      claimHandle: claimed.result.claimHandle,
    });
    assert.equal(acknowledged.result.id, claimed.result.id);
    assert.equal(acknowledged.result.state, "acked");
    assert.equal((await runClient(fixture.env, "result.claim", { clientInstanceId: "manager-b" })).result, null);
    const task = (await runClient(fixture.env, "task.get", { id: fixture.completed.id })).task;
    assert.equal(task.state, "completed");
    assert.equal(task.finalRevision, fixture.completed.finalRevision);
  } finally {
    await stopDaemon(fixture.daemonPid).catch(() => {});
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("duplicate terminal processing creates one durable Result", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const fixture = await completedFixture({ duplicate: true });
  try {
    await wait(150);
    const db = new DatabaseSync(fixture.env.PI_SAND_RUNTIME_DB);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ?").get(fixture.completed.id).count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await stopDaemon(fixture.daemonPid).catch(() => {});
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("stopping a Task creates a cancelled Result without changing the Task worktree authority", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-result-cancel-"));
  const source = await repository(parent);
  const env = environment(parent, await fakePi(parent), { noSettle: true });
  let daemonPid;
  try {
    const started = await runClient(env, "task.create", {
      goal: "cancel the durable task",
      cwd: source,
      trusted: true,
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
    });
    daemonPid = (await runClient(env, "runtime.status")).daemonPid;
    const stopped = (await runClient(env, "task.stop", { id: started.task.id })).task;
    assert.equal(stopped.state, "stopped");
    const claimed = await runClient(env, "result.claim", { clientInstanceId: "manager-a" });
    assert.equal(claimed.result.outcome, "cancelled");
    assert.equal(claimed.result.payload.taskId, stopped.id);
    assert.equal((await runClient(env, "task.get", { id: stopped.id })).task.state, "stopped");
  } finally {
    await stopDaemon(daemonPid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("concurrent public Stop requests create one cancelled Result", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-result-stop-race-"));
  const source = await repository(parent);
  const env = environment(parent, await fakePi(parent), { noSettle: true });
  const socketPath = join(parent, "runtime", "pi-sand", "pi-sand.sock");
  const store = new StopBarrierRuntimeStore({
    dbPath: env.PI_SAND_RUNTIME_DB,
    piCommand: env.PI_BIN,
    worktreeRoot: env.PI_SAND_TASK_WORKTREE_ROOT,
    workerFactory: async () => ({ callbacksAttached: true, close() {} }),
  });
  let daemon;
  try {
    daemon = await startRuntimeDaemon({
      dbPath: env.PI_SAND_RUNTIME_DB,
      socketPath,
      store,
    });
    const client = new RuntimeClient({
      env,
      socketPath,
      dbPath: env.PI_SAND_RUNTIME_DB,
    });
    const started = await client.createTask({
      goal: "cancel one durable result",
      cwd: source,
      trusted: true,
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
    });
    const outcomes = await Promise.allSettled([
      client.stopTask(started.id),
      client.stopTask(started.id),
    ]);
    assert.equal(
      outcomes.filter(({ status }) => status === "fulfilled").length,
      2,
    );
    assert.equal(
      outcomes.filter(({ status }) => status === "rejected").length,
      0,
    );
    for (const outcome of outcomes)
      assert.equal(outcome.value.state, "stopped");

    const stopped = await client.getTask(started.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.attempts[0].state, "stopped");

    const db = new DatabaseSync(env.PI_SAND_RUNTIME_DB);
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ?",
          )
          .get(started.id).count,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ? AND state = 'pending'",
          )
          .get(started.id).count,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT outcome FROM result_deliveries WHERE task_id = ?",
          )
          .get(started.id).outcome,
        "cancelled",
      );
    } finally {
      db.close();
    }
  } finally {
    await daemon?.close().catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("protocol-v1 clients fail clearly against the v2 daemon", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const fixture = await completedFixture();
  try {
    const client = new RuntimeClient({ env: fixture.env });
    await assert.rejects(
      client.request("runtime.status", {}, { version: 1 }),
      (error) => /protocol is incompatible/i.test(error.message) && /1/.test(error.message),
    );
  } finally {
    await stopDaemon(fixture.daemonPid).catch(() => {});
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("completion and Result insertion are atomic when the completed Result write fails", {
  skip: process.platform === "linux" ? false : "Linux-only",
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-result-atomic-"));
  const source = await repository(parent);
  const env = environment(parent, await fakePi(parent));
  let daemonPid;
  try {
    daemonPid = (await runClient(env, "runtime.status")).daemonPid;
    const db = new DatabaseSync(env.PI_SAND_RUNTIME_DB);
    db.exec(`CREATE TRIGGER fail_completed_result
      BEFORE INSERT ON result_deliveries
      WHEN NEW.outcome = 'completed'
      BEGIN SELECT RAISE(ABORT, 'injected completed Result failure'); END`);
    db.close();

    const started = await runClient(env, "task.create", {
      goal: "exercise atomic completion",
      cwd: source,
      trusted: true,
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
      completionContract: {
        objective: "exercise atomic completion",
        localGates: [{ id: "result-gate", command: [process.execPath, "-e", "process.exit(0)"] }],
      },
    });
    const failed = await waitForTask(env, started.task.id, (task) => task.state === "failed");
    assert.notEqual(failed.state, "completed");
    const rows = new DatabaseSync(env.PI_SAND_RUNTIME_DB);
    try {
      assert.equal(rows.prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ? AND outcome = 'completed'").get(started.task.id).count, 0);
      assert.equal(rows.prepare("SELECT COUNT(*) AS count FROM result_deliveries WHERE task_id = ? AND outcome = 'failed'").get(started.task.id).count, 1);
    } finally {
      rows.close();
    }
  } finally {
    await stopDaemon(daemonPid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});
