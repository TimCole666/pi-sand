import { readdirSync, readFileSync } from "node:fs";

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

function procStatFields(pid) {
  const stat = procStat(pid);
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) return null;
  return stat.slice(closingParen + 2).trim().split(/\s+/);
}

export function processStartIdentity(pid) {
  try {
    return procStatFields(pid)?.[19] ?? null;
  } catch {
    return null;
  }
}

export function processGroupIdentity(pid) {
  try {
    return Number(procStatFields(pid)?.[2]) || null;
  } catch {
    return null;
  }
}

function processGroupHasLiveMember(processGroupId) {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return true;
  }
  let uncertain = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let fields;
    try {
      fields = procStatFields(entry.name);
    } catch (error) {
      // Processes can disappear between readdir and stat. Other failures mean
      // that a live member could be hidden, so fail closed.
      if (error.code !== "ENOENT") uncertain = true;
      continue;
    }
    if (!fields || Number(fields[2]) !== processGroupId) continue;
    if (fields[0] !== "Z") return true;
  }
  return uncertain;
}

export function processGroupIsAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    // EPERM means the group exists but is not signalable by this process.
    if (error.code === "EPERM") return true;
    return false;
  }
  // kill(..., 0) also succeeds for zombie-only groups. Treat those as gone;
  // they cannot execute work and otherwise make TERM/KILL waits time out.
  return processGroupHasLiveMember(processGroupId);
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

async function waitForGroupGone(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForGroupGoneSync(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    sleepSync(25);
  }
  return true;
}

function recordedWorkerIsCurrent(worker) {
  return ownershipIsProven(worker)
    && (!worker.workerBootId || worker.workerBootId === readLinuxBootId());
}

function signalCurrentGroup(worker, signal) {
  if (!recordedWorkerIsCurrent(worker)) return false;
  try {
    process.kill(-worker.workerPgid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    return false;
  }
  return true;
}

/**
 * Synchronous counterpart for user-command handlers that must not report a
 * stopped Task until the owned process group has disappeared.
 */
export function stopOwnedProcessGroupSync(worker, { timeoutMs = WORKER_STOP_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(worker?.workerPid) || !Number.isInteger(worker?.workerPgid)) return false;
  if (!processGroupIsAlive(worker.workerPgid)) return true;
  if (!signalCurrentGroup(worker, "SIGTERM")) return false;
  if (waitForGroupGoneSync(worker.workerPgid, timeoutMs)) return true;
  if (!signalCurrentGroup(worker, "SIGKILL")) return false;
  return waitForGroupGoneSync(worker.workerPgid, timeoutMs);
}

/**
 * Stop one recorded worker group without ever signalling a reused PID/PGID.
 * A false result is deliberately conservative: callers retain all process
 * metadata and must not treat the task workspace as safe to reuse.
 */
export async function stopOwnedProcessGroup(worker, { timeoutMs = WORKER_STOP_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(worker?.workerPid) || !Number.isInteger(worker?.workerPgid)) return false;
  if (!processGroupIsAlive(worker.workerPgid)) return true;
  if (!recordedWorkerIsCurrent(worker)) return false;
  if (!signalCurrentGroup(worker, "SIGTERM")) return false;
  if (await waitForGroupGone(worker.workerPgid, timeoutMs)) return true;
  // If the leader disappeared while a descendant kept the group alive, the
  // identity proof is intentionally no longer sufficient. Preserve unsafe
  // metadata instead of risking a signal to a reused process group.
  if (!recordedWorkerIsCurrent(worker)) return false;
  if (!signalCurrentGroup(worker, "SIGKILL")) return false;
  return waitForGroupGone(worker.workerPgid, timeoutMs);
}
