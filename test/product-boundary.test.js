import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { AgentService } from "../src/service.js";
import { databaseLockPath } from "../src/database-lock.js";
import { createAgentServer, isAllowedLocalOrigin, startServer } from "../src/server.js";
import { launchProduct, locateChromium, openDesktop } from "../src/launcher.js";

const chromiumPath = (() => {
  try { return locateChromium(); } catch { return null; }
})();

async function listen(server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  return `http://${host}:${server.address().port}`;
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dumpDom(url) {
  return new Promise((resolve, reject) => {
    const child = openDesktop(url, {
      spawnImpl: (command, args) => spawn(command, [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--dump-dom", "--virtual-time-budget=1000", ...args,
      ], { stdio: ["ignore", "pipe", "pipe"] }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Chromium exited with ${code}: ${stderr}`)));
    setTimeout(() => child.kill("SIGTERM"), 9_000).unref();
  });
}

test("only one Local Agent Service owns a database at a time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-owner-"));
  const dbPath = join(directory, "state.sqlite");
  const first = new AgentService({ dbPath });
  try {
    assert.equal(existsSync(databaseLockPath(dbPath)), true);
    assert.throws(
      () => new AgentService({ dbPath }),
      /Local Agent Service is already running for this database/,
    );
    const child = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      `import { AgentService } from ${JSON.stringify(new URL("../src/service.js", import.meta.url).href)}; try { new AgentService({ dbPath: process.env.PI_SAND_DB }).close(); process.exit(0); } catch (error) { console.error(error.message); process.exit(2); }`,
    ], { env: { ...process.env, PI_SAND_DB: dbPath }, encoding: "utf8" });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /already running for this database/);
    first.close();
    assert.equal(existsSync(databaseLockPath(dbPath)), false);
    const second = new AgentService({ dbPath });
    second.close();
  } finally {
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed AgentService bootstrap releases ownership so product Retry works in the same server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-bootstrap-retry-"));
  const dbPath = join(directory, "state.sqlite");
  const attachmentDirectory = `${dbPath}.attachments`;
  const oldDatabase = process.env.PI_SAND_DB;
  await writeFile(attachmentDirectory, "bootstrap blocker");
  process.env.PI_SAND_DB = dbPath;
  const runtime = startServer({ port: 0 });
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const failed = await fetch(`${base}/api/health`);
    assert.equal(failed.status, 503);
    assert.equal(runtime.service, undefined, "the degraded server must not retain a partially initialized service");
    assert.ok(runtime.startupError);
    assert.equal(existsSync(databaseLockPath(dbPath)), false, "failed initialization must release the database ownership marker");

    await rm(attachmentDirectory);
    const retried = await fetch(`${base}/api/health`);
    assert.equal(retried.status, 200);
    assert.ok(runtime.service, "Retry must establish the service without restarting the product host");
    assert.equal(runtime.startupError, null);
    assert.equal(existsSync(databaseLockPath(dbPath)), true);
  } finally {
    runtime.service?.close();
    await closeServer(runtime.server);
    if (oldDatabase === undefined) delete process.env.PI_SAND_DB;
    else process.env.PI_SAND_DB = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal Desktop launch invokes the located Chromium runtime directly", { skip: !chromiumPath }, () => {
  const calls = [];
  const child = { unref() {} };
  const command = locateChromium();
  openDesktop("http://127.0.0.1:4317", {
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], command);
  assert.deepEqual(calls[0][1], ["http://127.0.0.1:4317"]);
  assert.notEqual(command, "xdg-open");
});

test("the product server is loopback-only and rejects arbitrary browser-origin mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-origin-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite") });
  const server = startServer({ port: 0, service }).server;
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(server.address().address, "127.0.0.1");
    assert.equal(isAllowedLocalOrigin({ headers: { host: `127.0.0.1:${server.address().port}` } }), true);
    assert.equal(isAllowedLocalOrigin({ headers: { host: `127.0.0.1:${server.address().port}`, origin: "https://attacker.example" } }), false);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const denied = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ name: "Attacker", workspace: directory }),
    });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /only available to the pi-sand Desktop/);
    assert.deepEqual(service.listAgents(), []);

    const allowed = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: "Desktop", workspace: directory }),
    });
    assert.equal(allowed.status, 201);
  } finally {
    service.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launchProduct bootstraps a detached service on the fixed loopback endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-launch-"));
  const probeServer = createServer();
  const probe = await listen(probeServer);
  const port = Number(new URL(probe).port);
  await closeServer(probeServer);
  assert.ok(port > 0);
  // This seam smoke avoids leaking a detached browser process while proving
  // that a cold launch starts the service before opening the Desktop.
  const calls = [];
  let healthChecks = 0;
  const child = { pid: 1234, exitCode: null, unref() {} };
  const result = await launchProduct({
    port,
    dbPath: join(directory, "state.sqlite"),
    fetchImpl: async () => {
      healthChecks += 1;
      if (healthChecks === 1) throw new Error("service is down");
      return { ok: true, status: 200 };
    },
    spawnImpl: (...args) => { calls.push(args); return child; },
    openDesktopImpl: (url) => calls.push(["browser", url]),
    timeoutMs: 100,
  });
  assert.equal(result.started, true);
  assert.equal(result.url, `http://127.0.0.1:${port}`);
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls.at(-1)[0], "browser");
  await rm(directory, { recursive: true, force: true });
});

test("failed service bootstrap still opens the Desktop for product-level Retry", async () => {
  const calls = [];
  const child = { pid: 4321, exitCode: null, unref() {} };
  await assert.rejects(
    launchProduct({
      port: 4318,
      fetchImpl: async () => { throw new Error("connection refused"); },
      spawnImpl: () => child,
      openDesktopImpl: (url) => calls.push(url),
      timeoutMs: 10,
    }),
    /could not be reached during product launch/,
  );
  assert.deepEqual(calls, ["http://127.0.0.1:4318"], "the Desktop must open even when bootstrap cannot establish the service");
});

test("cold launch starts a real detached Local Agent Service without manual port selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-cold-launch-"));
  const probeServer = createServer();
  const probe = await listen(probeServer);
  const port = Number(new URL(probe).port);
  await closeServer(probeServer);
  let pid;
  try {
    const launched = await launchProduct({ port, dbPath: join(directory, "state.sqlite"), openBrowser: false });
    pid = launched.pid;
    assert.equal(launched.started, true);
    assert.ok(pid > 0);
    const health = await fetch(launched.url + "/api/health");
    assert.equal(health.status, 200);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitForProcessExit(pid);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("the supported Chromium Desktop renders the two-pane cold shell", { skip: !chromiumPath }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-chromium-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite") });
  const server = createAgentServer(service);
  const base = await listen(server);
  try {
    const dom = await dumpDom(base);
    assert.match(dom, /id="setup"/);
    assert.match(dom, /id="conversation"/);
    assert.match(dom, /grid-template-columns:280px/);
    assert.match(dom, /No saved agents yet\./);
  } finally {
    service.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});
