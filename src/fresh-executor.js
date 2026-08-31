import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const FRESH_PI_VERSION = "0.84.4";
export const FRESH_EXECUTOR_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--approve",
  "--no-extensions",
];
export const FRESH_EXECUTOR_VERSION_ERROR = "Fresh Executor requires Pi 0.84.4 exactly.";

export class FreshExecutorError extends Error {
  constructor(message, { code = "FRESH_EXECUTOR_STARTUP_FAILED", phase = "startup", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "FreshExecutorError";
    this.code = code;
    this.phase = phase;
  }
}

function parseExactVersion(output) {
  const version = String(output ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** Check the one Pi version permitted for a Fresh Executor before spawning it. */
export function checkFreshExecutorCompatibility({
  command = process.env.PI_BIN ?? "pi",
  cwd,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  let result;
  try {
    result = spawnSyncImpl(command, ["--version"], { cwd, env, encoding: "utf8" });
  } catch (error) {
    return { compatible: false, version: null, error };
  }
  if (result?.error || result?.status !== 0) {
    return { compatible: false, version: null, error: result?.error ?? null };
  }
  const version = parseExactVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return { compatible: version === FRESH_PI_VERSION, version, error: null };
}

function readProcessStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function readLinuxBootId() {
  if (process.platform !== "linux") return null;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return bootId || null;
  } catch {
    return null;
  }
}

function processMetadata(child) {
  const pid = Number(child.pid);
  const processGroupId = Number.isInteger(pid) && pid > 0 ? pid : null;
  const processStartIdentity = processGroupId ? readProcessStartIdentity(pid) : null;
  const bootId = processGroupId ? readLinuxBootId() : null;
  return {
    pid: processGroupId,
    processGroupId,
    processStartIdentity,
    bootId,
    // These names match the durable worker metadata vocabulary used by the
    // later runtime without introducing any Task persistence here.
    workerPid: processGroupId,
    workerPgid: processGroupId,
    workerStartIdentity: processStartIdentity,
    workerBootId: bootId,
  };
}

function startupError(message, options) {
  return new FreshExecutorError(message, options);
}

/**
 * One controlled Pi 0.84.4 RPC process. Configuration is deliberately not
 * exposed as fire-and-forget methods: start() is the only operation that can
 * establish readiness, and it completes only after the full handshake.
 */
class FreshExecutorClient {
  #options;
  #child;
  #buffer = "";
  #closed = false;
  #closing = false;
  #ready = false;
  #requestNumber = 0;
  #pending = new Map();
  #eventListeners = new Set();
  #closeListeners = new Set();
  #eventHistory = [];
  #transportError;
  #metadata;

  constructor(options) {
    this.#options = {
      command: process.env.PI_BIN ?? "pi",
      env: process.env,
      timeoutMs: 10_000,
      spawnImpl: spawn,
      spawnSyncImpl: spawnSync,
      ...options,
    };
    if (typeof this.#options.cwd !== "string" || this.#options.cwd.length === 0) {
      throw startupError("Fresh Executor requires a task worktree cwd.", { code: "INVALID_CWD" });
    }
    for (const field of ["provider", "modelId", "thinkingLevel", "taskPrompt"]) {
      if (typeof this.#options[field] !== "string" || this.#options[field].length === 0) {
        throw startupError(`Fresh Executor requires ${field}.`, { code: "INVALID_CONFIGURATION" });
      }
    }
  }

  async start() {
    const compatibility = checkFreshExecutorCompatibility({
      command: this.#options.command,
      cwd: this.#options.cwd,
      env: this.#options.env,
      spawnSyncImpl: this.#options.spawnSyncImpl,
    });
    if (!compatibility.compatible) {
      throw startupError(FRESH_EXECUTOR_VERSION_ERROR, {
        code: "INCOMPATIBLE_PI_VERSION",
        phase: "version",
      });
    }

    this.#spawn();
    try {
      const modelResponse = await this.#request("set_model", {
        provider: this.#options.provider,
        modelId: this.#options.modelId,
      });
      this.#requireSuccess(modelResponse, "set_model");
      if (modelResponse.data?.provider !== this.#options.provider || modelResponse.data?.id !== this.#options.modelId) {
        throw startupError("Fresh Executor set_model acknowledgement did not match the requested model.", {
          code: "MODEL_MISMATCH",
          phase: "set_model",
        });
      }

      const thinkingResponse = await this.#request("set_thinking_level", {
        level: this.#options.thinkingLevel,
      });
      this.#requireSuccess(thinkingResponse, "set_thinking_level");

      const stateResponse = await this.#request("get_state", {});
      this.#requireSuccess(stateResponse, "get_state");
      const state = stateResponse.data;
      if (state?.model?.provider !== this.#options.provider
        || state.model.id !== this.#options.modelId
        || state.thinkingLevel !== this.#options.thinkingLevel) {
        throw startupError("Fresh Executor get_state did not exactly match the requested configuration.", {
          code: "STATE_MISMATCH",
          phase: "get_state",
        });
      }

