import test from "node:test";
import assert from "node:assert/strict";
import { registerPiSandExtension } from "../extensions/runtime.js";

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const status = [];
  const widgets = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };

  const invoke = async (event, eventData, ctx) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(eventData, ctx);
    }
  };

  const context = (session, idle = true) => ({
    mode: "tui",
    cwd: `/workspace/${session}`,
    sessionManager: { getSessionId: () => session },
    isIdle: () => idle,
    ui: {
      setStatus(key, text) {
        status.push({ session, key, text });
      },
      setWidget(key, lines) {
        widgets.push({ session, key, lines });
      },
      notify(message, type) {
        notifications.push({ session, message, type });
      },
    },
  });

  return { commands, handlers, invoke, context, notifications, pi, status, widgets };
}

test("factory only binds Pi-native handlers and does not start runtime resources", () => {
  const harness = createHarness();
  registerPiSandExtension(harness.pi);

  assert.deepEqual([...harness.commands.keys()], ["pi-sand", "pi-sand-reload"]);
  assert.deepEqual([...harness.handlers.keys()], [
    "project_trust",
    "session_start",
    "session_shutdown",
    "agent_start",
    "agent_end",
    "agent_settled",
    "ui_prompt_start",
    "ui_prompt_end",
  ]);
  assert.deepEqual(harness.status, []);
  assert.deepEqual(harness.widgets, []);
  assert.deepEqual(harness.notifications, []);
});

test("project trust remains owned by Pi", async () => {
  const harness = createHarness();
  registerPiSandExtension(harness.pi);
  const decision = await harness.handlers.get("project_trust")[0]({
    type: "project_trust",
    cwd: "/workspace/untrusted",
  }, harness.context("untrusted"));
  assert.deepEqual(decision, { trusted: "undecided" });
});

test("session lifecycle projects activity, preserves agent_end authority, and cleans up idempotently", async () => {
  const harness = createHarness();
  registerPiSandExtension(harness.pi);
  const oldContext = harness.context("old");
  const newContext = harness.context("new");

  await harness.invoke("session_start", { type: "session_start", reason: "startup" }, oldContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: idle");

  await harness.invoke("agent_start", { type: "agent_start" }, oldContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: running");

  await harness.invoke("agent_end", { type: "agent_end" }, oldContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: running");
  assert.equal(harness.widgets.at(-1).lines[0], "pi-sand activity: running");

  await harness.invoke("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm" }, oldContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: waiting_for_user");
  await harness.invoke("ui_prompt_end", { type: "ui_prompt_end", kind: "confirm" }, { ...oldContext, isIdle: () => false });
  assert.equal(harness.status.at(-1).text, "pi-sand: running");

  await harness.invoke("agent_settled", { type: "agent_settled" }, oldContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: idle");

  await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "new" }, oldContext);
  const cleanupCount = harness.status.filter(({ text }) => text === undefined).length;
  await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" }, oldContext);
  assert.equal(harness.status.filter(({ text }) => text === undefined).length, cleanupCount);
  assert.equal(harness.widgets.filter(({ lines }) => lines === undefined).length, 1);

  // Events from the old session cannot mutate the replacement projection.
  await harness.invoke("agent_start", { type: "agent_start" }, oldContext);
  assert.equal(harness.status.filter(({ session }) => session === "old").at(-1).text, undefined);

  await harness.invoke("session_start", { type: "session_start", reason: "new" }, newContext);
  assert.equal(harness.status.at(-1).text, "pi-sand: idle");
  await harness.commands.get("pi-sand").handler("", newContext);
  const status = JSON.parse(harness.notifications.at(-1).message);
  assert.equal(status.session, "new");
  assert.equal(status.cwd, "/workspace/new");
  assert.equal(status.activity, "idle");
});

test("reload replacement starts one fresh projection without duplicate registrations", async () => {
  const first = createHarness();
  registerPiSandExtension(first.pi);
  const context = first.context("same-session");
  await first.invoke("session_start", { type: "session_start", reason: "startup" }, context);
  await first.invoke("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);

  const second = createHarness();
  registerPiSandExtension(second.pi);
  const replacementContext = second.context("same-session");
  await second.invoke("session_start", { type: "session_start", reason: "reload" }, replacementContext);
  await second.commands.get("pi-sand").handler("", replacementContext);

  assert.equal(second.commands.size, 2);
  assert.equal(second.status.filter(({ text }) => text === "pi-sand: idle").length, 2);
  assert.equal(first.status.filter(({ text }) => text === undefined).length, 1);
  assert.equal(JSON.parse(second.notifications[0].message).session, "same-session");
});
