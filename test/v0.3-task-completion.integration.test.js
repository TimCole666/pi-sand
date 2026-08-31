import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeStore } from "../src/runtime-store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

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

function deterministicWorker({ events, close = () => {}, change = false, commit = false, failCheckpoint = false }) {
  return async ({ cwd, onEvent }) => {
    for (const event of events) onEvent(event);
    if (change) {
      await writeFile(join(cwd, "worker.txt"), "worker\n");
      if (commit) {
        execFileSync("git", ["add", "worker.txt"], { cwd });
        execFileSync("git", ["commit", "-qm", "worker commit"], {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "worker",
            GIT_AUTHOR_EMAIL: "worker@example.com",
            GIT_COMMITTER_NAME: "worker",
            GIT_COMMITTER_EMAIL: "worker@example.com",
          },
        });
        await writeFile(join(cwd, "residual.txt"), "residual\n");
      }
    }
    if (failCheckpoint) await writeFile(join(cwd, "checkpoint-failure.txt"), "failure\n");
    onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A bounded result." }], stopReason: "stop" } });
    onEvent({ type: "agent_settled" });
    return { pid: null, processGroupId: null, close };
  };
}

async function versionCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

function startOptions(source, workerFactory, piCommand) {
  return {
    dbPath: ":memory:",
    piCommand,
    workerFactory,
    worktreeRoot: join(source, "..", "worktrees"),
  };
}

const model = { provider: "provider", id: "model" };
const optionsFor = (source) => ({ goal: "bounded goal", cwd: source, trusted: true, model, thinkingLevel: "high" });

async function eventually(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await wait(10);
  }
  throw new Error("timed out waiting for terminal Task state");
}

async function fakePi(parent) {
  const command = join(parent, "fake-pi.cjs");
  const log = join(parent, "fake.log");
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const log = (value) => fs.appendFileSync(process.env.PI_SAND_FAKE_LOG, JSON.stringify(value) + "\\n");
let buffer = "";
const send = (value, delay = 0) => setTimeout(() => process.stdout.write(JSON.stringify(value) + "\\n"), delay);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const end = buffer.indexOf("\\n");
    const request = JSON.parse(buffer.slice(0, end));
    log({ direction: "in", request });
    buffer = buffer.slice(end + 1);
    if (request.type === "set_model") send({ type: "response", command: request.type, id: request.id, success: true, data: { provider: request.provider, id: request.modelId } });
    if (request.type === "set_thinking_level") send({ type: "response", command: request.type, id: request.id, success: true });
    if (request.type === "get_state") send({ type: "response", command: request.type, id: request.id, success: true, data: { model: { provider: "provider", id: "model" }, thinkingLevel: "high" } });
    if (request.type === "prompt") {
      send({ type: "response", command: request.type, id: request.id, success: true });
      setTimeout(() => {
        fs.writeFileSync("daemon-result.txt", "done\\n");
        const message = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed with zero clients" }], stopReason: "stop" } };
        log({ direction: "out", message });
        send(message);
        const settled = { type: "agent_settled" };
        log({ direction: "out", message: settled });
        send(settled);
      }, 100);
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
if (process.argv.includes("--version")) process.stdout.write("0.84.4\\n");
else setInterval(() => {}, 1000);
`);
  await chmod(command, 0o755);
  return { command, log };
}

async function runClient(env, method, params) {
  const script = `import { RuntimeClient } from ${JSON.stringify(join(root, "src", "runtime-client.js"))}; const result = await new RuntimeClient().request(${JSON.stringify(method)}, ${JSON.stringify(params)}); process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolveClient, rejectClient) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectClient);
    child.once("close", (code) => code === 0 ? resolveClient(JSON.parse(stdout)) : rejectClient(new Error(`client exited ${code}: ${stderr}`)));
  });
}

async function stopDaemon(env, pid) {
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let index = 0; index < 100; index += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; }
    await wait(10);
  }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  void env;
}

