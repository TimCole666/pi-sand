import test from "node:test";
import assert from "node:assert/strict";
import { registerPiSandExtension } from "../extensions/runtime.js";

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const pi = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
  };

  const context = (session = "session-1") => ({
    mode: "tui",
    cwd: "/tmp/pi-sand-workspace",
    sessionManager: { getSessionId: () => session },
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
  });

  async function emit(event, ctx) {
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  }

  function surface() {
    const status = [...calls].reverse().find((call) => call.method === "setStatus");
    const widget = [...calls].reverse().find((call) => call.method === "setWidget");
    return {
      status: status && { key: status.key, text: status.text },
      widget: widget && { key: widget.key, lines: widget.lines },
    };
  }

  async function report(ctx) {
    await commands.get("pi-sand")("", ctx);
    const notification = [...calls].reverse().find((call) => call.method === "notify");
    return notification ? JSON.parse(notification.message) : undefined;
  }

  registerPiSandExtension(pi);
  return { calls, context, emit, report, surface };
}

function assertSurface(harness, activity) {
  assert.deepEqual(harness.surface(), {
    status: { key: "pi-sand", text: `pi-sand: ${activity}` },
    widget: { key: "pi-sand", lines: [`pi-sand activity: ${activity}`] },
  });
}

test("v0.2 activity projection keeps status, widget, and command on one authority", async () => {
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
  await harness.emit("ui_prompt_start", ctx);
  assertSurface(harness, "waiting_for_user");
  await harness.emit("ui_prompt_end", ctx);
  assertSurface(harness, "running");

  await harness.emit("agent_end", ctx);
  assertSurface(harness, "running");
  assert.equal((await harness.report(ctx)).activity, "running");

  await harness.emit("agent_settled", ctx);
  assertSurface(harness, "idle");
  assert.equal((await harness.report(ctx)).activity, "idle");
});

test("v0.2 activity projection clears all Pi UI surfaces on session shutdown", async () => {
  const harness = createHarness();
  const ctx = harness.context();

  await harness.emit("session_start", ctx);
  await harness.emit("agent_start", ctx);
  await harness.emit("session_shutdown", ctx);

  assert.deepEqual(harness.surface(), {
    status: { key: "pi-sand", text: undefined },
    widget: { key: "pi-sand", lines: undefined },
  });
  assert.equal(await harness.report(ctx), undefined);
});
