import { spawn, spawnSync } from "node:child_process";

export const SUPPORTED_PI_VERSION = "0.84.2";
export const PI_LIFECYCLE_ERROR = "Pi is unavailable or incompatible with the required lifecycle contract.";

/**
 * The production adapter is intentionally pinned to the Pi release whose RPC
 * prompt/abort/agent_settled contract was probed in the v0.1 spike. This is a
 * narrow product preflight, not a provider/runtime compatibility layer.
 */
export function checkPiCompatibility({ command = process.env.PI_BIN ?? "pi", cwd } = {}) {
  let result;
  try {
    result = spawnSync(command, ["--version"], { cwd, encoding: "utf8" });
  } catch (error) {
    return { compatible: false, version: null, error };
  }
  if (result.error || result.status !== 0) return { compatible: false, version: null, error: result.error };
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  return { compatible: version === SUPPORTED_PI_VERSION, version, error: null };
}

// The product invokes Pi with the user's normal installed tools, extensions, and skills.
// The isolated spike keeps its restrictive flags because it intentionally probes a
// controlled contract; those flags are not product behavior.
const commonArgs = ["--mode", "rpc", "--no-session", "--approve"];

/** Spawn the installed Pi RPC process using the concrete contract proven by the spike. */
export function spawnPi({ cwd, onEvent, onClose, command = process.env.PI_BIN ?? "pi" }) {
  // A detached process group is only best-effort cleanup. Pi tools may create
  // descendants outside this group, so group disappearance is not a complete
  // workspace-safety proof; service reconciliation also uses the Linux boot ID.
  const child = spawn(command, commonArgs, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let closed = false;
  const send = (value) => { if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch { /* Pi's stdout contract is JSONL; ignore a malformed diagnostic line. */ }
    }
  });
  child.once("error", (error) => { if (!closed) onClose({ code: null, signal: null, error }); });
  child.once("close", (code, signal) => { closed = true; onClose({ code, signal }); });
  return {
    prompt({ id, message }) { send({ id, type: "prompt", message }); },
    abort() { send({ id: `abort-${Date.now()}`, type: "abort" }); },
    pid: child.pid,
    processGroupId: child.pid,
    close() {
      if (closed) return;
      closed = true;
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") child.kill("SIGTERM"); }
    },
  };
}
