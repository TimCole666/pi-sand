# Spike: v0.5 Contained Codex Execution Profile Verification

Issue reference: [TimCole666/pi-sand#76](https://github.com/TimCole666/pi-sand/issues/76)  
Specification reference: [docs/specs/v0.5-one-chat-responsibility.md](file:///home/tiancaijb/projects/pi-sand/docs/specs/v0.5-one-chat-responsibility.md)  
ADR reference: [docs/adr/0002-one-chat-responsibility-boundary.md](file:///home/tiancaijb/projects/pi-sand/docs/adr/0002-one-chat-responsibility-boundary.md)

---

## 1. Problem Statement & Invariant

In pi-sand v0.5, the host delegates coding execution to official Codex while retaining responsibility for the authoritative repository workspace. Issue #71 established that:

> "Protected Writer Class A may exist only if the pinned execution profile proves: Once T1 is retired and the execution placement/profile is torn down, no T1 descendant retaining write capability to the authoritative workspace can survive into later T2 authority. This must include descendants that attempt to escape ordinary parent/process-group lifetime."

Issue #65 proved that Codex-owned background terminals can be enumerated and terminated, but Issue #71 demonstrated that background terminal inventory alone does not prove descendant containment. Shell processes can fork, call `setsid()`, call `setpgid()`, or double-fork into background daemons.

This spike empirically verifies:
1. **Negative Control (`danger-full-access`)**: Demonstrates that ordinary cancellation and process group signaling (`killpg`) fail to contain descendants attempting escape via `setsid`, `setpgid`, or double-fork.
2. **Pinned Contained Profile (`workspace-write`)**: Demonstrates that the native Codex Linux sandbox (Bubblewrap / `codex-linux-sandbox`) creates a dedicated Linux PID and mount namespace that physically contains all descendants and guarantees that no descendant process or late workspace write can survive T1 teardown into T2 authority.

---

## 2. Toolchain & Environment

- **pi-sand base commit**: `ebe66d58dc7639f7a46e10f36f32e65e4ff53e8a`
- **OpenClaw commit**: `ff63da7237e5f99e9fc03a86daf56e3c3e8f5356`
- **Codex commit**: `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67`
- **Codex CLI / Package**: `@openai/codex@0.151.0-linux-x64`
- **Linux Distribution**: EndeavourOS Linux x86_64
- **Kernel**: `7.1.11-arch1-1 #1 SMP PREEMPT_DYNAMIC`
- **Sandbox Engine**: Bubblewrap `0.12.0` (`/usr/bin/bwrap`) via `codex-linux-sandbox`
- **Node Runtime**: `v26.8.1`, `npm 12.0.2`
- **Model Provider**: `codex_local_access` (`gpt-5.6-sol`)

---

## 3. Probe Matrix & Verification Results

The probe harness (`probe.mts`) runs against official Codex app-server via OpenClaw's app-server client. In each scenario, turn T1 starts, initiates a shell command that launches 6 distinct descendant process types (each attempting to write a unique marker to the authoritative workspace after an 8-second delay), and keeps the leader command active. T1 is then retired (`turn/interrupt`), the execution profile teardown occurs (`terminateCodexBackgroundTerminals`), fresh turn T2 is admitted, and the harness waits 12 seconds (well past the 8-second delayed write threshold).

| Probe Case | Process Topology / Escape Mechanism Attempted | Teardown Boundary | Negative Control (`danger-full-access`) | Contained Profile (`workspace-write`) |
| :--- | :--- | :--- | :--- | :--- |
| **child** | Direct child process (`subprocess.Popen`) | `terminateCodexBackgroundTerminals` / teardown | **NO** (Contained by process group kill) | **NO** (Contained by PID namespace) |
| **grandchild** | Child -> grandchild process | `terminateCodexBackgroundTerminals` / teardown | **NO** (Contained by process group kill) | **NO** (Contained by PID namespace) |
| **background** | Background process (`&` in subshell) | `terminateCodexBackgroundTerminals` / teardown | **NO** (Contained by process group kill) | **NO** (Contained by PID namespace) |
| **new process group** | Process calls `os.setpgid(0, 0)` | `terminateCodexBackgroundTerminals` / teardown | **YES (MUTATION SURVIVED)** | **NO (CONTAINED)** |
| **setsid / session** | Process calls `os.setsid()` | `terminateCodexBackgroundTerminals` / teardown | **YES (MUTATION SURVIVED)** | **NO (CONTAINED)** |
| **detached double-fork** | Double-fork daemon (`fork -> setsid -> fork`) | `terminateCodexBackgroundTerminals` / teardown | **YES (MUTATION SURVIVED)** | **NO (CONTAINED)** |
| **delayed writer** | Writers sleep 8s before workspace file creation | Wait 12s after T1 retirement and teardown | **Late markers written during T2** | **Zero late markers written** |

### Summary Matrix

```json
{
  "negativeControl": {
    "scenario": "negative-control",
    "sandboxMode": "danger-full-access",
    "effectiveSandbox": { "type": "dangerFullAccess" },
    "bgBeforeCount": 1,
    "bgAfterCount": 0,
    "results": {
      "child": false,
      "grandchild": false,
      "background": false,
      "new_pgroup": true,
      "setsid": true,
      "double_fork": true
    }
  },
  "containedProfile": {
    "scenario": "contained-profile",
    "sandboxMode": "workspace-write",
    "effectiveSandbox": {
      "type": "workspaceWrite",
      "writableRoots": [],
      "networkAccess": false,
      "excludeTmpdirEnvVar": false,
      "excludeSlashTmp": false
    },
    "bgBeforeCount": 1,
    "bgAfterCount": 0,
    "results": {
      "child": false,
      "grandchild": false,
      "background": false,
      "new_pgroup": false,
      "setsid": false,
      "double_fork": false
    }
  }
}
```

---

## 4. Physical Containment Mechanism Analysis

### Why `danger-full-access` Fails
In `danger-full-access`, Codex spawns the command process directly in a dedicated process group (`setpgid`). Teardown calls `kill_process_group` (`killpg(pgid, SIGKILL)`).
- When a child process calls `setpgid(0, 0)` or `setsid()`, its process group ID changes (`pgid = pid`).
- Because `killpg` targets only the original process group, processes in new process groups or sessions receive no signal.
- Double-forked processes are reparented to systemd/init.
- Codex's `thread/backgroundTerminals/list` tracks only top-level command processes, leaving escaped descendants undetected.
- As a result, `probe_new_pgroup.marker`, `probe_setsid.marker`, and `probe_double_fork.marker` are successfully written during T2 authority.

### Why `workspace-write` Succeeds
In `workspace-write`, Codex invokes `codex-linux-sandbox`, which configures and launches Bubblewrap (`bwrap`) with:
- `--unshare-user`
- `--unshare-pid`
- `--unshare-ipc`
- `--new-session`
- `--die-with-parent`
- `--bind <workspace> <workspace>` (and read-only root)

Under Linux kernel rules:
1. **PID Namespace Isolation**: All processes spawned by the command remain members of the created PID namespace. A process cannot escape its PID namespace even if it calls `setsid()`, `setpgid()`, or double-forks.
2. **PID 1 Termination Invariant**: The supervisor inside the PID namespace acts as PID 1 of that namespace. When teardown terminates the supervisor / bubblewrap process, the Linux kernel automatically delivers `SIGKILL` to every process residing in that PID namespace.
3. **Mount Namespace Dismantling**: Tearing down the container destroys the bind mount mappings, ensuring no dangling file handles can mutate the workspace.

---

## 5. Pinned Profile Integration in pi-sand

To ensure that pi-sand v0.5 consumes only the verified contained profile, `src/contained-codex-profile.js` provides:
- `resolveProtectedCodexExecutionProfile()`: Fails closed on `danger-full-access` or unknown profiles, returning strictly `"workspace-write"`.
- `createProtectedThreadStartParams()`: Builds `thread/start` payload with `sandbox: "workspace-write"`.
- `createProtectedTurnStartParams()`: Builds `turn/start` payload with `sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false }`.

---

## 6. How to Run the Verification Probe

From OpenClaw repository root:

```bash
cd /home/tiancaijb/tmp/pi-sand-openclaw
./node_modules/.bin/tsx /home/tiancaijb/projects/pi-sand/spikes/v0.5-contained-codex-profile/probe.mts
```

To run unit tests in `pi-sand`:

```bash
cd /home/tiancaijb/projects/pi-sand
npm test
```
