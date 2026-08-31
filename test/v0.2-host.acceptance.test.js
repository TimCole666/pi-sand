// v0.2 durable seam: Real Pi Extension Host Acceptance on Pi 0.84.4.
// Deterministic Extension Lifecycle Integration is the companion durable seam;
// this test proves package loading, command dispatch, and Pi-native prompting.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  ], {
    cwd: hostCwd,
    env: {
      ...process.env,
      PI_SAND_DB: join(hostCwd, "unexpected-pi-sand.sqlite"),
      XDG_DATA_HOME: join(hostCwd, "unexpected-xdg-data"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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

    const replacementStart = events.length;
    send({ id: "replacement", type: "new_session" }, child);
    const replacementResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "replacement",
      child,
      replacementStart,
    );
    assert.equal(replacementResponse.success, true);
    assert.deepEqual(replacementResponse.data, { cancelled: false });
    const replacementCleanup = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-sand" && event.statusText === undefined,
      child,
      replacementStart,
    );
    const replacementStatus = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-sand" && event.statusText === "pi-sand: idle",
      child,
      replacementStart,
    );
    assert.equal(replacementCleanup.statusText, undefined);
    assert.equal(replacementStatus.statusText, "pi-sand: idle");

    const postReplacementStart = events.length;
    send({ id: "post-replacement-status", type: "prompt", message: "/pi-sand" }, child);
    const postReplacementNotice = await waitForEvent(
      events,
      (event) => event.type === "extension_ui_request" && event.method === "notify",
      child,
      postReplacementStart,
    );
    const postReplacementStatus = JSON.parse(postReplacementNotice.message);
    assert.equal(postReplacementStatus.extension, "pi-sand");
    assert.equal(postReplacementStatus.mode, "rpc");
    assert.equal(postReplacementStatus.activity, "idle");
    assert.notEqual(postReplacementStatus.session, status.session);
    const postReplacementResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "post-replacement-status",
      child,
      postReplacementStart,
    );
    assert.equal(postReplacementResponse.success, true);

    const postReplacementCommandsStart = events.length;
    send({ id: "post-replacement-commands", type: "get_commands" }, child);
    const postReplacementCommands = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "post-replacement-commands",
      child,
      postReplacementCommandsStart,
    );
    assert.equal(postReplacementCommands.success, true);
    assert.equal(postReplacementCommands.data.commands.filter((candidate) => candidate.name === "pi-sand").length, 1);
    assert.equal(postReplacementCommands.data.commands.some((candidate) => candidate.name === "pi-sand-reload"), false);

    const ordinaryStart = events.length;
    send({ id: "ordinary", type: "prompt", message: "ordinary Pi-native prompt" }, child);
    const ordinaryResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "ordinary",
      child,
      ordinaryStart,
    );
    assert.equal(ordinaryResponse.success, true);
    await waitForEvent(events, (event) => event.type === "agent_start", child, ordinaryStart);
    send({ id: "abort-ordinary", type: "abort" }, child);
    const abortResponse = await waitForEvent(
      events,
      (event) => event.type === "response" && event.id === "abort-ordinary",
      child,
      ordinaryStart,
    );
    assert.equal(abortResponse.success, true);
    await waitForEvent(events, (event) => event.type === "agent_settled", child, ordinaryStart);

    const ordinaryEvents = events.slice(ordinaryStart);
    assert.equal(ordinaryEvents.filter((event) => event.type === "agent_start").length, 1);
    assert.equal(ordinaryEvents.filter((event) => event.type === "turn_start").length, 1);
    assert.equal(ordinaryEvents.some((event) => event.type === "message_start" && event.message?.role === "user" && event.message.content?.[0]?.text === "ordinary Pi-native prompt"), true);
    const assistantStarts = ordinaryEvents.filter((event) => event.type === "message_start" && event.message?.role === "assistant");
    assert.equal(assistantStarts.length, 1);
    assert.equal(assistantStarts[0].message.stopReason, "aborted");
    assert.deepEqual(assistantStarts[0].message.content, []);
    assert.equal(ordinaryEvents.some((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta"), false);
    assert.equal(ordinaryEvents.some((event) => event.type === "tool_execution_start"), false);
    assert.equal(ordinaryEvents.some((event) => event.type === "extension_ui_request" && event.method === "notify"), false);
    assert.equal(ordinaryEvents.some((event) => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusText === "pi-sand: running"), true);
    assert.equal(await readFile(join(hostCwd, "unexpected-pi-sand.sqlite")).catch(() => undefined), undefined, "ordinary prompts must not start the legacy service");
    assert.deepEqual(await readdir(hostCwd), [], "ordinary prompts must not create a second host-owned transcript or service state");
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
