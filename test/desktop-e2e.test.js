import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";

function delayedPi({ onEvent, onClose }) {
  let release;
  return {
    prompt({ message }) {
      onEvent({ type: "session", id: "desktop-e2e-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Started: ${message}` } });
      release = () => {
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed after Desktop reconnect." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
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

test("two Desktop connections reconnect independently while their separate workspace Turns run concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-desktop-parallel-e2e-"));
  const workspaceA = join(directory, "workspace-a");
  const workspaceB = join(directory, "workspace-b");
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: delayedPi });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let firstA;
  let firstB;
  let reopenedA;
  let reopenedB;
  try {
    const agentA = await json(base, "/api/agents", { method: "POST", body: JSON.stringify({ name: "A", workspace: workspaceA }) });
    const agentB = await json(base, "/api/agents", { method: "POST", body: JSON.stringify({ name: "B", workspace: workspaceB }) });
    firstA = await openEvents(base, `/api/agents/${agentA.agent.id}/events`);
    firstB = await openEvents(base, `/api/agents/${agentB.agent.id}/events`);
    const turnA = await json(base, `/api/agents/${agentA.agent.id}/turns`, { method: "POST", body: JSON.stringify({ message: "A keeps working" }) });
    const turnB = await json(base, `/api/agents/${agentB.agent.id}/turns`, { method: "POST", body: JSON.stringify({ message: "B keeps working" }) });
    await eventually(() => firstA.events.some((event) => event.type === "assistant_delta") && firstB.events.some((event) => event.type === "assistant_delta"), "both Desktops did not observe their independent active Turns");

    await Promise.all([firstA.close(), firstB.close()]);
    assert.equal((await json(base, `/api/agents/${agentA.agent.id}`)).activeTurnId, turnA.id);
    assert.equal((await json(base, `/api/agents/${agentB.agent.id}`)).activeTurnId, turnB.id);

    reopenedA = await openEvents(base, `/api/agents/${agentA.agent.id}/events`);
    reopenedB = await openEvents(base, `/api/agents/${agentB.agent.id}/events`);
    await eventually(
      () => reopenedA.events.some((event) => event.type === "snapshot" && event.snapshot.activeTurnId === turnA.id)
        && reopenedB.events.some((event) => event.type === "snapshot" && event.snapshot.activeTurnId === turnB.id),
      "each reconnected Desktop did not receive its own active Turn",
    );

    service.executions.get(turnA.id).release();
    await eventually(() => reopenedA.events.some((event) => event.type === "turn_finished"), "reconnected Desktop A did not observe completion");
    assert.equal((await json(base, `/api/agents/${agentB.agent.id}`)).activeTurnId, turnB.id);

    service.executions.get(turnB.id).release();
    await eventually(() => reopenedB.events.some((event) => event.type === "turn_finished"), "reconnected Desktop B did not observe completion");
  } finally {
    await Promise.allSettled([firstA?.close(), firstB?.close(), reopenedA?.close(), reopenedB?.close()]);
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
