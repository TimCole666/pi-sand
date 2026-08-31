import { chmodSync, mkdirSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const SOCKET_NAME = "pi-sand.sock";
export const SOCKET_DIRECTORY_NAME = "pi-sand";
export const MAX_PROTOCOL_LINE_LENGTH = 64 * 1024;
export const MAX_PROTOCOL_ERROR_LENGTH = 512;

function numericUid() {
  if (typeof process.getuid === "function") return process.getuid();
  return Number(userInfo().uid);
}

export function runtimeDirectory({ env = process.env, uid = numericUid() } = {}) {
  const configured = typeof env.XDG_RUNTIME_DIR === "string" && env.XDG_RUNTIME_DIR.trim()
    ? env.XDG_RUNTIME_DIR
    : join(tmpdir(), `pi-sand-${uid}`);
  if (!isAbsolute(configured)) throw new Error("XDG_RUNTIME_DIR must be an absolute path.");
  return join(configured, SOCKET_DIRECTORY_NAME);
}

export function runtimeSocketPath(options = {}) {
  return join(runtimeDirectory(options), SOCKET_NAME);
}

export function ensureOwnerOnlyDirectory(directory, { uid = numericUid() } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const details = statSync(directory);
  if (details.uid !== uid) throw new Error("The pi-sand runtime directory is not owned by the current user.");
  if ((details.mode & 0o077) !== 0) chmodSync(directory, 0o700);
  const secured = statSync(directory);
  if ((secured.mode & 0o077) !== 0) throw new Error("The pi-sand runtime directory is not owner-only.");
  return directory;
}

export function ensureRuntimeDirectory(options = {}) {
  return ensureOwnerOnlyDirectory(runtimeDirectory(options), options);
}

export function runtimeDatabasePath({ env = process.env } = {}) {
  if (env.PI_SAND_RUNTIME_DB) return env.PI_SAND_RUNTIME_DB;
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || userInfo().homedir, ".local", "share");
  return join(dataHome, "pi-sand", "task-runtime.sqlite");
}

export function protocolError(code, message) {
  return { code, message: String(message).slice(0, MAX_PROTOCOL_ERROR_LENGTH) };
}
