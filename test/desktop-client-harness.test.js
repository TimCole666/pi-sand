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

const mountedClients = new Set();

class Element {
  constructor() { this.hidden = false; this.textContent = ""; this.className = ""; this.value = ""; this.options = []; this.innerHtml = ""; this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    return Promise.all((this.listeners.get(event.type) ?? []).map((listener) => listener(event)));
  }
  focus() {}
  set innerHTML(value) {
    this.innerHtml = value;
    if (this.isSelect) this.options = [...value.matchAll(/<option value="([^"]*)">/g)].map((match) => ({ value: match[1] }));
  }
  get innerHTML() { return this.innerHtml; }
}

class FormDataFake {
  constructor(form) { this.entries = form?.values ? Object.entries(form.values) : []; }
  append(name, value, filename) { this.entries.push([name, value, filename]); }
  get(name) { return this.entries.find(([key]) => key === name)?.[1]; }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
}

function desktop({ base, storage = new Map(), fetchImpl = fetch }) {
  const elements = Object.fromEntries(["setup", "conversation", "agent-meta", "header-status", "messages", "status", "interrupt", "agents", "agent-list", "empty-state", "connection", "retry", "new-chat", "name", "workspace", "message", "create", "send", "send-submit", "attachments", "attachment-feedback", "pick-file", "file-input"].map((id) => [id, new Element()]));
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
    fetchImpl,
    EventSourceImpl: EventSourceFake,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    alertImpl: (message) => { throw new Error(`Desktop alert: ${message}`); },
    FormDataImpl: FormDataFake,
    apiBase: base,
  });
  mountedClients.add(client);
  return { client, elements, sources, storage };
}

function completedPi({ onEvent, onClose }) {
  return {
    prompt({ message }) {
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
      setTimeout(() => {
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      }, 5);
    },
    abort() {}, close() {},
  };
}

function controlledPi({ onEvent, onClose }) {
  let release;
  return {
    prompt({ message }) { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } }); release = () => { onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done later." }], stopReason: "stop" } }); onEvent({ type: "agent_end" }); onEvent({ type: "agent_settled" }); onClose({ code: 0, signal: null }); }; },
    abort() { onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped." }], stopReason: "aborted" } }); onEvent({ type: "agent_end" }); onEvent({ type: "agent_settled" }); onClose({ code: 0, signal: null }); }, close() {}, release() { release?.(); },
  };
}

function crashingPi({ onEvent, onClose }) {
  return { prompt() { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial response" } }); onClose({ code: null, signal: "SIGKILL" }); }, abort() {}, close() {} };
}

function dormantPi() {
  return { prompt() {}, abort() {}, close() {} };
}

function deferred() {
  let resolve;
  const promise = new Promise((result) => { resolve = result; });
  return { promise, resolve };
}

function jsonResponse(value, ok = true) {
  return { ok, json: async () => value };
}

async function withDesktop(fn, piFactory = completedPi) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-client-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn({ service, base: `http://127.0.0.1:${server.address().port}`, directory }); }
  finally {
    for (const client of mountedClients) client.destroy();
    mountedClients.clear();
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
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

test("New chat reveals the durable Agent creation form", async () => withDesktop(async ({ base }) => {
  const view = desktop({ base });
  await view.client.ready;
  assert.equal(view.elements.create.hidden, true);
  view.elements["new-chat"].dispatchEvent({ type: "click" });
  assert.equal(view.elements.create.hidden, false);
}));

test("Desktop client harness creates, opens, sends, streams, and renders a completed Turn", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory);
  await eventually(() => service.getAgent(agentId).turns[0]?.status === "completed", "Turn did not complete");
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.match(view.elements.messages.innerHTML, /Fix the failing tests/);
  assert.match(view.elements.messages.innerHTML, /Done\./);
  assert.equal(view.elements.status.textContent, "Turn completed.");
  assert.equal(view.elements.interrupt.hidden, true);
  assert.match(view.elements["agent-list"].innerHTML, /Done\./, "roster preview should reflect the latest durable assistant message");
}));

