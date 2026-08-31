import { readFileSync } from "node:fs";

export const WORKER_STOP_TIMEOUT_MS = 2_000;
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function readLinuxBootId() {
  try {
    const bootId = readFileSync(LINUX_BOOT_ID_PATH, "utf8").trim();
    return bootId || null;
  } catch {
    return null;
  }
}

function procStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

export function processStartIdentity(pid) {
  try {
    const stat = procStat(pid);
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

export function processGroupIdentity(pid) {
  try {
    const stat = procStat(pid);
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    return Number(stat.slice(closingParen + 2).trim().split(/\s+/)[2]) || null;
  } catch {
    return null;
  }
}

export function processGroupIsAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function workerProcessMetadata(worker) {
  const pid = Number(worker?.pid);
  const processGroupId = Number(worker?.processGroupId ?? worker?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(processGroupId) || processGroupId <= 0) return null;
  return {
    workerPid: pid,
    workerPgid: processGroupId,
    workerStartIdentity: processStartIdentity(pid),
    workerBootId: readLinuxBootId(),
  };
}

function ownershipIsProven(worker) {
  return Boolean(worker.workerStartIdentity)
    && processStartIdentity(worker.workerPid) === worker.workerStartIdentity
    && processGroupIdentity(worker.workerPid) === worker.workerPgid;
}

function signalOwnedGroup(worker, signal) {
  if (!ownershipIsProven(worker)) return false;
  try {
    process.kill(-worker.workerPgid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    return false;
  }
  return true;
}

async function waitForGroupGone(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/**
 * Stop one recorded worker group without ever signalling a reused PID/PGID.
 * A false result is deliberately conservative: callers retain all process
 * metadata and must not treat the task workspace as safe to reuse.
 */
export async function stopOwnedProcessGroup(worker, { timeoutMs = WORKER_STOP_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(worker?.workerPid) || !Number.isInteger(worker?.workerPgid)) return false;
  if (!processGroupIsAlive(worker.workerPgid)) return true;
  if (!ownershipIsProven(worker)) return false;
  if (!signalOwnedGroup(worker, "SIGTERM")) return false;
  if (await waitForGroupGone(worker.workerPgid, timeoutMs)) return true;
  // If the leader disappeared while a descendant kept the group alive, the
  // identity proof is intentionally no longer sufficient. Preserve unsafe
  // metadata instead of risking a signal to a reused process group.
  if (!ownershipIsProven(worker)) return false;
  if (!signalOwnedGroup(worker, "SIGKILL")) return false;
  return waitForGroupGone(worker.workerPgid, timeoutMs);
}
