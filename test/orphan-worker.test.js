import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AgentService } from "../src/service.js";

async function waitForLine(child) {
  let output = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        child.stdout.off("data", onData);
        resolve(JSON.parse(output.slice(0, newline)));
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`service fixture exited before ready (${code ?? signal})`)));
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

function completingPi({ onEvent, onClose }) {
  return {
    prompt() {
      onEvent({ type: "message_end", message: { role: "assistant", content: "Recovered work.", stopReason: "stop" } });
      onEvent({ type: "agent_settled" });
      onClose({ code: 0, signal: null });
    },
    abort() {},
    close() {},
  };
}

test("service restart terminates an orphan worker before releasing its workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-orphan-worker-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const marker = join(workspace, "orphan-worker.log");
  const serviceUrl = new URL("../src/service.js", import.meta.url).href;
  const workerCode = "const fs = require('node:fs'); const marker = process.argv[1]; setInterval(() => fs.appendFileSync(marker, 'x'), 10);";
  const fixtureCode = `
    import { spawn } from "node:child_process";
    import { mkdirSync } from "node:fs";
    import { AgentService } from ${JSON.stringify(serviceUrl)};
    mkdirSync(process.env.WORKSPACE, { recursive: true });
    const workerCode = ${JSON.stringify(workerCode)};
    const service = new AgentService({ dbPath: process.env.DB_PATH, piFactory: ({ cwd }) => {
      const worker = spawn(process.execPath, ["-e", workerCode, process.env.MARKER], { cwd, detached: true, stdio: "ignore" });
      return { pid: worker.pid, processGroupId: worker.pid, prompt() {}, abort() {}, close() {} };
    }});
    const agent = service.createAgent({ name: "Orphaned", workspace: process.env.WORKSPACE });
    const turn = service.sendMessage(agent.agent.id, "Keep mutating while the service is gone");
    console.log(JSON.stringify({ agentId: agent.agent.id, turnId: turn.id }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", fixtureCode], {
    env: { ...process.env, DB_PATH: dbPath, WORKSPACE: workspace, MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ready = await waitForLine(child);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = statSync(marker).size;
    child.kill("SIGKILL");
    await waitForExit(child);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterCrash = statSync(marker).size;
    assert.ok(afterCrash > before, "the worker must survive the service crash boundary");

    const service = new AgentService({ dbPath, piFactory: completingPi });
    try {
      const restored = service.getAgent(ready.agentId);
      assert.equal(restored.turns[0].id, ready.turnId);
      assert.equal(restored.turns[0].status, "interrupted");
      assert.match(restored.turns[0].terminalDetail, /not resumed/);
      const afterReconcile = statSync(marker).size;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(statSync(marker).size, afterReconcile, "the orphan worker must stop before workspace release");

      const nextTurn = service.sendMessage(ready.agentId, "Use the workspace after cleanup");
      assert.equal(nextTurn.status, "completed");
      const completed = service.getAgent(ready.agentId);
      assert.equal(completed.turns[1].status, "completed");
    } finally {
      service.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown prior-worker ownership fails closed across repeated service restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-unknown-worker-"));
  const dbPath = join(directory, "state.sqlite");
  try {
    const first = new AgentService({ dbPath, piFactory: completingPi });
    const agent = first.createAgent({ workspace: directory });
    first.close();

    const db = new DatabaseSync(dbPath);
    const turnId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_terminated) VALUES (?, ?, ?, 'running', ?, 0)").run(turnId, agent.agent.id, "Unknown worker", timestamp);
    db.close();

    const second = new AgentService({ dbPath, piFactory: completingPi });
    try {
      const restored = second.getAgent(agent.agent.id);
      assert.equal(restored.turns[0].status, "interrupted");
      const finishedAt = restored.turns[0].finishedAt;
      assert.throws(
        () => second.sendMessage(agent.agent.id, "Do not risk concurrent mutation"),
        /workspace remains unavailable/,
      );
      second.close();

      const third = new AgentService({ dbPath, piFactory: completingPi });
      try {
        const repeated = third.getAgent(agent.agent.id);
        assert.equal(repeated.turns[0].status, "interrupted");
        assert.equal(repeated.turns[0].finishedAt, finishedAt, "restart must not terminalize the same Turn twice");
        assert.throws(() => third.sendMessage(agent.agent.id, "Still blocked"), /workspace remains unavailable/);
      } finally {
        third.close();
      }
    } catch (error) {
      second.close();
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
