import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountDesktop } from "../public/app.js";
import { createAgentServer } from "../src/server.js";
import { AgentService } from "../src/service.js";

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class Element {
  constructor() { this.hidden = false; this.textContent = ""; this.className = ""; this.value = ""; this.options = []; this.innerHtml = ""; }
  set innerHTML(value) {
    this.innerHtml = value;
    if (this.isSelect) this.options = [...value.matchAll(/<option value="([^"]*)">/g)].map((match) => ({ value: match[1] }));
  }
  get innerHTML() { return this.innerHtml; }
}

class FetchEventSource {
  constructor(url) {
    this.controller = new AbortController();
    this.open(url);
  }

  async open(url) {
    try {
      const response = await fetch(url, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`SSE request failed: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (data) this.onmessage?.({ data: data.slice(6) });
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.onerror?.(error);
    }
  }

  close() { this.controller.abort(); }
}

function publicDesktop({ base, storage }) {
  const elements = Object.fromEntries(["setup", "conversation", "agent-meta", "messages", "status", "interrupt", "agents", "create", "send"].map((id) => [id, new Element()]));
  elements.agents.isSelect = true;
  elements.create.values = { name: "Agent", workspace: "" };
  elements.send.message = new Element();
  const desktop = mountDesktop({
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    fetchImpl: fetch,
    EventSourceImpl: FetchEventSource,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    alertImpl: (message) => { throw new Error(`Desktop alert: ${message}`); },
    FormDataImpl: class { constructor(form) { return new Map(Object.entries(form.values)); } },
    apiBase: base,
  });
  return { desktop, elements };
}

function controlledPiFactory(controls) {
  return ({ onEvent, onClose }) => {
    let stopped = false;
    const execution = {
      prompt({ message }) {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
      },
      release() {
        if (stopped) return;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed result." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      abort() {
        if (stopped) return;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped result." }], stopReason: "aborted" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      crash() {
        if (stopped) return;
        onClose({ code: null, signal: "SIGKILL" });
      },
      close() { stopped = true; },
    };
    controls.push(execution);
    return execution;
  };
}

async function withPublicDesktopServer(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-public-desktop-e2e-"));
  const controls = [];
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: controlledPiFactory(controls) });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const desktops = [];
  const storage = new Map();
  const base = `http://127.0.0.1:${server.address().port}`;
  const openDesktop = () => {
    const view = publicDesktop({ base, storage });
    desktops.push(view);
    return view;
  };
  try { await fn({ controls, directory, openDesktop, service }); }
  finally {
    desktops.forEach((view) => view.desktop.destroy());
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function createAndSend(view, directory, message = "Fix the failing tests") {
  await view.desktop.ready;
  view.elements.create.values = { name: "Public Desktop Agent", workspace: directory };
  await view.elements.create.onsubmit({ preventDefault() {}, target: view.elements.create });
  view.elements.send.message.value = message;
  await view.elements.send.onsubmit({ preventDefault() {}, target: view.elements.send });
}

test("public Desktop E2E: create, send, stream, and complete", async () => withPublicDesktopServer(async ({ controls, directory, openDesktop }) => {
  const view = openDesktop();
  await createAndSend(view, directory);
  await eventually(() => view.elements.status.textContent === "Pi is working…" && /Working: Fix the failing tests/.test(view.elements.messages.innerHTML), "Desktop did not render its real SSE stream");
  controls[0].release();
  await eventually(() => view.elements.status.textContent === "Turn completed.", "Desktop did not render completion from real SSE");
  assert.equal((view.elements.messages.innerHTML.match(/class="message/g) ?? []).length, 2);
  assert.equal((view.elements.messages.innerHTML.match(/Completed result\./g) ?? []).length, 1);
}));

test("public Desktop E2E: durable transcript restores after Desktop restart", async () => withPublicDesktopServer(async ({ controls, directory, openDesktop }) => {
  const first = openDesktop();
  await createAndSend(first, directory);
  controls[0].release();
  await eventually(() => first.elements.status.textContent === "Turn completed.", "first Desktop did not complete");
  first.desktop.destroy();

  const reopened = openDesktop();
  await reopened.desktop.ready;
  await eventually(() => reopened.elements.status.textContent === "Turn completed." && /Completed result\./.test(reopened.elements.messages.innerHTML), "reopened Desktop did not restore the durable transcript");
  assert.equal((reopened.elements.messages.innerHTML.match(/class="message/g) ?? []).length, 2);
}));

test("public Desktop E2E: closing during work reconnects to the same result", async () => withPublicDesktopServer(async ({ controls, directory, openDesktop, service }) => {
  const first = openDesktop();
  await createAndSend(first, directory, "Keep working");
  await eventually(() => first.elements.status.textContent === "Pi is working…", "first Desktop did not show active work");
  first.desktop.destroy();
  assert.equal(service.listAgents().length, 1);
  assert.equal(service.getAgent(service.listAgents()[0].id).state, "active");

  const reopened = openDesktop();
  await reopened.desktop.ready;
  await eventually(() => reopened.elements.status.textContent === "Pi is working…", "reopened Desktop did not reconnect to the active Turn");
  controls[0].release();
  await eventually(() => reopened.elements.status.textContent === "Turn completed.", "reopened Desktop did not render completion");
  assert.equal((reopened.elements.messages.innerHTML.match(/Completed result\./g) ?? []).length, 1);
}));

test("public Desktop E2E: interrupt reaches one stable visible interruption", async () => withPublicDesktopServer(async ({ directory, openDesktop }) => {
  const view = openDesktop();
  await createAndSend(view, directory, "Stop this work");
  await eventually(() => view.elements.interrupt.hidden === false, "Desktop did not show an interrupt action");
  await view.elements.interrupt.onclick();
  await eventually(() => view.elements.status.textContent === "Turn interrupted: The Turn was interrupted by the user.", "Desktop did not render interrupted settlement");
  assert.match(view.elements.messages.innerHTML, /Stopped result\./);
  assert.equal(view.elements.interrupt.hidden, true);
}));

test("public Desktop E2E: unexpected Pi exit reaches visible failure", async () => withPublicDesktopServer(async ({ controls, directory, openDesktop }) => {
  const view = openDesktop();
  await createAndSend(view, directory, "Fail this work");
  await eventually(() => /Working: Fail this work/.test(view.elements.messages.innerHTML), "Desktop did not render streaming content before failure");
  controls[0].crash();
  await eventually(() => view.elements.status.textContent === "Turn failed: Pi exited with SIGKILL", "Desktop did not render Pi failure");
  assert.equal(view.elements.status.className, "error");
}));
