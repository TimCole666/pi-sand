import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/runtime-store.js";
import { TaskRuntime } from "../src/task-runtime.js";

const linuxOnly = {
  skip:
    process.platform === "linux" ? false : "Linux-only runtime safety coverage",
};
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const model = { provider: "provider", id: "model" };

async function repository(parent) {
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", [
    "-C",
    source,
    "config",
    "user.email",
    "test@example.com",
  ]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "fixture.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  return source;
}

async function versionCommand(parent) {
  const command = join(parent, "pi-version");
  await writeFile(command, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(command, 0o755);
  return command;
}

const taskOptions = (source, selectedModel = model) => ({
  goal: "recover daemon-owned work",
  cwd: source,
  trusted: true,
  model: selectedModel,
  thinkingLevel: "high",
});
const startOptions = (source, workerFactory, piCommand) => ({
  dbPath: ":memory:",
  piCommand,
  workerFactory,
  worktreeRoot: join(source, "..", "worktrees"),
});

async function eventually(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for terminal Task state");
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

test(
  "legacy NOT NULL Attempt columns migrate before applied metadata is read",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-legacy-schema-"),
    );
    const dbPath = join(parent, "runtime.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, source_repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
        task_branch TEXT NOT NULL UNIQUE, task_worktree TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
        state TEXT NOT NULL, latest_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
        provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, worker_pid INTEGER, worker_pgid INTEGER,
        worker_terminated INTEGER NOT NULL DEFAULT 1, UNIQUE(task_id, number)
      );
      INSERT INTO tasks VALUES (
        'task-1', '/source', 'base', 'pi-sand/task-1', '/worktree', 'goal',
        'completed', 'attempt-1', '2020', '2020'
      );
      INSERT INTO attempts VALUES (
        'attempt-1', 'task-1', 1, 'provider', 'model', 'high', 'completed',
        '2020', '2020', NULL, NULL, 1
      );
    `);
    db.close();
    const runtime = new RuntimeStore({ dbPath, bootId: "boot" });
    try {
      const task = runtime.getTask("task-1");
      assert.equal(task.attempts[0].provider, null);
      assert.equal(task.attempts[0].modelId, null);
      assert.equal(task.attempts[0].thinkingLevel, null);
      assert.deepEqual(
        {
          ...runtime.db
            .prepare("SELECT provider, model_id, thinking_level FROM attempts")
            .get(),
        },
        { provider: "provider", model_id: "model", thinking_level: "high" },
      );
      const schema = runtime.db.prepare("PRAGMA table_info(attempts)").all();
      for (const name of ["provider", "model_id", "thinking_level"]) {
        assert.equal(schema.find((column) => column.name === name).notnull, 0);
      }
      runtime.close();
      const reopened = new TaskRuntime({ dbPath, bootId: "boot" });
      try {
        const taskAfterReopen = reopened.getTask("task-1");
        assert.equal(taskAfterReopen.attempts[0].provider, null);
        assert.equal(
          reopened.db.prepare("SELECT COUNT(*) AS count FROM attempts").get()
            .count,
          1,
        );
      } finally {
        reopened.close();
      }
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "prior-boot reconciliation leaves a retryable Attempt safely terminated",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-prior-boot-retry-"),
    );
    const source = await repository(parent);
    const command = await versionCommand(parent);
    const dbPath = join(parent, "runtime.sqlite");
    const worktreeRoot = join(parent, "worktrees");
    const first = new TaskRuntime({
      dbPath,
      piCommand: command,
      workerFactory: async () => ({ close() {} }),
      worktreeRoot,
      bootId: "boot-A",
    });
    let replacement;
    try {
      const started = await first.createTask(taskOptions(source));
      first.release();
      replacement = new TaskRuntime({
        dbPath,
        piCommand: command,
        workerFactory: async () => ({ close() {} }),
        worktreeRoot,
        bootId: "boot-B",
      });
      const interrupted = replacement.getTask(started.id);
      assert.equal(interrupted.state, "interrupted");
      assert.equal(interrupted.attempts[0].workerTerminated, true);
      const retried = await replacement.retryTask({
        id: started.id,
        trusted: true,
        model: { provider: "provider-2", id: "model-2" },
        thinkingLevel: "low",
      });
      assert.equal(retried.attempts.length, 2);
      assert.equal(retried.attempts[0].state, "interrupted");
      assert.equal(retried.attempts[0].workerTerminated, true);
      assert.equal(retried.attempts[1].state, "running");
      assert.equal(retried.attempts[1].provider, "provider-2");
    } finally {
      replacement?.close();
      first.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "recovery state changes keep Task and Attempt updates atomic",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-atomic-recovery-"),
    );
    let runtime;
    try {
      const source = await repository(parent);
      const command = await versionCommand(parent);
      const dbPath = join(parent, "runtime.sqlite");
      runtime = new RuntimeStore({
        dbPath,
        piCommand: command,
        workerFactory: () => ({ close() {} }),
        worktreeRoot: join(parent, "worktrees"),
        bootId: "boot-A",
      });
      const task = await runtime.createTask(taskOptions(source));
      runtime.release();
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TRIGGER fail_reconcile_task_update
      BEFORE UPDATE OF state ON tasks WHEN NEW.state = 'interrupted'
      BEGIN SELECT RAISE(ABORT, 'injected task update failure'); END`);
      db.close();

      const replacement = new RuntimeStore({
        dbPath,
        piCommand: command,
        worktreeRoot: join(parent, "worktrees"),
        bootId: "current-boot",
      });
      assert.throws(
        () => replacement.getTask(task.id),
        /injected task update failure/,
      );
      replacement.release();

      const restoredDb = new DatabaseSync(dbPath);
      assert.equal(
        restoredDb.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id)
          .state,
        "running",
      );
      assert.equal(
        restoredDb
          .prepare("SELECT state FROM attempts WHERE task_id = ?")
          .get(task.id).state,
        "running",
      );
      restoredDb.close();
    } finally {
      runtime?.release();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("Stop wins over a concurrent settled completion", linuxOnly, async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "pi-sand-runtime-stop-settle-race-"),
  );
  const source = await repository(parent);
  let child;
  let emit;
  const runtime = new TaskRuntime({
    dbPath: join(parent, "runtime.sqlite"),
    piCommand: await versionCommand(parent),
    workerFactory: ({ onEvent, onWorkerSpawn }) => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      const worker = { pid: child.pid, processGroupId: child.pid, close() {} };
      onWorkerSpawn(worker);
      emit = onEvent;
      return worker;
    },
    worktreeRoot: join(parent, "worktrees"),
    workerStopTimeoutMs: 100,
  });
  try {
    const started = await runtime.createTask(taskOptions(source));
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "settled result",
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });
    await eventually(
      () => runtime.getTask(started.id),
      (task) => task.attempts[0].attemptRuns[0].state === "settled",
    );
    const stopped = await runtime.stopTask(started.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(runtime.getTask(started.id).state, "stopped");
  } finally {
    killGroup(child);
    await waitForExit(child).catch(() => {});
    runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  "daemon shutdown wins over a concurrent settled completion",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-shutdown-settle-race-"),
    );
    const source = await repository(parent);
    let child;
    let emit;
    const runtime = new TaskRuntime({
      dbPath: join(parent, "runtime.sqlite"),
      piCommand: await versionCommand(parent),
      workerFactory: ({ onEvent, onWorkerSpawn }) => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        });
        const worker = {
          pid: child.pid,
          processGroupId: child.pid,
          close() {},
        };
        onWorkerSpawn(worker);
        emit = onEvent;
        return worker;
      },
      worktreeRoot: join(parent, "worktrees"),
      workerStopTimeoutMs: 100,
    });
    try {
      const started = await runtime.createTask(taskOptions(source));
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: "settled result",
          stopReason: "stop",
        },
      });
      emit({ type: "agent_settled" });
      await eventually(
        () => runtime.getTask(started.id),
        (task) => task.attempts[0].attemptRuns[0].state === "settled",
      );
      assert.equal(await runtime.shutdown("daemon-shutdown"), "interrupted");
      const interrupted = runtime.getTask(started.id);
      assert.equal(interrupted.state, "interrupted");
      assert.equal(interrupted.shutdownReason, "daemon-shutdown");
      assert.equal(interrupted.attempts[0].state, "interrupted");
    } finally {
      killGroup(child);
      await waitForExit(child).catch(() => {});
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "incomplete worker identity fails before the Attempt becomes running",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-worker-identity-"),
    );
    const source = await repository(parent);
    const command = await versionCommand(parent);
    const runtime = new RuntimeStore({
      ...startOptions(
        source,
        async () => ({ pid: 999999, processGroupId: 999999, close() {} }),
        command,
      ),
      dbPath: join(parent, "runtime.sqlite"),
    });
    try {
      await assert.rejects(
        runtime.createTask(taskOptions(source)),
        /identity metadata is incomplete/,
      );
      const failed = runtime.listTasks()[0];
      assert.equal(failed.state, "failed");
      assert.equal(failed.attempts[0].state, "failed");
      assert.equal(failed.attempts[0].workerPid, 999999);
      assert.equal(failed.attempts[0].provider, null);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "failed startup leaves applied Attempt metadata unset",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-applied-model-"),
    );
    const source = await repository(parent);
    const command = await versionCommand(parent);
    const runtime = new RuntimeStore({
      ...startOptions(
        source,
        async () => {
          throw new Error("model handshake failed");
        },
        command,
      ),
      dbPath: join(parent, "runtime.sqlite"),
    });
    try {
      await assert.rejects(
        runtime.createTask(taskOptions(source)),
        /model handshake failed/,
      );
      const failed = runtime.listTasks()[0];
      assert.equal(failed.state, "failed");
      assert.equal(failed.attempts[0].provider, null);
      assert.equal(failed.attempts[0].modelId, null);
      assert.equal(failed.attempts[0].thinkingLevel, null);
      assert.equal(
        runtime.db
          .prepare("SELECT provider, model_id, thinking_level FROM attempts")
          .get().provider,
        null,
      );
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "healthy settlement defers Git checkpointing until Supervisor verification",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-checkpoint-failure-"),
    );
    const source = await repository(parent);
    const command = await versionCommand(parent);
    const workerFactory = async ({ cwd, onEvent }) => {
      await mkdir(join(cwd, ".hooks"));
      await writeFile(join(cwd, ".hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
      await chmod(join(cwd, ".hooks", "pre-commit"), 0o755);
      execFileSync("git", ["config", "core.hooksPath", ".hooks"], { cwd });
      await writeFile(join(cwd, "partial.txt"), "partial\n");
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "result before finalization",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { pid: null, processGroupId: null, close() {} };
    };
    const runtime = new RuntimeStore({
      ...startOptions(source, workerFactory, command),
      dbPath: join(parent, "runtime.sqlite"),
    });
    try {
      const task = await runtime.createTask(taskOptions(source));
      const settled = await eventually(
        () => runtime.getTask(task.id),
        (value) => value.attempts[0].attemptRuns[0].state === "settled",
      );
      assert.equal(settled.state, "running");
      assert.equal(settled.finalResult, null);
      assert.equal(
        await readFile(join(settled.taskWorktree, "partial.txt"), "utf8"),
        "partial\n",
      );
      assert.match(
        git(settled.taskWorktree, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        /partial\.txt/,
      );
      assert.equal(settled.finalBranchHead, null);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "completion fails closed when the executor changes the Task branch",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-branch-identity-"),
    );
    const source = await repository(parent);
    const command = await versionCommand(parent);
    const workerFactory = async ({ cwd, onEvent }) => {
      execFileSync("git", ["switch", "--detach", "HEAD"], { cwd });
      onEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "wrong branch result",
          stopReason: "stop",
        },
      });
      onEvent({ type: "agent_settled" });
      return { pid: null, processGroupId: null, close() {} };
    };
    const runtime = new RuntimeStore({
      ...startOptions(source, workerFactory, command),
      dbPath: join(parent, "runtime.sqlite"),
    });
    try {
      const task = await runtime.createTask(taskOptions(source));
      const failed = await eventually(
        () => runtime.getTask(task.id),
        (value) => value.state !== "running",
      );
      assert.equal(failed.state, "failed");
      assert.match(
        failed.terminalDetail,
        /Git finalization failed.*branch identity changed/,
      );
      assert.equal(failed.finalBranchHead, null);
      assert.equal(failed.attempts[0].finalBranchHead, null);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "Retry keeps the Task non-running until the fresh Attempt starts",
  linuxOnly,
  async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "pi-sand-runtime-retry-starting-"),
    );
    const source = await repository(parent);
    const workers = [];
    let invocation = 0;
    let releaseRetry;
    const factory = ({ onWorkerSpawn }) => {
      invocation += 1;
      const startWorker = () => {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore" },
        );
        workers.push(child);
        const worker = {
          pid: child.pid,
          processGroupId: child.pid,
          close() {},
        };
        onWorkerSpawn(worker);
        return worker;
      };
      if (invocation === 1) return startWorker();
      return new Promise((resolveRetry) => {
        releaseRetry = () => resolveRetry(startWorker());
      });
    };
    const runtime = new TaskRuntime({
      dbPath: join(parent, "runtime.sqlite"),
      piCommand: await versionCommand(parent),
      workerFactory: factory,
      worktreeRoot: join(parent, "worktrees"),
      workerStopTimeoutMs: 25,
    });
    try {
      const started = await runtime.createTask(taskOptions(source));
      await runtime.stopTask(started.id);
      const retrying = runtime.retryTask({
        id: started.id,
        trusted: true,
        model: { provider: "p2", id: "m2" },
        thinkingLevel: "low",
      });
      for (let index = 0; index < 100; index += 1) {
        if (runtime.getTask(started.id)?.attempts.length === 2) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      const starting = runtime.getTask(started.id);
      assert.equal(starting.state, "accepted");
      assert.equal(starting.attempts[1].state, "starting");
      releaseRetry();
      const retried = await retrying;
      assert.equal(retried.state, "running");
    } finally {
      releaseRetry?.();
      for (const worker of workers) killGroup(worker);
      for (const worker of workers) await waitForExit(worker).catch(() => {});
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
