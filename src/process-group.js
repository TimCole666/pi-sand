import { readdirSync, readFileSync } from "node:fs";

function statFields(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = text.lastIndexOf(")");
  if (closingParen < 0) return null;
  return text.slice(closingParen + 2).trim().split(/\s+/);
}

export function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return statFields(pid)?.[19] ?? null; } catch { return null; }
}

export function processGroupIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const value = Number(statFields(pid)?.[2]);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function linuxBootIdentity() {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch { return null; }
}

function processIsZombie(pid) {
  try { return statFields(pid)?.[0] === "Z"; } catch { return false; }
}

/** Return true only while a non-zombie member of the recorded group exists. */
export function processGroupIsAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        if (processGroupIdentity(pid) === pgid && !processIsZombie(pid)) return true;
      } catch { /* A process can disappear between /proc reads. */ }
    }
    return false;
  } catch {
    try { process.kill(-pgid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  }
}

export function recordedWorkerIsOwned(worker, { bootId = linuxBootIdentity() } = {}) {
  if (!Number.isInteger(worker?.workerPid) || !Number.isInteger(worker?.workerPgid)) return false;
  if (worker.workerPid <= 0 || worker.workerPgid <= 0) return false;
  if (!worker.workerStartIdentity || !worker.workerBootId || !bootId) return false;
  return worker.workerBootId === bootId
    && processStartIdentity(worker.workerPid) === worker.workerStartIdentity
    && processGroupIdentity(worker.workerPid) === worker.workerPgid;
}

export function recordedWorkerIsGone(worker) {
  return Number.isInteger(worker?.workerPgid) && !processGroupIsAlive(worker.workerPgid);
}
