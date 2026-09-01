#!/usr/bin/env node
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  MAX_PROTOCOL_ERROR_LENGTH,
  MAX_PROTOCOL_LINE_LENGTH,
  PROTOCOL_VERSION,
  ensureOwnerOnlyDirectory,
  protocolError,
  runtimeDatabasePath,
  runtimeSocketPath,
} from "./runtime-ipc.js";
import { RUNTIME_OWNERSHIP_ERROR, RuntimeStore } from "./runtime-store.js";

export const DAEMON_UNSUPPORTED_PLATFORM_ERROR = "pi-sandd is supported only on Linux.";

function assertLinux() {
  if (process.platform !== "linux") throw new Error(DAEMON_UNSUPPORTED_PLATFORM_ERROR);
}

function boundedMessage(error) {
  return String(error?.message ?? error ?? "runtime request failed").slice(0, MAX_PROTOCOL_ERROR_LENGTH);
}

function response(id, success, value) {
  return JSON.stringify(success
    ? { id, version: PROTOCOL_VERSION, success: true, data: value }
    : { id, version: PROTOCOL_VERSION, success: false, error: value });
}

function requestError(id, code, message) {
  return `${response(id, false, protocolError(code, message))}\n`;
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw Object.assign(new Error("request must be a JSON object"), { code: "invalid_request" });
  }
  const version = request.version ?? request.protocolVersion;
  if (version !== PROTOCOL_VERSION) {
    throw Object.assign(new Error(`unsupported protocol version: ${String(version)}`), { code: "protocol_mismatch" });
  }
  if (typeof request.id !== "string" || !request.id) {
    throw Object.assign(new Error("request id is required"), { code: "invalid_request" });
  }
  if (typeof request.method !== "string" || !request.method) {
    throw Object.assign(new Error("request method is required"), { code: "invalid_request" });
  }
}

async function handleRequest(request, store) {
  validateRequest(request);
  const params = request.params && typeof request.params === "object" ? request.params : {};
  switch (request.method) {
    case "runtime.status":
      return {
        protocolVersion: PROTOCOL_VERSION,
        daemonPid: process.pid,
        pid: process.pid,
        state: "ready",
      };
    case "task.list":
      return { tasks: store.listTasks() };
    case "task.get": {
      const task = store.getTask(params.id);
      if (!task) throw Object.assign(new Error("Task was not found."), { code: "task_not_found" });
      return { task };
    }
    case "task.create":
      if (Object.keys(params).length === 0) throw Object.assign(new Error("method is not implemented in protocol v1 tracer bullet: task.create"), { code: "method_unimplemented" });
      return { task: await store.createTask(params) };
    case "task.stop":
      return { task: await store.stopTask(params.id) };
    case "task.retry":
      return { task: await store.retryTask(params) };
    case "task.wait":
    case "wait.register":
      return await store.registerWaitSubscription(params);
    case "wait.reconcile":
      return await store.reconcileWaitSubscription(
        params.id ?? params.subscriptionId ?? params.waitId,
        params,
      );
    case "result.claim": {
      const result = store.claimResult(
        params.clientInstanceId ?? params.client_instance_id,
      );
      return {
        result,
        resultId: result?.id ?? null,
        claimHandle: result?.claimHandle ?? null,
        claimExpiresAt: result?.claimExpiresAt ?? null,
      };
    }
    case "result.ack": {
      const result = store.ackResult(
        params.resultId ?? params.result_id,
        params.claimHandle ?? params.claim_handle,
      );
      return { result, acknowledged: true, resultId: result.id };
    }
    default:
      throw Object.assign(new Error(`unknown protocol method: ${request.method}`), { code: "unknown_method" });
  }
}

function unlinkOwnedSocket(socketPath) {
  if (!existsSync(socketPath)) return;
  try { unlinkSync(socketPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function bindServer(server, socketPath) {
  return new Promise((resolveReady, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try { chmodSync(socketPath, 0o600); } catch (error) {
        reject(error);
        return;
      }
      resolveReady();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function serveConnection(socket, store) {
  let buffer = "";
  let handled = false;
  const finish = async (line) => {
    if (handled) return;
    handled = true;
    let request;
    try { request = JSON.parse(line); } catch {
      socket.end(requestError(null, "invalid_json", "request is not valid JSON"));
      return;
    }
    try {
      const data = await handleRequest(request, store);
      socket.end(`${response(request.id, true, data)}\n`);
    } catch (error) {
      const code = error.code && /^[a-z_]+$/.test(error.code) ? error.code : "request_failed";
      socket.end(requestError(request.id ?? null, code, boundedMessage(error)));
    }
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (buffer.length > MAX_PROTOCOL_LINE_LENGTH) {
      handled = true;
      socket.end(requestError(null, "request_too_large", "request exceeds the protocol line limit"));
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    void finish(buffer.slice(0, newline).replace(/\r$/, ""));
  });
  socket.on("error", () => {});
}

export async function startRuntimeDaemon({
  dbPath = runtimeDatabasePath(),
  socketPath = process.env.PI_SAND_SOCKET ?? runtimeSocketPath(),
  store = new RuntimeStore({ dbPath, piCommand: process.env.PI_BIN ?? "pi", worktreeRoot: process.env.PI_SAND_TASK_WORKTREE_ROOT }),
} = {}) {
  assertLinux();
  // Secure the socket parent before binding. Singleton cleanup happens only
  // after the runtime DB lock is acquired, so a stale socket is never removed
  // by a process that failed to become the runtime owner.
  ensureRuntimeDirectoryForSocket(socketPath);
  store.open();
  await store.reconcileActiveWaits().catch(() => {});
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    serveConnection(socket, store);
  });
  try {
    try {
      await bindServer(server, socketPath);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      // DB ownership has already been acquired. Only this owner may reclaim a
      // socket left by a dead runtime; a losing candidate fails before here.
      unlinkOwnedSocket(socketPath);
      await bindServer(server, socketPath);
    }
  } catch (error) {
    server.close();
    store.release();
    throw error;
  }

  let closed = false;
  const close = async ({ shutdownReason } = {}) => {
    if (closed) return;
    closed = true;
    // The daemon is the lifetime root. Reconcile/terminate its owned worker
    // before releasing either singleton ownership marker or socket ownership.
    if (shutdownReason) await store.shutdown(shutdownReason);
    for (const connection of connections) connection.destroy();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    unlinkOwnedSocket(socketPath);
    store.release();
  };
  return { server, store, socketPath, close };
}

function ensureRuntimeDirectoryForSocket(socketPath) {
  if (!isAbsolute(socketPath)) throw new Error("The pi-sand runtime socket path must be absolute.");
  // The normal path is produced by runtimeSocketPath. For deterministic tests
  // and diagnostics, explicit socket paths are accepted but still require an
  // owner-only directory; no cross-user socket is created.
  ensureOwnerOnlyDirectory(dirname(socketPath));
}

export async function runRuntimeDaemon(options = {}) {
  const runtime = await startRuntimeDaemon(options);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.close({ shutdownReason: "daemon-shutdown" }).then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return runtime;
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runRuntimeDaemon()
    .catch((error) => {
      if (error.message === RUNTIME_OWNERSHIP_ERROR) process.exitCode = 0;
      else {
        console.error(`pi-sandd could not start: ${boundedMessage(error)}`);
        process.exitCode = 1;
      }
    });
}
