import { spawn } from "node:child_process";

const commonArgs = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--approve", "--tools", "read,write,bash"];

/** Spawn the installed Pi RPC process using the concrete contract proven by the spike. */
export function spawnPi({ cwd, onEvent, onClose, command = process.env.PI_BIN ?? "pi" }) {
  const child = spawn(command, commonArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    prompt(message) { send({ id: `prompt-${Date.now()}`, type: "prompt", message }); },
    abort() { send({ id: `abort-${Date.now()}`, type: "abort" }); },
    close() { if (!closed) { closed = true; child.kill("SIGTERM"); } },
  };
}
