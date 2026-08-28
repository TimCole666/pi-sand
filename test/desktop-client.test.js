import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountDesktop } from "../public/app.js";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";

function eventually(predicate, message) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (++attempts === 100) { clearInterval(timer); reject(new Error(message)); }
    }, 5);
  });
}

class Element {
  constructor() { this.hidden = false; this.textContent = ""; this.className = ""; this.value = ""; this.options = []; this.innerHtml = ""; }
  set innerHTML(value) {
    this.innerHtml = value;
    if (this.isSelect) this.options = [...value.matchAll(/<option value="([^"]*)">/g)].map((match) => ({ value: match[1] }));
  }
  get innerHTML() { return this.innerHtml; }
}

function desktop({ base, storage = new Map() }) {
  const elements = Object.fromEntries(["setup", "conversation", "agent-meta", "messages", "status", "interrupt", "agents", "create", "send"].map((id) => [id, new Element()]));
  elements.agents.isSelect = true;
  elements.create.values = { name: "Agent", workspace: "" };
  elements.send.message = new Element();
  const sources = [];
  class EventSourceFake {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    deliver(snapshot) { this.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }); }
  }
  const client = mountDesktop({
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    fetchImpl: fetch,
    EventSourceImpl: EventSourceFake,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    alertImpl: (message) => { throw new Error(`Desktop alert: ${message}`); },
    FormDataImpl: class { constructor(form) { return new Map(Object.entries(form.values)); } },
    apiBase: base,
  });
  return { client, elements, sources, storage };
}

function completedPi({ onEvent, onClose }) {
  return {
    prompt(message) {
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
      setTimeout(() => {
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
        onEvent({ type: "agent_end" });
        onClose({ code: 0, signal: null });
      }, 5);
    },
    abort() {}, close() {},
  };
}

function controlledPi({ onEvent, onClose }) {
  let release;
  return {
    prompt(message) { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } }); release = () => { onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done later." }] } }); onEvent({ type: "agent_end" }); onClose({ code: 0, signal: null }); }; },
    abort() { onClose({ code: 0, signal: null }); }, close() {}, release() { release?.(); },
  };
}

function crashingPi({ onEvent, onClose }) {
  return { prompt() { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial response" } }); onClose({ code: null, signal: "SIGKILL" }); }, abort() {}, close() {} };
}

async function withDesktop(fn, piFactory = completedPi) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-client-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn({ service, base: `http://127.0.0.1:${server.address().port}`, directory }); }
  finally { service.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}

async function createAndSend(view, directory, message = "Fix the failing tests") {
  await view.client.ready;
  view.elements.create.values = { name: "Desktop Agent", workspace: directory };
  await view.elements.create.onsubmit({ preventDefault() {}, target: view.elements.create });
  await eventually(() => view.sources.length === 1, "Desktop did not open its event stream");
  view.elements.send.message.value = message;
  await view.elements.send.onsubmit({ preventDefault() {}, target: view.elements.send });
  return view.storage.get("pi-sand-agent");
}

test("Desktop creates, opens, sends, streams, and renders a completed Turn", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory);
  await eventually(() => service.getAgent(agentId).turns[0]?.status === "completed", "Turn did not complete");
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.match(view.elements.messages.innerHTML, /Fix the failing tests/);
  assert.match(view.elements.messages.innerHTML, /Done\./);
  assert.equal(view.elements.status.textContent, "Turn completed.");
  assert.equal(view.elements.interrupt.hidden, true);
}));

test("Desktop restart reopens a completed durable transcript and terminal state", async () => withDesktop(async ({ service, base, directory }) => {
  const storage = new Map();
  const first = desktop({ base, storage });
  const agentId = await createAndSend(first, directory);
  await eventually(() => service.getAgent(agentId).turns[0]?.status === "completed", "Turn did not complete");
  const reopened = desktop({ base, storage });
  await reopened.client.ready;
  await eventually(() => reopened.sources.length === 1, "reopened Desktop did not load remembered Agent");
  assert.match(reopened.elements.messages.innerHTML, /Done\./);
  assert.equal(reopened.elements.status.textContent, "Turn completed.");
}));

test("Desktop close during work reconnects to the same active Turn and one result", async () => withDesktop(async ({ service, base, directory }) => {
  const storage = new Map();
  const first = desktop({ base, storage });
  const agentId = await createAndSend(first, directory, "Keep working");
  first.sources[0].close();
  assert.equal(service.getAgent(agentId).state, "active");
  const reopened = desktop({ base, storage });
  await reopened.client.ready;
  await eventually(() => reopened.sources.length === 1, "reopened Desktop did not load active Agent");
  assert.equal(reopened.elements.status.textContent, "Pi is working…");
  service.executions.get(service.getAgent(agentId).activeTurnId).release();
  reopened.sources[0].deliver(service.getAgent(agentId));
  assert.equal(reopened.elements.status.textContent, "Turn completed.");
  assert.equal((reopened.elements.messages.innerHTML.match(/class="message/g) ?? []).length, 2);
}, controlledPi));

test("Desktop interrupt renders the durable interruption explanation", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory, "Stop this work");
  await view.elements.interrupt.onclick();
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.equal(view.elements.status.textContent, "Turn interrupted: The Turn was interrupted by the user.");
  assert.equal(view.elements.interrupt.hidden, true);
}, controlledPi));

test("Desktop renders unexpected Pi exit as a durable failed Turn", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory, "Fail this work");
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.equal(view.elements.status.textContent, "Turn failed: Pi exited with SIGKILL");
  assert.equal(view.elements.status.className, "error");
}, crashingPi));
