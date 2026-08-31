import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repositoryRoot, "extensions", "pi-sand.ts");
const piCommand = process.env.PI_BIN ?? "pi";
const piVersionProbe = spawnSync(piCommand, ["--version"], { encoding: "utf8" });
const piAvailable = piVersionProbe.status === 0;
const unavailableReason = `set PI_BIN to a Pi 0.84.4 executable to run the v0.2 host acceptance test (${piVersionProbe.error?.code ?? "pi was not found"})`;

function send(command, child) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function waitForEvent(events, predicate, child) {
  const existing = events.find(predicate);
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
      const event = events.find(predicate);
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
    "--approve",
    "--extension", repositoryRoot,
  ], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
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
    const command = commandsResponse.data.commands.find((candidate) => candidate.name === "pi-sand");
    assert.deepEqual(command && {
      name: command.name,
      source: command.source,
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
    assert.equal(status.cwd, repositoryRoot);
    assert.match(status.session, /^[0-9a-f-]{36}$/);
    assert.equal(status.activity, "idle");
    assert.equal(statusRequest.notifyType, "info");

    const statusResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === "status", child);
    assert.equal(statusResponse.success, true);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "turn_start"), false, "an extension command must not start an LLM turn");
  } finally {
    child.stdin.end();
    await close;
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
  const source = await readFile(extensionPath, "utf8");
  assert.doesNotMatch(source, /AgentService|Local Agent Service|spawn\s*\(|execFile\s*\(/);
  assert.doesNotMatch(source, /pi\.on\(\s*["']input["']/);
  assert.doesNotMatch(source, /send(?:User)?Message\s*\(/);
});