test("Desktop client harness reopens a completed durable transcript and terminal state", async () => withDesktop(async ({ service, base, directory }) => {
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

test("Desktop client harness reconnects to the same active Turn and one result", async () => withDesktop(async ({ service, base, directory }) => {
  const storage = new Map();
  const first = desktop({ base, storage });
  const agentId = await createAndSend(first, directory, "Keep working");
  first.sources[0].deliver(service.getAgent(agentId));
  assert.match(first.elements.messages.innerHTML, /Working: Keep working/);
  assert.equal(first.elements["header-status"].textContent, "Working");
  assert.equal(first.elements.status.textContent, "");
  first.sources[0].close();
  assert.equal(service.getAgent(agentId).state, "active");
  const reopened = desktop({ base, storage });
  await reopened.client.ready;
  await eventually(() => reopened.sources.length === 1, "reopened Desktop did not load active Agent");
  assert.equal(reopened.elements["header-status"].textContent, "Working");
  assert.equal(reopened.elements.status.textContent, "");
  service.turnExecutions.get(service.getAgent(agentId).activeTurnId).release();
  reopened.sources[0].deliver(service.getAgent(agentId));
  assert.equal(reopened.elements.status.textContent, "Turn completed.");
  assert.match(reopened.elements.messages.innerHTML, /Done later\./);
  assert.equal((reopened.elements.messages.innerHTML.match(/Done later\./g) ?? []).length, 1);
  assert.equal((reopened.elements.messages.innerHTML.match(/class="message/g) ?? []).length, 2);
}, controlledPi));

test("Desktop client harness renders the durable interruption explanation", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory, "Stop this work");
  await view.elements.interrupt.onclick();
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.equal(view.elements.status.textContent, "Turn interrupted: The Turn was interrupted by the user.");
  assert.equal(view.elements.interrupt.hidden, true);
}, controlledPi));

test("Desktop client harness keeps independent drafts across Agent switching and restart", async () => withDesktop(async ({ base, directory }) => {
  const storage = new Map();
  const first = desktop({ base, storage });
  await first.client.ready;

  first.elements.create.values = { name: "Alpha", workspace: directory };
  await first.elements.create.onsubmit({ preventDefault() {}, target: first.elements.create });
  const alphaId = storage.get("pi-sand-agent");
  first.elements.send.message.value = "Alpha draft";
  first.elements.send.message.dispatchEvent({ type: "input" });

  first.elements.create.values = { name: "Beta", workspace: directory };
  await first.elements.create.onsubmit({ preventDefault() {}, target: first.elements.create });
  first.elements.send.message.value = "Beta draft";
  first.elements.send.message.dispatchEvent({ type: "input" });

  first.elements.agents.value = alphaId;
  await first.elements.agents.onchange({ target: first.elements.agents });
  assert.equal(first.elements.send.message.value, "Alpha draft");
  assert.match(first.elements["agent-list"].innerHTML, /Alpha draft/);
  assert.match(first.elements["agent-list"].innerHTML, /Beta draft/);

  const reopened = desktop({ base, storage });
  await reopened.client.ready;
  assert.equal(storage.get("pi-sand-agent"), alphaId);
  assert.equal(reopened.elements.send.message.value, "Alpha draft");
  assert.match(reopened.elements["agent-list"].innerHTML, /Beta draft/);

  storage.set("pi-sand-agent", "missing-agent");
  const fallback = desktop({ base, storage });
  await fallback.client.ready;
  assert.equal(storage.get("pi-sand-agent"), alphaId);
}, completedPi));

test("Desktop client harness renders unexpected Pi exit as a durable failed Turn", async () => withDesktop(async ({ service, base, directory }) => {
  const view = desktop({ base });
  const agentId = await createAndSend(view, directory, "Fail this work");
  view.sources.at(-1).deliver(service.getAgent(agentId));
  assert.equal(view.elements.status.textContent, "Turn failed: Pi exited with SIGKILL");
  assert.equal(view.elements.status.className, "error");
}, crashingPi));

test("Desktop client keeps a delayed Send bound to its initiating Agent", async () => withDesktop(async ({ service, base, directory }) => {
  const agentA = service.createAgent({ name: "A", workspace: directory });
  const agentB = service.createAgent({ name: "B", workspace: directory });
  const attachmentA = service.stageAttachment(agentA.agent.id, { filename: "a.txt", bytes: Buffer.from("A attachment") });
  const attachmentB = service.stageAttachment(agentB.agent.id, { filename: "b.txt", bytes: Buffer.from("B attachment") });
  const storage = new Map([
    ["pi-sand-agent", agentA.agent.id],
    ["pi-sand-drafts", JSON.stringify({
      [agentA.agent.id]: { text: "send A", attachments: [{ id: attachmentA.id, filename: attachmentA.filename }] },
      [agentB.agent.id]: { text: "keep B", attachments: [{ id: attachmentB.id, filename: attachmentB.filename }] },
    })],
  ]);
  const sendResponse = deferred();
  const view = desktop({
    base,
    storage,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith(`/api/agents/${agentA.agent.id}/turns`)) await sendResponse.promise;
      return response;
    },
  });
  await view.client.ready;
  const send = view.elements.send.onsubmit({ preventDefault() {}, target: view.elements.send });
  await eventually(() => service.getAgent(agentA.agent.id).activeTurnId !== null, "A Send did not reach the service");
  await view.client.openAgent(agentB.agent.id);
  const beforeB = JSON.stringify(JSON.parse(storage.get("pi-sand-drafts"))[agentB.agent.id]);
  assert.equal(view.elements.send.message.value, "keep B");
  sendResponse.resolve();
  await send;

  const afterDrafts = JSON.parse(storage.get("pi-sand-drafts") ?? "{}");
  assert.equal(JSON.stringify(afterDrafts[agentB.agent.id]), beforeB, "A completion must not alter B's text or attachments");
  assert.equal(view.elements.send.message.value, "keep B");
  assert.equal(afterDrafts[agentA.agent.id], undefined, "the sent A draft must be cleared");
  const sent = service.getAgent(agentA.agent.id);
  assert.equal(sent.messages[0].content, "send A");
  assert.deepEqual(sent.messages[0].attachments.map((attachment) => attachment.id), [attachmentA.id]);
  assert.equal(service.attachmentSnapshot(attachmentA.id).state, "committed");
}, dormantPi));

test("Desktop client keeps delayed attachment staging bound to its initiating Agent", async () => withDesktop(async ({ service, base, directory }) => {
  const agentA = service.createAgent({ name: "A", workspace: directory });
  const agentB = service.createAgent({ name: "B", workspace: directory });
  const attachmentB = service.stageAttachment(agentB.agent.id, { filename: "b.txt", bytes: Buffer.from("B attachment") });
  const storage = new Map([
    ["pi-sand-agent", agentA.agent.id],
    ["pi-sand-drafts", JSON.stringify({
      [agentB.agent.id]: { text: "keep B", attachments: [{ id: attachmentB.id, filename: attachmentB.filename }] },
    })],
  ]);
  const stageResponse = deferred();
  let stageStarted = false;
  const view = desktop({
    base,
    storage,
    fetchImpl: async (url, options) => {
      if (url === `${base}/api/agents/${agentA.agent.id}/attachments`) {
        stageStarted = true;
        await stageResponse.promise;
        const file = options.body.get("file");
        const attachment = service.stageAttachment(agentA.agent.id, { filename: file.name, bytes: Buffer.from(file.contents) });
        return jsonResponse({ attachment });
      }
      return fetch(url, options);
    },
  });
  await view.client.ready;
  const stage = view.elements["file-input"].dispatchEvent({
    type: "change",
    target: { files: [{ name: "a.txt", size: 1, contents: "A attachment" }], value: "" },
  });
  await eventually(() => stageStarted, "A attachment staging did not start");
  await view.client.openAgent(agentB.agent.id);
  const beforeB = JSON.stringify(JSON.parse(storage.get("pi-sand-drafts"))[agentB.agent.id]);
  stageResponse.resolve();
  await stage;

  const afterDrafts = JSON.parse(storage.get("pi-sand-drafts") ?? "{}");
  assert.equal(JSON.stringify(afterDrafts[agentB.agent.id]), beforeB, "A staging completion must not alter B's draft");
  assert.equal(view.elements.send.message.value, "keep B");
  assert.doesNotMatch(view.elements.attachments.innerHTML, /a\.txt/);
  const aDraft = afterDrafts[agentA.agent.id];
  assert.deepEqual(aDraft.attachments.map((attachment) => attachment.filename), ["a.txt"]);
}, dormantPi));

test("Desktop client preserves a staged attachment completed during reconciliation", async () => withDesktop(async ({ service, base, directory }) => {
  const agentA = service.createAgent({ name: "A", workspace: directory });
  const agentB = service.createAgent({ name: "B", workspace: directory });
  const existing = service.stageAttachment(agentA.agent.id, { filename: "existing.txt", bytes: Buffer.from("existing") });
  const storage = new Map([
    ["pi-sand-agent", agentA.agent.id],
    ["pi-sand-drafts", JSON.stringify({
      [agentA.agent.id]: { text: "draft A", attachments: [{ id: existing.id, filename: existing.filename }] },
    })],
  ]);
  const stageResponse = deferred();
  const reconciliationResponse = deferred();
  let stageStarted = false;
  let attachmentReads = 0;
  let reconciliationStarted = false;
  const view = desktop({
    base,
    storage,
    fetchImpl: async (url, options) => {
      if (url === `${base}/api/agents/${agentA.agent.id}/attachments` && options?.method === undefined) {
        attachmentReads += 1;
        const response = await fetch(url, options);
        if (attachmentReads === 2) {
          reconciliationStarted = true;
          await reconciliationResponse.promise;
        }
        return response;
      }
      if (url === `${base}/api/agents/${agentA.agent.id}/attachments` && options?.method === "POST") {
        stageStarted = true;
        await stageResponse.promise;
        const file = options.body.get("file");
        const attachment = service.stageAttachment(agentA.agent.id, { filename: file.name, bytes: Buffer.from(file.contents) });
        return jsonResponse({ attachment });
      }
      return fetch(url, options);
    },
  });
  await view.client.ready;
  const stage = view.elements["file-input"].dispatchEvent({ type: "change", target: { files: [{ name: "staged-during-reconcile.txt", size: 1, contents: "new" }], value: "" } });
  await eventually(() => stageStarted, "the attachment staging operation did not start");
  await view.client.openAgent(agentB.agent.id);
  const reopenA = view.client.openAgent(agentA.agent.id);
  await eventually(() => reconciliationStarted, "the second Agent attachment reconciliation did not start");
  stageResponse.resolve();
  await stage;
  reconciliationResponse.resolve();
  await reopenA;

  const draft = JSON.parse(storage.get("pi-sand-drafts"))[agentA.agent.id];
  assert.deepEqual(draft.attachments.map((attachment) => attachment.filename), ["existing.txt", "staged-during-reconcile.txt"]);
}, dormantPi));

test("Desktop client merges overlapping attachment staging results for one Agent", async () => withDesktop(async ({ service, base, directory }) => {
  const agent = service.createAgent({ name: "A", workspace: directory });
  const storage = new Map([["pi-sand-agent", agent.agent.id]]);
  const pending = [];
  const view = desktop({
    base,
    storage,
    fetchImpl: async (url, options) => {
      if (url === `${base}/api/agents/${agent.agent.id}/attachments`) {
        const file = options.body.get("file");
        const gate = deferred();
        pending.push({ file, gate });
        await gate.promise;
        const attachment = service.stageAttachment(agent.agent.id, { filename: file.name, bytes: Buffer.from(file.contents) });
        return jsonResponse({ attachment });
      }
      return fetch(url, options);
    },
  });
  await view.client.ready;
  const first = view.elements["file-input"].dispatchEvent({ type: "change", target: { files: [{ name: "one.txt", size: 1, contents: "one" }], value: "" } });
  const second = view.elements["file-input"].dispatchEvent({ type: "change", target: { files: [{ name: "two.txt", size: 1, contents: "two" }], value: "" } });
  await eventually(() => pending.length === 2, "overlapping attachment staging did not start twice");
  pending[1].gate.resolve();
  pending[0].gate.resolve();
  await Promise.all([first, second]);

  const draft = JSON.parse(storage.get("pi-sand-drafts"))[agent.agent.id];
  assert.deepEqual(draft.attachments.map((attachment) => attachment.filename).sort(), ["one.txt", "two.txt"]);
  assert.match(view.elements.attachments.innerHTML, /one\.txt/);
  assert.match(view.elements.attachments.innerHTML, /two\.txt/);
}, dormantPi));

test("Desktop client enforces the attachment limit after overlapping uploads", async () => withDesktop(async ({ service, base, directory }) => {
  const agent = service.createAgent({ name: "A", workspace: directory });
  const existing = [];
  for (let index = 0; index < 5; index += 1) existing.push(service.stageAttachment(agent.agent.id, { filename: `existing-${index}.txt`, bytes: Buffer.from(String(index)) }));
  const storage = new Map([
    ["pi-sand-agent", agent.agent.id],
    ["pi-sand-drafts", JSON.stringify({
      [agent.agent.id]: { text: "", attachments: existing.map((attachment) => ({ id: attachment.id, filename: attachment.filename })) },
    })],
  ]);
  const pending = [];
  const view = desktop({
    base,
    storage,
    fetchImpl: async (url, options) => {
      if (url === `${base}/api/agents/${agent.agent.id}/attachments` && options?.method === "POST") {
        const file = options.body.get("file");
        const gate = deferred();
        pending.push({ file, gate });
        await gate.promise;
        const attachment = service.stageAttachment(agent.agent.id, { filename: file.name, bytes: Buffer.from(file.contents) });
        return jsonResponse({ attachment });
      }
      return fetch(url, options);
    },
  });
  await view.client.ready;
  const first = view.elements["file-input"].dispatchEvent({ type: "change", target: { files: [{ name: "sixth-a.txt", size: 1, contents: "a" }], value: "" } });
  const second = view.elements["file-input"].dispatchEvent({ type: "change", target: { files: [{ name: "sixth-b.txt", size: 1, contents: "b" }], value: "" } });
  await eventually(() => pending.length === 2, "overlapping limit-boundary staging did not start twice");
  pending[1].gate.resolve();
  pending[0].gate.resolve();
  await Promise.all([first, second]);

  const draft = JSON.parse(storage.get("pi-sand-drafts"))[agent.agent.id];
  assert.equal(draft.attachments.length, 6);
  assert.equal(draft.attachments.some((attachment) => attachment.filename === "sixth-b.txt"), true);
  assert.equal(draft.attachments.some((attachment) => attachment.filename === "sixth-a.txt"), false);
  assert.equal(service.listAttachments(agent.agent.id).length, 6);
}, dormantPi));

test("Desktop client ignores stale out-of-order Agent selection and events", async () => withDesktop(async ({ service, base, directory }) => {
  const agentA = service.createAgent({ name: "A", workspace: directory });
  const agentB = service.createAgent({ name: "B", workspace: directory });
  const pending = new Map([
    [agentA.agent.id, deferred()],
    [agentB.agent.id, deferred()],
  ]);
  const started = new Set();
  const view = desktop({
    base,
    storage: new Map([["pi-sand-agent", agentA.agent.id]]),
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      const id = [agentA.agent.id, agentB.agent.id].find((candidate) => url === `${base}/api/agents/${candidate}`);
      if (id) {
        started.add(id);
        await pending.get(id).promise;
      }
      return response;
    },
  });
  await eventually(() => started.has(agentA.agent.id), "selection setup failed");
  const selectB = view.client.openAgent(agentB.agent.id);
  await eventually(() => started.has(agentB.agent.id), "B selection did not start");
  pending.get(agentB.agent.id).resolve();
  await selectB;
  assert.match(view.elements["agent-meta"].textContent, /^B ·/);
  assert.equal(view.storage.get("pi-sand-agent"), agentB.agent.id);
  assert.deepEqual(view.sources.filter((source) => !source.closed).map((source) => source.url), [`${base}/api/agents/${agentB.agent.id}/events`]);

  pending.get(agentA.agent.id).resolve();
  await view.client.ready;
  assert.match(view.elements["agent-meta"].textContent, /^B ·/);
  assert.equal(view.storage.get("pi-sand-agent"), agentB.agent.id);
  assert.deepEqual(view.sources.filter((source) => !source.closed).map((source) => source.url), [`${base}/api/agents/${agentB.agent.id}/events`]);
  await view.client.openAgent(agentA.agent.id);
  const staleSource = view.sources.at(-1);
  const latestSelection = view.client.openAgent(agentB.agent.id);
  staleSource.deliver(service.getAgent(agentA.agent.id));
  await latestSelection;
  assert.match(view.elements["agent-meta"].textContent, /^B ·/);
  assert.equal(view.storage.get("pi-sand-agent"), agentB.agent.id);
  assert.deepEqual(view.sources.filter((source) => !source.closed).map((source) => source.url), [`${base}/api/agents/${agentB.agent.id}/events`]);
  view.sources.at(-1).deliver(service.getAgent(agentA.agent.id));
  assert.match(view.elements["agent-meta"].textContent, /^B ·/, "a stale Agent event must not render A");
}, dormantPi));

