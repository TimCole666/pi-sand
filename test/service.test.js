import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentService, defaultDatabasePath } from "../src/service.js";

function fakePi({ onEvent, onClose }) {
  let stopped = false;
  let timer;
  return {
    prompt({ message }) {
      onEvent({ type: "session", id: "fake-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working on: ${message}` } });
      timer = setTimeout(() => { if (!stopped) { onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } }); onEvent({ type: "agent_end" }); onEvent({ type: "agent_settled" }); onClose({ code: 0, signal: null }); } }, 5);
    },
    abort() { stopped = true; clearTimeout(timer); onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped." }], stopReason: "aborted" } }); onEvent({ type: "agent_end" }); onEvent({ type: "agent_settled" }); onClose({ code: 0, signal: null }); },
    close() { stopped = true; clearTimeout(timer); },
  };
}

function longRunningFakePi({ onEvent, onClose }) {
  let stopped = false;
  let release;
  return {
    prompt({ message }) {
      onEvent({ type: "session", id: "long-running-session" });
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Started: ${message}` } });
      release = () => {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished after reconnect." }], stopReason: "stop" } });
        onEvent({ type: "agent_end" });
        onEvent({ type: "agent_settled" });
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

test("defaults local persistence to XDG data and honors PI_SAND_DB", async () => {
  const oldDataHome = process.env.XDG_DATA_HOME;
  const oldDatabase = process.env.PI_SAND_DB;
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-storage-"));
  const override = join(directory, "override.sqlite");
  try {
    process.env.XDG_DATA_HOME = join(directory, "xdg-data");
    delete process.env.PI_SAND_DB;
    assert.equal(defaultDatabasePath(), join(directory, "xdg-data", "pi-sand", "pi-sand.sqlite"));
    process.env.PI_SAND_DB = override;
    const service = new AgentService({ piFactory: fakePi });
    service.close();
    await assert.doesNotReject(stat(override));
  } finally {
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldDatabase === undefined) delete process.env.PI_SAND_DB;
    else process.env.PI_SAND_DB = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates an Agent and persists a complete user/assistant conversation", async () => withService(async (service, path) => {
  const created = service.createAgent({ name: "Project", workspace: "/tmp" });
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
  const created = service.createAgent({ workspace: "/tmp" });
  const updates = [];
  const unsubscribe = service.subscribe(created.agent.id, (event) => updates.push(event));
  service.sendMessage(created.agent.id, "Inspect the project");
  await new Promise((resolve) => setTimeout(resolve, 20));
  unsubscribe();
  assert.ok(updates.some((event) => event.type === "assistant_delta"));
  assert.ok(updates.some((event) => event.type === "turn_finished" && event.status === "completed"));
  assert.equal(new Set(updates.flatMap((e) => e.snapshot.messages.map((m) => m.id))).size, updates.at(-1).snapshot.messages.length);
}));

test("same-Agent follow-up reuses one Pi-native session without replaying the durable transcript", async () => {
  const prompts = [];
  let factoryCalls = 0;
  const piFactory = ({ onEvent }) => {
    factoryCalls += 1;
    return {
      prompt({ message }) {
        prompts.push(message);
        onEvent({ type: "session", id: "native-session" });
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Streaming ${message}` } });
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Answer to ${message}` }], stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
      },
      abort() {},
      close() {},
    };
  };

  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const first = service.sendMessage(agent.agent.id, "Remember the codeword BLUE.");
    const second = service.sendMessage(agent.agent.id, "Use the codeword from our previous turn to continue.");

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(factoryCalls, 1, "follow-up must use the same live Pi RPC session");
    assert.deepEqual(prompts, [
      "Remember the codeword BLUE.",
      "Use the codeword from our previous turn to continue.",
    ], "pi-sand sends only the new user prompt, not a transcript replay");
    const snapshot = service.getAgent(agent.agent.id);
    assert.deepEqual(snapshot.turns.map((turn) => turn.piSessionId), ["native-session", "native-session"]);
    assert.deepEqual(snapshot.messages.map((message) => message.content), [
      "Remember the codeword BLUE.",
      "Answer to Remember the codeword BLUE.",
      "Use the codeword from our previous turn to continue.",
      "Answer to Use the codeword from our previous turn to continue.",
    ]);
  }, piFactory);
});

test("agent_end leaves a Turn running until agent_settled and then finishes exactly once", async () => {
  let execution;
  const piFactory = ({ onEvent, onClose }) => {
    let closed = false;
    execution = {
      prompt() {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "First attempt." } });
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First attempt." }], stopReason: "stop" } });
        onEvent({ type: "agent_end", willRetry: true });
      },
      finishRetry() {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " Final result." } });
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final result." }], stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      close() { closed = true; },
      get closed() { return closed; },
    };
    return execution;
  };
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const updates = [];
    const unsubscribe = service.subscribe(agent.agent.id, (event) => updates.push(event));
    const turn = service.sendMessage(agent.agent.id, "Continue if Pi decides to retry");

    assert.equal(service.getAgent(agent.agent.id).turns[0].status, "running");
    assert.equal(service.getAgent(agent.agent.id).activeTurnId, turn.id);
    assert.equal(execution.closed, false);
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 0);

    execution.finishRetry();
    unsubscribe();
    const settled = service.getAgent(agent.agent.id);
    assert.equal(settled.turns[0].status, "completed");
    assert.equal(settled.messages[1].content, "Final result.");
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
  }, piFactory);
});

test("a rejected Pi prompt fails one Turn without waiting for process close", async () => {
  const piFactory = ({ onEvent, onClose }) => ({
    prompt({ id }) {
      onEvent({ type: "response", id, command: "prompt", success: false, error: "workspace is unavailable" });
      onEvent({ type: "agent_settled" });
      onClose({ code: 1, signal: null });
    },
    abort() {}, close() {},
  });
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const updates = [];
    const unsubscribe = service.subscribe(agent.agent.id, (event) => updates.push(event));
    service.sendMessage(agent.agent.id, "Start work");
    unsubscribe();

    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.state, "idle");
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.turns[0].terminalDetail, "Pi rejected the prompt: workspace is unavailable");
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
  }, piFactory);
});

test("an unavailable Pi executable becomes an understandable product failure", async () => {
  const piFactory = ({ onClose }) => ({
    prompt() { onClose({ error: Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }) }); },
    abort() {},
    close() {},
  });
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    service.sendMessage(agent.agent.id, "Start work");
    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.turns[0].terminalDetail, "Pi is unavailable or incompatible with the required lifecycle contract.");
    assert.doesNotMatch(snapshot.turns[0].terminalDetail, /spawn pi|ENOENT/);
  }, piFactory);
});

test("Stop plus a settled assistant error is failed and keeps the partial transcript", async () => {
  const piFactory = ({ onEvent }) => ({
    prompt() {
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } });
    },
    abort() {
      onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason: "error", errorMessage: "upstream timeout" } });
      onEvent({ type: "agent_settled" });
    },
    close() {},
  });
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const turn = service.sendMessage(agent.agent.id, "Stop while the provider is failing");
    service.interrupt(agent.agent.id, turn.id);
    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.turns[0].terminalDetail, "Pi assistant error: upstream timeout");
    assert.deepEqual(snapshot.messages.map((message) => message.content), [
      "Stop while the provider is failing",
      "Partial answer",
    ]);
  }, piFactory);
});

test("the production Pi preflight rejects an incompatible lifecycle version before creating a Turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-pi-preflight-"));
  const binary = join(directory, "incompatible-pi");
  const oldPiBin = process.env.PI_BIN;
  await writeFile(binary, "#!/bin/sh\nprintf '0.84.1\\n'\n");
  await chmod(binary, 0o755);
  process.env.PI_BIN = binary;
  const service = new AgentService({ dbPath: join(directory, "state.sqlite") });
  try {
    const agent = service.createAgent({ workspace: directory });
    assert.throws(
      () => service.sendMessage(agent.agent.id, "This must not hang"),
      /Pi is unavailable or incompatible with the required lifecycle contract/,
    );
    assert.deepEqual(service.getAgent(agent.agent.id).turns, []);
  } finally {
    service.close();
    if (oldPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = oldPiBin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a settled final assistant error fails one Turn and preserves its final text", async () => {
  const piFactory = ({ onEvent, onClose }) => ({
    prompt() {
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } });
      onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The provider failed." }], stopReason: "error", errorMessage: "upstream timeout" } });
      onEvent({ type: "agent_end" });
      onEvent({ type: "agent_settled" });
      onClose({ code: 0, signal: null });
    },
    abort() {}, close() {},
  });
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const updates = [];
    const unsubscribe = service.subscribe(agent.agent.id, (event) => updates.push(event));
    service.sendMessage(agent.agent.id, "Start work");
    unsubscribe();

    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.turns[0].terminalDetail, "Pi assistant error: upstream timeout");
    assert.equal(snapshot.messages[1].content, "The provider failed.");
    assert.equal(updates.filter((event) => event.type === "turn_finished").length, 1);
  }, piFactory);
});

test("a reconnect observes the same active Turn and later completion without transcript duplication", async () => {
  let execution;
  const piFactory = (options) => {
    execution = longRunningFakePi(options);
    return execution;
  };
  await withService(async (service) => {
    const created = service.createAgent({ name: "Long task", workspace: "/tmp" });
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
    const agent = first.createAgent({ name: "Interruptible", workspace: "/tmp" });
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

test("Pi close before interrupted settlement fails once and ignores a late settlement", async () => {
  let execution;
  const piFactory = ({ onEvent, onClose }) => {
    execution = {
      prompt() { onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } }); },
      abort() { onClose({ code: 0, signal: null }); },
      close() {},
      completeLate() { onEvent({ type: "agent_end" }); onEvent({ type: "agent_settled" }); onClose({ code: 0, signal: null }); },
    };
    return execution;
  };
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const updates = [];
    const unsubscribe = service.subscribe(agent.agent.id, (event) => updates.push(event));
    const turn = service.sendMessage(agent.agent.id, "Do work");
    service.interrupt(agent.agent.id, turn.id);
    execution.completeLate();
    unsubscribe();

    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.turns[0].terminalDetail, "Pi exited with code 0 after interruption was requested before Pi settled.");
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
    const agent = first.createAgent({ name: "Failure case", workspace: "/tmp" });
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
    const agent = first.createAgent({ name: "Persisted", workspace: "/tmp" });
    first.sendMessage(agent.agent.id, "Make a change");
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.close();
    const second = new AgentService({ dbPath: path, piFactory: fakePi });
    const restored = second.getAgent(agent.agent.id);
    assert.equal(restored.agent.workspace, "/tmp");
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
    const agent = first.createAgent({ name: "Restarted", workspace: "/tmp" });
    const unfinished = first.sendMessage(agent.agent.id, "Do not replay this request");
    assert.equal(starts, 1);
    first.close();

    const second = new AgentService({ dbPath: path, piFactory: fakePi });
    const restored = second.getAgent(agent.agent.id);
    assert.equal(starts, 1, "restart must not adopt or replay the previous execution");
    assert.equal(restored.agent.workspace, "/tmp");
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

test("a pre-v0.1 database migrates terminal history safe while unknown running history stays unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-pre-v01-migration-"));
  const dbPath = join(directory, "state.sqlite");
  const safeWorkspace = join(directory, "safe-workspace");
  const unknownWorkspace = join(directory, "unknown-workspace");
  await mkdir(safeWorkspace);
  await mkdir(unknownWorkspace);
  const ids = { agent: randomUUID(), unknown: randomUUID() };
  const db = new DatabaseSync(dbPath);
  const timestamp = new Date().toISOString();
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      user_message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
      started_at TEXT NOT NULL, finished_at TEXT, pi_session_id TEXT
    );
    CREATE TABLE messages (
      id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT REFERENCES turns(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(ids.agent, "Historical", safeWorkspace, timestamp, timestamp);
  db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(ids.unknown, "Unknown worker", unknownWorkspace, timestamp, timestamp);
  for (const [status, content] of [["completed", "completed history"], ["failed", "failed history"], ["interrupted", "interrupted history"]]) {
    const turnId = randomUUID();
    db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run(turnId, ids.agent, `old ${status}`, status, timestamp, timestamp);
    db.prepare("INSERT INTO messages (id, agent_id, turn_id, role, content, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").run(randomUUID(), ids.agent, turnId, content, timestamp, timestamp);
  }
  const runningId = randomUUID();
  db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(runningId, ids.unknown, "old running work", timestamp);
  db.close();

  const service = new AgentService({ dbPath, piFactory: fakePi });
  try {
    const historical = service.getAgent(ids.agent);
    assert.deepEqual(historical.turns.map((turn) => turn.status), ["completed", "failed", "interrupted"]);
    assert.equal(service.db.prepare("SELECT worker_terminated FROM turns WHERE agent_id = ? ORDER BY started_at LIMIT 1").get(ids.agent).worker_terminated, 1);
    const newTurn = service.sendMessage(ids.agent, "Start new work after migration");
    assert.equal(newTurn.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(service.getAgent(ids.agent).turns.at(-1).status, "completed");

    const restoredUnknown = service.getAgent(ids.unknown);
    assert.equal(restoredUnknown.turns[0].status, "interrupted");
    assert.equal(service.db.prepare("SELECT worker_terminated FROM turns WHERE id = ?").get(runningId).worker_terminated, 0);
    assert.throws(() => service.sendMessage(ids.unknown, "Do not risk old concurrent work"), /workspace remains unavailable/);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an immediately previous v0.1 schema migrates worker boot identity conservatively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-worker-boot-migration-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const ids = { agent: randomUUID(), safe: randomUUID(), unresolved: randomUUID() };
  const timestamp = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      user_message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
      started_at TEXT NOT NULL, finished_at TEXT, pi_session_id TEXT, terminal_detail TEXT,
      worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT,
      worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1))
    );
    CREATE TABLE messages (
      id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT REFERENCES turns(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(ids.agent, "Migrated", workspace, timestamp, timestamp);
  db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at, finished_at, worker_terminated) VALUES (?, ?, ?, 'completed', ?, ?, 1)").run(ids.safe, ids.agent, "Safe historical work", timestamp, timestamp);
  db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_terminated) VALUES (?, ?, ?, 'running', ?, 0)").run(ids.unresolved, ids.agent, "Unresolved historical work", timestamp);
  db.close();

  let first;
  let second;
  try {
    first = new AgentService({ dbPath, piFactory: fakePi, bootId: "boot-A" });
    const columns = first.db.prepare("PRAGMA table_info(turns)").all();
    assert.equal(columns.some((column) => column.name === "worker_boot_id"), true, "the immediately previous schema must gain worker_boot_id");
    const migrated = first.db.prepare("SELECT id, status, worker_boot_id AS workerBootId, worker_terminated AS workerTerminated FROM turns ORDER BY id").all();
    const safe = migrated.find((turn) => turn.id === ids.safe);
    const unresolved = migrated.find((turn) => turn.id === ids.unresolved);
    assert.equal(safe.status, "completed");
    assert.equal(safe.workerTerminated, 1, "safe terminal history must remain safe");
    assert.equal(safe.workerBootId, null);
    assert.equal(unresolved.status, "interrupted");
    assert.equal(unresolved.workerBootId, "boot-A", "unresolved historical work must be assigned the current boot, not an invented older boot");
    assert.equal(unresolved.workerTerminated, 0);
    assert.throws(() => first.sendMessage(ids.agent, "Do not unlock same-boot migrated work"), /This workspace remains unavailable because a prior Pi execution may still be able to run/);
    first.close();
    first = null;

    second = new AgentService({ dbPath, piFactory: fakePi, bootId: "boot-B" });
    const released = second.db.prepare("SELECT worker_boot_id AS workerBootId, worker_terminated AS workerTerminated FROM turns WHERE id = ?").get(ids.unresolved);
    assert.equal(released.workerBootId, "boot-A");
    assert.equal(released.workerTerminated, 1, "the boot boundary must be the release proof");
    const nextTurn = second.sendMessage(ids.agent, "Work after the proven reboot boundary");
    assert.equal(nextTurn.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.getAgent(ids.agent).turns.at(-1).status, "completed");
  } finally {
    second?.close();
    first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent creation persists a canonical workspace and rejects missing or non-directory paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-workspace-validation-"));
  const path = join(directory, "state.sqlite");
  const file = join(directory, "not-a-workspace");
  await writeFile(file, "not a directory");
  const service = new AgentService({ dbPath: path, piFactory: fakePi });
  try {
    const agent = service.createAgent({ workspace: directory });
    assert.equal(agent.agent.workspace, directory);
    assert.throws(() => service.createAgent({ workspace: "." }), /absolute path or use ~ home notation/);
    assert.throws(() => service.createAgent({ workspace: `./${basename(directory)}` }), /absolute path or use ~ home notation/);
    assert.throws(() => service.createAgent({ workspace: `../${basename(directory)}` }), /absolute path or use ~ home notation/);
    assert.throws(() => service.createAgent({ workspace: join(directory, "missing") }), /workspace must exist and be a directory/);
    assert.throws(() => service.createAgent({ workspace: file }), /workspace must exist and be a directory/);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tilde and filesystem aliases persist one canonical workspace and cannot bypass its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-workspace-alias-"));
  const path = join(directory, "state.sqlite");
  const home = homedir();
  const homeWorkspace = await mkdtemp(join(home, ".pi-sand-workspace-"));
  const link = join(directory, "workspace-alias");
  await symlink(homeWorkspace, link, "dir");
  const dormantPi = () => ({ prompt() {}, abort() {}, close() {} });
  const service = new AgentService({ dbPath: path, piFactory: dormantPi });
  try {
    const homeAgent = service.createAgent({ name: "Home", workspace: "~" });
    const tilde = service.createAgent({ name: "Tilde", workspace: `~/${basename(homeWorkspace)}` });
    const normalized = service.createAgent({ name: "Normalized", workspace: join(homeWorkspace, "..", basename(homeWorkspace)) });
    const symlinked = service.createAgent({ name: "Symlinked", workspace: link });
    assert.equal(homeAgent.agent.workspace, home);
    assert.equal(tilde.agent.workspace, homeWorkspace);
    assert.equal(normalized.agent.workspace, homeWorkspace);
    assert.equal(symlinked.agent.workspace, homeWorkspace);

    service.sendMessage(tilde.agent.id, "Lock this workspace");
    assert.throws(() => service.sendMessage(normalized.agent.id, "Do not bypass the lock"), /workspace already has a running Turn/);
    assert.throws(() => service.sendMessage(symlinked.agent.id, "Do not bypass the lock either"), /workspace already has a running Turn/);
  } finally {
    service.close();
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(homeWorkspace, { recursive: true, force: true })]);
  }
});

test("Agent roster summaries expose stable order and the latest durable message preview", async () => withService(async (service) => {
  const first = service.createAgent({ name: "First", workspace: "/tmp" });
  const second = service.createAgent({ name: "Second", workspace: "/tmp" });
  const initial = service.listAgents();
  assert.deepEqual(initial.map((agent) => agent.id), [first.agent.id, second.agent.id]);
  assert.equal(initial[0].recentPreview, null);

  service.sendMessage(first.agent.id, "first request");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterTurn = service.listAgents();
  assert.equal(afterTurn[0].recentPreview, "Done.");
  assert.equal(afterTurn[1].recentPreview, null);
}), fakePi);

test("independent Agents run concurrently while completion, failure, and interruption stay isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-parallel-turns-"));
  const path = join(directory, "state.sqlite");
  const workspaceA = await mkdtemp(join(directory, "workspace-a-"));
  const workspaceB = await mkdtemp(join(directory, "workspace-b-"));
  const controls = new Map();
  const piFactory = ({ onEvent, onClose }) => {
    let settled = false;
    const settle = (stopReason = "stop") => {
      if (settled) return;
      settled = true;
      onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${stopReason} result` }], stopReason } });
      onEvent({ type: "agent_end" });
      onEvent({ type: "agent_settled" });
      onClose({ code: 0, signal: null });
    };
    return {
      prompt({ message }) {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` } });
        controls.set(message, { complete: () => settle(), fail: () => onClose({ code: null, signal: "SIGKILL" }) });
      },
      abort() { settle("aborted"); },
      close() {},
    };
  };
  const service = new AgentService({ dbPath: path, piFactory });
  try {
    const agentA = service.createAgent({ name: "A", workspace: workspaceA });
    const agentB = service.createAgent({ name: "B", workspace: workspaceB });
    const sameWorkspaceAsA = service.createAgent({ name: "A duplicate", workspace: `${workspaceA}/.` });
    const firstA = service.sendMessage(agentA.agent.id, "A completes");
    const turnB = service.sendMessage(agentB.agent.id, "B remains running");
    assert.equal(service.getAgent(agentA.agent.id).state, "active");
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, turnB.id);
    assert.throws(() => service.sendMessage(agentA.agent.id, "A must not overlap"), /Agent already has a running Turn/);
    assert.throws(() => service.sendMessage(sameWorkspaceAsA.agent.id, "Shared workspace must not overlap"), /workspace already has a running Turn/);

    controls.get("A completes").complete();
    assert.equal(service.getAgent(agentA.agent.id).turns.find((turn) => turn.id === firstA.id).status, "completed");
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, turnB.id);

    const failedA = service.sendMessage(agentA.agent.id, "A fails");
    controls.get("A fails").fail();
    assert.equal(service.getAgent(agentA.agent.id).turns.find((turn) => turn.id === failedA.id).status, "failed");
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, turnB.id);

    const interruptedA = service.sendMessage(agentA.agent.id, "A interrupts");
    service.interrupt(agentA.agent.id, interruptedA.id);
    assert.equal(service.getAgent(agentA.agent.id).turns.find((turn) => turn.id === interruptedA.id).status, "interrupted");
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, turnB.id);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
