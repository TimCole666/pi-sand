import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/service.js";

function settledResult({ onEvent, onClose }, text) {
  onEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  });
  onEvent({ type: "agent_end" });
  onEvent({ type: "agent_settled" });
  onClose({ code: 0, signal: null });
}

test("Stop is scoped to one Agent and repeated requests are idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-stop-isolation-"));
  const workspaceA = await mkdtemp(join(directory, "workspace-a-"));
  const workspaceB = await mkdtemp(join(directory, "workspace-b-"));
  const controls = new Map();
  let abortCount = 0;
  const piFactory = (options) => {
    let stopped = false;
    let promptText;
    const execution = {
      prompt({ message }) {
        promptText = message;
        options.onEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `Working: ${message}` },
        });
        controls.set(message, {
          complete: () => {
            if (stopped) return;
            stopped = true;
            settledResult(options, `Completed: ${message}`);
          },
        });
      },
      abort() {
        abortCount += 1;
        if (stopped) return;
        stopped = true;
        settledResult({ ...options }, `Interrupted: ${promptText}`);
      },
      close() { stopped = true; },
    };
    return execution;
  };
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory });
  try {
    const agentA = service.createAgent({ name: "A", workspace: workspaceA });
    const agentB = service.createAgent({ name: "B", workspace: workspaceB });
    const turnA = service.sendMessage(agentA.agent.id, "A keeps working");
    const turnB = service.sendMessage(agentB.agent.id, "B keeps working");

    assert.equal(service.getAgent(agentA.agent.id).activeTurnId, turnA.id);
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, turnB.id);

    service.interrupt(agentA.agent.id, turnA.id);
    service.interrupt(agentA.agent.id, turnA.id);

    const interruptedA = service.getAgent(agentA.agent.id);
    assert.equal(abortCount, 1, "repeated Stop must not issue a second Pi abort");
    assert.equal(interruptedA.turns.find((turn) => turn.id === turnA.id).status, "interrupted");
    assert.match(interruptedA.messages.at(-1).content, /Interrupted: A keeps working/);

    const stillWorkingB = service.getAgent(agentB.agent.id);
    assert.equal(stillWorkingB.activeTurnId, turnB.id, "Stopping A must not affect B");
    assert.equal(stillWorkingB.turns.find((turn) => turn.id === turnB.id).status, "running");

    controls.get("B keeps working").complete();
    const completedB = service.getAgent(agentB.agent.id);
    assert.equal(completedB.turns.find((turn) => turn.id === turnB.id).status, "completed");
    assert.match(completedB.messages.at(-1).content, /Completed: B keeps working/);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stop followed by Pi failure remains failed rather than interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-stop-failure-"));
  let execution;
  const piFactory = ({ onEvent, onClose }) => {
    execution = {
      prompt() {
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial work" } });
      },
      abort() { onClose({ code: null, signal: "SIGKILL" }); },
      close() {},
    };
    return execution;
  };
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory });
  try {
    const agent = service.createAgent({ workspace: directory });
    const turn = service.sendMessage(agent.agent.id, "Fail after Stop");
    service.interrupt(agent.agent.id, turn.id);
    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.match(snapshot.turns[0].terminalDetail, /SIGKILL/);
    assert.equal(snapshot.messages.at(-1).content, "Partial work");
  } finally {
    execution?.close();
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
