import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { runtimeSocketPath } from "../src/runtime-ipc.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function runClient(environment) {
  const script = `
    import { RuntimeClient } from ${JSON.stringify(join(repositoryRoot, "src", "runtime-client.js"))};
    const client = new RuntimeClient();
    const status = await client.status();
    const tasks = await client.listTasks();
    process.stdout.write(JSON.stringify({ status, tasks }) + "\\n");
  `;
  return new Promise((resolveClient, rejectClient) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectClient);
    child.once("close", (code, signal) => {
      if (code !== 0) rejectClient(new Error(`client failed (${code}, ${signal}): ${stderr}`));
      else resolveClient(JSON.parse(stdout.trim()));
    });
  });
}

function environment(parent) {
  return {
    XDG_RUNTIME_DIR: join(parent, "runtime"),
    PI_SAND_RUNTIME_DB: join(parent, "runtime-state.sqlite"),
  };
}

async function terminateDaemon(pid) {
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let index = 0; index < 100; index += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function terminateRuntimes(env, knownPid) {
  let pid = knownPid;
  for (let index = 0; index < 5 && pid; index += 1) {
    await terminateDaemon(pid);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    try {
      const response = await new RuntimeClient({ env, requestTimeoutMs: 100 }).requestSocket("runtime.status", {}, 1);
      pid = response.data?.daemonPid;
    } catch {
      pid = null;
    }
  }
}

test("a detached daemon survives a client process and a fresh client reconnects to its durable runtime", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-ipc-lifetime-"));
  const env = environment(parent);
  let daemonPid;
  try {
    const first = await runClient(env);
    daemonPid = first.status.daemonPid;
    assert.equal(first.status.protocolVersion, 1);
    assert.deepEqual(first.tasks, []);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));

    const second = await runClient(env);
    assert.equal(second.status.daemonPid, daemonPid);
    assert.deepEqual(second.tasks, []);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));

    const directory = join(env.XDG_RUNTIME_DIR, "pi-sand");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(runtimeSocketPath({ env }))).mode & 0o777, 0o600);
    assert.equal((await stat(env.PI_SAND_RUNTIME_DB)).mode & 0o777, 0o600);
  } finally {
    if (daemonPid) await terminateRuntimes(env, daemonPid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("singleton races converge, stale sockets are reclaimed only after DB ownership, and protocol errors stay explicit", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-ipc-race-"));
  const env = environment(parent);
  let daemonPid;
  try {
    const socket = runtimeSocketPath({ env });
    await mkdir(dirname(socket), { recursive: true });
    await chmod(dirname(socket), 0o700);
    await writeFile(socket, "stale socket marker");

    const [first, second] = await Promise.all([runClient(env), runClient(env)]);
    daemonPid = first.status.daemonPid;
    assert.equal(second.status.daemonPid, daemonPid);
    assert.deepEqual(first.tasks, []);
    assert.deepEqual(second.tasks, []);

    const client = new RuntimeClient({ env });
    await assert.rejects(client.request("task.create"), (error) => {
      assert.equal(error.code, "method_unimplemented");
      return /not implemented/.test(error.message);
    });
    await assert.rejects(client.request("unknown.method"), (error) => {
      assert.equal(error.code, "unknown_method");
      return /unknown protocol method/.test(error.message);
    });
    await assert.rejects(client.request("runtime.status", {}, { version: 2 }), (error) => /protocol is incompatible/.test(error.message));
  } finally {
    if (daemonPid) await terminateRuntimes(env, daemonPid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("the Extension exposes /tasks through an IPC client and never owns runtime storage", async () => {
  const harness = createExtensionHarness();
  const clients = [];
  registerPiSandExtension(harness.pi, {
    runtimeClientFactory: () => {
      const client = { closed: false, listTasks: async () => [{ id: "task-1", state: "completed" }], close() { this.closed = true; } };
      clients.push(client);
      return client;
    },
  });
  const context = harness.context("session");
  const result = await harness.commands.get("tasks").handler("", context);
  assert.deepEqual(result, { ok: true, tasks: [{ id: "task-1", state: "completed" }] });
  assert.equal(clients.length, 1);
  assert.equal(harness.notifications.at(-1).type, "info");
  assert.equal([...harness.commands.keys()].includes("task"), false);
  assert.equal([...harness.commands.keys()].includes("task-show"), false);
  assert.equal([...harness.commands.keys()].includes("task-stop"), false);
  assert.equal([...harness.commands.keys()].includes("task-retry"), false);

  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    await harness.invoke("session_start", { type: "session_start", reason }, harness.context(reason));
    await harness.invoke("session_shutdown", { type: "session_shutdown", reason }, harness.context(reason));
  }
  assert.equal(clients.every((client) => client.closed === false), true);
});
