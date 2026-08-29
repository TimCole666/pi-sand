import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";
import { launchProduct } from "../src/launcher.js";

const chromiumPath = "/usr/bin/chromium";
const canDriveChromium = existsSync(chromiumPath) && typeof WebSocket === "function";

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(message);
}

async function browserDebugger(port, userDataDir, url) {
  const browser = spawn(chromiumPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    url,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let endpoint;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      endpoint = pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl && page.url.startsWith(url));
      return Boolean(endpoint);
    } catch {
      if (browser.exitCode !== null) throw new Error(`Chromium exited with ${browser.exitCode}`);
      return false;
    }
  }, "Chromium did not expose a DevTools page");

  const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
    return result.result?.value;
  };
  await waitFor(() => evaluate("Boolean(document.querySelector('#name'))"), "Chromium Desktop did not load the supported shell");
  return {
    browser,
    evaluate,
    async close() {
      socket.close();
      if (browser.exitCode === null) browser.kill("SIGTERM");
      await once(browser, "exit").catch(() => {});
    },
  };
}

function controlledPiFactory(controls) {
  return ({ onEvent, onClose }) => {
    let stopped = false;
    let promptText = "";
    const execution = {
      prompt({ message }) {
        promptText = message;
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
        controls.set(message, execution);
      },
      release() {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Completed: ${promptText}` }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      abort() {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Interrupted: ${promptText}` }], stopReason: "aborted" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      close() { stopped = true; },
    };
    return execution;
  };
}

