import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIsolatedCodexAppServerClient } from "/home/tiancaijb/tmp/pi-sand-openclaw/extensions/codex/src/app-server/shared-client.ts";
import { resolveCodexAppServerRuntimeOptions } from "/home/tiancaijb/tmp/pi-sand-openclaw/extensions/codex/src/app-server/config.ts";
import { terminateCodexBackgroundTerminals } from "/home/tiancaijb/tmp/pi-sand-openclaw/extensions/codex/src/app-server/attempt-client-cleanup.ts";

/**
 * Issue #76 Process Containment Verification Probe.
 *
 * Verifies the Protected Writer Class A invariant:
 * "Once T1 is retired and the execution placement/profile is torn down, no T1 descendant
 * retaining write capability to the authoritative workspace can survive into later T2 authority.
 * This must include descendants that attempt to escape ordinary parent/process-group lifetime."
 *
 * Matrix exercised:
 * - child: direct child process
 * - grandchild: child -> grandchild process
 * - background: background process via &
 * - new process group: process calling os.setpgid(0, 0)
 * - setsid / new session: process calling os.setsid()
 * - detached / double-fork: daemon double-forking with setsid()
 * - delayed writer: all writers delay 8s before writing their unique marker into the workspace.
 *
 * Profiles compared:
 * 1. negative-control: danger-full-access (uncontained)
 * 2. contained-profile: workspace-write (pinned candidate)
 */

const rootBase = process.env.PI_SAND_PROBE_ROOT ?? "/tmp/pi-sand-containment-probe";
const sourceCodexHome = process.env.PI_SAND_CODEX_HOME ?? path.join(os.homedir(), ".codex");

