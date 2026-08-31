import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import {
  processIsAlive,
  readProcessIdentity,
  readProcessState,
} from "./process.js";

const LOCK_MODE = 0o600;

function lockOwner(lockPath) {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8"));
    return Number.isInteger(value.pid) ? value : null;
  } catch {
    return null;
  }
}

function lockError(owner) {
  const pid = owner?.pid;
  const suffix = pid ? ` (process ${pid})` : "";
  return new Error(
    `The Local Agent Service is already running for this database${suffix}.`,
  );
}

function lockOwnerStatus(owner) {
  if (process.platform !== "linux")
    return processIsAlive(owner.pid) ? "alive" : "stale";
  if (!owner.processStartIdentity || !owner.bootId) return "unknown";
  const identity = readProcessIdentity(owner.pid);
  if (!identity) return processIsAlive(owner.pid) ? "unknown" : "stale";
  if (readProcessState(owner.pid) === "Z") return "stale";
  return identity.processStartIdentity === owner.processStartIdentity &&
    identity.bootId === owner.bootId
    ? "alive"
    : "stale";
}

/**
 * Acquire an OS-process ownership marker for a product database.
 *
 * SQLite protects individual reads/writes, but does not express the product
 * invariant that exactly one Local Agent Service owns a database for its whole
 * lifetime. An exclusive-create marker gives competing service startups a
 * deterministic product error. A marker left by a dead process is reclaimed;
 * malformed markers fail closed rather than risking two owners.
 */
function canonicalDatabasePath(dbPath) {
  const absolute = resolve(dbPath);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return `${realpathSync.native(dirname(absolute))}/${basename(absolute)}`;
  }
}

export function acquireDatabaseLock(dbPath) {
  if (dbPath === ":memory:") return null;

  const lockPath = `${canonicalDatabasePath(dbPath)}.lock`;
  const token = randomUUID();
  const identity = readProcessIdentity(process.pid);
  const contents = JSON.stringify({
    pid: process.pid,
    processStartIdentity: identity?.processStartIdentity ?? null,
    bootId: identity?.bootId ?? null,
    token,
  });
  let descriptor;

  for (;;) {
    try {
      descriptor = openSync(lockPath, "wx", LOCK_MODE);
      writeSync(descriptor, contents);
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(lockPath);
        } catch {
          /* Preserve the original acquisition error. */
        }
      }
      if (error.code !== "EEXIST") throw error;

      const owner = lockOwner(lockPath);
      if (!owner || lockOwnerStatus(owner) !== "stale") throw lockError(owner);
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw lockError(owner);
      }
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        const owner = lockOwner(lockPath);
        if (owner?.token === token && owner.pid === process.pid)
          unlinkSync(lockPath);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

export function databaseLockPath(dbPath) {
  return dbPath === ":memory:" ? null : `${canonicalDatabasePath(dbPath)}.lock`;
}