test("Desktop client keeps Interrupt bound to its initiating Agent and Turn", async () => withDesktop(async ({ service, base, directory }) => {
  const agentA = service.createAgent({ name: "A", workspace: directory });
  const agentB = service.createAgent({ name: "B", workspace: directory });
  const pendingRead = deferred();
  let delayInterruptRead = false;
  let readStarted = false;
  const view = desktop({
    base,
    storage: new Map([["pi-sand-agent", agentA.agent.id]]),
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (delayInterruptRead && url === `${base}/api/agents/${agentA.agent.id}` && options?.method === undefined) {
        readStarted = true;
        await pendingRead.promise;
      }
      return response;
    },
  });
  await view.client.ready;
  view.elements.send.message.value = "A work";
  await view.elements.send.onsubmit({ preventDefault() {}, target: view.elements.send });
  await eventually(() => service.getAgent(agentA.agent.id).activeTurnId !== null, "A Turn did not start");
  const turnId = service.getAgent(agentA.agent.id).activeTurnId;
  delayInterruptRead = true;
  const interrupt = view.elements.interrupt.onclick();
  await eventually(() => readStarted, "the preliminary Interrupt read did not start");
  await view.client.openAgent(agentB.agent.id);
  pendingRead.resolve();
  await interrupt;
  assert.equal(service.getAgent(agentA.agent.id).turns.find((turn) => turn.id === turnId).status, "interrupted");
  assert.equal(service.getAgent(agentB.agent.id).turns.length, 0);
}, controlledPi));
