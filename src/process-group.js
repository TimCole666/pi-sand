// Compatibility facade: process.js is the sole implementation of Linux
// worker identity, zombie-aware group liveness, and safe group termination.
export {
  WORKER_STOP_TIMEOUT_MS,
  linuxBootIdentity,
  processGroupIdentity,
  processGroupIsAlive,
  processGroupStatus,
  processStartIdentity,
  readLinuxBootId,
  readProcessGroupId,
  readProcessIdentity,
  readProcessStartIdentity,
  recordedWorkerIsGone,
  recordedWorkerIsOwned,
  stopOwnedProcessGroup,
  stopOwnedProcessGroupSync,
  workerProcessMetadata,
} from "./process.js";
