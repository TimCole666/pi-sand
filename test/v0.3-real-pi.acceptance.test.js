// v0.3 opt-in acceptance: prove the real Pi Manager -> Extension -> daemon
// -> Fresh Executor boundary survives Manager A exit and reconnects in B.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { RuntimeClient } from "../src/runtime-client.js";
import { FRESH_EXECUTOR_ARGS } from "../src/fresh-executor.js";

const enabled = process.env.PI_SAND_REAL_RUNTIME === "1";
const timeoutMs = Number(process.env.PI_SAND_REAL_RUNTIME_TIMEOUT_MS ?? 180_000);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonPath = join(repositoryRoot, "src", "daemon.js");
const piCommand = process.env.PI_BIN ?? "pi";
const expectedExtensionCommands = ["pi-sand", "task", "task-retry", "task-show", "task-stop", "tasks"];

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function makeRepository(parent) {
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "acceptance@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Acceptance Test"]);
  await writeFile(join(source, "fixture.txt"), "base fixture\n");
  execFileSync("git", ["-C", source, "add", "fixture.txt"]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  return source;
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(JSON.parse(line));
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) onLine(JSON.parse(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForEvent(events, predicate, child, stderr, startAt = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.slice(startAt).find(predicate);
    if (event) return event;
    if (child.exitCode !== null) {
      throw new Error(`Pi RPC exited before the expected event (code=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr.join("")})`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for the Pi RPC event (stderr=${stderr.join("")})`);
}

function send(child, command) {
  assert.equal(child.stdin.destroyed, false, "Pi RPC stdin must remain writable");
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function notificationPayload(event) {
  try {
    return JSON.parse(event.message);
  } catch {
    return undefined;
  }
}

async function makePiWrapper(parent) {
  const command = join(parent, "pi-wrapper");
  const logPath = join(parent, "pi-argv.log");
  await writeFile(command, `#!/bin/sh
printf '%s\\0' "$@" >> "$PI_SAND_REAL_RUNTIME_ARG_LOG"
printf '\\0' >> "$PI_SAND_REAL_RUNTIME_ARG_LOG"
exec "$PI_SAND_REAL_PI_BIN" "$@"
`);
  await chmod(command, 0o755);
  return { command, logPath };
}

function startDaemon(environment) {
  const child = spawn(process.execPath, [daemonPath, "--foreground"], {
    cwd: repositoryRoot,
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitForDaemon(runtimeClient, daemonProcess) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    if (daemonProcess.exitCode !== null) {
      throw new Error(`the wrapper-backed daemon exited before becoming ready (code=${daemonProcess.exitCode}, signal=${daemonProcess.signalCode})`);
    }
    try {
      await access(runtimeClient.socketPath);
      return await runtimeClient.status();
    } catch {
      await delay(25);
    }
  }
  throw new Error("timed out waiting for the wrapper-backed daemon socket");
}

async function readInvocationLog(logPath) {
  let bytes;
  try {
    bytes = await readFile(logPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const invocations = [];
  let invocation = [];
  for (const argument of bytes.toString("utf8").split(String.fromCharCode(0))) {
    if (argument) invocation.push(argument);
    else if (invocation.length > 0) {
      invocations.push(invocation);
      invocation = [];
    }
  }
  return invocations;
}

async function waitForInvocation(logPath, expectedArguments) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  let invocations = [];
  while (Date.now() < deadline) {
    invocations = await readInvocationLog(logPath);
    const matchingInvocation = invocations.find((argumentsForInvocation) => argumentsForInvocation.length === expectedArguments.length
      && argumentsForInvocation.every((argument, index) => argument === expectedArguments[index]));
    if (matchingInvocation) return matchingInvocation;
    await delay(25);
  }
  throw new Error(`timed out waiting for exact Pi invocation ${JSON.stringify(expectedArguments)}; recorded ${JSON.stringify(invocations)}`);
}

async function commandNotification(child, events, stderr, id, message) {
  const startAt = events.length;
  send(child, { id, type: "prompt", message });
  const response = await waitForEvent(events, (event) => event.type === "response" && event.id === id, child, stderr, startAt);
  const notification = await waitForEvent(
    events,
    (event) => event.type === "extension_ui_request" && event.method === "notify" && notificationPayload(event)?.ok !== undefined,
    child,
    stderr,
    startAt,
  );
  assert.equal(response.success, true, JSON.stringify(response));
  return notificationPayload(notification);
}

async function waitForTask(client, id, predicate) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    task = await client.getTask(id);
    if (predicate(task)) return task;
    await delay(250);
  }
  throw new Error(`timed out waiting for durable Task ${id}; last state was ${task?.state}`);
}

async function emptyDirectory(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForProcessGone(pid, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`process ${pid} did not exit`);
}

async function stopDaemon(daemonPid, workerPgid) {
  if (workerPgid) {
    try { process.kill(-workerPgid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (!daemonPid) return;
  try { process.kill(daemonPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await waitForProcessGone(daemonPid).catch(() => {});
}

function managerArguments(model, thinkingLevel) {
  return [
    "--mode", "rpc",
    "--no-session",
    "--approve",
    "--no-extensions",
    ...(model ? ["--provider", model.provider, "--model", model.id] : []),
    ...(thinkingLevel ? ["--thinking", thinkingLevel] : []),
    "-e", repositoryRoot,
  ];
}

function managerEnvironment(parent, runtimeDatabase) {
  return {
    ...process.env,
    PI_SAND_RUNTIME_DB: runtimeDatabase,
    XDG_RUNTIME_DIR: join(parent, "runtime"),
    PI_SAND_TASK_WORKTREE_ROOT: join(parent, "task-worktrees"),
    PI_CODING_AGENT_SESSION_DIR: join(parent, "sessions"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

function startManager(source, environment, model, thinkingLevel) {
  const child = spawn(piCommand, managerArguments(model, thinkingLevel), {
    cwd: source,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  attachJsonlReader(child.stdout, (event) => events.push(event));
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  return { child, closed, events, stderr };
}

async function closeManager(manager) {
  if (!manager.child.stdin.destroyed) manager.child.stdin.end();
  await manager.closed;
  await waitForProcessGone(manager.child.pid);
}

async function runAcceptance(t) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-real-runtime-"));
  const source = await makeRepository(parent);
  const runtimeDatabase = join(parent, "task-runtime.sqlite");
  const environment = managerEnvironment(parent, runtimeDatabase);
  const runtimeClient = new RuntimeClient({ env: environment, requestTimeoutMs: 5_000 });
  let managerA;
  let managerB;
  let daemonPid;
  let workerPgid;
  try {
    managerA = startManager(source, environment);
    send(managerA.child, { id: "manager-state", type: "get_state" });
    const stateResponse = await waitForEvent(managerA.events, (event) => event.type === "response" && event.id === "manager-state", managerA.child, managerA.stderr);
    assert.equal(stateResponse.success, true, JSON.stringify(stateResponse));
    const model = stateResponse.data.model;
    const thinkingLevel = stateResponse.data.thinkingLevel;
    if (!model?.provider || !model?.id || model.provider === "unknown" || model.id === "unknown" || !thinkingLevel) {
      t.skip("the real Manager has no configured provider, model, and thinking level");
      return;
    }
    const auth = spawnSync(piCommand, ["auth", "check", "--provider", model.provider, "--model", model.id, "--json", "--no-refresh"], {
      env: environment,
      encoding: "utf8",
    });
    if (auth.status !== 0) {
      t.skip(`configured auth probe failed: ${auth.stderr || auth.stdout}`);
      return;
    }
    let authResult;
    try {
      authResult = JSON.parse(auth.stdout);
    } catch {
      t.skip(`configured auth probe returned no JSON status: ${auth.stdout || auth.stderr}`);
      return;
    }
    if (authResult.status !== "ready") {
      t.skip(`configured auth is not usable: ${auth.stdout}`);
      return;
    }

    // Keep Manager A's model selection, but use the exact public RPC command
    // surface. The Extension's registration is the contract under test.
    const commandsResponse = await (async () => {
      send(managerA.child, { id: "manager-commands", type: "get_commands" });
      return waitForEvent(managerA.events, (event) => event.type === "response" && event.id === "manager-commands", managerA.child, managerA.stderr);
    })();
    assert.equal(commandsResponse.success, true, JSON.stringify(commandsResponse));
    const extensionPath = join(repositoryRoot, "extensions", "pi-sand.ts");
    const extensionCommands = commandsResponse.data.commands
      .filter((command) => command.source === "extension" && command.sourceInfo?.path === extensionPath)
      .map((command) => command.name)
      .sort();
    assert.deepEqual(extensionCommands, [...expectedExtensionCommands].sort());

    // Start pi-sandd with the wrapper in its environment only. Manager A and
    // B below are still spawned directly with the real installed Pi command.
    const wrapper = await makePiWrapper(parent);
    const daemonEnvironment = {
      ...environment,
      PI_BIN: wrapper.command,
      PI_SAND_REAL_PI_BIN: piCommand,
      PI_SAND_REAL_RUNTIME_ARG_LOG: wrapper.logPath,
    };
    const daemonProcess = startDaemon(daemonEnvironment);
    daemonPid = daemonProcess.pid;
    const daemonStarted = await waitForDaemon(runtimeClient, daemonProcess);
    assert.equal(daemonStarted.daemonPid, daemonPid);

    const goal = [
      "Create exactly one repository file named real-runtime-artifact.txt.",
      "Its complete bytes must be exactly PI_SAND_REAL_RUNTIME_OK followed by one trailing newline.",
      "As your first action, use the shell to run sleep 8 so the Manager can exit while this Task is still running.",
      "Do not modify, create, or delete any other file. Do not create a commit; the daemon will checkpoint your change.",
      "After verifying the file, reply briefly and do not do anything else.",
    ].join(" ");
    const started = await commandNotification(managerA.child, managerA.events, managerA.stderr, "manager-task", `/task ${goal}`);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.task.goal, goal);
    assert.equal(started.task.state, "running");
    assert.notEqual(started.task.taskWorktree, source);
    assert.match(started.task.taskBranch, /^pi-sand\/task-/);
    assert.equal(started.task.baseCommit, git(source, ["rev-parse", "HEAD"]));

    const attempt = started.task.attempts[0];
    assert.equal(typeof attempt.workerPid, "number");
    assert.equal(typeof attempt.workerPgid, "number");
    workerPgid = attempt.workerPgid;
    assert.notEqual(attempt.workerPid, managerA.child.pid, "Fresh Executor must be a separate Pi process");
    assert.equal(attempt.workerPgid, attempt.workerPid, "Fresh Executor must retain one detached process group across the wrapper exec");
    assert.doesNotThrow(() => process.kill(attempt.workerPid, 0));
    const freshExecutorInvocation = await waitForInvocation(wrapper.logPath, FRESH_EXECUTOR_ARGS);
    assert.deepEqual(freshExecutorInvocation, FRESH_EXECUTOR_ARGS, "daemon Fresh Executor must invoke the real Pi with the exact controlled profile");

    const daemonBeforeExit = await runtimeClient.status();
    assert.equal(daemonBeforeExit.daemonPid, daemonPid);
    assert.notEqual(daemonBeforeExit.daemonPid, managerA.child.pid);
    assert.doesNotThrow(() => process.kill(daemonBeforeExit.daemonPid, 0));

    // This is the defining lifetime boundary: Manager A is fully gone before
    // the bounded real Task may finish. No Pi client remains as an owner.
    await closeManager(managerA);
    managerA = undefined;
    const afterManagerExit = await runtimeClient.getTask(started.task.id);
    assert.notEqual(afterManagerExit.state, "stopped");
    assert.notEqual(afterManagerExit.state, "interrupted");
    assert.equal(afterManagerExit.state, "running", "Task must still be running after Manager A exits");
    assert.doesNotThrow(() => process.kill(daemonBeforeExit.daemonPid, 0));
    assert.doesNotThrow(() => process.kill(attempt.workerPid, 0));

    const completed = await waitForTask(runtimeClient, started.task.id, (task) => task.state === "completed");
    workerPgid = undefined;
    assert.equal(completed.attempts[0].state, "completed");
    assert.equal(completed.attempts[0].provider, model.provider);
    assert.equal(completed.attempts[0].modelId, model.id);
    assert.equal(completed.attempts[0].thinkingLevel, thinkingLevel);
    assert.equal(completed.attempts[0].terminalDetail, "Fresh Executor settled successfully.");
    assert.ok(completed.finalResult);
    assert.ok(completed.finalResult.length <= 4 * 1024);
    assert.equal(completed.finalBranchHead, completed.attempts[0].finalBranchHead);
    assert.notEqual(completed.finalBranchHead, completed.baseCommit);

    const taskWorktree = completed.taskWorktree;
    assert.equal(git(taskWorktree, ["branch", "--show-current"]), completed.taskBranch);
    assert.equal(await readFile(join(taskWorktree, "real-runtime-artifact.txt"), "utf8"), "PI_SAND_REAL_RUNTIME_OK\n");
    assert.deepEqual(
      git(taskWorktree, ["diff", "--name-status", `${completed.baseCommit}..${completed.finalBranchHead}`]).split("\n"),
      ["A\treal-runtime-artifact.txt"],
    );
    assert.equal(git(taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(source, ["rev-parse", "HEAD"]), completed.baseCommit);
    assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(source, ["ls-files", "--others", "--exclude-standard"]), "");
    assert.equal(git(source, ["diff", "--binary", completed.baseCommit]), "");
    await assert.rejects(readFile(join(source, "real-runtime-artifact.txt")));

    managerB = startManager(source, environment, model, thinkingLevel);
    const listed = await commandNotification(managerB.child, managerB.events, managerB.stderr, "manager-b-tasks", "/tasks");
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.tasks.some((task) => task.id === completed.id && task.state === "completed"), true);
    const shown = await commandNotification(managerB.child, managerB.events, managerB.stderr, "manager-b-task-show", `/task-show ${completed.id}`);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(shown.task.id, completed.id);
    assert.equal(shown.task.state, "completed");
    assert.equal(shown.task.finalResult, completed.finalResult);
    assert.equal(shown.task.finalBranchHead, completed.finalBranchHead);
    assert.equal(shown.task.taskWorktree, completed.taskWorktree);
    assert.equal(shown.task.taskBranch, completed.taskBranch);
    assert.deepEqual(shown.task.attempts, completed.attempts);
    await closeManager(managerB);
    managerB = undefined;

    // --no-session applies to both Managers and the Fresh Executor. No Pi
    // session tree is a hidden continuity or replay channel for this proof.
    assert.deepEqual(await emptyDirectory(join(parent, "sessions")), []);
  } finally {
    if (managerA) {
      managerA.child.kill("SIGKILL");
      await managerA.closed.catch(() => {});
    }
    if (managerB) {
      managerB.child.kill("SIGKILL");
      await managerB.closed.catch(() => {});
    }
    await stopDaemon(daemonPid, workerPgid).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
}

const piVersionProbe = enabled ? spawnSync(piCommand, ["--version"], { encoding: "utf8" }) : null;

const skipReason = enabled
  ? piVersionProbe?.status === 0
    ? piVersionProbe.stdout.trim() === "0.84.4"
      ? undefined
      : `Pi 0.84.4 is required; found ${piVersionProbe.stdout.trim() || "no version"}`
    : `Pi 0.84.4 is required (${piVersionProbe?.error?.message ?? "version probe failed"})`
  : "set PI_SAND_REAL_RUNTIME=1 with Pi 0.84.4 and usable configured model credentials to run the opt-in persistent-runtime acceptance";

test("v0.3 real Pi Manager A exit -> daemon completion -> Manager B reconnect", {
  skip: skipReason,
  timeout: timeoutMs + 15_000,
}, async (t) => {
  await runAcceptance(t);
});
