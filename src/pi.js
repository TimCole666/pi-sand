import { spawn } from "node:child_process";

// The product invokes Pi with the user's normal installed tools, extensions, and skills.
// The isolated spike keeps its restrictive flags because it intentionally probes a
// controlled contract; those flags are not product behavior.
const commonArgs = ["--mode", "rpc", "--no-session", "--approve"];

/** Spawn the installed Pi RPC process using the concrete contract proven by the spike. */
export function spawnPi({ cwd, onEvent, onClose, command = process.env.PI_BIN ?? "pi" }) {
  // A detached process group gives restart reconciliation a concrete liveness
  // boundary: terminating the Pi worker also terminates descendants that could
  // still mutate the Agent workspace.
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