function setupEnv(root: string) {
  for (const key of Object.keys(process.env)) {
    if (!["PATH", "NODE_PATH", "TERM"].includes(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex-home"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
    XDG_STATE_HOME: path.join(root, "home", ".local", "state"),
    XDG_CACHE_HOME: path.join(root, "home", ".cache"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
  });
}

const PROBE_MARKERS = [
  { name: "child", file: "probe_child.marker" },
  { name: "grandchild", file: "probe_grandchild.marker" },
  { name: "background", file: "probe_background.marker" },
  { name: "new_pgroup", file: "probe_new_pgroup.marker" },
  { name: "setsid", file: "probe_setsid.marker" },
  { name: "double_fork", file: "probe_double_fork.marker" },
];

async function runScenario(scenarioName: string, sandboxMode: "danger-full-access" | "workspace-write") {
  console.log(`\n======================================================`);
  console.log(`STARTING SCENARIO: ${scenarioName} (mode: ${sandboxMode})`);
  console.log(`======================================================`);

  const root = path.join(rootBase, scenarioName);
  const workspace = path.join(root, "workspace");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(root, "codex-home"), { recursive: true });
  await fs.mkdir(path.join(root, "tmp"), { recursive: true });

  for (const name of ["config.toml", "cockpit-model-catalog.json"]) {
    try {
      await fs.copyFile(path.join(sourceCodexHome, name), path.join(root, "codex-home", name));
    } catch {}
  }

  // Create the probe runner python script inside workspace
  const runnerScript = `
import os, sys, subprocess, time

# Delayed write threshold: 8 seconds
DELAY = 8
ws = os.path.abspath(".")

# 1. ordinary child
subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({DELAY}); open('{ws}/probe_child.marker', 'w').write('CHILD')"])

# 2. child -> grandchild
subprocess.Popen([sys.executable, "-c", f"import subprocess, sys; subprocess.Popen([sys.executable, '-c', \\"import time; time.sleep({DELAY}); open('{ws}/probe_grandchild.marker', 'w').write('GRANDCHILD')\\"])"])

# 3. background process
subprocess.Popen(f"(sleep {DELAY}; printf BG > '{ws}/probe_background.marker') &", shell=True)

# 4. new process group
subprocess.Popen([sys.executable, "-c", f"import os, time; os.setpgid(0, 0); time.sleep({DELAY}); open('{ws}/probe_new_pgroup.marker', 'w').write('NEW_PGROUP')"])

# 5. setsid / new session
subprocess.Popen([sys.executable, "-c", f"import os, time; os.setsid(); time.sleep({DELAY}); open('{ws}/probe_setsid.marker', 'w').write('SETSID')"])

# 6. double fork / detached
subprocess.Popen([sys.executable, "-c", f"import os, sys, time; pid=os.fork(); sys.exit(0) if pid>0 else (os.setsid(), (os.fork()>0 and sys.exit(0)), time.sleep({DELAY}), open('{ws}/probe_double_fork.marker', 'w').write('DOUBLE_FORK'))"])

print("PROBE_LAUNCHER_STARTED")
sys.stdout.flush()

# Keep parent alive so command stays active until interrupted
time.sleep(30)
`;

  await fs.writeFile(path.join(workspace, "probe_runner.py"), runnerScript, "utf8");

  setupEnv(root);
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: { appServer: { homeScope: "user", sandbox: sandboxMode, approvalPolicy: "never", requestTimeoutMs: 120_000 } },
    modelProvider: "codex_local_access",
    model: "gpt-5.6-sol",
    env: process.env,
  });

  const client = await createIsolatedCodexAppServerClient({
    startOptions: runtime.start,
    agentDir: path.join(root, "agent"),
    authProfileId: null,
    timeoutMs: 120_000,
  });

  const events: Array<{ method: string; params: any }> = [];
  client.addNotificationHandler((notification) => {
    events.push({ method: notification.method, params: notification.params });
    if (notification.method === "item/started") {
      const item = notification.params?.item;
      console.log(`[EVENT] item/started: type=${item?.type}, id=${item?.id}`);
    } else if (notification.method === "turn/completed") {
      console.log(`[EVENT] turn/completed: status=${notification.params?.turn?.status ?? notification.params?.status}`);
    }
  });

  try {
    const threadStartParams: any = {
      cwd: workspace,
      model: "gpt-5.6-sol",
      modelProvider: "codex_local_access",
      approvalPolicy: "never",
      sandbox: sandboxMode,
    };
    const threadStarted: any = await client.request("thread/start", threadStartParams, { timeoutMs: 30_000 });
    const threadId = threadStarted.thread.id;
    console.log(`Thread started: ${threadId}, effectiveSandbox: ${JSON.stringify(threadStarted.sandbox)}`);

    const turnStartParams: any = {
      threadId,
      input: [{
        type: "text",
        text: "Use the terminal exactly once. Execute exactly this command: python3 probe_runner.py. Do not use any other tool. Keep the turn active after starting the command."
      }],
      approvalPolicy: "never",
      effort: "low",
    };
    if (sandboxMode === "workspace-write") {
      turnStartParams.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    } else {
      turnStartParams.sandboxPolicy = { type: "dangerFullAccess" };
    }

    const turnStarted: any = await client.request("turn/start", turnStartParams, { timeoutMs: 30_000 });
    const turnId = turnStarted.turn.id;
    console.log(`T1 started: ${turnId}`);

    // Wait until item/started commandExecution appears
    console.log("Waiting for commandExecution item/started...");
    const startTime = Date.now();
    let commandStarted = false;
    while (Date.now() - startTime < 60_000) {
      if (events.some(e => e.method === "item/started" && e.params?.item?.type === "commandExecution")) {
        commandStarted = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!commandStarted) {
      throw new Error("Timed out waiting for commandExecution item/started");
    }
    console.log("commandExecution started! Giving it 2 seconds to launch descendants...");
    await new Promise(r => setTimeout(r, 2000));

    // Now RETIRE / INTERRUPT T1
    console.log("Retiring/interrupting T1...");
    const interruptRes = await client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 });
    console.log("turn/interrupt response:", JSON.stringify(interruptRes));

    // Wait for turn/completed
    console.log("Waiting for T1 turn/completed...");
    while (Date.now() - startTime < 90_000) {
      if (events.some(e => e.method === "turn/completed" && (e.params?.turnId === turnId || e.params?.turn?.id === turnId))) {
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log("T1 turn completed!");

    // Check background terminals before cleanup
    const bgBefore: any = await client.request("thread/backgroundTerminals/list", { threadId }, { timeoutMs: 10_000 });
    console.log(`Background terminals before cleanup: ${bgBefore.data?.length ?? 0}`);

    // REAL PROFILE TEARDOWN OCCURS
    console.log("Performing real background terminal teardown...");
    await terminateCodexBackgroundTerminals(client, threadId);

    const bgAfter: any = await client.request("thread/backgroundTerminals/list", { threadId }, { timeoutMs: 10_000 });
    console.log(`Background terminals after cleanup: ${bgAfter.data?.length ?? 0}`);

    // Now start T2 (simulating fresh T2 authority admission)
    console.log("Admitting canonical fresh T2 on same thread...");
    const t2Turn: any = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply exactly T2_READY and do not use any tools." }],
      approvalPolicy: "never",
      effort: "low",
      ...(sandboxMode === "workspace-write"
        ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
        : { sandboxPolicy: { type: "dangerFullAccess" } }),
    }, { timeoutMs: 30_000 });
    console.log(`T2 turn started: ${t2Turn.turn.id}`);

    // Wait beyond delayed writer threshold (DELAY = 8s, we gave 2s before interrupt, so wait 12s)
    console.log("Waiting 12 seconds beyond delayed writer threshold (8s)...");
    await new Promise(r => setTimeout(r, 12_000));

    // Inspect workspace for markers
    const files = await fs.readdir(workspace);
    console.log(`Workspace files after wait:`, [...files].sort());

    const results: Record<string, boolean> = {};
    for (const marker of PROBE_MARKERS) {
      const exists = files.includes(marker.file);
      results[marker.name] = exists;
      console.log(`  Probe [${marker.name}]: marker '${marker.file}' exists? -> ${exists ? "YES (MUTATION SURVIVED)" : "NO (CONTAINED)"}`);
    }

    return {
      scenario: scenarioName,
      sandboxMode,
      effectiveSandbox: threadStarted.sandbox,
      bgBeforeCount: bgBefore.data?.length ?? 0,
      bgAfterCount: bgAfter.data?.length ?? 0,
      results,
    };
  } finally {
    await client.closeAndWait().catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(rootBase, { recursive: true });

  const negativeControl = await runScenario("negative-control", "danger-full-access");
  const containedProfile = await runScenario("contained-profile", "workspace-write");

  const summary = { negativeControl, containedProfile };

  console.log("\n======================================================");
  console.log("FINAL PROBE SUMMARY MATRIX:");
  console.log("======================================================");
  console.log(JSON.stringify(summary, null, 2));

  const summaryPath = path.join(rootBase, "containment-summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Wrote summary to ${summaryPath}`);
}

main().catch((err) => {
  console.error("FATAL ERROR in probe:", err);
  process.exit(1);
});
