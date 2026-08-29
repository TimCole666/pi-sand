import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

const LOCK_MODE = 0o600;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

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
  return new Error(`The Local Agent Service is already running for this database${suffix}.`);
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
  const contents = JSON.stringify({ pid: process.pid, token });
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
        try { unlinkSync(lockPath); } catch { /* Preserve the original acquisition error. */ }
      }
      if (error.code !== "EEXIST") throw error;

      const owner = lockOwner(lockPath);
      if (!owner || processIsAlive(owner.pid)) throw lockError(owner);
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
        if (owner?.token === token && owner.pid === process.pid) unlinkSync(lockPath);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

export function databaseLockPath(dbPath) {
  return dbPath === ":memory:" ? null : `${canonicalDatabasePath(dbPath)}.lock`;
}
