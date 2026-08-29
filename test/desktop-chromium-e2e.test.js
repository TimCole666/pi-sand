import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { AgentService } from "../src/service.js";
import { locateChromium, openDesktop } from "../src/launcher.js";
import { createAgentServer } from "../src/server.js";

const CHROMIUM = (() => {
  try { return locateChromium(); } catch { return null; }
})();
const supportedDesktop = Boolean(CHROMIUM) && typeof WebSocket === "function";

async function eventually(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

class DevTools {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
      this.socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      };
      this.socket.onclose = () => {
        for (const pending of this.pending.values()) pending.reject(new Error("Chromium DevTools connection closed"));
        this.pending.clear();
      };
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Desktop evaluation failed");
    return result.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function waitForDevToolsPort(directory, child) {
  const path = join(directory, "DevToolsActivePort");
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error("Chromium exited before opening DevTools");
    try { return (await readFile(path, "utf8")).trim().length > 0; } catch { return false; }
  }, "Chromium did not publish a DevTools endpoint");
  return Number((await readFile(path, "utf8")).split("\n", 1)[0]);
}

async function startChromium(url, agentId) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-chromium-profile-"));
  let browserCommand;
  const child = openDesktop(url, {
    spawnImpl: (command, args, spawnOptions) => {
      browserCommand = command;
      return spawn(command, [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
        `--user-data-dir=${directory}`, ...args,
      ], { ...spawnOptions, stdio: ["ignore", "ignore", "ignore"] });
    },
  });
  assert.equal(browserCommand, CHROMIUM);
  const port = await waitForDevToolsPort(directory, child);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((item) => item.type === "page");
  assert.ok(page?.webSocketDebuggerUrl, "Chromium did not expose a page target");
  const desktop = new DevTools(page.webSocketDebuggerUrl);
  await desktop.connect();
  await desktop.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem("pi-sand-agent", ${JSON.stringify(agentId)});`,
  });
  await desktop.send("Page.navigate", { url });
  await eventually(
    () => desktop.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#agent-meta')?.textContent)"),
    "Chromium did not render the selected Agent",
  );
  desktop.shutdown = async () => {
    desktop.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await once(child, "close").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };
  return desktop;
}

function controlledPi(controls) {
  return ({ onEvent, onClose }) => {
    let closed = false;
    const execution = {
      prompt({ message }) {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working on: ${message}` } });
      },
      release() {
        if (closed) return;
        closed = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed result." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      crash() {
        if (closed) return;
        closed = true;
        onClose({ code: null, signal: "SIGKILL" });
      },
      abort() {},
      close() { closed = true; },
    };
    controls.push(execution);
    return execution;
  };
}

async function withDesktop(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-chromium-"));
  const controls = [];
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: controlledPi(controls) });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = service.createAgent({ name: "Chromium Agent", workspace: directory });
  const base = `http://127.0.0.1:${server.address().port}`;
  let desktop;
  try {
    desktop = await startChromium(base, agent.agent.id);
    await fn({ desktop, controls, service });
  } finally {
    await desktop?.shutdown();
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("Actual Chromium Desktop sends a request, streams, settles, and disables a second Send", { skip: !supportedDesktop }, async () => withDesktop(async ({ desktop, controls, service }) => {
  await eventually(() => desktop.evaluate("Boolean(document.querySelector('#message')?.value === '')"), "Desktop composer did not load");
  await desktop.evaluate(`(() => { const input = document.querySelector('#message'); input.value = 'Fix the failing tests'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').requestSubmit(); })()`);
  await eventually(() => controls.length === 1, "Desktop did not submit a Turn");
  await eventually(() => desktop.evaluate("document.querySelector('#header-status')?.textContent === 'Working'"), "Desktop did not show Working in the conversation header");
  assert.equal(await desktop.evaluate("document.querySelector('#send-submit')?.disabled"), true);
  assert.equal(service.getAgent(service.listAgents()[0].id).turns.length, 1);

  controls[0].release();
  await eventually(() => desktop.evaluate("document.querySelector('#status')?.textContent === 'Turn completed.'"), "Desktop did not show completion");
  const messages = await desktop.evaluate("document.querySelector('#messages')?.textContent");
  assert.match(messages, /Fix the failing tests/);
  assert.match(messages, /Completed result\./);
}));

test("Actual Chromium Desktop renders a classified Pi failure instead of raw process output", { skip: !supportedDesktop }, async () => withDesktop(async ({ desktop, controls }) => {
  await desktop.evaluate(`(() => { const input = document.querySelector('#message'); input.value = 'Run the failing task'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').requestSubmit(); })()`);
  await eventually(() => controls.length === 1, "Desktop did not submit the failure Turn");
  controls[0].crash();
  await eventually(() => desktop.evaluate("document.querySelector('#status')?.textContent === 'Turn failed: Pi exited with SIGKILL'"), "Desktop did not classify the Pi failure");
  assert.equal(await desktop.evaluate("document.querySelector('#status')?.className"), "error");
  assert.match(await desktop.evaluate("document.querySelector('#messages')?.textContent"), /Working on: Run the failing task/);
}));
