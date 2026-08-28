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

function longRunningFakePi({ onEvent, onClose }) {
  let stopped = false;
  let release;
  return {
    prompt(message) {
      onEvent({ type: "session", id: "long-running-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Started: ${message}` } });
      release = () => {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished after reconnect." }] } });
        onEvent({ type: "agent_end" });
        onClose({ code: 0, signal: null });
      };
    },
    abort() { stopped = true; onClose({ code: 0, signal: null }); },
    close() { stopped = true; },
    release() { release?.(); },
  };
}

async function withService(fn, piFactory = fakePi) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-test-"));
  const path = join(directory, "state.sqlite");
  const service = new AgentService({ dbPath: path, piFactory });
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

test("a reconnect observes the same active Turn and later completion without transcript duplication", async () => {
  let execution;
  const piFactory = (options) => {
    execution = longRunningFakePi(options);
    return execution;
  };
  await withService(async (service) => {
    const created = service.createAgent({ name: "Long task", workspace: "/tmp/project" });
    const firstUpdates = [];
    const unsubscribe = service.subscribe(created.agent.id, (event) => firstUpdates.push(event));
    const turn = service.sendMessage(created.agent.id, "Work while the desktop is closed");
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();

    const disconnected = service.getAgent(created.agent.id);
    assert.equal(disconnected.activeTurnId, turn.id);
    assert.equal(disconnected.state, "active");
    assert.deepEqual(disconnected.messages.map((message) => message.role), ["user", "assistant"]);

    // A reopened desktop takes this authoritative snapshot, then subscribes
    // for updates. The service-owned execution was never interrupted.
    const reopened = service.getAgent(created.agent.id);
    const reconnectUpdates = [];
    const unsubscribeReconnect = service.subscribe(created.agent.id, (event) => reconnectUpdates.push(event));
    assert.equal(reopened.activeTurnId, turn.id);
    assert.equal(reopened.messages.length, 2);
    execution.release();
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribeReconnect();

    const completed = service.getAgent(created.agent.id);
    assert.equal(completed.state, "idle");
    assert.equal(completed.turns[0].status, "completed");
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.messages[1].content, "Finished after reconnect.");
    assert.ok(firstUpdates.some((event) => event.type === "turn_started"));
    assert.ok(reconnectUpdates.some((event) => event.type === "turn_finished"));
    assert.equal(new Set(completed.messages.map((message) => message.id)).size, completed.messages.length);
  }, piFactory);
});

test("interrupt preserves the durable transcript and settles a running Turn once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-interrupt-"));
  const path = join(directory, "state.sqlite");
  try {
    const first = new AgentService({ dbPath: path, piFactory: fakePi });
    const agent = first.createAgent({ name: "Interruptible", workspace: "/tmp/project" });
    const updates = [];
    const unsubscribe = first.subscribe(agent.agent.id, (event) => updates.push(event));
    const turn = first.sendMessage(agent.agent.id, "Stop this work");
    first.interrupt(agent.agent.id, turn.id);
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();

    const interrupted = first.getAgent(agent.agent.id);
    assert.equal(interrupted.state, "idle");
    assert.equal(interrupted.turns[0].status, "interrupted");
    assert.equal(interrupted.turns[0].terminalDetail, "The Turn was interrupted by the user.");
    assert.deepEqual(interrupted.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(interrupted.messages[1].content, "Stopped.");
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
    assert.equal(updates.find((event) => event.type === "turn_finished").status, "interrupted");
    first.close();

    const reopened = new AgentService({ dbPath: path, piFactory: fakePi });
    const restored = reopened.getAgent(agent.agent.id);
    assert.equal(restored.turns[0].status, "interrupted");
    assert.equal(restored.turns[0].terminalDetail, "The Turn was interrupted by the user.");
    assert.equal(restored.messages.length, 2);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("interrupt wins its completion race without a second terminal update", async () => {
  let execution;
  const piFactory = ({ onEvent, onClose }) => {
    execution = {
      prompt() { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } }); },
      abort() { onClose({ code: 0, signal: null }); },
      close() {},
      completeLate() { onEvent({ type: "agent_end" }); onClose({ code: 0, signal: null }); },
    };
    return execution;
  };
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp/project" });
    const updates = [];
    const unsubscribe = service.subscribe(agent.agent.id, (event) => updates.push(event));
    const turn = service.sendMessage(agent.agent.id, "Do work");
    service.interrupt(agent.agent.id, turn.id);
    execution.completeLate();
    unsubscribe();

    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "interrupted");
    assert.equal(snapshot.messages[1].content, "Working");
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
  }, piFactory);
});

