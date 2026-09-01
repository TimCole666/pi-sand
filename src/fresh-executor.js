import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readProcessIdentity, stopOwnedProcessGroupSync, WORKER_STOP_TIMEOUT_MS } from "./process.js";

export const FRESH_PI_VERSION = "0.84.4";
export const FRESH_EXECUTOR_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--approve",
  "--no-extensions",
];
export const FRESH_REVIEWER_ARGS = [
  ...FRESH_EXECUTOR_ARGS,
  "--tools",
  "read,grep,find,ls",
];
export const FRESH_EXECUTOR_VERSION_ERROR = "Fresh Executor requires Pi 0.84.4 exactly.";

function argsForRole(role) {
  return role === "reviewer" ? FRESH_REVIEWER_ARGS : FRESH_EXECUTOR_ARGS;
}

function environmentForRole(role, env) {
  if (role !== "reviewer") return env;
  const restricted = { ...env };
  // A reviewer has no daemon or runtime IPC authority. It retains provider
  // credentials so Pi can answer the review, but cannot discover the shared
  // Task database/socket through inherited configuration.
  for (const key of ["PI_SAND_RUNTIME_DB", "PI_SAND_SOCKET", "PI_SAND_DB", "PI_SAND_TASK_WORKTREE_ROOT"])
    delete restricted[key];
  return restricted;
}

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

function processMetadata(child) {
  const pid = Number(child.pid);
  const processGroupId = Number.isInteger(pid) && pid > 0 ? pid : null;
  const identity = processGroupId ? readProcessIdentity(processGroupId) : null;
  return {
    pid: processGroupId,
    processGroupId,
    processStartIdentity: identity?.processStartIdentity ?? null,
    bootId: identity?.bootId ?? null,
    // These names match the durable worker metadata vocabulary used by the
    // later runtime without introducing any Task persistence here.
    workerPid: processGroupId,
    workerPgid: processGroupId,
    workerStartIdentity: identity?.processStartIdentity ?? null,
    workerBootId: identity?.bootId ?? null,
  };
}

function startupError(message, options) {
  return new FreshExecutorError(message, options);
}

function environmentDigest(env) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(env ?? {})
          .map(([key, value]) => [key, String(value)])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      "utf8",
    )
    .digest("hex");
}

