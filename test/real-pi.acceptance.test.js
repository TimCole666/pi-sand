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
