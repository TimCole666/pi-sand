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
  // A signal-terminated child keeps exitCode null, so either terminal field
  // must make this helper safe to call repeatedly during teardown.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

function processInfo(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");
  const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
  return { pid, processGroupId: Number(fields[2]), sessionId: Number(fields[3]) };
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processStartIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");
  return stat.slice(closingParen + 2).trim().split(/\s+/)[19];
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

test("service restart best-effort stops an orphan worker but keeps its workspace fenced in the same boot", async () => {
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
      assert.equal(statSync(marker).size, afterReconcile, "the original process group must be best-effort stopped");
      assert.equal(service.db.prepare("SELECT worker_terminated FROM turns WHERE id = ?").get(ready.turnId).worker_terminated, 0, "PGID cleanup is not a same-boot safety proof");
      assert.throws(
        () => service.sendMessage(ready.agentId, "Use the workspace only after a proven boundary"),
        /This workspace remains unavailable because a prior Pi execution may still be able to run/,
      );
    } finally {
      service.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a setsid descendant survives service crash and keeps the same-boot workspace fenced", { skip: process.platform === "linux" ? false : "requires Linux process groups" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-escaped-worker-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const independentWorkspace = join(directory, "independent-workspace");
  const marker = join(workspace, "escaped-worker.log");
  const leaderPidFile = join(workspace, "leader.pid");
  const escapedPidFile = join(workspace, "escaped.pid");
  await mkdir(workspace);
  await mkdir(independentWorkspace);
  const escapedCode = "const fs = require('node:fs'); fs.writeFileSync(process.env.ESCAPED_PID_FILE, String(process.pid)); setInterval(() => fs.appendFileSync(process.env.MARKER, 'x'), 10);";
  const leaderCode = "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); spawn(process.execPath, ['-e', process.env.ESCAPED_CODE], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: process.env }); writeFileSync(process.env.LEADER_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);";
  const serviceUrl = new URL("../src/service.js", import.meta.url).href;
  const fixtureCode = `
    import { spawn } from "node:child_process";
    import { AgentService } from ${JSON.stringify(serviceUrl)};
    const service = new AgentService({ dbPath: process.env.DB_PATH, piFactory: ({ cwd }) => {
      const leader = spawn(process.execPath, ["-e", ${JSON.stringify(leaderCode)}], {
        cwd,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ESCAPED_CODE: ${JSON.stringify(escapedCode)},
          MARKER: process.env.MARKER,
          LEADER_PID_FILE: process.env.LEADER_PID_FILE,
          ESCAPED_PID_FILE: process.env.ESCAPED_PID_FILE,
        },
      });
      return { pid: leader.pid, processGroupId: leader.pid, prompt() {}, abort() {}, close() {} };
    }});
    const agent = service.createAgent({ name: "Escaped worker", workspace: process.env.WORKSPACE });
    const independent = service.createAgent({ name: "Independent", workspace: process.env.INDEPENDENT_WORKSPACE });
    const turn = service.sendMessage(agent.agent.id, "Keep the escaped worker mutating");
    console.log(JSON.stringify({ agentId: agent.agent.id, turnId: turn.id, independentId: independent.agent.id }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", fixtureCode], {
    env: { ...process.env, DB_PATH: dbPath, WORKSPACE: workspace, INDEPENDENT_WORKSPACE: independentWorkspace, MARKER: marker, LEADER_PID_FILE: leaderPidFile, ESCAPED_PID_FILE: escapedPidFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let replacement;
  let repeated;
  try {
    const ready = await waitForLine(child);
    for (let attempt = 0; attempt < 100 && !existsSync(escapedPidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(leaderPidFile), true, "the leader must publish its PID");
    assert.equal(existsSync(escapedPidFile), true, "the detached descendant must publish its PID");
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true, "the detached descendant must begin mutating the workspace");
    const leader = processInfo(Number(readFileSync(leaderPidFile, "utf8")));
    const escaped = processInfo(Number(readFileSync(escapedPidFile, "utf8")));
    assert.notEqual(leader.processGroupId, escaped.processGroupId, "setsid/detached spawn must escape the leader PGID");
    assert.notEqual(leader.sessionId, escaped.sessionId, "setsid/detached spawn must escape the leader session");
    assert.equal(leader.processGroupId, leader.pid);

    const beforeCrash = statSync(marker).size;
    child.kill("SIGKILL");
    await waitForExit(child);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(statSync(marker).size > beforeCrash, "the escaped descendant must continue after service A crashes");

    replacement = new AgentService({ dbPath, piFactory: completingPi });
    const restored = replacement.getAgent(ready.agentId);
    assert.equal(restored.turns[0].status, "interrupted");
    assert.match(restored.turns[0].terminalDetail, /not resumed/);
    assert.equal(replacement.db.prepare("SELECT worker_terminated FROM turns WHERE id = ?").get(ready.turnId).worker_terminated, 0);
    for (let attempt = 0; attempt < 100 && processGroupIsAlive(leader.processGroupId); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(processGroupIsAlive(leader.processGroupId), false, "the recorded leader group must be gone after best-effort cleanup");

    const afterCleanup = statSync(marker).size;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(statSync(marker).size > afterCleanup, "PGID cleanup must not stop the detached descendant");
    assert.throws(
      () => replacement.sendMessage(ready.agentId, "Do not overlap the escaped worker"),
      /This workspace remains unavailable because a prior Pi execution may still be able to run/,
    );

    const independentTurn = replacement.sendMessage(ready.independentId, "The independent workspace remains usable");
    assert.equal(independentTurn.status, "completed");
    assert.equal(replacement.getAgent(ready.independentId).turns[0].status, "completed");
    const finishedAt = restored.turns[0].finishedAt;
    replacement.close();
    replacement = null;

    repeated = new AgentService({ dbPath, piFactory: completingPi });
    const repeatedSnapshot = repeated.getAgent(ready.agentId);
    assert.equal(repeatedSnapshot.turns[0].status, "interrupted");
    assert.equal(repeatedSnapshot.turns[0].finishedAt, finishedAt, "restart reconciliation must terminalize the Turn exactly once");
    assert.equal(repeated.db.prepare("SELECT worker_terminated FROM turns WHERE id = ?").get(ready.turnId).worker_terminated, 0);
    assert.throws(
      () => repeated.sendMessage(ready.agentId, "Still fenced in the same boot"),
      /This workspace remains unavailable because a prior Pi execution may still be able to run/,
    );
  } finally {
    repeated?.close();
    replacement?.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (existsSync(escapedPidFile)) {
      const escapedPid = Number(readFileSync(escapedPidFile, "utf8"));
      try { process.kill(-escapedPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (existsSync(leaderPidFile)) {
      const leaderPid = Number(readFileSync(leaderPidFile, "utf8"));
      try { process.kill(-leaderPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a boot boundary releases an unresolved worker without signalling stale PID or PGID values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-boot-boundary-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const marker = join(workspace, "stale-worker-terminated");
  await mkdir(workspace);
  const worker = spawn(process.execPath, ["-e", "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.MARKER, 'terminated'); process.exit(0); }); setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MARKER: marker },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const workerInfo = processInfo(worker.pid);
    const first = new AgentService({ dbPath, piFactory: completingPi, bootId: "boot-A" });
    const agent = first.createAgent({ workspace });
    first.close();

    const db = new DatabaseSync(dbPath);
    const turnId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 'boot-A', 0)
    `).run(turnId, agent.agent.id, "Worker from the previous boot", timestamp, worker.pid, workerInfo.processGroupId, processStartIdentity(worker.pid));
    db.close();

    const second = new AgentService({ dbPath, piFactory: completingPi, bootId: "boot-B" });
    try {
      const restored = second.getAgent(agent.agent.id);
      assert.equal(restored.turns[0].status, "interrupted");
      assert.equal(second.db.prepare("SELECT worker_boot_id AS workerBootId, worker_terminated AS workerTerminated FROM turns WHERE id = ?").get(turnId).workerBootId, "boot-A");
      assert.equal(second.db.prepare("SELECT worker_terminated AS workerTerminated FROM turns WHERE id = ?").get(turnId).workerTerminated, 1);
      assert.equal(existsSync(marker), false, "a cross-boot reconciliation must not signal stale numeric process identity");
      assert.doesNotThrow(() => process.kill(worker.pid, 0), "the unrelated current-boot process must remain alive");

      const nextTurn = second.sendMessage(agent.agent.id, "Work after the proven boot boundary");
      assert.equal(nextTurn.status, "completed");
      assert.equal(second.getAgent(agent.agent.id).turns[1].status, "completed");
    } finally {
      second.close();
    }
  } finally {
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await waitForExit(worker).catch(() => {});
    try { process.kill(-worker.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-boot reconciliation keeps a workspace fenced when the recorded PGID is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-same-boot-fence-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const first = new AgentService({ dbPath, piFactory: completingPi, bootId: "boot-A" });
  const agent = first.createAgent({ workspace });
  first.close();

  try {
    const db = new DatabaseSync(dbPath);
    const turnId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_pid, worker_pgid, worker_start_identity, worker_boot_id, worker_terminated)
      VALUES (?, ?, ?, 'running', ?, 2000000000, 2000000000, 'no-such-process-start', 'boot-A', 0)
    `).run(turnId, agent.agent.id, "Worker from the same boot", timestamp);
    db.close();

    const second = new AgentService({ dbPath, piFactory: completingPi, bootId: "boot-A" });
    try {
      const restored = second.getAgent(agent.agent.id);
      assert.equal(restored.turns[0].status, "interrupted");
      assert.equal(second.db.prepare("SELECT worker_terminated AS workerTerminated FROM turns WHERE id = ?").get(turnId).workerTerminated, 0);
      assert.throws(
        () => second.sendMessage(agent.agent.id, "The absent PGID is not a safety proof"),
        /This workspace remains unavailable because a prior Pi execution may still be able to run/,
      );
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unavailable boot identity fails closed without signalling a live recorded group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-unknown-boot-"));
  const dbPath = join(directory, "state.sqlite");
  const workspace = join(directory, "workspace");
  const marker = join(workspace, "unknown-boot-terminated");
  await mkdir(workspace);
  const worker = spawn(process.execPath, ["-e", "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.MARKER, 'terminated'); process.exit(0); }); setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MARKER: marker },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const workerInfo = processInfo(worker.pid);
    const first = new AgentService({ dbPath, piFactory: completingPi, bootId: null });
    const agent = first.createAgent({ workspace });
    first.close();

    const db = new DatabaseSync(dbPath);
    const turnId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO turns (id, agent_id, user_message, status, started_at, worker_pid, worker_pgid, worker_start_identity, worker_terminated)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0)
    `).run(turnId, agent.agent.id, "Worker with unknown boot provenance", timestamp, worker.pid, workerInfo.processGroupId, processStartIdentity(worker.pid));
    db.close();

    const second = new AgentService({ dbPath, piFactory: completingPi, bootId: null });
    try {
      assert.equal(second.getAgent(agent.agent.id).turns[0].status, "interrupted");
      assert.equal(second.db.prepare("SELECT worker_terminated AS workerTerminated FROM turns WHERE id = ?").get(turnId).workerTerminated, 0);
      assert.equal(existsSync(marker), false, "unknown boot identity must suppress optional PID/PGID cleanup");
      assert.doesNotThrow(() => process.kill(worker.pid, 0), "the live group must remain untouched when boot identity is unknown");
      assert.throws(
        () => second.sendMessage(agent.agent.id, "Remain unavailable without a boot proof"),
        /This workspace remains unavailable because a prior Pi execution may still be able to run/,
      );
    } finally {
      second.close();
    }
  } finally {
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await waitForExit(worker).catch(() => {});
    try { process.kill(-worker.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
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