function frozenExecutionSnapshot(snapshot) {
  return Object.freeze({
    ...snapshot,
    args: Object.freeze([...(snapshot.args ?? [])]),
  });
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
  #promptGeneration = 0;
  #pendingPromptGeneration = null;
  #promptInFlight = false;
  #promptAmbiguous = false;
  #promptStatus = "none";
  #awaitingAgentStart = false;
  #settled = false;
  #sessionId = null;
  #sessionIdentityChanged = false;
  #executionSnapshot;
  #args;

  constructor(options) {
    const role = options?.role === "reviewer" ? "reviewer" : "executor";
    this.#options = {
      command: process.env.PI_BIN ?? "pi",
      env: process.env,
      timeoutMs: 10_000,
      workerStopTimeoutMs: WORKER_STOP_TIMEOUT_MS,
      spawnImpl: spawn,
      spawnSyncImpl: spawnSync,
      ...options,
      role,
    };
    this.#options.env = environmentForRole(role, this.#options.env);
    this.#args = [...argsForRole(role)];
    if (typeof this.#options.cwd !== "string" || this.#options.cwd.length === 0) {
      throw startupError("Fresh Executor requires a task worktree cwd.", { code: "INVALID_CWD" });
    }
    for (const field of ["provider", "modelId", "thinkingLevel", "taskPrompt"]) {
      if (typeof this.#options[field] !== "string" || this.#options[field].length === 0) {
        throw startupError(`Fresh Executor requires ${field}.`, { code: "INVALID_CONFIGURATION" });
      }
    }
    this.#executionSnapshot = frozenExecutionSnapshot({
      command: this.#options.command,
      cwd: this.#options.cwd,
      args: this.#args,
      role: this.#options.role,
      provider: this.#options.provider,
      modelId: this.#options.modelId,
      thinkingLevel: this.#options.thinkingLevel,
      environmentDigest: environmentDigest(this.#options.env),
      sessionId: null,
    });
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

    try {
      this.#spawn();
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

      this.#sessionId =
        typeof state.sessionId === "string" && state.sessionId.length > 0
          ? state.sessionId
          : null;
      this.#executionSnapshot = frozenExecutionSnapshot({
        ...this.#executionSnapshot,
        sessionId: this.#sessionId,
      });
      // This is a synchronous final launch fence. Do not await or yield after
      // it: the next operation writes the initial prompt request immediately.
      this.#options.beforeInitialPrompt?.();
      const promptGeneration = this.#promptGeneration + 1;
      this.#pendingPromptGeneration = promptGeneration;
      this.#promptStatus = "pending";
      const promptResponse = await this.#request(
        "prompt",
        { message: this.#options.taskPrompt },
        { promptGeneration, requiresAgentStart: false },
      );
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
      const workerTerminated = await this.#terminate(failure);
      failure.workerMetadata = this.#metadata;
      failure.workerTerminated = workerTerminated;
      throw failure;
    }
  }

  #spawn() {
    try {
      this.#child = this.#options.spawnImpl(this.#options.command, [...this.#args], {
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
    // Install every transport and cleanup handler before notifying the daemon
    // that the worker exists. If that callback fails, start() can still
    // retire the recorded process group without losing the worker identity.
    this.#options.onWorkerSpawn?.(this.#metadata);
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
      if (pending.command === "prompt") {
        if (message.success === true) {
          this.#promptGeneration = pending.promptGeneration;
          this.#pendingPromptGeneration = null;
          this.#promptStatus = "accepted";
          this.#awaitingAgentStart = pending.requiresAgentStart === true;
          this.#settled = false;
        } else {
          this.#promptStatus = "rejected";
          this.#awaitingAgentStart = false;
          if (this.#pendingPromptGeneration === pending.promptGeneration)
            this.#pendingPromptGeneration = null;
        }
      }
      pending.resolve(message);
      return;
    }
    const metadata = this.#eventMetadata();
    if (message.type === "session") {
      const sessionId = message.id ?? message.sessionId;
      if (
        typeof sessionId === "string" &&
        this.#sessionId &&
        this.#sessionId !== sessionId
      ) {
        this.#sessionIdentityChanged = true;
        if (this.#promptInFlight) this.#promptAmbiguous = true;
      }
    }
    if (metadata.promptAcknowledged && message.type === "agent_start") {
      this.#awaitingAgentStart = false;
      this.#settled = false;
    }
    if (
      metadata.promptAcknowledged &&
      message.type === "agent_settled" &&
      !this.#awaitingAgentStart
    )
      this.#settled = true;
    this.#eventHistory.push(message);
    for (const listener of this.#eventListeners) listener(message, metadata);
  }

  #eventMetadata() {
    return { promptAcknowledged: this.#promptStatus === "accepted" };
  }

  #request(
    command,
    payload,
    { promptGeneration = null, requiresAgentStart = false } = {},
  ) {
    if (this.#transportError) return Promise.reject(this.#transportError);
    if (this.#closed || this.#closing) {
      return Promise.reject(startupError("Fresh Executor is closed.", { code: "WORKER_CLOSED", phase: "transport" }));
    }
    const id = `fresh-executor-${randomUUID()}-${++this.#requestNumber}`;
    const request = { id, type: command, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (command === "prompt" && this.#pendingPromptGeneration === promptGeneration)
          this.#pendingPromptGeneration = null;
        reject(startupError(`Fresh Executor ${command} acknowledgement timed out.`, {
          code: "RPC_TIMEOUT",
          phase: command,
        }));
      }, this.#options.timeoutMs);
      this.#pending.set(id, {
        command,
        resolve,
        reject,
        timer,
        promptGeneration,
        requiresAgentStart,
      });
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
    if (this.#promptInFlight) this.#promptAmbiguous = true;
    this.#rejectPending(error);
    if (this.#ready) {
      this.#eventHistory.push({ type: "executor_error", code: error.code });
      const metadata = this.#eventMetadata();
      for (const listener of this.#eventListeners)
        listener(this.#eventHistory.at(-1), metadata);
    }
  }

  async #prompt(message) {
    if (typeof message !== "string" || message.length === 0)
      throw startupError("Fresh Executor continuation prompt is required.", {
        code: "INVALID_PROMPT",
        phase: "prompt",
      });
    if (!this.#ready)
      throw startupError("Fresh Executor is not ready for a continuation prompt.", {
        code: "WORKER_NOT_READY",
        phase: "prompt",
      });
    if (this.#promptAmbiguous)
      throw startupError("Fresh Executor cannot reuse an ambiguous prompt outcome.", {
        code: "PROMPT_AMBIGUOUS",
        phase: "prompt",
      });
    if (typeof this.#sessionId !== "string" || this.#sessionId.length === 0)
      throw startupError("Fresh Executor session identity is unavailable; reuse is refused.", {
        code: "SESSION_ID_UNAVAILABLE",
        phase: "prompt",
      });
    if (this.#sessionIdentityChanged)
      throw startupError("Fresh Executor session identity changed; reuse is refused.", {
        code: "SESSION_IDENTITY_CHANGED",
        phase: "prompt",
      });
    if (this.#promptInFlight)
      throw startupError("Fresh Executor already has a prompt in flight.", {
        code: "PROMPT_IN_FLIGHT",
        phase: "prompt",
      });
    if (!this.#settled)
      throw startupError("Fresh Executor is not settled for a continuation prompt.", {
        code: "PROMPT_NOT_SETTLED",
        phase: "prompt",
      });

    const promptGeneration = this.#promptGeneration + 1;
    this.#pendingPromptGeneration = promptGeneration;
    this.#promptStatus = "pending";
    this.#promptInFlight = true;
    this.#settled = false;
    try {
      const response = await this.#request(
        "prompt",
        { message },
        { promptGeneration, requiresAgentStart: true },
      );
      if (response.success !== true)
        throw startupError("Fresh Executor rejected the continuation prompt.", {
          code: "PROMPT_REJECTED",
          phase: "prompt",
        });
      this.#promptInFlight = false;
      if (this.#sessionIdentityChanged) {
        throw startupError("Fresh Executor session identity changed; reuse is refused.", {
          code: "SESSION_IDENTITY_CHANGED",
          phase: "prompt",
        });
      }
      return { accepted: true, promptGeneration };
    } catch (error) {
      if (this.#pendingPromptGeneration === promptGeneration)
        this.#pendingPromptGeneration = null;
      this.#promptInFlight = false;
      if (error.code === "PROMPT_REJECTED") {
        this.#settled = true;
        this.#awaitingAgentStart = false;
      } else {
        this.#promptAmbiguous = true;
      }
      throw error;
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #terminate(error) {
    if (this.#closing) return this.#metadata ? stopOwnedProcessGroupSync(this.#metadata, {
      timeoutMs: this.#options.workerStopTimeoutMs,
    }) : true;
    this.#closing = true;
    this.#rejectPending(error);
    if (!this.#metadata?.processGroupId) {
      try { this.#child.kill?.("SIGTERM"); } catch { /* The process is already unavailable. */ }
      return true;
    }
    return stopOwnedProcessGroupSync({
      workerPid: this.#metadata.pid,
      workerPgid: this.#metadata.processGroupId,
      workerStartIdentity: this.#metadata.processStartIdentity,
      workerBootId: this.#metadata.bootId,
    }, {
      timeoutMs: this.#options.workerStopTimeoutMs,
    });
  }

  #handle() {
    const client = this;
    if (typeof this.#options.onEvent === "function") this.#eventListeners.add(this.#options.onEvent);
    if (typeof this.#options.onClose === "function") this.#closeListeners.add(this.#options.onClose);
    return {
      args: [...this.#args],
      role: this.#options.role,
      ...this.#metadata,
      callbacksAttached: typeof this.#options.onEvent === "function" || typeof this.#options.onClose === "function",
      get events() { return [...client.#eventHistory]; },
      get sessionId() { return client.#sessionId; },
      get promptGeneration() { return client.#promptGeneration; },
      get executionSnapshot() {
        return client.#executionSnapshot;
      },
      get sessionIdentityChanged() { return client.#sessionIdentityChanged; },
      prompt: (message) => client.#prompt(message),
      onEvent: (listener) => {
        client.#eventListeners.add(listener);
        return () => client.#eventListeners.delete(listener);
      },
      onClose: (listener) => {
        client.#closeListeners.add(listener);
        return () => client.#closeListeners.delete(listener);
      },
      close: () => {
        void client.#terminate(startupError("Fresh Executor was closed by its owner.", {
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

export { processMetadata };
export { readLinuxBootId, readProcessStartIdentity } from "./process.js";