test("actual Chromium Desktop isolates concurrent Agents and stops only the selected Agent", { skip: !canDriveChromium }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-actual-stop-e2e-"));
  const workspaceA = await mkdtemp(join(directory, "workspace-a-"));
  const workspaceB = await mkdtemp(join(directory, "workspace-b-"));
  const browserData = join(directory, "chromium-profile");
  const controls = new Map();
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: controlledPiFactory(controls) });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let desktop;
  try {
    desktop = await browserDebugger(await reservePort(), browserData, base);
    const evaluate = desktop.evaluate;
    const createAgent = async (name, workspace) => {
      await evaluate(`(async () => { document.querySelector('#name').value = ${JSON.stringify(name)}; document.querySelector('#workspace').value = ${JSON.stringify(workspace)}; document.querySelector('#create').requestSubmit(); })()`);
      await waitFor(() => evaluate(`document.querySelectorAll('[data-agent-id]').length`) .then((count) => count >= (name === "A" ? 1 : 2)), `${name} was not created`);
    };
    await createAgent("A", workspaceA);
    await createAgent("B", workspaceB);

    const idFor = async (name) => evaluate(`[...document.querySelectorAll('[data-agent-id]')].find((button) => button.textContent.includes(${JSON.stringify(name)}))?.dataset.agentId`);
    const send = async (name, message) => {
      const id = await idFor(name);
      await evaluate(`(async () => { document.querySelector('[data-agent-id="${id}"]').click(); await new Promise((resolve) => setTimeout(resolve, 20)); const input = document.querySelector('#message'); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').requestSubmit(); })()`);
      await waitFor(() => evaluate("document.querySelector('#header-status').textContent") .then((status) => status === "Working"), `${name} did not enter Working state`);
    };
    await send("A", "A running");
    await send("B", "B running");
    assert.equal(controls.size, 2);

    await evaluate(`(async () => { const id = ${JSON.stringify(await idFor("A"))}; document.querySelector('[data-agent-id="' + id + '"]').click(); await new Promise((resolve) => setTimeout(resolve, 20)); document.querySelector('#interrupt').click(); })()`);
    await waitFor(() => evaluate("document.querySelector('#status').textContent") .then((status) => status.startsWith("Turn interrupted:")), "Desktop did not render A interruption");
    const agentBId = await idFor("B");
    await evaluate(`document.querySelector('[data-agent-id="${agentBId}"]').click()`);
    await waitFor(() => evaluate("document.querySelector('#header-status').textContent") .then((status) => status === "Working"), "Stopping A affected B");

    controls.get("B running").release();
    await waitFor(() => evaluate("document.querySelector('#status').textContent") .then((status) => status === "Turn completed."), "B did not complete after A stopped");
    const completedB = service.getAgent(agentBId);
    assert.equal(completedB.turns[0].status, "completed");
    assert.equal(service.getAgent(await idFor("A")).turns[0].status, "interrupted");
  } finally {
    await desktop?.close();
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual Desktop cold-launches the Local Agent Service through the product launcher", { skip: !canDriveChromium }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-actual-cold-launch-"));
  const workspace = join(directory, "workspace");
  const browserData = join(directory, "chromium-profile");
  const fakePi = join(directory, "fake-pi");
  await mkdir(workspace);
  await writeFile(fakePi, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.84.2"); process.exit(0); }
let buffer = "";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.type !== "prompt") continue;
    emit({ id: request.id, command: "prompt", success: true });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working from the launched product" } });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Cold launch completed." }], stopReason: "stop" } });
      emit({ type: "agent_settled" });
    }, 250);
  }
});
`);
  await chmod(fakePi, 0o755);
  const oldPiBin = process.env.PI_BIN;
  process.env.PI_BIN = fakePi;
  const port = await reservePort();
  let desktop;
  let desktopPromise;
  let launched;
  try {
    launched = await launchProduct({
      port,
      dbPath: join(directory, "state.sqlite"),
      openDesktopImpl: (url) => {
        desktopPromise = (async () => browserDebugger(await reservePort(), browserData, url))();
      },
    });
    assert.equal(launched.started, true);
    desktop = await desktopPromise;
    await waitFor(() => desktop.evaluate("document.querySelector('#connection').hidden === true"), "launched Desktop did not connect to the cold-started service");
    await desktop.evaluate(`(() => {
      document.querySelector('#new-chat').click();
      document.querySelector('#name').value = 'Cold launch Agent';
      document.querySelector('#workspace').value = ${JSON.stringify(workspace)};
      document.querySelector('#create').requestSubmit();
    })()`);
    await waitFor(() => desktop.evaluate("document.querySelector('[data-agent-id]')?.textContent.includes('Cold launch Agent')"), "cold-launched Desktop did not create an Agent");
    await desktop.evaluate(`(() => {
      const input = document.querySelector('#message');
      input.value = 'Do work after cold bootstrap';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#send').requestSubmit();
    })()`);
    await waitFor(() => desktop.evaluate("document.querySelector('#header-status')?.textContent === 'Working'"), "cold-launched Desktop did not show Working in the conversation header");
    await waitFor(() => desktop.evaluate("document.querySelector('#status')?.textContent === 'Turn completed.'"), "cold-launched Desktop did not show the completed Turn");
    assert.match(await desktop.evaluate("document.querySelector('#messages')?.textContent"), /Cold launch completed/);
  } finally {
    await desktop?.close().catch(() => {});
    if (launched?.pid) {
      try { process.kill(launched.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (oldPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = oldPiBin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual Desktop shows Retry when cold service bootstrap fails", { skip: !canDriveChromium }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-actual-bootstrap-error-"));
  const browserData = join(directory, "chromium-profile");
  const port = await reservePort();
  let desktop;
  let desktopPromise;
  let serverProcess;
  try {
    await assert.rejects(
      launchProduct({
        port,
        // /dev/null is a file, so the child cannot create the requested DB
        // parent. The server still hosts the static Desktop shell in degraded
        // mode while the product-level connection state is rendered.
        dbPath: "/dev/null/pi-sand.sqlite",
        spawnImpl: (...args) => {
          serverProcess = spawn(...args);
          return serverProcess;
        },
        openDesktopImpl: (url) => {
          desktopPromise = (async () => browserDebugger(await reservePort(), browserData, url))();
        },
        timeoutMs: 250,
      }),
      /could not be reached during product launch/,
    );
    desktop = await desktopPromise;
    await waitFor(() => desktop.evaluate("document.querySelector('#connection')?.textContent === 'Can’t reach your computer'"), "bootstrap failure was not rendered in the Desktop");
    assert.equal(await desktop.evaluate("document.querySelector('#retry')?.hidden"), false);
  } finally {
    await desktop?.close().catch(() => {});
    if (serverProcess?.exitCode === null) serverProcess.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
