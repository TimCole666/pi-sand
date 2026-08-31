import { readFileSync } from "node:fs";

export const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export function readLinuxBootId(path = LINUX_BOOT_ID_PATH) {
  try {
    const bootId = readFileSync(path, "utf8").trim();
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

// Linux process start time is stable for one PID lifetime and changes when the
// kernel reuses that PID. It is not meaningful on non-Linux hosts.
export function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return procStatFields(pid)?.[19] ?? null; } catch { return null; }
}

export function processGroupIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const value = Number(procStatFields(pid)?.[2]);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function processGroupStatus(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return "unknown";
  try {
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (error) {
    if (error.code === "ESRCH") return "gone";
    if (error.code === "EPERM") return "alive";
    return "unknown";
  }
}

export function processGroupIsAlive(processGroupId) {
  return processGroupStatus(processGroupId) === "alive";
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
