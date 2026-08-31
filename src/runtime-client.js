import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  MAX_PROTOCOL_LINE_LENGTH,
  PROTOCOL_VERSION,
  ensureOwnerOnlyDirectory,
  runtimeDatabasePath,
  runtimeSocketPath,
} from "./runtime-ipc.js";

export const CLIENT_PROTOCOL_MISMATCH_ERROR = "The pi-sand runtime protocol is incompatible with this client.";
export const RUNTIME_UNAVAILABLE_ERROR = "The pi-sand runtime could not be reached.";
export const MUTATION_OUTCOME_UNKNOWN_ERROR = "The Task mutation outcome is unknown; inspect /tasks before trying again.";
const MUTATING_METHODS = new Set(["task.create", "task.stop", "task.retry"]);
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function messageFromError(error) {
  return String(error?.message ?? error ?? RUNTIME_UNAVAILABLE_ERROR);
}

function protocolMismatch(detail) {
  return new Error(`${CLIENT_PROTOCOL_MISMATCH_ERROR} ${detail}`.trim());
}

function responseError(response) {
  const error = response.error;
  if (error && typeof error === "object") {
    const result = new Error(String(error.message || "runtime request failed"));
    result.code = error.code;
    return result;
  }
  return new Error(String(error || "runtime request failed"));
}

export class RuntimeClient {
  constructor(options = {}) {
    const {
      socketPath,
      dbPath,
      daemon = options.daemonPath ?? daemonPath,
      spawnImpl = spawn,
      connectImpl = createConnection,
      env = process.env,
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    } = options;
    this.socketPath = socketPath ?? env.PI_SAND_SOCKET ?? runtimeSocketPath({ env });
    this.dbPath = dbPath ?? runtimeDatabasePath({ env });
    this.daemon = daemon;
    this.spawnImpl = spawnImpl;
    this.connectImpl = connectImpl;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
  }

  async status() {
    const status = await this.request("runtime.status");
    if (status.protocolVersion !== PROTOCOL_VERSION) throw protocolMismatch(`daemon reported version ${String(status.protocolVersion)}.`);
    if (!Number.isInteger(status.daemonPid) || status.daemonPid <= 0) throw new Error("The runtime returned an invalid daemon pid.");
    return status;
  }

  async listTasks() {
    const result = await this.request("task.list");
    if (!result || !Array.isArray(result.tasks)) throw new Error("The runtime returned an invalid task list.");
    return result.tasks;
  }

  async createTask(params) {
    const result = await this.request("task.create", params);
    if (!result?.task) throw new Error("The runtime returned an invalid Task.");
    return result.task;
  }

  async getTask(id) {
    const result = await this.request("task.get", { id });
    if (!result?.task) throw new Error("The runtime returned an invalid Task.");
    return result.task;
  }

  async stopTask(id) {
    const result = await this.request("task.stop", { id });
    if (!result?.task) throw new Error("The runtime returned an invalid stopped Task.");
    return result.task;
  }

  async retryTask(params) {
    const result = await this.request("task.retry", params);
    if (!result?.task) throw new Error("The runtime returned an invalid retried Task.");
    return result.task;
  }

  async request(method, params = {}, { version = PROTOCOL_VERSION } = {}) {
    if (process.platform !== "linux") throw new Error("The pi-sand runtime is supported only on Linux.");
    if (!isAbsolute(this.socketPath)) throw new Error("The pi-sand runtime socket path must be absolute.");
    ensureOwnerOnlyDirectory(dirname(this.socketPath));
    let response;
    try {
      response = await this.requestSocket(method, params, version);
    } catch (firstError) {
      if (firstError.code === "ambiguous_mutation" || (MUTATING_METHODS.has(method) && firstError.sent)) throw firstError;
      await this.startDaemon(firstError);
      response = await this.waitForResponse(method, params, version);
    }
    if (response.version !== PROTOCOL_VERSION) throw protocolMismatch(`daemon returned version ${String(response.version)}.`);
    if (!response.success) {
      if (response.error?.code === "protocol_mismatch") throw protocolMismatch(response.error.message);
      throw responseError(response);
    }
    return response.data;
  }

  async requestSocket(method, params, version) {
    return new Promise((resolveResponse, rejectResponse) => {
      let settled = false;
      let sent = false;
      let buffer = "";
      const requestId = randomUUID();
      const socket = this.connectImpl({ path: this.socketPath });
      const timer = setTimeout(() => finish(new Error("runtime request timed out")), this.requestTimeoutMs);
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error && sent && MUTATING_METHODS.has(method)) {
          const unknown = new Error(MUTATION_OUTCOME_UNKNOWN_ERROR, { cause: error });
          unknown.code = "ambiguous_mutation"; unknown.sent = true; rejectResponse(unknown);
        } else if (error) { error.sent = sent; rejectResponse(error); }
        else resolveResponse(response);
      };
      socket.setEncoding?.("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_PROTOCOL_LINE_LENGTH) {
          finish(new Error("runtime response exceeds the protocol line limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        try {
          const response = JSON.parse(line);
          if (response.id !== requestId) throw new Error("runtime response id did not match the request");
          finish(null, response);
        } catch (error) { finish(error.message === "runtime response id did not match the request" ? error : new Error("runtime returned invalid JSON")); }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => { if (!settled) finish(new Error("runtime closed the connection before responding")); });
      socket.once("connect", () => {
        try { sent = true; socket.write(`${JSON.stringify({ id: requestId, version, method, params })}\n`); }
        catch (error) { finish(error); }
      });
    });
  }

  async waitForResponse(method, params, version) {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await this.requestSocket(method, params, version);
      } catch (error) {
        if (error.code === "ambiguous_mutation" || (MUTATING_METHODS.has(method) && error.sent)) throw error;
        lastError = error;
        await delay(50);
      }
    }
    throw new Error(`${RUNTIME_UNAVAILABLE_ERROR} ${messageFromError(lastError)}`.trim());
  }

  async startDaemon(previousError) {
    const environment = {
      ...this.env,
      PI_SAND_RUNTIME_DB: this.dbPath,
      PI_SAND_SOCKET: this.socketPath,
    };
    let child;
    try {
      child = this.spawnImpl(process.execPath, [this.daemon, "--foreground"], {
        detached: true,
        stdio: "ignore",
        env: environment,
      });
      child.once?.("error", () => {});
      child.unref?.();
    } catch (error) {
      throw new Error(`${RUNTIME_UNAVAILABLE_ERROR} ${messageFromError(error)}`.trim(), { cause: previousError });
    }
  }
}

export function defaultDaemonPath() {
  return resolve(daemonPath);
}
