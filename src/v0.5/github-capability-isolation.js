import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Pinned host and executor contract versions for v0.5 negative-capability fencing.
 */
export const PROTECTED_PINNED_CONTRACT = Object.freeze({
  openClawCommit: "ff63da7237e5f99e9fc03a86daf56e3c3e8f5356",
  codexCommit: "a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67",
  codexPackageVersion: "0.151.0",
  codexManagedBinary: "codex-cli 0.151.0",
  platform: "linux-x64",
  bubblewrapRequired: true,
});

/**
 * Environment variables that convey GitHub tokens or hosts and must be stripped
 * from the protected Codex execution placement.
 */
export const FORBIDDEN_GITHUB_ENV_VARS = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GITHUB_API_URL",
  "GITHUB_SERVER_URL",
]);

/**
 * Closed-world tool allowlist for protected execution.
 * Any write-capable GitHub connector, MCP server, or unverified dynamic tool
 * is strictly rejected.
 */
export const PROTECTED_TOOL_ALLOWLIST = Object.freeze({
  allowedToolNames: Object.freeze([
    "read",
    "write",
    "edit",
    "apply_patch",
    "dir_list",
    "exec",
    "process",
    "github_publish", // Gateway publication request boundary only; carries no credentials
  ]),
  forbiddenToolPatterns: Object.freeze([
    /^mcp__github__.*/,
    /^github_(?!publish$).*/,
    /^connector__github__.*/,
  ]),
  isToolAllowed(toolName) {
    if (this.forbiddenToolPatterns.some((pattern) => pattern.test(toolName))) {
      return false;
    }
    return this.allowedToolNames.includes(toolName);
  },
});

/**
 * Sanitizes and constructs the isolated environment for the protected Codex placement.
 *
 * @param {object} options
 * @param {string} options.rootDir - Base runtime isolation directory
 * @param {string} [options.path] - Explicit PATH to use
 * @param {Record<string, string>} [options.extraEnv] - Controlled additional variables
 * @returns {Record<string, string>}
 */
export function createProtectedCodexEnvironment(options) {
  const { rootDir, path: execPath, extraEnv = {} } = options;
  if (!rootDir) {
    throw new Error("createProtectedCodexEnvironment requires rootDir");
  }

  const resolvedRoot = path.resolve(rootDir);
  const homeDir = path.join(resolvedRoot, "home");
  const tmpDir = path.join(resolvedRoot, "tmp");
  const runDir = path.join(resolvedRoot, "run");
  const codexHome = path.join(resolvedRoot, "codex-home");

  const env = {
    PATH: execPath || process.env.PATH || "/usr/bin:/bin",
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEX_HOME: codexHome,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    // Isolating XDG_RUNTIME_DIR prevents access to operator runtime sockets (/run/user/<uid>)
    XDG_RUNTIME_DIR: runDir,
    // Disabling DBUS explicitly blocks libdbus from falling back to /run/user/<uid>/bus,
    // which otherwise exposes the operator's GNOME Keyring / Secret Service credentials
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
    // Git credential isolation:
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      "ssh -F /dev/null -o IdentityFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes",
    // Codex-specific launch controls:
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
    ...extraEnv,
  };

  // Strip all ambient GitHub tokens and SSH agent sockets
  for (const varName of FORBIDDEN_GITHUB_ENV_VARS) {
    delete env[varName];
  }
  delete env.SSH_AUTH_SOCK;

  return env;
}

/**
 * Prepares the directory hierarchy and default git configuration in the isolated home.
 *
 * @param {string} rootDir
 */
export async function prepareProtectedCodexHome(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const homeDir = path.join(resolvedRoot, "home");
  const configDir = path.join(homeDir, ".config");
  const shareDir = path.join(homeDir, ".local", "share");
  const stateDir = path.join(homeDir, ".local", "state");
  const cacheDir = path.join(homeDir, ".cache");
  const runDir = path.join(resolvedRoot, "run");
  const tmpDir = path.join(resolvedRoot, "tmp");
  const codexHome = path.join(resolvedRoot, "codex-home");

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(shareDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });

  // Write isolated, dummy-authored .gitconfig that explicitly clears credential.helper
  // and hardens SSH commands to drop all identities.
  const gitconfigContent = [
    "[user]",
    "\tname = Protected Codex Executor",
    "\temail = codex@protected.local",
    "[credential]",
    "\thelper = ",
    "[core]",
    "\tsshCommand = ssh -F /dev/null -o IdentityFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes",
    "",
  ].join("\n");

  await fs.writeFile(path.join(homeDir, ".gitconfig"), gitconfigContent, "utf8");
}

