import test from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { RuntimeClient } from "../src/runtime-client.js";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const daemonPath = join(repositoryRoot, "src", "daemon.js");
const model = { provider: "fixture", id: "deterministic" };
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

const nextTurn = () => new Promise((resolveTurn) => setImmediate(resolveTurn));

async function eventually(read, predicate, message = "release proof timed out") {
  const deadline = Date.now() + 10_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await nextTurn();
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function repository(parent) {
  const source = join(parent, "source");
  const remote = join(parent, "fixture", "repository.git");
  await mkdir(join(parent, "fixture"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.name", "Release Test"]);
  execFileSync("git", ["-C", source, "config", "user.email", "release@example.com"]);
  await writeFile(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "base.txt"]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote]);
  return { source, remote, base: git(source, ["rev-parse", "HEAD"]) };
}

async function fakePi(parent) {
  const command = join(parent, "fake-pi.cjs");
  const counter = join(parent, "pi-attempt-count");
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const counter = process.env.PI_SAND_RELEASE_COUNTER;
if (process.argv.includes("--version")) { process.stdout.write("0.84.4\\n"); process.exit(0); }
let buffer = "";
let model = null;
let thinkingLevel = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const response = { type: "response", command: request.type, id: request.id, success: true };
    if (request.type === "set_model") { model = { provider: request.provider, id: request.modelId }; response.data = model; }
    if (request.type === "set_thinking_level") thinkingLevel = request.level;
    if (request.type === "get_state") response.data = { model, thinkingLevel, sessionId: "release-session-" + process.pid };
    process.stdout.write(JSON.stringify(response) + "\\n");
    if (request.type === "prompt") {
      const attempt = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0") + 1;
      fs.writeFileSync(counter, String(attempt));
      fs.writeFileSync("candidate.txt", "release-candidate-" + attempt + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "executor settled", stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  await chmod(command, 0o755);
  return { command, counter };
}

async function localTlsCertificate(parent) {
  const key = join(parent, "api.key");
  const cert = join(parent, "api.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  return { key: await readFile(key), cert: await readFile(cert) };
}

async function fakeGitHub(parent) {
  const tls = await localTlsCertificate(parent);
  const states = new Map();
  const requests = [];
  const server = createServer(tls, (request, response) => {
    const match = request.url.match(/\/repos\/fixture\/repository\/commits\/([^/]+)\/(check-runs|status)/);
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    const sha = match[1];
    const state = states.get(sha) ?? { checkRuns: [], statuses: [] };
    requests.push({ sha, path: match[2], checkRuns: state.checkRuns.length, statuses: state.statuses.length });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(match[2] === "check-runs"
      ? { check_runs: state.checkRuns }
      : { statuses: state.statuses }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    host: `127.0.0.1:${address.port}`,
    requests,
    set(sha, state) { states.set(sha, state); },
    async close() { await new Promise((resolveClose) => server.close(resolveClose)); },
  };
}

function environment(parent, pi, github) {
  return {
    ...process.env,
    PI_BIN: pi.command,
    PI_SAND_RELEASE_COUNTER: pi.counter,
    PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite"),
    PI_SAND_TASK_WORKTREE_ROOT: join(parent, "worktrees"),
    XDG_RUNTIME_DIR: join(parent, "runtime"),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    PI_SAND_RELEASE_GITHUB_HOST: github.host,
  };
}

function startDaemon(env) {
  const child = spawn(process.execPath, [daemonPath, "--foreground"], {
    cwd: repositoryRoot,
    env: { ...env, PI_SAND_GITHUB_HOST: env.PI_SAND_RELEASE_GITHUB_HOST },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitForDaemon(client, child) {
  return eventually(async () => {
    if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}`);
    try { return await client.status(); } catch { return null; }
  }, Boolean, "daemon did not become ready");
}

async function stopDaemon(child) {
  if (!child) return;
  try { process.kill(child.pid, "SIGTERM"); } catch (error) { if (error.code === "ESRCH") return; throw error; }
  try {
    await eventually(() => {
      try { process.kill(child.pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, Boolean, "daemon did not stop");
  } catch {
    try { process.kill(child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

function taskInput(goal, githubHost, { repair = false } = {}) {
  return JSON.stringify({
    goal,
    authority: {
      ...authority,
      remotePublication: { ...authority.remotePublication, githubHost },
    },
    completionContract: {
      objective: goal,
      localGates: [{ id: "release-gate", command: [process.execPath, "-e", "process.exit(0)"] }],
      requiredChecks: ["check_run:github-actions/ci", "commit_status:release"],
      ...(repair ? { semanticReview: false } : {}),
    },
  });
}

async function runJourney({ repair = false } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-release-"));
  const repositoryValue = await repository(parent);
  const pi = await fakePi(parent);
  const github = await fakeGitHub(parent);
  const env = environment(parent, pi, github);
  const socketPath = join(parent, "runtime", "pi-sand", "pi-sand.sock");
  const client = new RuntimeClient({ env, socketPath, dbPath: env.PI_SAND_RUNTIME_DB });
  let daemon;
  try {
    daemon = startDaemon(env);
    await waitForDaemon(client, daemon);
    const managerA = createExtensionHarness({ cwd: () => repositoryValue.source });
    registerPiSandExtension(managerA.pi, { runtimeClientFactory: () => client });
    const managerContext = {
      ...managerA.context("manager-a"),
      model,
      thinkingLevel: "high",
      isProjectTrusted: () => true,
    };
    await managerA.commands.get("task").handler(
      taskInput("release proof", github.host, { repair }),
      managerContext,
    );
    const accepted = JSON.parse(managerA.notifications.at(-1).message);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const acceptedTask = accepted.task;
    assert.equal(acceptedTask.controlVersion, 1);
    assert.equal(acceptedTask.contractVersion, 1);

    const waiting = await eventually(
      () => client.getTask(acceptedTask.id),
      (task) => task.state === "waiting",
      "Task did not reach exact-SHA wait",
    );
    const candidateR = waiting.finalRevision;
    assert.match(candidateR, /^[0-9a-f]{40}$/);
    assert.equal(git(waiting.taskWorktree, ["rev-parse", "HEAD"]), candidateR);
    assert.equal(git(repositoryValue.remote, ["show-ref", `refs/heads/pi-sand/${waiting.id}`]).split(" ")[0], candidateR);
    assert.equal(waiting.waitSubscriptions[0].revisionSha, candidateR);
    assert.equal(waiting.waitSubscriptions[0].status, "active");
    assert.equal(waiting.attempts[0].state, "parked_wait");
    assert.equal(waiting.attempts[0].workerTerminated, true);

    await assert.rejects(
      client.createTask({ goal: "second unresolved commitment", cwd: repositoryValue.source, trusted: true, model, thinkingLevel: "high" }),
      /active or unresolved/,
    );

    await stopDaemon(daemon);
    daemon = undefined;
    github.set(candidateR, {
      checkRuns: [{ id: 1, name: "ci", head_sha: candidateR, status: "completed", conclusion: repair ? "failure" : "success", app: { slug: "github-actions" } }],
      statuses: [{ id: 2, context: "release", sha: candidateR, state: repair ? "failure" : "success" }],
    });

    daemon = startDaemon(env);
    await waitForDaemon(client, daemon);
    const activeWaitAfterRestart = (await client.getTask(acceptedTask.id)).waitSubscriptions.find((subscription) => subscription.status === "active");
    if (activeWaitAfterRestart)
      await client.request("wait.reconcile", { id: activeWaitAfterRestart.id });
    let current = await eventually(
      () => client.getTask(acceptedTask.id),
      (task) => repair ? task.attempts.length === 2 && task.state === "waiting" : task.state === "completed",
      repair ? `CI failure did not create one fresh repair Attempt (${JSON.stringify(github.requests)})` : "green CI did not complete the Task",
    );

    if (repair) {
      assert.equal(current.attempts.length, 2);
      assert.equal(current.attempts[1].cause, "repair");
      assert.equal(current.attempts[1].number, 2);
      const candidateR2 = current.finalRevision;
      assert.notEqual(candidateR2, candidateR);
      assert.equal(current.waitSubscriptions.filter((subscription) => subscription.status === "active").length, 1);
      assert.equal(current.waitSubscriptions.at(-1).revisionSha, candidateR2);
      assert.equal(git(repositoryValue.remote, ["show-ref", `refs/heads/pi-sand/${current.id}`]).split(" ")[0], candidateR2);
      await stopDaemon(daemon);
      daemon = undefined;
      github.set(candidateR2, {
        checkRuns: [{ id: 3, name: "ci", head_sha: candidateR2, status: "completed", conclusion: "success", app: { slug: "github-actions" } }],
        statuses: [{ id: 4, context: "release", sha: candidateR2, state: "success" }],
      });
      daemon = startDaemon(env);
      await waitForDaemon(client, daemon);
      const activeR2Wait = (await client.getTask(acceptedTask.id)).waitSubscriptions.find((subscription) => subscription.status === "active");
      if (activeR2Wait)
        await client.request("wait.reconcile", { id: activeR2Wait.id });
      current = await eventually(() => client.getTask(acceptedTask.id), (task) => task.state === "completed", `R2 CI did not complete the Task (${JSON.stringify(github.requests)})`);
      assert.equal(current.finalRevision, candidateR2);
    }

    assert.equal(current.terminalReason, "verified_ci");
    assert.equal(current.attempts.at(-1).workerTerminated, true);
    assert.equal(current.waitSubscriptions.at(-1).status, "triggered");
    assert.ok(github.requests.some(({ sha }) => sha === current.finalRevision));

    const managerB = createExtensionHarness({ cwd: () => repositoryValue.source });
    registerPiSandExtension(managerB.pi, { runtimeClientFactory: () => client });
    const managerBContext = managerB.context("manager-b");
    await managerB.invoke("session_start", { type: "session_start" }, managerBContext);
    const resultNotification = await eventually(
      () => managerB.notifications.map(({ message }) => JSON.parse(message)).find((value) => value?.id === current.result?.id || value?.taskId === current.id),
      Boolean,
      "Manager B did not receive the durable Result",
    );
    assert.equal(resultNotification.outcome, "completed");
    assert.equal(resultNotification.payload.finalRevision, current.finalRevision);
    assert.equal(await client.claimResult("manager-c"), null);
    await managerB.invoke("session_shutdown", { type: "session_shutdown" }, managerBContext);
    return { current, candidateR, parent, github, env };
  } finally {
    await stopDaemon(daemon).catch(() => {});
    await github.close().catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
}

test("v0.4 release green leave-and-return proof uses daemon, protocol-v2, real Git, and Extension seams", async () => {
  const result = await runJourney();
  assert.equal(result.current.state, "completed");
});

test("v0.4 release proof repairs one failed exact-SHA CI revision through a fresh Attempt", async () => {
  const result = await runJourney({ repair: true });
  assert.equal(result.current.state, "completed");
});
