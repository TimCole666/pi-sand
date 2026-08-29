import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
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
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`, url,
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
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "browser evaluation failed");
    if (result.result?.subtype === "error") throw new Error(result.result.description || "browser evaluation failed");
    return result.result?.value;
  }
  await eventually(() => evaluate('Boolean(document.querySelector("#setup"))'), "Chromium did not render the Desktop shell");
  return {
    child,
    command,
    evaluate,
    async setFileInput(path) {
      const document = await command("DOM.getDocument");
      const node = await command("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#file-input" });
      await command("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] });
    },
    async close() {
      socket.close();
      child.kill("SIGTERM");
      return waitForClose(child);
    },
  };
}

function attachmentPi(capture) {
  return ({ onEvent, onClose }) => ({
    prompt({ message }) {
      capture.push(message);
      const paths = [...message.matchAll(/- [^:]+: (.+)$/gm)].map((match) => match[1]);
      const contents = paths.map((path) => readFileSync(path, "utf8")).join(" | ");
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Read attachment: ${contents}` } });
      onEvent({ type: "message_end", message: { role: "assistant", content: `Read attachment: ${contents}`, stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      onClose({ code: 0, signal: null });
    },
    abort() {},
    close() {},
  });
}

async function browserState(browser) {
  return browser.evaluate(`({
    draft: document.querySelector("#message")?.value || "",
    chips: [...document.querySelectorAll("#attachments .attachment-chip")].map((element) => element.textContent.trim()),
    messages: [...document.querySelectorAll("#messages .message")].map((element) => element.textContent.trim()),
    status: document.querySelector("#status")?.textContent || "",
    feedback: document.querySelector("#attachment-feedback")?.textContent || "",
    selectedAgent: localStorage.getItem("pi-sand-agent"),
  })`);
}

test("Actual Chromium Desktop picker, drop, and paste inputs share one durable pipeline", { skip: !supportedDesktop }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-attachment-"));
  const profile = join(directory, "chromium-profile");
  const file = join(directory, "notes.txt");
  const prompts = [];
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: attachmentPi(prompts) });
  const server = createAgentServer(service);
  const base = await listen(server);
  let browser;
  try {
    await writeFile(file, "attachment survives restart");
    browser = await launchChromium(base, profile);
    await eventually(() => browser.evaluate('Boolean(document.querySelector("#name"))'), "Desktop did not render Agent creation controls");
    await browser.evaluate(`(() => {
      document.querySelector("#name").value = "Attachment Agent";
      document.querySelector("#workspace").value = ${JSON.stringify(directory)};
      document.querySelector("#create").requestSubmit();
    })()`);
    const agent = await eventually(() => service.listAgents()[0], "Desktop did not create an Agent");
    await eventually(() => browser.evaluate(`localStorage.getItem("pi-sand-agent") === ${JSON.stringify(agent.id)}`), "Desktop did not select the new Agent");

    await browser.setFileInput(file);
    await eventually(async () => (await browserState(browser)).chips.length === 1, "Desktop did not render staged picker attachment");
    await browser.evaluate(`(() => {
      const target = document.querySelector("#send");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["drop survives restart"], "drop.txt", { type: "text/plain" }));
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
    })()`);
    await eventually(async () => (await browserState(browser)).chips.length === 2, "Desktop did not render staged drop attachment");
    await browser.evaluate(`(() => {
      const target = document.querySelector("#send");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["paste survives restart"], "paste.txt", { type: "text/plain" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      target.dispatchEvent(event);
    })()`);
    await eventually(async () => (await browserState(browser)).chips.length === 3, "Desktop did not render staged pasted attachment");
    await browser.evaluate(`(() => {
      const target = document.querySelector("#send");
      const transfer = new DataTransfer();
      for (let i = 0; i < 4; i += 1) transfer.items.add(new File(["too many"], "extra-" + i + ".txt"));
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
    })()`);
    await eventually(async () => (await browserState(browser)).feedback.includes("up to 6"), "Desktop did not show deterministic attachment count feedback");
    const beforeRemove = await browserState(browser);
    assert.deepEqual(beforeRemove.chips, ["notes.txt ×", "drop.txt ×", "paste.txt ×"]);
    await browser.evaluate("document.querySelector('#attachments .attachment-chip button').click()");
    await eventually(async () => (await browserState(browser)).chips.length === 2, "Desktop did not remove the selected draft attachment");
    assert.equal(service.db.prepare("SELECT state FROM attachments WHERE filename = 'notes.txt'").get().state, "released");
    await browser.evaluate(`(() => {
      const target = document.querySelector("#send");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["replacement survives restart"], "replacement.txt", { type: "text/plain" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      target.dispatchEvent(event);
    })()`);
    await eventually(async () => (await browserState(browser)).chips.length === 3, "Desktop did not stage a replacement pasted attachment");
    await browser.evaluate(`(() => {
      const input = document.querySelector("#message");
      input.value = "Read the attached notes";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const beforeClose = await browserState(browser);
    assert.equal(beforeClose.draft, "Read the attached notes");
    assert.deepEqual(beforeClose.chips, ["drop.txt ×", "paste.txt ×", "replacement.txt ×"]);
    const staged = service.db.prepare("SELECT id, state, storage_path AS storagePath FROM attachments WHERE state = 'staged' ORDER BY filename").all();
    assert.equal(staged.length, 3);
    assert.ok(staged.every((attachment) => readFileSync(attachment.storagePath, "utf8").includes("survives restart")));

    await browser.close();
    browser = null;
    browser = await launchChromium(base, profile);
    await eventually(async () => {
      const state = await browserState(browser);
      return state.selectedAgent === agent.id && state.draft === "Read the attached notes" && state.chips.length === 3;
    }, "reopened Desktop did not restore the live attachment draft");

    await browser.evaluate('document.querySelector("#send").requestSubmit()');
    await eventually(() => service.getAgent(agent.id).turns[0]?.status === "completed", "attachment Turn did not complete");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /drop\.txt/);
    assert.match(prompts[0], /paste\.txt/);
    assert.match(prompts[0], /replacement\.txt/);
    const committed = service.getAgent(agent.id);
    assert.deepEqual(committed.messages[0].attachments.map((attachment) => attachment.filename), ["drop.txt", "paste.txt", "replacement.txt"]);
    const attachmentRows = service.db.prepare("SELECT id, state FROM attachments WHERE state = 'committed'").all();
    assert.equal(attachmentRows.length, 3);
    assert.ok(attachmentRows.every((attachment) => service.attachmentSnapshot(attachment.id).state === "committed"));
    await eventually(async () => (await browserState(browser)).messages.some((message) => message.includes("Read attachment: drop survives restart")), "Desktop did not render the attachment result");

    await browser.close();
    browser = null;
    browser = await launchChromium(base, profile);
    await eventually(async () => {
      const messages = (await browserState(browser)).messages;
      return messages.some((message) => message.includes("📎 drop.txt"))
        && messages.some((message) => message.includes("📎 paste.txt"))
        && messages.some((message) => message.includes("📎 replacement.txt"));
    }, "reopened transcript did not retain the sent attachments");
  } finally {
    if (browser) await browser.close().catch(() => {});
    service.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});
