import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/service.js";

function fakePi({ onEvent, onClose }) {
  let stopped = false;
  let timer;
  return {
    prompt(message) {
      onEvent({ type: "session", id: "fake-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working on: ${message}` } });
      timer = setTimeout(() => { if (!stopped) { onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } }); onEvent({ type: "agent_end" }); onClose({ code: 0, signal: null }); } }, 5);
    },
    abort() { stopped = true; clearTimeout(timer); onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped." }], stopReason: "aborted" } }); onEvent({ type: "agent_end" }); onClose({ code: 0, signal: null }); },
    close() { stopped = true; clearTimeout(timer); },
  };
}

async function withService(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-test-"));
  const path = join(directory, "state.sqlite");
  const service = new AgentService({ dbPath: path, piFactory: fakePi });
  try { await fn(service, path); } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("creates an Agent and persists a complete user/assistant conversation", async () => withService(async (service, path) => {
  const created = service.createAgent({ name: "Project", workspace: "/tmp/project" });
  assert.equal(created.agent.name, "Project");
  const turn = service.sendMessage(created.agent.id, "Fix the failing tests");
  assert.equal(turn.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = service.getAgent(created.agent.id);
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.turns[0].status, "completed");
  assert.deepEqual(snapshot.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(snapshot.messages[1].content, "Done.");
  assert.equal(snapshot.messages[1].turnId, snapshot.turns[0].id);
  assert.ok(path.endsWith("state.sqlite"));
}));

test("streams updates through the semantic service subscription", async () => withService(async (service) => {
  const created = service.createAgent({ workspace: "/tmp/project" });
  const updates = [];
  const unsubscribe = service.subscribe(created.agent.id, (event) => updates.push(event));
  service.sendMessage(created.agent.id, "Inspect the project");
  await new Promise((resolve) => setTimeout(resolve, 20));
  unsubscribe();
  assert.ok(updates.some((event) => event.type === "assistant_delta"));
  assert.ok(updates.some((event) => event.type === "turn_finished" && event.status === "completed"));
  assert.equal(new Set(updates.flatMap((e) => e.snapshot.messages.map((m) => m.id))).size, updates.at(-1).snapshot.messages.length);
}));

test("reopening the service restores completed Agent, Turn, and transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-restart-"));
  const path = join(directory, "state.sqlite");
  try {
    const first = new AgentService({ dbPath: path, piFactory: fakePi });
    const agent = first.createAgent({ name: "Persisted", workspace: "/tmp/project" });
    first.sendMessage(agent.agent.id, "Make a change");
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.close();
    const second = new AgentService({ dbPath: path, piFactory: fakePi });
    const restored = second.getAgent(agent.agent.id);
    assert.equal(restored.agent.workspace, "/tmp/project");
    assert.equal(restored.turns[0].status, "completed");
    assert.equal(restored.messages.length, 2);
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
