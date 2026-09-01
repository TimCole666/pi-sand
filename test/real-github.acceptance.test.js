// Opt-in v0.4 real GitHub proof. It intentionally uses a deterministic local
// Pi executable so this acceptance measures publication and exact-SHA CI, not
// model quality. The configured repository must run the required check on the
// dedicated pi-sand/<task-id> branch without a pull request.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeClient } from "../src/runtime-client.js";
import { PROTOCOL_VERSION } from "../src/runtime-ipc.js";

const enabled = process.env.PI_SAND_REAL_GITHUB === "1";
const source = process.env.PI_SAND_REAL_GITHUB_SOURCE;
const repository = process.env.PI_SAND_REAL_GITHUB_REPOSITORY;
const remote = process.env.PI_SAND_REAL_GITHUB_REMOTE;
const requiredChecks = (process.env.PI_SAND_REAL_GITHUB_CHECK ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const githubHost = process.env.PI_SAND_REAL_GITHUB_HOST ?? "github.com";
const daemonPath = new URL("../src/daemon.js", import.meta.url).pathname;
const configurationError = !source || !repository || !remote || requiredChecks.length === 0
  ? "configure PI_SAND_REAL_GITHUB_SOURCE, PI_SAND_REAL_GITHUB_REMOTE, PI_SAND_REAL_GITHUB_REPOSITORY, and PI_SAND_REAL_GITHUB_CHECK"
  : undefined;

function git(args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
}

async function fakePi(parent) {
  const command = join(parent, "real-github-fake-pi.cjs");
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { process.stdout.write("0.84.4\\n"); process.exit(0); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const response = { type: "response", command: request.type, id: request.id, success: true };
    if (request.type === "set_model") response.data = { provider: request.provider, id: request.modelId };
    if (request.type === "get_state") response.data = { model: { provider: "fixture", id: "real-github" }, thinkingLevel: "low", sessionId: "real-github-proof" };
    process.stdout.write(JSON.stringify(response) + "\\n");
    if (request.type === "prompt") {
      fs.writeFileSync("pi-sand-real-github-proof.txt", "real GitHub proof\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "candidate ready", stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  await chmod(command, 0o755);
  return command;
}

async function waitForReady(client, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await client.requestSocket("runtime.status", {}, PROTOCOL_VERSION, 250);
      if (response.success && response.data?.daemonPid === child.pid) return response.data;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("real GitHub proof daemon did not become ready");
}

async function waitForTask(client, id, predicate) {
  const deadline = Date.now() + Number(process.env.PI_SAND_REAL_GITHUB_TIMEOUT_MS ?? 900_000);
  let task;
  while (Date.now() < deadline) {
    task = await client.getTask(id);
    if (predicate(task)) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  throw new Error(`real GitHub proof timed out in state ${task?.state}`);
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await new Promise((resolveClose) => child.once("close", resolveClose));
}

test("v0.4 opt-in real GitHub exact-SHA publication and CI proof", {
  skip: !enabled
    ? "set PI_SAND_REAL_GITHUB=1 to run the credentialed real GitHub acceptance"
    : process.env.PI_SAND_REAL_GITHUB_PR_ONLY === "1"
      ? "unsupported: configured GitHub CI is PR-only; v0.4 does not create pull requests"
      : configurationError,
  timeout: Number(process.env.PI_SAND_REAL_GITHUB_TIMEOUT_MS ?? 900_000) + 30_000,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-real-github-"));
  const pi = await fakePi(parent);
  const env = {
    ...process.env,
    PI_BIN: pi,
    PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite"),
    PI_SAND_TASK_WORKTREE_ROOT: join(parent, "worktrees"),
    XDG_RUNTIME_DIR: join(parent, "runtime"),
  };
  const client = new RuntimeClient({ env });
  const daemon = spawn(process.execPath, [daemonPath, "--foreground"], {
    env,
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitForReady(client, daemon);
    assert.equal(git(["remote", "get-url", "--push", "origin"]), remote);
    const created = await client.createTask({
      goal: "publish and verify this real GitHub candidate",
      cwd: source,
      trusted: true,
      model: { provider: "fixture", id: "real-github" },
      thinkingLevel: "low",
      authority: {
        remotePublication: {
          remote: "origin",
          repositoryId: repository,
          githubHost,
          allowedRefPrefix: "refs/heads/pi-sand/",
          allowCreateOrFastForward: true,
          allowRewrite: false,
          allowDelete: false,
          allowPr: false,
          allowMerge: false,
          maxPublications: 3,
        },
      },
      completionContract: {
        objective: "publish and verify this real GitHub candidate",
        localGates: [{ id: "real-github-local", command: [process.execPath, "-e", "process.exit(0)"] }],
        requiredChecks,
      },
    });
    const waiting = await waitForTask(client, created.id, (task) => task.state === "waiting");
    const candidate = waiting.finalRevision;
    assert.equal(git(["ls-remote", "origin", `refs/heads/pi-sand/${created.id}`]).split("\t")[0], candidate);
    const completed = await waitForTask(client, created.id, (task) => task.state === "completed");
    assert.equal(completed.finalRevision, candidate);
    assert.equal(completed.terminalReason, "verified_ci");
    assert.ok(completed.resultDeliveries?.length === undefined || completed.resultDeliveries.length >= 1);
    assert.equal(await readFile(join(completed.taskWorktree, "pi-sand-real-github-proof.txt"), "utf8"), "real GitHub proof\n");
  } finally {
    await stopDaemon(daemon).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});
