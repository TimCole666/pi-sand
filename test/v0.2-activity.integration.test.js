import test from "node:test";
import assert from "node:assert/strict";
import registerPiSandActivity from "../extensions/pi-sand-activity.js";

function createHarness() {
  const handlers = new Map();
  const calls = [];
  let command;

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, definition) {
      assert.equal(name, "pi-sand");
      command = definition.handler;
    },
  };

  registerPiSandActivity(pi);

  function context(overrides = {}) {
    return {
      mode: "tui",
      cwd: "/tmp/pi-sand-workspace",
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus(key, text) {
          calls.push({ method: "setStatus", key, text });
        },
        setWidget(key, lines) {
          calls.push({ method: "setWidget", key, lines });
        },
        notify(message, type) {
          calls.push({ method: "notify", message, type });
        },
      },
      ...overrides,
    };
  }

  async function emit(event, ctx = context()) {
    await handlers.get(event)({}, ctx);
  }

  async function report(ctx = context()) {
    await command("", ctx);
    const notification = [...calls].reverse().find((call) => call.method === "notify");
    return notification ? JSON.parse(notification.message) : undefined;
  }

  function visibleSurface() {
    const status = [...calls].reverse().find((call) => call.method === "setStatus");
    const widget = [...calls].reverse().find((call) => call.method === "setWidget");
    return {
      status: status && { key: status.key, text: status.text },
      widget: widget && { key: widget.key, lines: widget.lines },
    };
  }

  return { calls, context, emit, report, visibleSurface };
}

function assertSurface(harness, activity) {
  assert.deepEqual(harness.visibleSurface(), {
    status: { key: "pi-sand", text: `pi-sand: ${activity}` },
    widget: { key: "pi-sand", lines: [`pi-sand activity: ${activity}`] },
  });
}

test("v0.2 activity projection follows the documented foreground lifecycle", async () => {
  const harness = createHarness();
  const ctx = harness.context();

  await harness.emit("session_start", ctx);
  assertSurface(harness, "idle");
  assert.equal((await harness.report(ctx)).activity, "idle");

  await harness.emit("ui_prompt_start", ctx);
  assertSurface(harness, "waiting_for_user");
  assert.equal((await harness.report(ctx)).activity, "waiting_for_user");

  await harness.emit("ui_prompt_end", ctx);
  assertSurface(harness, "idle");

  await harness.emit("agent_start", ctx);
  assertSurface(harness, "running");
  assert.equal((await harness.report(ctx)).activity, "running");

  await harness.emit("ui_prompt_start", ctx);
  assertSurface(harness, "waiting_for_user");
  await harness.emit("ui_prompt_end", ctx);
  assertSurface(harness, "running");

  const callsBeforeAgentEnd = harness.calls.length;
  await harness.emit("agent_end", ctx);
  assertSurface(harness, "running");
  assert.equal((await harness.report(ctx)).activity, "running");
  assert.ok(harness.calls.length > callsBeforeAgentEnd);

  await harness.emit("agent_settled", ctx);
  assertSurface(harness, "idle");
  assert.equal((await harness.report(ctx)).activity, "idle");
});

test("v0.2 activity projection clears its Pi UI surface on session shutdown", async () => {
  const harness = createHarness();
  const ctx = harness.context();

  await harness.emit("session_start", ctx);
  await harness.emit("agent_start", ctx);
  await harness.emit("session_shutdown", ctx);

  assert.deepEqual(harness.visibleSurface(), {
    status: { key: "pi-sand", text: undefined },
    widget: { key: "pi-sand", lines: undefined },
  });
  assert.equal((await harness.report(ctx)), undefined);
});
