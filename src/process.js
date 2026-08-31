import { readdirSync, readFileSync } from "node:fs";

export const WORKER_STOP_TIMEOUT_MS = 2_000;
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export function readLinuxBootId() {
  if (process.platform !== "linux") return null;
  try {
    const bootId = readFileSync(LINUX_BOOT_ID_PATH, "utf8").trim();
    return bootId || null;
  } catch {
    return null;
  }
}

function procStatFields(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) return null;
  return stat.slice(closingParen + 2).trim().split(/\s+/);
}

export function readProcessStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    return procStatFields(pid)?.[19] ?? null;
  } catch {
    return null;
  }
}

export function readProcessGroupId(pid) {
  if (process.platform !== "linux") return null;
  try {
    const groupId = Number(procStatFields(pid)?.[2]);
    return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
  } catch {
    return null;
  }
}

/**
 * Read the complete identity used for safe worker signalling. PID alone is
 * not an identity: Linux can reuse both a PID and a process-group id.
 */
export function readProcessIdentity(pid) {
  if (process.platform !== "linux") return null;
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  try {
    const numericPid = Number(pid);
    const fields = procStatFields(numericPid);
    const processGroupId = Number(fields?.[2]);
    const processStartIdentity = fields?.[19] ?? null;
    if (!Number.isInteger(processGroupId) || processGroupId <= 0 || !processStartIdentity) return null;
    const bootId = readLinuxBootId();
    return { pid: numericPid, processGroupId, processStartIdentity, bootId };
  } catch {
    return null;
  }
}

export const processStartIdentity = readProcessStartIdentity;
export const processGroupIdentity = readProcessGroupId;
export const linuxBootIdentity = readLinuxBootId;

function processGroupMemberStatus(processGroupId) {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return "unknown";
  }

  let uncertain = false;
  let foundMember = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let fields;
    try {
      fields = procStatFields(entry.name);
    } catch (error) {
      // A process can disappear between /proc enumeration and stat. Other
      // visibility/read failures must fail closed.
      if (error.code !== "ENOENT") uncertain = true;
      continue;
    }
    if (!fields || Number(fields[2]) !== processGroupId) continue;
    foundMember = true;
    if (fields[0] !== "Z") return "alive";
  }
  if (uncertain) return "unknown";
  // A zombie-only group, and a group whose members disappeared during the
  // scan, cannot execute work. kill(..., 0) is not sufficient to distinguish
  // that case, so both are treated as gone.
  return foundMember ? "gone" : "gone";
}

/** Return a zombie-aware liveness state for one process group. */
export function processGroupStatus(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return "unknown";
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    if (error.code === "EPERM") return "alive";
    if (error.code === "ESRCH") return "gone";
    return "unknown";
  }
  return processGroupMemberStatus(processGroupId);
}

export function processGroupIsAlive(processGroupId) {
  return processGroupStatus(processGroupId) !== "gone";
}

export function recordedWorkerIsGone(worker) {
  return Number.isInteger(worker?.workerPgid) && processGroupStatus(worker.workerPgid) === "gone";
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function workerProcessMetadata(worker) {
  const pid = Number(worker?.pid);
  const processGroupId = Number(worker?.processGroupId ?? worker?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(processGroupId) || processGroupId <= 0) return null;
  const identity = readProcessIdentity(pid);
  if (!identity || identity.processGroupId !== processGroupId) return null;
  return {
    workerPid: identity.pid,
    workerPgid: identity.processGroupId,
    workerStartIdentity: identity.processStartIdentity,
    workerBootId: identity.bootId,
  };
}

function ownershipIsProven(worker, currentBootId = readLinuxBootId()) {
  const identity = readProcessIdentity(worker?.workerPid);
  return Boolean(identity && currentBootId && worker?.workerBootId)
    && identity.processGroupId === worker.workerPgid
    && identity.processStartIdentity === worker.workerStartIdentity
    && worker.workerBootId === currentBootId;
}

export const recordedWorkerIsOwned = ownershipIsProven;

function signalOwnedGroup(worker, signal, currentBootId) {
  if (!ownershipIsProven(worker, currentBootId)) return false;
  try {
    process.kill(-worker.workerPgid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return processGroupStatus(worker.workerPgid) === "gone";
    return false;
  }
}

function waitForGroupGoneSync(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupStatus(processGroupId) !== "gone") {
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return true;
}

/**
 * Terminate a recorded worker group only while PID/start/PGID/boot identity
 * remains proven. A false result is deliberately unsafe: callers must retain
 * the worktree and keep global capacity blocked.
 */
export function stopOwnedProcessGroupSync(worker, { timeoutMs = WORKER_STOP_TIMEOUT_MS, currentBootId = readLinuxBootId() } = {}) {
  if (!Number.isInteger(worker?.workerPid) || !Number.isInteger(worker?.workerPgid)) return false;
  const initialStatus = processGroupStatus(worker.workerPgid);
  if (initialStatus === "gone") return true;
  if (initialStatus !== "alive" || !ownershipIsProven(worker, currentBootId)) return false;
  if (!signalOwnedGroup(worker, "SIGTERM", currentBootId)) return false;
  if (waitForGroupGoneSync(worker.workerPgid, timeoutMs)) return true;
  // Never KILL a reused group after the recorded leader identity disappears.
  if (!ownershipIsProven(worker, currentBootId)) return false;
  if (!signalOwnedGroup(worker, "SIGKILL", currentBootId)) return false;
  return waitForGroupGoneSync(worker.workerPgid, timeoutMs);
}

export async function stopOwnedProcessGroup(worker, options = {}) {
  return stopOwnedProcessGroupSync(worker, options);
}

export { procStatFields };
