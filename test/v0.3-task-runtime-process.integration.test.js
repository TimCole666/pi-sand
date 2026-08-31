import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerPiSandExtension } from "../extensions/runtime.js";
import { createExtensionHarness } from "./helpers/v0.2-extension-harness.js";
import { MAX_TASK_GOAL_LENGTH, buildTaskPacket } from "../src/task-runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
async function client(parent, env, method, params = {}) {
  const script = `import { RuntimeClient } from ${JSON.stringify(join(root, "src", "runtime-client.js"))}; const result = await new RuntimeClient().request(${JSON.stringify(method)}, ${JSON.stringify(params)}); process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolveClient, rejectClient) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: parent, env, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectClient); child.once("close", (code, signal) => code === 0 ? resolveClient(JSON.parse(stdout)) : rejectClient(new Error(`client exited ${code}/${signal}: ${stderr}`)));
  });
}
async function waitForFile(path) { for (let index = 0; index < 100; index += 1) { try { return await readFile(path, "utf8"); } catch { await wait(10); } } throw new Error(`timed out waiting for ${path}`); }

async function makeFixture(parent) {
  const source = join(parent, "source"); const fake = join(parent, "fake-pi.cjs"); const packet = join(parent, "packet.jsonl");
  execFileSync("git", ["init", "-q", source]); execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]); execFileSync("git", ["-C", source, "config", "user.name", "Test"]); await writeFile(join(source, "fixture.txt"), "base\n"); execFileSync("git", ["-C", source, "add", "."]); execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  await writeFile(fake, `#!/usr/bin/env node
const fs=require("node:fs");if(process.argv.includes("--version")){process.stdout.write("0.84.4\\n");process.exit(0)}let b="";process.stdin.on("data",c=>{b+=c;while(b.includes("\\n")){const i=b.indexOf("\\n"),x=JSON.parse(b.slice(0,i));b=b.slice(i+1);fs.appendFileSync(process.env.PI_SAND_PACKET,JSON.stringify(x)+"\\n");const r={type:"response",command:x.type,id:x.id,success:true};if(x.type==="set_model")r.data={provider:x.provider,id:x.modelId};if(x.type==="get_state")r.data={model:{provider:"provider",id:"model"},thinkingLevel:"high"};process.stdout.write(JSON.stringify(r)+"\\n")}});process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);`); await chmod(fake, 0o755);
  return { source, fake, packet };
}

test("client A disappears while daemon Task and worker remain reconnectable", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-tracer-")); const { source, fake, packet } = await makeFixture(parent); const env = { ...process.env, PI_BIN: fake, PI_SAND_PACKET: packet, XDG_RUNTIME_DIR: join(parent, "runtime"), PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite"), PI_SAND_TASK_WORKTREE_ROOT: join(parent, "worktrees") }; let daemonPid;
  try {
    const started = await client(parent, env, "task.create", { goal: "bounded goal", transcript: "SECRET_TRANSCRIPT", cwd: source, trusted: true, model: { provider: "provider", id: "model" }, thinkingLevel: "high" }); daemonPid = (await client(parent, env, "runtime.status")).daemonPid;
    assert.equal(started.task.state, "running"); assert.equal(started.task.attempts[0].state, "running"); assert.equal(git(source, ["rev-parse", "HEAD"]), started.task.baseCommit); assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal((await client(parent, env, "task.list")).tasks[0].id, started.task.id); assert.equal((await client(parent, env, "task.get", { id: started.task.id })).task.state, "running");
    const second = await client(parent, env, "task.create", { goal: "must fail capacity", cwd: source, trusted: true, model: { provider: "provider", id: "model" }, thinkingLevel: "high" }).catch((error) => error); assert.match(second.message, /already active/);
    const lines = (await waitForFile(packet)).trim().split("\n").map(JSON.parse); const prompts = lines.filter((line) => line.type === "prompt"); assert.equal(prompts.length, 1); assert.match(prompts[0].message, new RegExp(started.task.id)); assert.doesNotMatch(prompts[0].message, /SECRET_TRANSCRIPT|credential|token|api.key/i); assert.doesNotThrow(() => process.kill(daemonPid, 0));
  } finally { if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } } await wait(100); await rm(parent, { recursive: true, force: true }); }
});

test("daemon rejects dirty sources before Task acceptance and bounds packets", { skip: process.platform === "linux" ? false : "Linux-only" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v03-preflight-")); const { source } = await makeFixture(parent); await writeFile(join(source, "untracked.txt"), "dirty\n"); const env = { ...process.env, XDG_RUNTIME_DIR: join(parent, "runtime"), PI_SAND_RUNTIME_DB: join(parent, "runtime.sqlite") }; let daemonPid;
  try { const error = await client(parent, env, "task.create", { goal: "reject", cwd: source, trusted: true, model: { provider: "p", id: "m" }, thinkingLevel: "high" }).catch((failure) => failure); assert.match(error.message, /clean.*untracked/i); daemonPid = (await client(parent, env, "runtime.status")).daemonPid; assert.equal((await client(parent, env, "task.list")).tasks.length, 0); assert.equal(existsSync(join(parent, "worktrees")), false); assert.throws(() => buildTaskPacket({ taskId: "task", attemptNumber: 1, goal: "x".repeat(MAX_TASK_GOAL_LENGTH * 2), taskBranch: "branch", taskWorktree: "/tmp/worktree", baseCommit: "a".repeat(40) }), /bounded size/); } finally { if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } } await wait(50); await rm(parent, { recursive: true, force: true }); }
});

test("official Extension checks trust/auth and every Pi client lifecycle is a Task no-op", async () => {
  const createCalls = [];
  const controlCalls = [];
  const clientAdapter = {
    createTask: async (params) => { createCalls.push(params); return { id: "task-1", state: "running" }; },
    listTasks: async () => [],
    getTask: async () => ({ id: "task-1", state: "running" }),
    stopTask: async (id) => { controlCalls.push(["stop", id]); return { id, state: "stopped" }; },
    retryTask: async (params) => { controlCalls.push(["retry", params]); return { id: params.id, state: "running" }; },
  };
  const harness = createExtensionHarness();
  registerPiSandExtension(harness.pi, { runtimeClientFactory: () => clientAdapter });
  const base = { ...harness.context("manager"), model: { provider: "p", id: "m", apiKey: "secret" }, thinkingLevel: "high" };

  assert.equal((await harness.commands.get("task").handler("nope", { ...base, isProjectTrusted: () => false })).ok, false);
  assert.equal(createCalls.length, 0);
  assert.equal((await harness.commands.get("task").handler("nope", { ...base, isProjectTrusted: () => true, modelRegistry: { hasConfiguredAuth: () => false } })).ok, false);
  assert.equal(createCalls.length, 0);
  assert.equal((await harness.commands.get("task").handler("do it", { ...base, isProjectTrusted: () => true, modelRegistry: { hasConfiguredAuth: () => true } })).ok, true);
  assert.deepEqual(createCalls[0].model, { provider: "p", id: "m" });

  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    const context = { ...base, ...harness.context(reason) };
    await harness.invoke("session_start", { type: "session_start", reason }, context);
    await harness.invoke("agent_start", { type: "agent_start" }, context);
    await harness.invoke("session_shutdown", { type: "session_shutdown", reason }, context);
  }
  assert.equal(createCalls.length, 1);
  assert.deepEqual(controlCalls, [], "Pi client lifecycle must not stop or retry a daemon-owned Task");
});
