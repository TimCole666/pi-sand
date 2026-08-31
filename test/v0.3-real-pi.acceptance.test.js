// v0.3 opt-in acceptance: a real Pi Manager submits one Task to a real
// extension-free Fresh Executor and observes its durable Git completion.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const enabled = process.env.PI_SAND_REAL_FRESH_EXECUTOR === "1";
const timeoutMs = Number(process.env.PI_SAND_REAL_FRESH_EXECUTOR_TIMEOUT_MS ?? 180_000);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCommand = process.env.PI_BIN ?? "pi";

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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForEvent(events, predicate, child, stderr, startAt = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.slice(startAt).find(predicate);
    if (event) return event;
    if (child.exitCode !== null) {
      throw new Error(`Manager Pi exited before the expected event (code=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr.join("")})`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for the Manager Pi RPC event (stderr=${stderr.join("")})`);
}

function send(child, command) {
  assert.equal(child.stdin.destroyed, false, "Manager Pi stdin must remain writable");
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function notificationPayload(event) {
  try {
    return JSON.parse(event.message);
  } catch {
    return undefined;
  }
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

async function readProcessArguments(pid) {
  const bytes = await readFile(`/proc/${pid}/cmdline`);
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

async function waitForProcessArguments(pid) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    try {
      const args = await readProcessArguments(pid);
      if (args.length > 0) return args;
    } catch {
      // The worker may not have entered /proc yet; keep the proof bounded.
    }
    await delay(25);
  }
  throw new Error(`Fresh Executor process ${pid} was not observable in /proc`);
}

async function emptyDirectory(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function runFreshExecutorAcceptance() {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-real-fresh-"));
  const source = await makeRepository(parent);
  const sessionDirectory = join(parent, "sessions");
  const runtimeDatabase = join(parent, "task-runtime.sqlite");
  const managerEnvironment = {
    ...process.env,
    PI_SAND_RUNTIME_DB: runtimeDatabase,
    PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
  };
  const managerArgs = [
    "--mode", "rpc",
    "--no-session",
    "--approve",
    "--no-extensions",
    "-e", repositoryRoot,
  ];
  const manager = spawn(piCommand, managerArgs, {
    cwd: source,
    env: managerEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const managerClosed = new Promise((resolveClose) => manager.once("close", resolveClose));
  const events = [];
  const stderr = [];
  manager.stderr.setEncoding("utf8");
  manager.stderr.on("data", (chunk) => stderr.push(chunk));
  attachJsonlReader(manager.stdout, (event) => events.push(event));

  try {
    const stateRequest = "fresh-state";
    send(manager, { id: stateRequest, type: "get_state" });
    const stateResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === stateRequest, manager, stderr);
    assert.equal(stateResponse.success, true, JSON.stringify(stateResponse));
    assert.ok(stateResponse.data.model?.provider, "the real Manager must select a configured provider");
    assert.notEqual(stateResponse.data.model.provider, "unknown");
    assert.ok(stateResponse.data.model?.id, "the real Manager must select a configured model");
    assert.notEqual(stateResponse.data.model.id, "unknown");
    assert.ok(stateResponse.data.thinkingLevel, "the real Manager must select a thinking level");

    const commandsRequest = "fresh-commands";
    send(manager, { id: commandsRequest, type: "get_commands" });
    const commandsResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === commandsRequest, manager, stderr);
    assert.equal(commandsResponse.success, true, JSON.stringify(commandsResponse));
    const extensionCommands = commandsResponse.data.commands.filter((command) => command.source === "extension").map((command) => command.name);
    assert.deepEqual(extensionCommands.sort(), ["pi-sand", "task", "task-show", "tasks"]);

    const goal = [
      "Create exactly one repository file named real-fresh-executor.txt.",
      "Its complete bytes must be exactly PI_SAND_FRESH_EXECUTOR_OK followed by one trailing newline.",
      "Do not modify, create, or delete any other file. Do not create a commit; the Manager will checkpoint your change.",
      "After verifying the file, reply briefly and do not do anything else.",
    ].join(" ");
    const started = await commandNotification(manager, events, stderr, "fresh-task", `/task ${goal}`);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.task.goal, goal);
    assert.equal(started.task.state, "running");
    assert.notEqual(started.task.taskWorktree, source);
    assert.match(started.task.taskBranch, /^pi-sand\/task-/);
    assert.equal(started.task.baseCommit, git(source, ["rev-parse", "HEAD"]));

    const attempt = started.task.attempts[0];
    assert.equal(typeof attempt.workerPid, "number");
    assert.notEqual(attempt.workerPid, manager.pid, "the Fresh Executor must be a separate Pi process");
    const workerArguments = await waitForProcessArguments(attempt.workerPid);
    const profileStart = workerArguments.indexOf("--mode");
    assert.deepEqual(
      workerArguments.slice(profileStart, profileStart + 5),
      ["--mode", "rpc", "--no-session", "--approve", "--no-extensions"],
      `Fresh Executor command line must use the controlled profile: ${workerArguments.join(" ")}`,
    );

    let shown = await commandNotification(manager, events, stderr, "fresh-task-show-start", `/task-show ${started.task.id}`);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(shown.task.id, started.task.id);
    assert.equal(shown.task.attempts[0].workerPid, attempt.workerPid);

    const completionDeadline = Date.now() + timeoutMs;
    while (shown.task.state === "running" && Date.now() < completionDeadline) {
      await delay(250);
      shown = await commandNotification(manager, events, stderr, `fresh-task-show-${Date.now()}`, `/task-show ${started.task.id}`);
    }
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(shown.task.state, "completed", JSON.stringify(shown));
    assert.equal(shown.task.attempts[0].state, "completed", JSON.stringify(shown));
    assert.equal(shown.task.attempts[0].terminalDetail, "Fresh Executor settled successfully.");
    assert.ok(shown.task.finalResult);
    assert.equal(shown.task.attempts[0].finalResult, shown.task.finalResult);
    assert.equal(shown.task.finalBranchHead, shown.task.attempts[0].finalBranchHead);
    assert.notEqual(shown.task.finalBranchHead, shown.task.baseCommit);

    const taskWorktree = shown.task.taskWorktree;
    assert.equal(git(taskWorktree, ["branch", "--show-current"]), shown.task.taskBranch);
    assert.equal(await readFile(join(taskWorktree, "real-fresh-executor.txt"), "utf8"), "PI_SAND_FRESH_EXECUTOR_OK\n");
    assert.deepEqual(git(taskWorktree, ["diff", "--name-status", `${shown.task.baseCommit}..${shown.task.finalBranchHead}`]).split("\n"), ["A\treal-fresh-executor.txt"]);
    assert.equal(git(taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.match(git(taskWorktree, ["log", "-1", "--format=%s"]), new RegExp(`^pi-sand: checkpoint completed Task ${started.task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

    assert.equal(git(source, ["rev-parse", "HEAD"]), shown.task.baseCommit);
    assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(source, ["ls-files", "--others", "--exclude-standard"]), "");
    assert.equal(git(source, ["diff", "--binary", shown.task.baseCommit]), "");
    await assert.rejects(readFile(join(source, "real-fresh-executor.txt")));
  } finally {
    manager.stdin.end();
    await managerClosed;
    assert.deepEqual(await emptyDirectory(sessionDirectory), [], "Manager and Fresh Executor must not persist Pi sessions");
    assert.equal(stderr.join(""), "", `Manager Pi wrote unexpected stderr: ${stderr.join("")}`);
    await rm(parent, { recursive: true, force: true });
  }
}

const piVersionProbe = enabled ? spawnSync(piCommand, ["--version"], { encoding: "utf8" }) : null;

test("v0.3 real Pi 0.84.4 Manager submits and durably completes one Fresh Executor Task", {
  skip: enabled
    ? false
    : "set PI_SAND_REAL_FRESH_EXECUTOR=1 with a configured Pi 0.84.4 model to run the opt-in Fresh Executor acceptance scenario",
  timeout: timeoutMs + 15_000,
}, async () => {
  assert.equal(piVersionProbe?.status, 0, `Pi 0.84.4 is required (${piVersionProbe?.error?.message ?? "pi was not found"})`);
  assert.equal(piVersionProbe.stdout.trim(), "0.84.4");
  await runFreshExecutorAcceptance();
});
