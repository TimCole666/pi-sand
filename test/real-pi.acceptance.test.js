import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/service.js";

const enabled = process.env.PI_SAND_REAL_PI === "1";
const timeoutMs = Number(process.env.PI_SAND_REAL_PI_TIMEOUT_MS ?? 120_000);

function waitForTerminal(service, agentId) {
  const snapshot = service.getAgent(agentId);
  if (snapshot.turns[0] && snapshot.turns[0].status !== "running") return Promise.resolve(snapshot);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`real Pi smoke did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = service.subscribe(agentId, (event) => {
      if (event.type === "turn_finished") {
        clearTimeout(timer);
        unsubscribe();
        resolve(event.snapshot);
      }
    });
  });
}

function waitForTurn(service, agentId, turnId) {
  const snapshot = service.getAgent(agentId);
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (turn && turn.status !== "running") return Promise.resolve(snapshot);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`real Pi Turn ${turnId} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = service.subscribe(agentId, (event) => {
      if (event.type === "turn_finished" && event.turnId === turnId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event.snapshot);
      }
    });
  });
}

test("real Pi writes a controlled workspace fixture through the Local Agent Service", { skip: enabled ? false : "set PI_SAND_REAL_PI=1 with a configured pi CLI to run the real-Pi acceptance scenario" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sand-real-pi-"));
  const dbPath = join(workspace, "state.sqlite");
  const fixture = join(workspace, "pi-sand-smoke.txt");
  const service = new AgentService({ dbPath });
  try {
    const agent = service.createAgent({ name: "Real Pi smoke", workspace });
    service.sendMessage(agent.agent.id, [
      "Use your normal workspace tools to create pi-sand-smoke.txt in the current workspace.",
      "Its complete contents must be exactly: pi-sand real smoke passed",
      "Do not modify any other file. Reply after the file is written.",
    ].join(" "));
    const completed = await waitForTerminal(service, agent.agent.id);
    assert.equal(completed.turns[0].status, "completed", "Pi must reach a normal terminal state");
    assert.equal(await readFile(fixture, "utf8"), "pi-sand real smoke passed");
    assert.equal(completed.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    service.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real Pi preserves ordinary follow-up context in one Agent session", { skip: enabled ? false : "set PI_SAND_REAL_PI=1 with a configured pi CLI to run the real-Pi acceptance scenario" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sand-real-pi-context-"));
  const dbPath = join(workspace, "state.sqlite");
  const fixture = join(workspace, "pi-sand-context-smoke.txt");
  const service = new AgentService({ dbPath });
  try {
    const agent = service.createAgent({ name: "Real Pi context smoke", workspace });
    const first = service.sendMessage(agent.agent.id, [
      "Memorize this exact codeword for our next conversation turn: PI_NATIVE_CONTEXT_7X.",
      "Do not create or modify any files. Reply with a brief acknowledgement.",
    ].join(" "));
    const firstResult = await waitForTurn(service, agent.agent.id, first.id);
    assert.equal(firstResult.turns.find((turn) => turn.id === first.id).status, "completed");

    const second = service.sendMessage(agent.agent.id, [
      "Using only the conversation context from the previous turn, write pi-sand-context-smoke.txt",
      "in the current workspace. Its complete contents must be exactly the codeword you were asked",
      "to memorize. Do not derive it from any file or from pi-sand's durable transcript. Reply after writing.",
    ].join(" "));
    const secondResult = await waitForTurn(service, agent.agent.id, second.id);
    assert.equal(secondResult.turns.find((turn) => turn.id === second.id).status, "completed");
    assert.equal(await readFile(fixture, "utf8"), "PI_NATIVE_CONTEXT_7X");
    assert.equal(secondResult.messages.filter((message) => message.role === "assistant").length, 2);
  } finally {
    service.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
