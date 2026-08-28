import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";

function delayedPi({ onEvent, onClose }) {
  let release;
  return {
    prompt(message) {
      onEvent({ type: "session", id: "desktop-e2e-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Started: ${message}` } });
      release = () => {
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed after Desktop reconnect." }] } });
        onEvent({ type: "agent_end" });
        onClose({ code: 0, signal: null });
      };
    },
    abort() {},
    close() {},
    release() { release(); },
  };
}

async function json(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const value = await response.json();
  assert.ok(response.ok, value.error);
  return value;
}

async function openEvents(base, path) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let ended = false;
  const pump = (async () => {
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })();
  return { events, close: async () => { ended = true; await reader.cancel(); await pump; } };
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("Desktop HTTP/SSE journey closes during work and reconnects to one canonical result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-e2e-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: delayedPi });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await json(base, "/api/agents", { method: "POST", body: JSON.stringify({ name: "Acceptance", workspace: directory }) });
    const agentId = created.agent.id;
    const firstDesktop = await openEvents(base, `/api/agents/${agentId}/events`);
    await eventually(() => firstDesktop.events.some((event) => event.type === "snapshot"), "first Desktop did not receive its snapshot");

    const turn = await json(base, `/api/agents/${agentId}/turns`, { method: "POST", body: JSON.stringify({ message: "Keep working while I close the Desktop" }) });
    await eventually(() => firstDesktop.events.some((event) => event.type === "assistant_delta"), "Desktop did not receive streaming output");
    await firstDesktop.close(); // Closing the UI only drops its SSE connection.

    const whileClosed = await json(base, `/api/agents/${agentId}`);
    assert.equal(whileClosed.state, "active");
    assert.equal(whileClosed.activeTurnId, turn.id);
    assert.deepEqual(whileClosed.messages.map((message) => message.role), ["user", "assistant"]);

    const reopenedDesktop = await openEvents(base, `/api/agents/${agentId}/events`);
    await eventually(() => reopenedDesktop.events.some((event) => event.type === "snapshot"), "reopened Desktop did not receive a snapshot");
    const reconnectSnapshot = reopenedDesktop.events.find((event) => event.type === "snapshot").snapshot;
    assert.equal(reconnectSnapshot.activeTurnId, turn.id);
    assert.deepEqual(reconnectSnapshot.messages.map((message) => message.id), whileClosed.messages.map((message) => message.id));

    const execution = service.executions.get(turn.id);
    execution.release();
    await eventually(() => reopenedDesktop.events.some((event) => event.type === "turn_finished"), "reopened Desktop did not receive completion");
    await reopenedDesktop.close();

    const completed = await json(base, `/api/agents/${agentId}`);
    assert.equal(completed.turns[0].status, "completed");
    assert.equal(completed.state, "idle");
    assert.deepEqual(completed.messages.map((message) => message.content), ["Keep working while I close the Desktop", "Completed after Desktop reconnect."]);
    assert.equal(new Set(completed.messages.map((message) => message.id)).size, completed.messages.length);
  } finally {
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
