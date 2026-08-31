// v0.2 durable seam: Real Pi Extension Host Acceptance on Pi 0.84.4.
// Deterministic Extension Lifecycle Integration is the companion durable seam;
// this test proves package loading, command dispatch, and session replacement.

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

// Pi 0.84.4 reads provider credentials from these documented environment
// variables, while the agent directory below covers auth.json, settings.json,
// models.json, and model-store files. The allowlist in createHostEnvironment
// intentionally excludes all of them rather than relying on --offline.
const providerCredentialEnvironmentVariables = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "RADIUS_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

function createHostEnvironment({ hostCwd, agentDir }) {
  const environment = {
    PATH: process.env.PATH,
    HOME: hostCwd,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    XDG_CONFIG_HOME: join(hostCwd, "unexpected-xdg-config"),
    XDG_DATA_HOME: join(hostCwd, "unexpected-xdg-data"),
    XDG_CACHE_HOME: join(hostCwd, "unexpected-xdg-cache"),
    PI_SAND_DB: join(hostCwd, "unexpected-pi-sand.sqlite"),
  };
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

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
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sand-v02-agent-"));
  const childEnvironment = createHostEnvironment({ hostCwd, agentDir });
  assert.equal(childEnvironment.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(childEnvironment.HOME, hostCwd);
  assert.equal(childEnvironment.PI_OFFLINE, "1");
  assert.deepEqual(
    providerCredentialEnvironmentVariables.filter((name) => Object.hasOwn(childEnvironment, name)),
    [],
    "the real Pi child must not inherit provider credentials",
  );

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
    env: childEnvironment,
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

    send({ id: "state", type: "get_state" }, child);
    const stateResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === "state", child);
    assert.equal(stateResponse.success, true);
    assert.equal(stateResponse.data.model?.provider, "unknown", "the isolated host must start without a configured provider");
    assert.equal(stateResponse.data.model?.id, "unknown", "the isolated host must start without a selected model");

    send({ id: "models", type: "get_available_models" }, child);
    const modelsResponse = await waitForEvent(events, (event) => event.type === "response" && event.id === "models", child);
    assert.equal(modelsResponse.success, true);
    assert.deepEqual(modelsResponse.data.models, [], "the isolated host must not expose user-configured models");

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

    assert.equal(await readFile(join(hostCwd, "unexpected-pi-sand.sqlite")).catch(() => undefined), undefined, "the extension host must not start the legacy service");
    assert.deepEqual(await readdir(hostCwd), [], "the extension host must not create host-owned transcript or service state");
  } finally {
    child.stdin.end();
    await close;
    await Promise.all([
      rm(hostCwd, { recursive: true, force: true }),
      rm(agentDir, { recursive: true, force: true }),
    ]);
    assert.equal(stderr.join(""), "", `Pi RPC wrote unexpected stderr: ${stderr.join("")}`);
  }
}

test("v0.2 host package metadata follows Pi's documented local/Git package contract", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/pi-sand.ts"] });
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*" });
});

test("v0.2 Real Pi Extension Host Acceptance loads and dispatches /pi-sand without an LLM", {
  skip: piAvailable ? false : unavailableReason,
}, async () => {
  assert.equal(piVersionProbe.stdout.trim(), "0.84.4", "the v0.2 host contract is pinned to Pi 0.84.4");
  await runHostAcceptance();
});
