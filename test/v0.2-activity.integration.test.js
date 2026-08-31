import test from "node:test";
import assert from "node:assert/strict";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";

function createHarness() {
  const harness = createExtensionHarness({ cwd: () => "/tmp/pi-sand-workspace" });
  registerPiSandExtension(harness.pi);
  return harness;
}

function assertSurface(harness, activity) {
  assert.deepEqual(harness.surface(), {
    status: { key: "pi-sand", text: `pi-sand: ${activity}` },
    widget: { key: "pi-sand", lines: [`pi-sand activity: ${activity}`] },
  });
}

test("v0.2 activity projection proves the settled lifecycle sequence", async () => {
  const harness = createHarness();
  const ctx = harness.context();
  const sequence = [];
  const observe = (activity) => {
    assertSurface(harness, activity);
    sequence.push(activity);
  };

  await harness.emit("session_start", ctx);
  observe("idle");
  assert.equal((await harness.report(ctx)).activity, "idle");

  await harness.emit("agent_start", ctx);
  observe("running");
  await harness.emit("ui_prompt_start", ctx);
  observe("waiting_for_user");
  assert.equal((await harness.report(ctx)).activity, "waiting_for_user");

  await harness.emit("ui_prompt_end", ctx);
  observe("running");

  await harness.emit("agent_end", ctx);
  observe("running");
  assert.equal((await harness.report(ctx)).activity, "running");

  await harness.emit("agent_settled", ctx);
  observe("idle");
  assert.equal((await harness.report(ctx)).activity, "idle");
  assert.deepEqual(sequence, ["idle", "running", "waiting_for_user", "running", "running", "idle"]);
  assert.deepEqual(sequence.filter((activity, index) => index === 0 || activity !== sequence[index - 1]), [
    "idle",
    "running",
    "waiting_for_user",
    "running",
    "idle",
  ]);
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
