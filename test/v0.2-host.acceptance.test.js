// v0.2 durable seam: Real Pi Extension Host Acceptance on Pi 0.84.4.
// Deterministic Extension Lifecycle Integration is the companion durable seam;
// this test proves package loading, command dispatch, and reload in real Pi.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionSourcePaths = [
  join(repositoryRoot, "extensions", "pi-sand.ts"),
  join(repositoryRoot, "extensions", "runtime.js"),
];
const piCommand = process.env.PI_BIN ?? "pi";
const piVersionProbe = spawnSync(piCommand, ["--version"], { encoding: "utf8" });
const piAvailable = piVersionProbe.status === 0;
const unavailableReason = `set PI_BIN to a Pi 0.84.4 executable to run the v0.2 host acceptance test (${piVersionProbe.error?.code ?? "pi was not found"})`;

function send(command, child) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function waitForEvent(events, predicate, child, startAt = 0) {
  const existing = events.slice(startAt).find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error("timed out waiting for the Pi RPC event"));
    }, 10_000);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Pi RPC exited before the expected event (code=${code}, signal=${signal})`));
    };
    child.once("close", onClose);
    const check = () => {
      const event = events.slice(startAt).find(predicate);
      if (!event) return;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolveEvent(event);
    };
    events.onChange = check;
  });
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

async function runHostAcceptance() {
  const hostCwd = await mkdtemp(join(tmpdir(), "pi-sand-v02-host-"));
  const child = spawn(piCommand, [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--offline",
    "-e", repositoryRoot,
  ], { cwd: hostCwd, stdio: ["pipe", "pipe", "pipe"] });
  const close = once(child, "close");
  const events = [];
  let changed;
  Object.defineProperty(events, "onChange", {
    configurable: true,
    set(listener) { changed = listener; },
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  attachJsonlReader(child.stdout, (event) => {
    events.push(event);
    changed?.();
  });

  try {
    send({ id: "commands", type: "get_commands" }, child);
    const commandsResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === "commands", child);
    assert.equal(commandsResponse.success, true);
    const piSandCommands = commandsResponse.data.commands.filter((candidate) => candidate.name === "pi-sand");
    assert.equal(piSandCommands.length, 1);
    assert.deepEqual({
      name: piSandCommands[0].name,
      source: piSandCommands[0].source,
    }, {
      name: "pi-sand",
      source: "extension",
    });

    send({ id: "status", type: "prompt", message: "/pi-sand" }, child);
    const statusRequest = await waitForEvent(events, (event) => event.type === "extension_ui_request" && event.method === "notify", child);
    const status = JSON.parse(statusRequest.message);
    assert.deepEqual(Object.keys(status).sort(), ["activity", "cwd", "extension", "mode", "session"]);
    assert.equal(status.extension, "pi-sand");
    assert.equal(status.mode, "rpc");
    assert.equal(status.cwd, hostCwd);
    assert.match(status.session, /^[0-9a-f-]{36}$/);
    assert.equal(status.activity, "idle");
    assert.equal(statusRequest.notifyType, "info");

    const statusResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === "status", child);
    assert.equal(statusResponse.success, true);

    const reloadStart = events.length;
    send({ id: "reload", type: "prompt", message: "/pi-sand-reload" }, child);
    const reloadResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "reload",
      child,
      reloadStart,
    );
    assert.equal(reloadResponse.success, true);
    const reloadStatus = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-sand" && event.statusText === "pi-sand: idle",
      child,
      reloadStart,
    );
    assert.equal(reloadStatus.statusText, "pi-sand: idle");

    const postReloadStart = events.length;
    send({ id: "post-reload-status", type: "prompt", message: "/pi-sand" }, child);
    const postReloadNotice = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "notify",
      child,
      postReloadStart,
    );
    const postReloadStatus = JSON.parse(postReloadNotice.message);
    assert.equal(postReloadStatus.extension, "pi-sand");
    assert.equal(postReloadStatus.mode, "rpc");
    assert.equal(postReloadStatus.activity, "idle");
    const postReloadResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "post-reload-status",
      child,
      postReloadStart,
    );
    assert.equal(postReloadResponse.success, true);

    const postReloadCommandsStart = events.length;
    send({ id: "post-reload-commands", type: "get_commands" }, child);
    const postReloadCommands = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "post-reload-commands",
      child,
      postReloadCommandsStart,
    );
    assert.equal(postReloadCommands.success, true);
    assert.equal(postReloadCommands.data.commands.filter((candidate) => candidate.name === "pi-sand").length, 1);
    assert.equal(postReloadCommands.data.commands.filter((candidate) => candidate.name === "pi-sand-reload").length, 1);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "turn_start"), false, "an extension command must not start an LLM turn");
  } finally {
    child.stdin.end();
    await close;
    await rm(hostCwd, { recursive: true, force: true });
    assert.equal(stderr.join(""), "", `Pi RPC wrote unexpected stderr: ${stderr.join("")}`);
  }
}

test("v0.2 host package metadata follows Pi's documented local/Git package contract", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/pi-sand.ts"] });
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*" });
});

test("v0.2 host acceptance loads the package in real Pi 0.84.4 and dispatches /pi-sand without an LLM", {
  skip: piAvailable ? false : unavailableReason,
}, async () => {
  assert.equal(piVersionProbe.stdout.trim(), "0.84.4", "the v0.2 host contract is pinned to Pi 0.84.4");
  await runHostAcceptance();
});

test("v0.2 host extension leaves ordinary prompts with foreground Pi", async () => {
  const source = (await Promise.all(extensionSourcePaths.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(source, /AgentService|Local Agent Service|child_process|spawn\s*\(|execFile\s*\(/);
  assert.doesNotMatch(source, /chromium|localhost|http\.createServer|\.listen\s*\(/i);
  assert.doesNotMatch(source, /pi\.on\(\s*["']input["']/);
  assert.doesNotMatch(source, /send(?:User)?Message\s*\(/);
  assert.doesNotMatch(source, /appendEntry|transcript|sqlite|database/i);
});