/**
 * Programmatic audit that verifies all 10 negative capability paths from within
 * a given environment and workspace directory.
 *
 * @param {object} params
 * @param {Record<string, string>} params.env
 * @param {string} params.cwd
 * @param {(cmd: string[], opts?: object) => Promise<{ stdout: string; stderr: string; exitCode: number }>} [params.execFn]
 * @returns {Promise<Record<string, { status: "PASS" | "FAIL"; detail: string }>>}
 */
export async function auditNegativeGitHubCapabilities(params) {
  const { env, cwd, execFn } = params;

  const runCommand =
    execFn ||
    (async (cmd, opts = {}) => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), {
          cwd,
          env,
          timeout: 10_000,
          ...opts,
        });
        return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
      } catch (err) {
        return {
          stdout: String(err.stdout || ""),
          stderr: String(err.stderr || err.message || ""),
          exitCode: typeof err.code === "number" ? err.code : 1,
        };
      }
    });

  const matrix = {};

  // 1. Environment tokens
  const envTokenKeys = Object.keys(env).filter((k) =>
    /^(gh_|github_)/i.test(k),
  );
  matrix.envTokens = {
    status: envTokenKeys.length === 0 ? "PASS" : "FAIL",
    detail:
      envTokenKeys.length === 0
        ? "No GitHub token variables present in process environment"
        : `Forbidden variables present: ${envTokenKeys.join(", ")}`,
  };

  // 2. GitHub CLI (gh auth status)
  const ghStatus = await runCommand(["gh", "auth", "status"]);
  const ghUnauthed =
    ghStatus.exitCode !== 0 ||
    ghStatus.stderr.includes("You are not logged into any GitHub hosts") ||
    ghStatus.stdout.includes("You are not logged into any GitHub hosts");
  matrix.ghAuthStatus = {
    status: ghUnauthed ? "PASS" : "FAIL",
    detail: ghUnauthed
      ? "gh auth status confirmed no authenticated accounts"
      : "gh auth status found an authenticated account",
  };

  // 3. GitHub CLI (gh auth token)
  const ghToken = await runCommand(["gh", "auth", "token"]);
  const ghTokenAbsent =
    ghToken.exitCode !== 0 ||
    ghToken.stderr.includes("no oauth token found") ||
    ghToken.stdout.includes("no oauth token found") ||
    !ghToken.stdout.trim();
  matrix.ghAuthToken = {
    status: ghTokenAbsent ? "PASS" : "FAIL",
    detail: ghTokenAbsent
      ? "gh auth token confirmed no token available"
      : "gh auth token returned a token",
  };

  // 4. Git credential helpers
  const gitConfig = await runCommand([
    "git",
    "config",
    "--list",
    "--show-origin",
  ]);
  const hasCredentialHelper =
    gitConfig.stdout.includes("credential.helper=") &&
    !gitConfig.stdout.includes("credential.helper=\n") &&
    !gitConfig.stdout.includes("credential.helper=\r\n");
  // Fill attempt
  const fillRes = await runCommand(
    [
      "sh",
      "-c",
      "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
    ],
    { timeout: 5000 },
  );
  const helperUnusable =
    fillRes.exitCode !== 0 &&
    (fillRes.stderr.includes("terminal prompts disabled") ||
      fillRes.stdout.includes("terminal prompts disabled") ||
      fillRes.stderr.includes("could not read Username") ||
      fillRes.stdout.includes("could not read Username"));
  matrix.gitCredentialHelper = {
    status: helperUnusable ? "PASS" : "FAIL",
    detail: helperUnusable
      ? "git credential helper disabled; fill failed with terminal prompts disabled"
      : `Unexpected fill result: exit ${fillRes.exitCode}, out: ${fillRes.stdout}`,
  };

  // 5. SSH agent & keys
  const sshAgent = await runCommand(["ssh-add", "-l"]);
  const agentUnavailable =
    sshAgent.exitCode !== 0 &&
    (sshAgent.stderr.includes("Could not open a connection") ||
      sshAgent.stdout.includes("Could not open a connection") ||
      sshAgent.stderr.includes("Error connecting to agent") ||
      sshAgent.stdout.includes("Error connecting to agent"));
  matrix.sshAgent = {
    status: agentUnavailable ? "PASS" : "FAIL",
    detail: agentUnavailable
      ? "SSH_AUTH_SOCK absent, ssh-add reports no agent connection"
      : "SSH agent connection succeeded",
  };

  // 6. SSH transport to GitHub
  const sshGit = await runCommand([
    "ssh",
    "-v",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "git@github.com",
  ]);
  const sshDenied =
    sshGit.exitCode !== 0 &&
    (sshGit.stderr.includes("Permission denied (publickey)") ||
      sshGit.stdout.includes("Permission denied (publickey)"));
  matrix.sshWrite = {
    status: sshDenied ? "PASS" : "FAIL",
    detail: sshDenied
      ? "Direct SSH authentication to git@github.com denied (publickey)"
      : "Unexpected SSH connection outcome",
  };

  // 7. Operator HOME / XDG state
  const isIsolatedHome =
    env.HOME &&
    env.HOME !== process.env.HOME &&
    env.XDG_CONFIG_HOME &&
    env.XDG_CONFIG_HOME !== process.env.XDG_CONFIG_HOME;
  matrix.homeXdgIsolation = {
    status: isIsolatedHome ? "PASS" : "FAIL",
    detail: isIsolatedHome
      ? `HOME and XDG redirected to isolated root (${env.HOME})`
      : `HOME or XDG not isolated (HOME=${env.HOME})`,
  };

  // 8. Keyring / Secret Service DBus isolation
  const dbusDisabled = env.DBUS_SESSION_BUS_ADDRESS === "disabled:";
  matrix.keyringDbus = {
    status: dbusDisabled ? "PASS" : "FAIL",
    detail: dbusDisabled
      ? "DBUS_SESSION_BUS_ADDRESS disabled; libdbus fallback blocked"
      : `DBUS address not disabled: ${env.DBUS_SESSION_BUS_ADDRESS}`,
  };

  // 9. Raw HTTPS API mutation
  const rawApi = await runCommand([
    "curl",
    "-s",
    "-X",
    "POST",
    "https://api.github.com/user/repos",
    "-d",
    '{"name":"unauthorized-probe-repo"}',
  ]);
  const rawApiDenied =
    rawApi.stdout.includes("Requires authentication") ||
    rawApi.stdout.includes("rate limit exceeded") ||
    rawApi.stdout.includes("Bad credentials");
  matrix.rawApiMutation = {
    status: rawApiDenied ? "PASS" : "FAIL",
    detail: rawApiDenied
      ? "Unauthenticated raw POST to GitHub API rejected (HTTP 401/rate limit without bearer)"
      : `Unexpected API response: ${rawApi.stdout.slice(0, 100)}`,
  };

  // 10. Controlled Git push
  const gitPushHttps = await runCommand([
    "sh",
    "-c",
    "git init . && echo test > file.txt && git add file.txt && git commit -m test && git push https://github.com/TimCole666/nonexistent-probe-repo.git HEAD:main",
  ]);
  const pushDenied =
    gitPushHttps.exitCode !== 0 &&
    (gitPushHttps.stderr.includes("terminal prompts disabled") ||
      gitPushHttps.stdout.includes("terminal prompts disabled") ||
      gitPushHttps.stderr.includes("Authentication failed") ||
      gitPushHttps.stdout.includes("Authentication failed"));
  matrix.gitPush = {
    status: pushDenied ? "PASS" : "FAIL",
    detail: pushDenied
      ? "Controlled git push denied with terminal prompts disabled (no credentials)"
      : `Unexpected push outcome: exit ${gitPushHttps.exitCode}, err: ${gitPushHttps.stderr}`,
  };

  return matrix;
}
