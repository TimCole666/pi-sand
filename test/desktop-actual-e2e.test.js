import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";
import { launchProduct, locateChromium, openDesktop } from "../src/launcher.js";
import { processIsAlive } from "../src/process.js";

const chromiumPath = (() => {
  try { return locateChromium(); } catch { return null; }
})();
const canDriveChromium = Boolean(chromiumPath) && typeof WebSocket === "function";

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

async function connectDesktop({ browser, command: browserCommand, port, url }) {
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
    browserCommand,
    evaluate,
    async close() {
      socket.close();
      if (browser.exitCode === null) browser.kill("SIGTERM");
      await once(browser, "exit").catch(() => {});
    },
  };
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processIsAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processIsAlive(pid), false, `process ${pid} did not exit`);
}

async function browserDebugger(port, userDataDir, url) {
  let browserCommand;
  const browser = openDesktop(url, {
    spawnImpl: (command, args, spawnOptions) => {
      browserCommand = command;
      return spawn(command, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        ...args,
      ], { ...spawnOptions, stdio: ["ignore", "ignore", "pipe"] });
    },
  });
  return connectDesktop({ browser, command: browserCommand, port, url });
}

async function desktopState(desktop) {
  return desktop.evaluate(`({
    headerStatus: document.querySelector('#header-status')?.textContent || '',
    status: document.querySelector('#status')?.textContent || '',
    draft: document.querySelector('#message')?.value || '',
    selectedAgent: localStorage.getItem('pi-sand-agent'),
    messages: [...document.querySelectorAll('#messages .message')].map((element) => ({ id: element.dataset.id, text: element.textContent })),
  })`);
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

test("actual Chromium Desktop preserves each Agent draft across switch and return", { skip: !canDriveChromium }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-actual-draft-e2e-"));
  const workspaceA = await mkdtemp(join(directory, "workspace-a-"));
  const workspaceB = await mkdtemp(join(directory, "workspace-b-"));
  const browserData = join(directory, "chromium-profile");
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: controlledPiFactory(new Map()) });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let desktop;
  try {
    desktop = await browserDebugger(await reservePort(), browserData, base);
    const createAgent = async (name, workspace) => {
      await desktop.evaluate(`(() => {
        document.querySelector('#new-chat').click();
        document.querySelector('#name').value = ${JSON.stringify(name)};
        document.querySelector('#workspace').value = ${JSON.stringify(workspace)};
        document.querySelector('#create').requestSubmit();
      })()`);
      await waitFor(() => desktop.evaluate(`document.querySelectorAll('[data-agent-id]').length >= ${name === "A" ? 1 : 2}`), `${name} was not created`);
    };
    await createAgent("A", workspaceA);
    await createAgent("B", workspaceB);
    const idFor = async (name) => desktop.evaluate(`[...document.querySelectorAll('[data-agent-id]')].find((button) => button.textContent.includes(${JSON.stringify(name)}))?.dataset.agentId`);
    const selectAgent = async (name) => {
      const id = await idFor(name);
      await desktop.evaluate(`document.querySelector('[data-agent-id="${id}"]').click()`);
      await waitFor(() => desktop.evaluate(`document.querySelector('#agent-meta').textContent.startsWith(${JSON.stringify(name)})`), `${name} was not selected`);
    };
    const setDraft = async (text) => desktop.evaluate(`(() => {
      const input = document.querySelector('#message');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    await selectAgent("A");
    await setDraft("Alpha draft");
    await selectAgent("B");
    assert.equal(await desktop.evaluate("document.querySelector('#message').value"), "");
    await setDraft("Beta draft");
    await selectAgent("A");
    assert.equal(await desktop.evaluate("document.querySelector('#message').value"), "Alpha draft");
    await selectAgent("B");
    assert.equal(await desktop.evaluate("document.querySelector('#message').value"), "Beta draft");
  } finally {
    await desktop?.close().catch(() => {});
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

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
      await evaluate(`document.querySelector('[data-agent-id="${id}"]').click()`);
      await waitFor(() => evaluate(`document.querySelector('#agent-meta').textContent.startsWith(${JSON.stringify(name)})`), `${name} was not selected before sending`);
      await evaluate(`(() => { const input = document.querySelector('#message'); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').requestSubmit(); })()`);
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

test("actual Desktop traces cold launch, background work, relaunch, and authoritative reconnect", { skip: !canDriveChromium }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-actual-lifetime-"));
  const workspaceA = join(directory, "workspace-a");
  const workspaceB = join(directory, "workspace-b");
  const browserData = join(directory, "chromium-profile");
  const fakePi = join(directory, "fake-pi");
  const workerPidPath = join(directory, "worker.pid");
  const releasePath = join(directory, "release-turn");
  const dbPath = join(directory, "state.sqlite");
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  await writeFile(fakePi, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const workerPidPath = ${JSON.stringify(workerPidPath)};
const releasePath = ${JSON.stringify(releasePath)};
if (process.argv.includes("--version")) { console.log("0.84.2"); process.exit(0); }
writeFileSync(workerPidPath, String(process.pid));
let buffer = "";
let releaseTimer;
let settled = false;
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.type === "prompt") {
      emit({ type: "session", id: "slow-deterministic-session" });
      emit({ id: request.id, command: "prompt", success: true });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working from the slow deterministic Pi" } });
      releaseTimer = setInterval(() => {
        if (settled || !existsSync(releasePath)) return;
        settled = true;
        clearInterval(releaseTimer);
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed deterministic result." }], stopReason: "stop" } });
        emit({ type: "agent_settled" });
      }, 25);
    }
  }
});
`);
  await chmod(fakePi, 0o755);
  const oldPiBin = process.env.PI_BIN;
  process.env.PI_BIN = fakePi;
  const port = await reservePort();
  const debugPorts = await Promise.all([reservePort(), reservePort()]);
  const desktopLaunches = [];
  let servicePid;
  const desktopOptions = {
    spawnImpl: (command, args, spawnOptions) => {
      assert.equal(spawnOptions?.detached, true, "the actual tracer must preserve the production Desktop detachment boundary");
      const launch = { command, port: debugPorts[desktopLaunches.length], spawnOptions };
      assert.ok(launch.port, "the tracer must reserve a debugger port for each production Desktop launch");
      launch.browser = spawn(command, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${launch.port}`,
        `--user-data-dir=${browserData}`,
        ...args,
      ], { ...spawnOptions, stdio: ["ignore", "ignore", "pipe"] });
      desktopLaunches.push(launch);
      return launch.browser;
    },
  };
  let firstDesktop;
  let secondDesktop;
  let firstLaunch;
  let secondLaunch;
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), "the lifetime tracer must begin without a Local Agent Service");
    firstLaunch = await launchProduct({
      port,
      dbPath,
      openBrowser: true,
      spawnImpl: (...args) => {
        const child = spawn(...args);
        servicePid = child.pid;
        return child;
      },
      openDesktopOptions: desktopOptions,
    });
    assert.equal(firstLaunch.started, true);
    assert.equal(desktopLaunches.length, 1);
    assert.equal(desktopLaunches[0].command, chromiumPath, "the tracer must use the production Chromium selection");
    firstDesktop = await connectDesktop({ ...desktopLaunches[0], url: `http://127.0.0.1:${port}` });
    await waitFor(() => firstDesktop.evaluate("document.querySelector('#connection').hidden === true"), "first production Desktop did not connect");

    const createAgent = async (name, workspace) => {
      await firstDesktop.evaluate(`(() => {
        document.querySelector('#new-chat').click();
        document.querySelector('#name').value = ${JSON.stringify(name)};
        document.querySelector('#workspace').value = ${JSON.stringify(workspace)};
        document.querySelector('#create').requestSubmit();
      })()`);
      await waitFor(() => firstDesktop.evaluate(`document.querySelectorAll('[data-agent-id]').length >= ${name === "A" ? 1 : 2}`), `${name} was not created through the production Desktop`);
    };
    await createAgent("A", workspaceA);
    await createAgent("B", workspaceB);

    const idFor = async (name) => firstDesktop.evaluate(`[...document.querySelectorAll('[data-agent-id]')].find((button) => button.textContent.includes(${JSON.stringify(name)}))?.dataset.agentId`);
    const selectAgent = async (name) => {
      const id = await idFor(name);
      await firstDesktop.evaluate(`document.querySelector('[data-agent-id="${id}"]').click()`);
      await waitFor(() => firstDesktop.evaluate(`document.querySelector('#agent-meta').textContent.startsWith(${JSON.stringify(name)})`), `${name} was not selected in the actual Desktop`);
      return id;
    };
    const setDraft = async (text) => firstDesktop.evaluate(`(() => {
      const input = document.querySelector('#message');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const draftPreview = async (name) => firstDesktop.evaluate(`[...document.querySelectorAll('[data-agent-id]')].find((button) => button.textContent.includes(${JSON.stringify(name)}))?.querySelector('small')?.textContent`);

    const agentAId = await selectAgent("A");
    await setDraft("Draft A before switching");
    await waitFor(() => draftPreview("A").then((preview) => preview === "Draft A before switching"), "A draft was not visible in the actual roster");
    const agentBId = await selectAgent("B");
    assert.equal(await firstDesktop.evaluate("document.querySelector('#message').value"), "", "B must not inherit A's draft");
    await setDraft("Draft B before returning");
    await waitFor(() => draftPreview("B").then((preview) => preview === "Draft B before returning"), "B draft was not visible in the actual roster");
    await selectAgent("A");
    assert.equal(await firstDesktop.evaluate("document.querySelector('#message').value"), "Draft A before switching");
    await selectAgent("B");
    assert.equal(await firstDesktop.evaluate("document.querySelector('#message').value"), "Draft B before returning");
    await selectAgent("A");

    await firstDesktop.evaluate(`(() => {
      const input = document.querySelector('#message');
      input.value = 'Slow deterministic request';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#send').requestSubmit();
    })()`);
    const serviceUrl = `http://127.0.0.1:${port}`;
    const getSnapshot = async () => (await fetch(`${serviceUrl}/api/agents/${agentAId}`)).json();
    await waitFor(async () => (await getSnapshot()).activeTurnId !== null, "the actual Desktop did not start the slow Turn");
    const turnBeforeClose = await getSnapshot();
    const turnId = turnBeforeClose.activeTurnId;
    await waitFor(async () => {
      const state = await desktopState(firstDesktop);
      return state.headerStatus === "Working" && state.messages.some((message) => message.text.includes("Working from the slow deterministic Pi"));
    }, "the actual Desktop did not show Working and streamed output");
    await firstDesktop.evaluate(`(() => {
      const input = document.querySelector('#message');
      input.value = 'Draft retained across Desktop close';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal((await desktopState(firstDesktop)).draft, "Draft retained across Desktop close");

    await waitFor(async () => {
      try { return Number((await readFile(workerPidPath, "utf8")).trim()) > 0; } catch { return false; }
    }, "the slow deterministic Pi worker did not start");
    const workerPid = Number((await readFile(workerPidPath, "utf8")).trim());
    assert.ok(processIsAlive(firstLaunch.pid), "the detached Local Agent Service must remain alive while the Desktop is open");
    await firstDesktop.close();
    firstDesktop = null;
    assert.ok(processIsAlive(firstLaunch.pid), "closing the Desktop must not stop the detached Local Agent Service");
    assert.ok(processIsAlive(workerPid), "closing the Desktop must not stop the Pi worker");
    const afterCloseHealth = await fetch(`${serviceUrl}/api/health`);
    assert.equal(afterCloseHealth.status, 200);
    const afterClose = await getSnapshot();
    assert.equal(afterClose.activeTurnId, turnId, "the active Turn must remain authoritative after Desktop close");

    secondLaunch = await launchProduct({ port, dbPath, openDesktopOptions: desktopOptions, openBrowser: true });
    assert.equal(secondLaunch.started, false, "the second product launch must reconnect to the existing service");
    assert.equal(secondLaunch.pid, null);
    assert.equal(desktopLaunches.length, 2, "the second product launch must open the actual Desktop");
    assert.equal(desktopLaunches[1].command, chromiumPath);
    secondDesktop = await connectDesktop({ ...desktopLaunches[1], url: serviceUrl });
    await waitFor(async () => {
      const state = await desktopState(secondDesktop);
      const snapshot = await getSnapshot();
      return state.selectedAgent === agentAId
        && state.draft === "Draft retained across Desktop close"
        && snapshot.turns.some((turn) => turn.id === turnId && ["running", "completed"].includes(turn.status));
    }, "the relaunched actual Desktop did not restore the selected Agent, draft, and same Turn");
    const duringReopen = await desktopState(secondDesktop);
    assert.ok(duringReopen.headerStatus === "Working" || duringReopen.status === "Turn completed.", "relaunch must show the active or authoritative terminal state");
    assert.equal(new Set(duringReopen.messages.map((message) => message.id)).size, duringReopen.messages.length);
    await writeFile(releasePath, "release");

    await waitFor(async () => (await getSnapshot()).turns.find((turn) => turn.id === turnId)?.status === "completed", "the background Turn did not settle");
    await waitFor(async () => (await desktopState(secondDesktop)).status === "Turn completed.", "the relaunched actual Desktop did not render the authoritative completion");
    const completedState = await desktopState(secondDesktop);
    assert.deepEqual(completedState.messages.map((message) => message.text), [
      "Slow deterministic request",
      "Completed deterministic result.",
    ]);
    assert.equal(new Set(completedState.messages.map((message) => message.id)).size, completedState.messages.length);
    const completedSnapshot = await getSnapshot();
    assert.deepEqual(completedSnapshot.messages.map((message) => message.content), [
      "Slow deterministic request",
      "Completed deterministic result.",
    ]);
    assert.equal(new Set(completedSnapshot.messages.map((message) => message.id)).size, completedSnapshot.messages.length);
    assert.equal(completedSnapshot.messages[0].role, "user");
    assert.equal(completedSnapshot.messages[1].role, "assistant");
    assert.notEqual(agentBId, agentAId);
  } finally {
    await firstDesktop?.close().catch(() => {});
    await secondDesktop?.close().catch(() => {});
    if (servicePid && processIsAlive(servicePid)) {
      try { process.kill(servicePid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitForProcessExit(servicePid).catch(() => {});
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
