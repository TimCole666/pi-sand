import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";

const CHROMIUM = "/usr/bin/chromium";
const supportedDesktop = existsSync(CHROMIUM);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function launchChromium(url, profilePath) {
  const child = spawn(CHROMIUM, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    url,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let debugging;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    debugging ??= stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
  });

  const port = await eventually(() => debugging, "Chromium did not expose its DevTools endpoint");
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl && page.url.startsWith(url));
  }, "Chromium did not expose a page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextCommand = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function command(method, params = {}) {
    const id = ++nextCommand;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => {
        pending.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
    });
  }

  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "browser evaluation failed");
    if (result.result?.subtype === "error") throw new Error(result.result.description || "browser evaluation failed");
    return result.result?.value;
  }

  await eventually(() => evaluate('Boolean(document.querySelector("#setup"))'), "Chromium did not render the Desktop shell");

  return {
    child,
    evaluate,
    close() {
      socket.close();
      child.kill("SIGTERM");
      return waitForClose(child);
    },
  };
}

function slowPiFactory(control) {
  return ({ onEvent, onClose }) => {
    let stopped = false;
    const execution = {
      prompt({ message }) {
        onEvent({ type: "session", id: "desktop-process-session" });
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
      },
      release() {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed after Desktop reopen." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      abort() { stopped = true; onClose({ code: 0, signal: null }); },
      close() { stopped = true; },
    };
    control.execution = execution;
    return execution;
  };
}

async function browserState(browser) {
  return browser.evaluate(`({
    status: document.querySelector("#status")?.textContent || "",
    headerStatus: document.querySelector("#header-status")?.textContent || "",
    draft: document.querySelector("#message")?.value || "",
    messages: [...document.querySelectorAll("#messages .message")].map((element) => ({ id: element.dataset.id, text: element.textContent })),
    selectedAgent: localStorage.getItem("pi-sand-agent"),
  })`);
}

test("supported Desktop process closes and reopens around one active service Turn", { skip: !supportedDesktop }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-process-"));
  const profile = join(directory, "chromium-profile");
  const control = {};
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: slowPiFactory(control) });
  const server = createAgentServer(service);
  const base = await listen(server);
  let firstDesktop;
  let reopenedDesktop;
  try {
    firstDesktop = await launchChromium(base, profile);
    await eventually(() => firstDesktop.evaluate('document.readyState === "complete"'), "Desktop did not load the product shell");
    await eventually(() => firstDesktop.evaluate('Boolean(document.querySelector("#name"))'), "Desktop did not render the Agent creation form");
    await firstDesktop.evaluate(`(() => {
      document.querySelector("#name").value = "Process Agent";
      document.querySelector("#workspace").value = ${JSON.stringify(directory)};
      document.querySelector("#create").requestSubmit();
    })()`);
    const agent = await eventually(() => service.listAgents()[0], "Desktop did not create an Agent");
    await eventually(() => firstDesktop.evaluate(`localStorage.getItem("pi-sand-agent") === ${JSON.stringify(agent.id)}`), "Desktop did not select the new Agent");

    await firstDesktop.evaluate(`(() => {
      const input = document.querySelector("#message");
      input.value = "Keep this Turn running";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#send").requestSubmit();
    })()`);
    const turn = await eventually(() => service.getAgent(agent.id).turns[0], "Desktop did not start a Turn");
    await eventually(async () => (await browserState(firstDesktop)).headerStatus === "Working", "Desktop did not render Working");
    await eventually(async () => (await browserState(firstDesktop)).messages.some((message) => message.text.includes("Working: Keep this Turn running")), "Desktop did not render streamed output");

    // The draft is Desktop-owned presentation state, independent from the active Turn.
    await firstDesktop.evaluate(`(() => {
      const input = document.querySelector("#message");
      input.value = "Unsent draft survives Desktop restart";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const beforeClose = await browserState(firstDesktop);
    assert.equal(beforeClose.selectedAgent, agent.id);
    assert.equal(beforeClose.draft, "Unsent draft survives Desktop restart");

    await firstDesktop.close();
    firstDesktop = null;
    assert.equal(service.getAgent(agent.id).activeTurnId, turn.id, "closing the Desktop must not stop the Turn");
    assert.equal(service.getAgent(agent.id).state, "active");
    assert.ok(control.execution, "the service must retain the Pi execution after Desktop close");

    reopenedDesktop = await launchChromium(base, profile);
    await eventually(async () => {
      const state = await browserState(reopenedDesktop);
      return state.headerStatus === "Working" && state.selectedAgent === agent.id && state.draft === "Unsent draft survives Desktop restart";
    }, "reopened Desktop did not restore active state, selection, and draft");
    const duringReopen = await browserState(reopenedDesktop);
    assert.equal(duringReopen.messages.filter((message) => message.text.includes("Working: Keep this Turn running")).length, 1);
    assert.deepEqual(duringReopen.messages.map((message) => message.id), [
      ...new Set(duringReopen.messages.map((message) => message.id)),
    ], "reconnect must not duplicate message identities");

    control.execution.release();
    await eventually(async () => (await browserState(reopenedDesktop)).status === "Turn completed.", "reopened Desktop did not render completion");
    const completed = await browserState(reopenedDesktop);
    assert.deepEqual(completed.messages.map((message) => message.text), [
      "Keep this Turn running",
      "Completed after Desktop reopen.",
    ]);
    assert.equal(new Set(completed.messages.map((message) => message.id)).size, completed.messages.length);
  } finally {
    if (firstDesktop) await firstDesktop.close().catch(() => {});
    if (reopenedDesktop) await reopenedDesktop.close().catch(() => {});
    service.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});
