import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
 * An exclusive SQLite transaction on a dedicated `.owner.sqlite` guard database
 * establishes kernel-enforced mutual exclusion across competing daemon processes
 * for the entire runtime lifetime. A diagnostic `.lock` marker file retains
 * process identity metadata for recovery and error reporting.
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

  const canonical = canonicalDatabasePath(dbPath);
  const lockPath = `${canonical}.lock`;
  const ownerDbPath = `${canonical}.owner.sqlite`;
  const token = randomUUID();
  const identity = readProcessIdentity(process.pid);
  const contents = JSON.stringify({
    pid: process.pid,
    processStartIdentity: identity?.processStartIdentity ?? null,
    bootId: identity?.bootId ?? null,
    token,
  });

  const parentDir = dirname(ownerDbPath);
  try {
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  } catch {}

  let ownerDb;
  try {
    ownerDb = new DatabaseSync(ownerDbPath);
    try {
      chmodSync(ownerDbPath, LOCK_MODE);
    } catch {}
    ownerDb.exec("BEGIN EXCLUSIVE;");
  } catch (error) {
    if (ownerDb) {
      try {
        ownerDb.close();
      } catch {}
    }
    if (/database is locked|busy/i.test(error.message)) {
      const owner = lockOwner(lockPath);
      throw lockError(owner);
    }
    throw error;
  }

  // The exclusive transaction guarantees only one candidate reaches this point.
  // Verify that any existing diagnostic metadata is not from a live process.
  const existingOwner = lockOwner(lockPath);
  if (existingOwner) {
    const status = lockOwnerStatus(existingOwner);
    if (status !== "stale") {
      try {
        ownerDb.exec("ROLLBACK;");
      } catch {}
      try {
        ownerDb.close();
      } catch {}
      throw lockError(existingOwner);
    }
  }

  // Atomically write the diagnostic metadata.
  const tmpLockPath = `${lockPath}.${token}.tmp`;
  try {
    writeFileSync(tmpLockPath, contents, { mode: LOCK_MODE });
    renameSync(tmpLockPath, lockPath);
  } catch (error) {
    try {
      unlinkSync(tmpLockPath);
    } catch {}
    try {
      ownerDb.exec("ROLLBACK;");
    } catch {}
    try {
      ownerDb.close();
    } catch {}
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        const owner = lockOwner(lockPath);
        if (owner?.token === token && owner.pid === process.pid) {
          try {
            unlinkSync(lockPath);
          } catch {}
        }
      } finally {
        try {
          ownerDb.exec("ROLLBACK;");
        } catch {}
        try {
          ownerDb.close();
        } catch {}
      }
    },
  };
}

export function databaseLockPath(dbPath) {
  return dbPath === ":memory:" ? null : `${canonicalDatabasePath(dbPath)}.lock`;
}