test("daemon completes a Task after the submitting client disappears", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-completion-boundary-"));
  const source = await repository(parent);
  const fake = await fakePi(parent);
  const env = { ...process.env, PI_BIN: fake.command, PI_SAND_FAKE_LOG: fake.log, XDG_RUNTIME_DIR: join(parent, "runtime"), PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite"), PI_SAND_TASK_WORKTREE_ROOT: join(parent, "worktrees") };
  let daemonPid;
  try {
    const started = await runClient(env, "task.create", { goal: "zero clients", cwd: source, trusted: true, model, thinkingLevel: "high" });
    daemonPid = (await runClient(env, "runtime.status", {})).daemonPid;
    assert.equal(started.task.state, "running");
    await wait(2_500);
    const shown = await runClient(env, "task.get", { id: started.task.id });
    if (shown.task.state !== "completed") console.error(await readFile(fake.log, "utf8"));
    assert.equal(shown.task.state, "completed");
    assert.equal(shown.task.finalResult, "completed with zero clients");
    assert.match(shown.task.finalBranchHead, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(shown.task.taskWorktree, "daemon-result.txt"), "utf8"), "done\n");
    assert.equal(git(shown.task.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  } finally {
    if (daemonPid) await stopDaemon(env, daemonPid);
    await rm(parent, { recursive: true, force: true });
  }
});

test("settlement rules preserve commits, checkpoint residual changes, avoid empty commits, and retain failed worktrees", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const cases = [
    { name: "changed", worker: deterministicWorker({ events: [{ type: "agent_end" }], change: true }), state: "completed", commits: 2 },
    { name: "worker-commit", worker: deterministicWorker({ events: [], change: true, commit: true }), state: "completed", commits: 3 },
    { name: "clean", worker: deterministicWorker({ events: [] }), state: "completed", commits: 1 },
  ];
  for (const scenario of cases) {
    const parent = await mkdtemp(join(tmpdir(), `pi-sand-v03-settle-${scenario.name}-`));
    const source = await repository(parent);
    const piCommand = await versionCommand(parent);
    const runtime = new RuntimeStore({ ...startOptions(source, scenario.worker, piCommand), dbPath: join(parent, "runtime.sqlite") });
    try {
      const result = await runtime.createTask(optionsFor(source));
      const completed = await eventually(() => runtime.getTask(result.id), (task) => task.state !== "running");
      assert.equal(completed.state, scenario.state);
      assert.equal(git(completed.taskWorktree, ["rev-list", "--count", "HEAD"]), String(scenario.commits));
      assert.equal(git(completed.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
      assert.equal(completed.finalBranchHead, git(completed.taskWorktree, ["rev-parse", "HEAD"]));
      assert.equal(completed.attempts[0].finalBranchHead, completed.finalBranchHead);
      assert.equal(git(source, ["rev-parse", "HEAD"]), completed.baseCommit);
      assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  }

  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-settle-aborted-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  let emit;
  const runtime = new RuntimeStore({ ...startOptions(source, ({ onEvent }) => ({ prompt() { emit = onEvent; }, close() {} }), piCommand), dbPath: join(parent, "runtime.sqlite") });
  try {
    const running = await runtime.createTask(optionsFor(source));
    emit({ type: "agent_end" });
    assert.equal(runtime.getTask(running.id).state, "running");
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" } });
    emit({ type: "agent_settled" });
    const failed = await eventually(() => runtime.getTask(running.id), (task) => task.state !== "running");
    assert.equal(failed.state, "failed");
    assert.equal(failed.finalResult, "partial");
    assert.match(failed.terminalDetail, /aborted/);
    assert.equal(git(failed.taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  } finally {
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("unsafe worker retirement keeps the result inspectable and blocks capacity", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-retirement-"));
  const source = await repository(parent);
  const piCommand = await versionCommand(parent);
  const lingering = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const workerFactory = async (options) => {
    const worker = await deterministicWorker({ events: [], change: true, close() {} })(options);
    return { ...worker, pid: lingering.pid, processGroupId: lingering.pid };
  };
  const runtime = new RuntimeStore({ ...startOptions(source, workerFactory, piCommand), dbPath: join(parent, "runtime.sqlite"), workerRetireTimeoutMs: 0 });
  try {
    const task = await runtime.createTask(optionsFor(source));
    const blocked = await eventually(() => runtime.getTask(task.id), (value) => value.state !== "running");
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.attempts[0].state, "orphaned");
    assert.equal(blocked.attempts[0].workerTerminated, false);
    assert.match(blocked.finalResult, /bounded/);
    await assert.rejects(() => runtime.createTask(optionsFor(source)), /already active/);
  } finally {
    runtime.close();
    try { process.kill(-lingering.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await rm(parent, { recursive: true, force: true });
  }
});
