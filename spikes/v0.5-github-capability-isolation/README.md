# v0.5 Protected Codex GitHub Write-Capability Isolation

This spike implements and proves that the protected Codex execution placement physically lacks any independent GitHub write capability, satisfying the negative capability boundary for v0.5 ([Issue #77](https://github.com/TimCole666/pi-sand/issues/77), [ADR-0002](https://github.com/TimCole666/pi-sand/blob/main/docs/adr/0002-one-chat-responsibility-boundary.md)).

## Physical Capability Topology

```text
Protected Codex Execution Placement
  │
  │ (github_publish request only; no tokens/credentials conveyed)
  ▼
OpenClaw Gateway Session
  │
  │ (credential-bearing publication path owned by Gateway)
  ▼
GitHub
```

Codex possesses no direct, ambient, or inherited credential to perform GitHub mutations. Prompt instructions ("do not push") are explicitly ignored; containment is enforced mechanically.

---

## Negative-Capability Audit Matrix

Captured from inside the official `@openai/codex` 0.151.0 process placement:

| Path | Expected | Actual | Status | Mechanism |
| --- | --- | --- | --- | --- |
| `GH_TOKEN` | unavailable | unavailable | **PASS** | Environment sanitization |
| `GITHUB_TOKEN` | unavailable | unavailable | **PASS** | Environment sanitization |
| `gh` authenticated profile | unavailable | unauthenticated | **PASS** | Isolated `XDG_CONFIG_HOME`, `HOME`, disabled DBus |
| HTTPS credential helper | unusable | prompt disabled (fill failed) | **PASS** | `credential.helper=""`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` |
| SSH private key | unavailable | permission denied | **PASS** | `GIT_SSH_COMMAND` & `core.sshCommand` forced to `/dev/null` identities |
| `SSH_AUTH_SOCK` | unavailable | no agent connection | **PASS** | Stripped from execution environment |
| Operator HOME credentials | unavailable | isolated (`$ISOLATED_HOME`) | **PASS** | `HOME` & `USERPROFILE` redirected to clean workspace runtime tree |
| GitHub write MCP/App | unavailable | tool allowlist rejected | **PASS** | `PROTECTED_TOOL_ALLOWLIST` closed-world rejection |
| Raw authenticated API | unavailable | HTTP 401 / unauthenticated | **PASS** | Process lacks any bearer token; raw POST rejected by GitHub |
| `git push` authentication/write | denied | prompt disabled (auth failed) | **PASS** | Cannot authenticate over HTTPS or SSH |

---

## Controlled Write Proof

Direct mutation attempts executed from within the protected Codex placement:
1. **`git push` over HTTPS**: Failed with `fatal: could not read Username for 'https://github.com': terminal prompts disabled`.
2. **`git push` over SSH**: Failed with `git@github.com: Permission denied (publickey). fatal: Could not read from remote repository.`.
3. **`gh` CLI mutation (`gh repo edit`)**: Failed with `To get started with GitHub CLI, please run: gh auth login`.
4. **Raw API write (`curl -X POST https://api.github.com/user/repos`)**: Failed with `401 Unauthorized` / unauthenticated rate limit; no repo created.

---

## Normal Coding Behavior Preserved

The protected placement retains full local developer coding capabilities:
- **Workspace reads & writes**: Local files can be created, edited, and read (`calc.js`, `math.js`).
- **Local Git operations**: `git init`, `git add`, `git commit` (with isolated dummy author), `git status`, and `git diff` work completely.
- **Shell tests & build commands**: `node -e "..."` and test suites execute cleanly with full local exit code reporting.

---

## Toolchain & Environment Facts

- **Base commit (pi-sand)**: `ebe66d5`
- **OpenClaw commit**: `ff63da7237e5f99e9fc03a86daf56e3c3e8f5356`
- **Codex commit**: `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67`
- **Codex managed package / binary**: `@openai/codex` `0.151.0` (`codex-cli 0.151.0`)
- **OS**: Linux 6.6.137+bwh #1 SMP PREEMPT_DYNAMIC x86_64
- **Bubblewrap**: `/usr/bin/bwrap` (0.12.0)
- **Local access model**: `gpt-5.6-sol` via `http://localhost:43599/v1`

---

## Critical Linux Discoveries & Hardening

1. **DBus / Keyring Fallback**: On systemd user sessions, if `DBUS_SESSION_BUS_ADDRESS` is merely unset or deleted, the DBus client library defaults to connecting to `/run/user/<uid>/bus`. This allows `gh auth token` to read credentials directly from GNOME Keyring even when `HOME` and `XDG_CONFIG_HOME` are isolated! The profile hardens against this by setting `DBUS_SESSION_BUS_ADDRESS="disabled:"` and isolating `XDG_RUNTIME_DIR`.
2. **OpenSSH `~` Expansion**: OpenSSH's client code expands `~` using `getpwuid(getuid())` from `/etc/passwd`, ignoring `$HOME`. Without configuration, `ssh` checks `/home/tiancaijb/.ssh/id_ed25519`. The protected profile enforces `GIT_SSH_COMMAND="ssh -F /dev/null -o IdentityFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes"` and `core.sshCommand`, preventing any Git operations from offering host identities. Full filesystem masking is owned by #76.

---

## Reproduction & Verification

### 1. Fast Release Verification (Node.js test runner)
```bash
# Run automated repository tests
npm test

# Run standalone verification matrix
node spikes/v0.5-github-capability-isolation/verify.js
```

### 2. Live Official Codex App-Server Probe
```bash
cd /home/tiancaijb/tmp/pi-sand-openclaw
./node_modules/.bin/tsx /home/tiancaijb/projects/pi-sand-github-capability-isolation/spikes/v0.5-github-capability-isolation/probe.mts
```
