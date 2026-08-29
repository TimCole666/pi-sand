import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/service.js";

function releasePiFactory(controls) {
  return ({ onEvent, onClose }) => {
    let promptCount = 0;
    let stopped = false;
    let held = false;
    const execution = {
      prompt({ message }) {
        promptCount += 1;
        const result = promptCount > 1 ? "Pi-native context survived." : "Initial result.";
        onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: held ? `Working: ${message}` : result } });
        if (message.includes("hold")) {
          held = true;
          controls.set(message, execution);
          return;
        }
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: result }], stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
      },
      abort() {
        if (stopped) return;
        stopped = true;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped." }], stopReason: "aborted" } });
        onEvent({ type: "agent_settled" });
        onClose({ code: 0, signal: null });
      },
      close() { stopped = true; },
      release() {
        if (stopped) return;
        held = false;
        onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Held work completed." }], stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
      },
    };
    return execution;
  };
}

async function waitForTurn(service, agentId, status = "completed") {
  const current = service.getAgent(agentId).turns.at(-1);
  if (current?.status === status) return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`release integration Turn did not become ${status}`));
    }, 1_000);
    const unsubscribe = service.subscribe(agentId, (event) => {
      if (event.type === "turn_finished" && event.status === status) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event.snapshot.turns.at(-1));
      }
    });
  });
}

test("v0.1 release integration composes durable attachment, native follow-up, and scoped Agent lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-release-integration-"));
  const workspaceA = await mkdtemp(join(directory, "workspace-a-"));
  const workspaceB = await mkdtemp(join(directory, "workspace-b-"));
  const dbPath = join(directory, "state.sqlite");
  const controls = new Map();
  const service = new AgentService({ dbPath, piFactory: releasePiFactory(controls) });
  try {
    const agentA = service.createAgent({ name: "Release A", workspace: workspaceA });
    const agentB = service.createAgent({ name: "Release B", workspace: workspaceB });
    const attachment = service.stageAttachment(agentA.agent.id, {
      filename: "release-note.txt",
      contentType: "text/plain",
      bytes: Buffer.from("release attachment"),
    });

    service.sendMessage(agentA.agent.id, "Read the attached release note", { attachments: [attachment.id] });
    await waitForTurn(service, agentA.agent.id);
    service.sendMessage(agentA.agent.id, "Continue using what you learned");
    await waitForTurn(service, agentA.agent.id);

    const held = service.sendMessage(agentB.agent.id, "hold independent work");
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, held.id);
    const followUp = service.getAgent(agentA.agent.id);
    assert.equal(followUp.turns.at(-1).status, "completed");
    assert.equal(followUp.messages.at(-1).content, "Pi-native context survived.");
    assert.equal(followUp.messages[0].attachments[0].filename, "release-note.txt");

    service.interrupt(agentB.agent.id, held.id);
    assert.equal(service.getAgent(agentB.agent.id).turns[0].status, "interrupted");
    assert.equal(service.getAgent(agentA.agent.id).turns.every((turn) => turn.status === "completed"), true);
    assert.equal(service.getAgent(agentB.agent.id).activeTurnId, null);

    service.close();
    const reopened = new AgentService({ dbPath, piFactory: releasePiFactory(new Map()) });
    try {
      const restored = reopened.getAgent(agentA.agent.id);
      assert.equal(restored.agent.workspace, workspaceA);
      assert.deepEqual(restored.turns.map((turn) => turn.status), ["completed", "completed"]);
      assert.equal(restored.messages[0].attachments[0].filename, "release-note.txt");
      assert.equal(new Set(restored.messages.map((message) => message.id)).size, restored.messages.length);
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
