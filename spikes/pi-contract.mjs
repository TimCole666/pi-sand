#!/usr/bin/env node
/**
 * Narrow, reproducible probe for the installed Pi subprocess contract.
 *
 * This is intentionally a process probe rather than a provider/runtime abstraction.
 * It captures the JSON event stream used by the Local Agent Service spike.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_BIN = process.env.PI_BIN ?? "pi";
const COMMON_ARGS = [
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--approve",
  "--tools",
  "read,write,bash",
];

function parseArgs(argv) {
  const [mode = "run", ...rest] = argv;
  const options = { mode, prompt: undefined, cwd: undefined, afterMs: 1_500, output: undefined };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--prompt") options.prompt = rest[++i];
    else if (arg === "--cwd") options.cwd = rest[++i];
    else if (arg === "--after-ms") options.afterMs = Number(rest[++i]);
    else if (arg === "--output") options.output = rest[++i];
    else if (arg === "--help" || arg === "-h") return { mode: "help" };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.afterMs) || options.afterMs < 0) throw new Error("--after-ms must be a non-negative number");
  return options;
}

function usage() {
  return `Usage:
  node spikes/pi-contract.mjs run [--cwd DIR] [--prompt TEXT] [--output FILE]
  node spikes/pi-contract.mjs interrupt [--cwd DIR] [--prompt TEXT] [--after-ms MS] [--output FILE]
  node spikes/pi-contract.mjs crash [--cwd DIR] [--prompt TEXT] [--after-ms MS] [--output FILE]
  node spikes/pi-contract.mjs self-test

Modes run Pi with --mode json, or --mode rpc for interrupt/crash probes. The default
prompt is deliberately read-only; use --cwd to point at a controlled workspace.`;
}

function parseJsonLines(text) {
  return text.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on output line ${index + 1}: ${error.message}`);
    }
  });
}

function eventSummary(events) {
  const summary = {
    session: events.find((event) => event.type === "session") ?? null,
    eventTypes: [...new Set(events.map((event) => event.type))],
    textDeltas: events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      .map((event) => event.assistantMessageEvent.delta)
      .join(""),
    toolExecutions: events
      .filter((event) => event.type === "tool_execution_start")
      .map((event) => ({ id: event.toolCallId, name: event.toolName, args: event.args })),
    assistantEnds: events
      .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
      .map((event) => ({ stopReason: event.message.stopReason, errorMessage: event.message.errorMessage })),
    terminalEvents: events.filter((event) => ["agent_end", "agent_settled"].includes(event.type)).map((event) => event.type),
    state: events.find((event) => event.type === "response" && event.command === "get_state")?.data ?? null,
  };
  return summary;
}

function appendLine(state, chunk) {
  state.buffer += chunk.toString();
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (line.length > 0) state.lines.push(line);
  }
}

function spawnProbe({ mode, cwd, prompt, afterMs }) {
  const rpc = mode !== "run";
  const args = rpc ? ["--mode", "rpc", ...COMMON_ARGS] : ["--mode", "json", ...COMMON_ARGS, "-p", prompt];
  const child = spawn(PI_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const state = { buffer: "", lines: [], stderr: "", sentAbort: false, stateRequested: false, settled: false };

  child.stdout.on("data", (chunk) => {
    appendLine(state, chunk);
    if (rpc && !state.stateRequested && state.lines.some((line) => line.includes('"command":"prompt"'))) {
      state.stateRequested = true;
      child.stdin.write(`${JSON.stringify({ id: "probe-state", type: "get_state" })}\n`);
    }
    if (mode === "interrupt" && !state.sentAbort && state.lines.some((line) => line.includes('"type":"agent_start"'))) {
      state.sentAbort = true;
      setTimeout(() => child.stdin.write(`${JSON.stringify({ id: "probe-abort", type: "abort" })}\n`), afterMs);
    }
    if (rpc && state.lines.some((line) => line.includes('"type":"agent_settled"'))) state.settled = true;
  });
  child.stderr.on("data", (chunk) => { state.stderr += chunk.toString(); });

  if (rpc) child.stdin.write(`${JSON.stringify({ id: "probe-prompt", type: "prompt", message: prompt })}\n`);
  else child.stdin.end();

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (state.buffer.trim()) state.lines.push(state.buffer.trim());
      const events = parseJsonLines(state.lines.join("\n"));
      resolve({ code, signal, events, stderr: state.stderr, summary: eventSummary(events), settled: state.settled });
    });
    if (mode === "crash") {
      setTimeout(() => child.kill("SIGKILL"), afterMs);
    }
    // RPC mode intentionally stays open after a settled run; end the probe once the
    // terminal agent event has arrived. A graceful stdin close is not a Pi command.
    if (mode === "interrupt") {
      const poll = setInterval(() => {
        if (state.settled) {
          clearInterval(poll);
          child.kill("SIGTERM");
        }
      }, 25);
      child.once("close", () => clearInterval(poll));
    }
  });
}

async function makeWorkspace(cwd) {
  if (cwd) return { path: cwd, cleanup: async () => {} };
  const path = await mkdtemp(join(tmpdir(), "pi-sand-contract-"));
  await writeFile(join(path, "fixture.txt"), "contract fixture\n");
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function run(options) {
  const workspace = await makeWorkspace(options.cwd);
  const prompt = options.prompt ?? "Read fixture.txt and respond with exactly CONTRACT_OK. Do not modify files.";
  try {
    const result = await spawnProbe({ ...options, cwd: workspace.path, prompt });
    const report = {
      probe: options.mode,
      piBinary: PI_BIN,
      cwd: workspace.path,
      prompt,
      process: { exitCode: result.code, signal: result.signal },
      summary: result.summary,
      stderr: result.stderr || undefined,
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(options.output, output);
    process.stdout.write(output);
    // A crash is expected to be signalled; a normal probe must produce agent_end.
    if (options.mode === "run" && (result.code !== 0 || !result.summary.terminalEvents.includes("agent_end"))) process.exitCode = 1;
    if (options.mode === "interrupt" && !result.summary.assistantEnds.some((message) => message.stopReason === "aborted")) process.exitCode = 1;
    if (options.mode === "crash" && result.signal !== "SIGKILL") process.exitCode = 1;
  } finally {
    await workspace.cleanup();
  }
}

function selfTest() {
  const events = parseJsonLines([
    '{"type":"session","version":3,"id":"session-1","cwd":"/tmp/workspace"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}',
    '{"type":"tool_execution_start","toolCallId":"call-1","toolName":"read","args":{"path":"fixture.txt"}}',
    '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}',
    '{"type":"agent_end","messages":[]}',
  ].join("\n"));
  const summary = eventSummary(events);
  if (summary.session.id !== "session-1") throw new Error("session header was not parsed");
  if (summary.textDeltas !== "hello") throw new Error("text deltas were not assembled");
  if (summary.toolExecutions[0].name !== "read") throw new Error("tool event was not captured");
  if (!summary.terminalEvents.includes("agent_end")) throw new Error("agent completion was not captured");
  console.log("self-test passed");
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === "help") console.log(usage());
else if (options.mode === "self-test") selfTest();
else if (["run", "interrupt", "crash"].includes(options.mode)) await run(options);
else throw new Error(`Unknown mode: ${options.mode}`);
