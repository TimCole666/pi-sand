import test from "node:test";
import assert from "node:assert/strict";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";

test("first-party Extension claims, renders, and acknowledges one durable Result on reconnect", async () => {
  const harness = createExtensionHarness();
  const calls = [];
  let clientInstanceId;
  const result = {
    id: "result-1",
    taskId: "task-1",
    outcome: "completed",
    state: "claimed",
    claimHandle: "claim-1",
    payload: { objective: "finish the task" },
  };
  const client = {
    claimResult: async (instanceId) => {
      calls.push(["claim", instanceId]);
      clientInstanceId = instanceId;
      return result;
    },
    ackResult: async (resultId, claimHandle) => {
      assert.equal(harness.notifications.length, 1, "render must happen before ack");
      calls.push(["ack", resultId, claimHandle]);
      return { ...result, state: "acked", claimHandle: null };
    },
  };
  registerPiSandExtension(harness.pi, { runtimeClientFactory: () => client });
  const context = harness.context("manager");

  await harness.invoke("session_start", { type: "session_start" }, context);
  assert.match(clientInstanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls, [
    ["claim", clientInstanceId],
    ["ack", "result-1", "claim-1"],
  ]);
  assert.deepEqual(harness.notifications, [{
    session: "manager",
    message: JSON.stringify(result),
    type: "info",
  }]);

  await harness.invoke("session_shutdown", { type: "session_shutdown" }, context);
});

test("Extension leaves a Result unacknowledged when rendering fails", async () => {
  const harness = createExtensionHarness();
  let acknowledgements = 0;
  const client = {
    claimResult: async () => ({
      id: "result-2",
      taskId: "task-2",
      outcome: "failed",
      state: "claimed",
      claimHandle: "claim-2",
      payload: {},
    }),
    ackResult: async () => { acknowledgements += 1; },
  };
  const context = harness.context("manager");
  context.ui.notify = () => { throw new Error("render failed"); };
  registerPiSandExtension(harness.pi, { runtimeClientFactory: () => client });

  await harness.invoke("session_start", { type: "session_start" }, context);
  assert.equal(acknowledgements, 0);
  await harness.invoke("session_shutdown", { type: "session_shutdown" }, context);
});