test("an unexpected Pi exit during streaming fails one Turn and preserves its transcript", async () => {
  let factoryCalls = 0;
  const piFactory = (options) => {
    factoryCalls += 1;
    if (factoryCalls > 1) return fakePi(options);
    const { onEvent, onClose } = options;
    let closed = false;
    return {
      prompt() {
        onEvent({ type: "session", id: "crashing-session" });
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } });
        setImmediate(() => {
          onClose({ code: null, signal: "SIGKILL" });
          // A child can surface more than one close-adjacent notification. The
          // service must keep the first terminal outcome authoritative.
          onClose({ code: null, signal: "SIGKILL" });
        });
      },
      abort() {},
      close() { closed = true; },
      get closed() { return closed; },
    };
  };
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-failure-"));
  const path = join(directory, "state.sqlite");
  try {
    const first = new AgentService({ dbPath: path, piFactory });
    const agent = first.createAgent({ name: "Failure case", workspace: "/tmp/project" });
    const updates = [];
    const unsubscribe = first.subscribe(agent.agent.id, (event) => updates.push(event));
    const turn = first.sendMessage(agent.agent.id, "Start a long task");
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();

    const failed = first.getAgent(agent.agent.id);
    assert.equal(failed.state, "idle");
    assert.equal(failed.activeTurnId, null);
    assert.equal(failed.turns[0].status, "failed");
    assert.equal(failed.turns[0].terminalDetail, "Pi exited with SIGKILL");
    assert.ok(failed.turns[0].finishedAt);
    assert.deepEqual(failed.messages.map((message) => message.content), ["Start a long task", "Partial answer"]);
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
    assert.equal(updates.find((event) => event.type === "turn_finished")?.status, "failed");
    first.close();

    const reopened = new AgentService({ dbPath: path, piFactory });
    const restored = reopened.getAgent(agent.agent.id);
    assert.equal(restored.turns[0].status, "failed");
    assert.equal(restored.turns[0].terminalDetail, "Pi exited with SIGKILL");
    assert.deepEqual(restored.messages.map((message) => message.content), ["Start a long task", "Partial answer"]);

    const nextTurn = reopened.sendMessage(agent.agent.id, "Try again");
    assert.equal(nextTurn.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reopened.getAgent(agent.agent.id).turns.map((savedTurn) => savedTurn.status), ["failed", "completed"]);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});


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

test("service restart interrupts persisted running work without replay and accepts a later Turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-unfinished-restart-"));
  const path = join(directory, "state.sqlite");
  let starts = 0;
  const dormantPi = () => ({ prompt() { starts += 1; }, abort() {}, close() {} });
  try {
    const first = new AgentService({ dbPath: path, piFactory: dormantPi });
    const agent = first.createAgent({ name: "Restarted", workspace: "/tmp/project" });
    const unfinished = first.sendMessage(agent.agent.id, "Do not replay this request");
    assert.equal(starts, 1);
    first.close();

    const second = new AgentService({ dbPath: path, piFactory: fakePi });
    const restored = second.getAgent(agent.agent.id);
    assert.equal(starts, 1, "restart must not adopt or replay the previous execution");
    assert.equal(restored.agent.workspace, "/tmp/project");
    assert.equal(restored.state, "idle");
    assert.equal(restored.activeTurnId, null);
    assert.equal(restored.turns[0].id, unfinished.id);
    assert.equal(restored.turns[0].status, "interrupted");
    assert.equal(restored.turns[0].terminalDetail, "The Local Agent Service restarted before Pi finished. The unfinished work was not resumed.");
    assert.ok(restored.turns[0].finishedAt);
    assert.deepEqual(restored.messages.map((message) => message.content), ["Do not replay this request"]);

    second.sendMessage(agent.agent.id, "Start a new request");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterNewTurn = second.getAgent(agent.agent.id);
    assert.deepEqual(afterNewTurn.turns.map((turn) => turn.status), ["interrupted", "completed"]);
    assert.deepEqual(afterNewTurn.messages.map((message) => message.content), ["Do not replay this request", "Start a new request", "Done."]);
    assert.equal(new Set(afterNewTurn.messages.map((message) => message.id)).size, afterNewTurn.messages.length);
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v0.1 permits only one active workflow across durable Agents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-single-workflow-"));
  const path = join(directory, "state.sqlite");
  const dormantPi = ({ onClose }) => ({ prompt() {}, abort() { onClose({ code: 0, signal: null }); }, close() {} });
  const service = new AgentService({ dbPath: path, piFactory: dormantPi });
  try {
    const first = service.createAgent({ name: "First", workspace: "/tmp/one" });
    const second = service.createAgent({ name: "Second", workspace: "/tmp/two" });
    service.sendMessage(first.agent.id, "Run the only active workflow");
    assert.throws(() => service.sendMessage(second.agent.id, "This must wait"), /only one active workflow/);
    service.interrupt(first.agent.id, service.getAgent(first.agent.id).activeTurnId);
    service.sendMessage(second.agent.id, "This can start after interruption");
    assert.equal(service.getAgent(second.agent.id).state, "active");
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
