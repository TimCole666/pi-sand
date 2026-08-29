import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test("a crash after Pi spawn but before metadata persistence keeps the workspace fenced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-spawn-window-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const marker = join(workspace, "spawned-worker.log");
  const pidFile = join(workspace, "spawned-worker.pid");
  await mkdir(workspace);
  const workerCode = "const fs = require('node:fs'); fs.writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => fs.appendFileSync(process.env.MARKER, 'x'), 10);";
  const serviceUrl = new URL("../src/service.js", import.meta.url).href;
  const fixtureCode = `
    import { spawn } from "node:child_process";
    import { AgentService } from ${JSON.stringify(serviceUrl)};
    const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerCode)}], {
      cwd: process.env.WORKSPACE,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MARKER: process.env.MARKER, PID_FILE: process.env.PID_FILE },
    });
    const service = new AgentService({ dbPath: process.env.DB_PATH, piFactory: () => {
      // sendMessage has committed the running/unsafe row, but has not yet
      // received this execution object to persist its worker metadata.
      process.kill(process.pid, "SIGKILL");
      return { pid: worker.pid, processGroupId: worker.pid, prompt() {}, abort() {}, close() {} };
    }});
    const agent = service.createAgent({ workspace: process.env.WORKSPACE });
    service.sendMessage(agent.agent.id, "Crash in the worker metadata window");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", fixtureCode], {
    env: { ...process.env, DB_PATH: dbPath, WORKSPACE: workspace, MARKER: marker, PID_FILE: pidFile },
    stdio: "ignore",
  });
  try {
    await waitForExit(child);
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true, "the detached worker must survive the service crash");
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT status, worker_pid AS workerPid, worker_terminated AS workerTerminated FROM turns").get();
    db.close();
    assert.equal(row.status, "running");
    assert.equal(row.workerPid, null, "the crash must precede worker metadata persistence");
    assert.equal(row.workerTerminated, 0, "a newly running Turn must be pessimistically unsafe");

    const service = new AgentService({ dbPath, piFactory: completingPi });
    try {
      const restored = service.getAgent(service.listAgents()[0].id);
      assert.equal(restored.turns[0].status, "interrupted");
      assert.throws(() => service.sendMessage(restored.agent.id, "Workspace remains fenced"), /workspace remains unavailable/);
      const before = statSync(marker).size;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.ok(statSync(marker).size > before, "unidentifiable worker activity must not be mistaken for a safe workspace");
    } finally {
      service.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("a reused worker PID mismatch never signals an unrelated live process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-reused-worker-pid-"));
  const dbPath = join(directory, "state.sqlite");
  const marker = join(directory, "reused-worker-terminated");
  const worker = spawn(process.execPath, ["-e", "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.MARKER, 'terminated'); process.exit(0); }); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MARKER: marker },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const first = new AgentService({ dbPath, piFactory: completingPi });
    const agent = first.createAgent({ workspace: directory });
    first.close();

    const db = new DatabaseSync(dbPath);
    const turnId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_pid, worker_pgid, worker_start_identity, worker_terminated)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0)
    `).run(turnId, agent.agent.id, "Prior worker with a reused PID", timestamp, worker.pid, worker.pid, "not-the-current-process");
    db.close();

    const second = new AgentService({ dbPath, piFactory: completingPi });
    try {
      assert.equal(second.getAgent(agent.agent.id).turns[0].status, "interrupted");
      assert.equal(existsSync(marker), false, "identity mismatch must not signal the unrelated group");
      assert.doesNotThrow(() => process.kill(worker.pid, 0), "the unrelated worker must remain alive");
      assert.throws(
        () => second.sendMessage(agent.agent.id, "Do not risk the reused process group"),
        /workspace remains unavailable/,
      );
    } finally {
      second.close();
    }
  } finally {
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await waitForExit(worker).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a closed Pi leader does not release a workspace while a descendant group member runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-descendant-worker-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const marker = join(workspace, "descendant-worker.log");
  const pidFile = join(workspace, "descendant-worker.pid");
  await mkdir(workspace);
  const descendantCode = "const fs = require('node:fs'); fs.writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => fs.appendFileSync(process.env.MARKER, 'x'), 10);";
  const leaderCode = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', process.env.DESCENDANT_CODE], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 50);";
  let leaderPid;
  const piFactory = ({ cwd, onClose }) => {
    const leader = spawn(process.execPath, ["-e", leaderCode], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DESCENDANT_CODE: descendantCode, MARKER: marker, PID_FILE: pidFile },
    });
    leaderPid = leader.pid;
    leader.once("close", (code, signal) => onClose({ code, signal }));
    return { pid: leader.pid, processGroupId: leader.pid, prompt() {}, abort() {}, close() {} };
  };
  const service = new AgentService({ dbPath, piFactory });
  try {
    const agent = service.createAgent({ workspace });
    service.sendMessage(agent.agent.id, "Start a worker whose leader exits first");
    for (let attempt = 0; attempt < 100 && service.getAgent(agent.agent.id).turns[0].status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const failed = service.getAgent(agent.agent.id);
    assert.equal(failed.turns[0].status, "failed");
    assert.equal(service.db.prepare("SELECT worker_terminated FROM turns WHERE id = ?").get(failed.turns[0].id).worker_terminated, 0);
    const before = statSync(marker).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(statSync(marker).size > before, "a descendant must still be able to mutate the workspace");
    assert.throws(() => service.sendMessage(agent.agent.id, "Workspace must remain fenced"), /workspace remains unavailable/);
  } finally {
    service.close();
    if (leaderPid) {
      try { process.kill(-leaderPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
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