      const promptResponse = await this.#request("prompt", { message: this.#options.taskPrompt });
      if (promptResponse.success !== true) {
        throw startupError("Fresh Executor rejected the Task prompt.", {
          code: "PROMPT_REJECTED",
          phase: "prompt",
        });
      }
      this.#ready = true;
      return this.#handle();
    } catch (error) {
      const failure = error instanceof FreshExecutorError
        ? error
        : startupError("Fresh Executor RPC startup failed before Task inference.", {
          code: "RPC_STARTUP_FAILED",
          cause: error,
        });
      this.#terminate(failure);
      throw failure;
    }
  }

  #spawn() {
    try {
      this.#child = this.#options.spawnImpl(this.#options.command, [...FRESH_EXECUTOR_ARGS], {
        cwd: this.#options.cwd,
        detached: true,
        env: this.#options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw startupError("Fresh Executor could not be spawned.", { code: "SPAWN_FAILED", cause: error });
    }
    this.#metadata = processMetadata(this.#child);
    this.#child.stdout?.setEncoding?.("utf8");
    this.#child.stdout?.on("data", (chunk) => this.#onStdout(chunk));
    this.#child.stderr?.on("data", () => {
      if (!this.#ready) {
        this.#transportFailure(startupError("Fresh Executor wrote to stderr during startup.", {
          code: "RPC_STDERR",
          phase: "transport",
        }));
      }
    });
    this.#child.stdin?.on("error", (error) => this.#transportFailure(startupError("Fresh Executor stdin failed.", {
      code: "RPC_TRANSPORT_FAILED",
      phase: "transport",
      cause: error,
    })));
    this.#child.once("error", (error) => this.#transportFailure(startupError("Fresh Executor process failed.", {
      code: "RPC_TRANSPORT_FAILED",
      phase: "transport",
      cause: error,
    })));
    this.#child.once("close", (code, signal) => {
      this.#closed = true;
      if (this.#pending.size > 0) {
        this.#rejectPending(startupError("Fresh Executor closed during startup.", {
          code: "WORKER_CLOSED",
          phase: "transport",
        }));
      }
      for (const listener of this.#closeListeners) listener({ code, signal });
    });
  }

  #onStdout(chunk) {
    this.#buffer += String(chunk);
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) this.#onLine(line.slice(0, -1));
      else this.#onLine(line);
    }
  }

  #onLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#transportFailure(startupError("Fresh Executor emitted malformed JSONL during startup.", {
        code: "MALFORMED_RPC",
        phase: "transport",
        cause: error,
      }));
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending || message.command !== pending.command) {
        this.#transportFailure(startupError("Fresh Executor emitted an uncorrelated RPC response.", {
          code: "RPC_CORRELATION_FAILED",
          phase: "transport",
        }));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    this.#eventHistory.push(message);
    for (const listener of this.#eventListeners) listener(message);
  }

  #request(command, payload) {
    if (this.#transportError) return Promise.reject(this.#transportError);
    if (this.#closed || this.#closing) {
      return Promise.reject(startupError("Fresh Executor is closed.", { code: "WORKER_CLOSED", phase: "transport" }));
    }
    const id = `fresh-executor-${randomUUID()}-${++this.#requestNumber}`;
    const request = { id, type: command, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(startupError(`Fresh Executor ${command} acknowledgement timed out.`, {
          code: "RPC_TIMEOUT",
          phase: command,
        }));
      }, this.#options.timeoutMs);
      this.#pending.set(id, { command, resolve, reject, timer });
      try {
        this.#child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(startupError("Fresh Executor stdin failed.", {
          code: "RPC_TRANSPORT_FAILED",
          phase: "transport",
          cause: error,
        }));
      }
    });
  }

  #requireSuccess(response, command) {
    if (response.success !== true) {
      throw startupError(`Fresh Executor ${command} was rejected.`, {
        code: `${command.toUpperCase()}_FAILED`,
        phase: command,
      });
    }
  }

  #transportFailure(error) {
    if (this.#closed || this.#closing) return;
    this.#transportError ??= error;
    this.#rejectPending(error);
    if (this.#ready) {
      this.#eventHistory.push({ type: "executor_error", code: error.code });
      for (const listener of this.#eventListeners) listener(this.#eventHistory.at(-1));
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #terminate(error) {
    if (this.#closing) return;
    this.#closing = true;
    this.#rejectPending(error);
    const pid = this.#metadata?.processGroupId;
    if (!pid) {
      try { this.#child.kill?.("SIGTERM"); } catch { /* The process is already unavailable. */ }
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch (killError) {
      if (killError.code !== "ESRCH") {
        try { this.#child.kill("SIGTERM"); } catch { /* The process is already unavailable. */ }
      }
    }
  }

  #handle() {
    const client = this;
    if (typeof this.#options.onEvent === "function") this.#eventListeners.add(this.#options.onEvent);
    if (typeof this.#options.onClose === "function") this.#closeListeners.add(this.#options.onClose);
    return {
      args: [...FRESH_EXECUTOR_ARGS],
      ...this.#metadata,
      callbacksAttached: typeof this.#options.onEvent === "function" || typeof this.#options.onClose === "function",
      get events() { return [...client.#eventHistory]; },
      onEvent: (listener) => {
        client.#eventListeners.add(listener);
        return () => client.#eventListeners.delete(listener);
      },
      onClose: (listener) => {
        client.#closeListeners.add(listener);
        return () => client.#closeListeners.delete(listener);
      },
      close: () => {
        client.#terminate(startupError("Fresh Executor was closed by its owner.", {
          code: "WORKER_CLOSED",
          phase: "transport",
        }));
      },
    };
  }
}

/** Start one fresh executor and return it only after prompt acceptance. */
export async function startFreshExecutor(options) {
  const client = new FreshExecutorClient(options);
  return client.start();
}

// Keep the process-boundary name useful to callers while retaining one
// acknowledged startup operation and no fire-and-forget configuration API.
export const spawnFreshExecutor = startFreshExecutor;

export { processMetadata, readLinuxBootId, readProcessStartIdentity };
