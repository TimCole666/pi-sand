import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createProtectedCodexEnvironment,
  prepareProtectedCodexHome,
  PROTECTED_TOOL_ALLOWLIST,
  PROTECTED_PINNED_CONTRACT,
  auditNegativeGitHubCapabilities,
} from "../src/v0.5/github-capability-isolation.js";

const execFileAsync = promisify(execFile);

test("v0.5 GitHub capability isolation: environment sanitization", () => {
  const rootDir = "/tmp/mock-protected-root";
  const dirtyProcessEnv = {
    PATH: "/bin:/usr/bin",
    HOME: "/home/operator",
    USER: "operator",
    GH_TOKEN: "ghp_mock_token_that_must_be_stripped",
    GITHUB_TOKEN: "gho_mock_token_that_must_be_stripped",
    GITHUB_ENTERPRISE_TOKEN: "ghe_mock_token_that_must_be_stripped",
    GH_ENTERPRISE_TOKEN: "ghe_mock_token_that_must_be_stripped",
    GH_HOST: "github.com",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  };

  const originalEnv = { ...process.env };
  try {
    Object.assign(process.env, dirtyProcessEnv);

    const protectedEnv = createProtectedCodexEnvironment({ rootDir });

    assert.equal(protectedEnv.HOME, "/tmp/mock-protected-root/home");
    assert.equal(protectedEnv.USERPROFILE, "/tmp/mock-protected-root/home");
    assert.equal(
      protectedEnv.XDG_CONFIG_HOME,
      "/tmp/mock-protected-root/home/.config",
    );
    assert.equal(
      protectedEnv.XDG_DATA_HOME,
      "/tmp/mock-protected-root/home/.local/share",
    );
    assert.equal(
      protectedEnv.XDG_STATE_HOME,
      "/tmp/mock-protected-root/home/.local/state",
    );
    assert.equal(
      protectedEnv.XDG_CACHE_HOME,
      "/tmp/mock-protected-root/home/.cache",
    );
    assert.equal(protectedEnv.XDG_RUNTIME_DIR, "/tmp/mock-protected-root/run");
    assert.equal(protectedEnv.DBUS_SESSION_BUS_ADDRESS, "disabled:");
    assert.equal(protectedEnv.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(protectedEnv.GIT_TERMINAL_PROMPT, "0");
    assert.equal(
      protectedEnv.GIT_SSH_COMMAND,
      "ssh -F /dev/null -o IdentityFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes",
    );
    assert.equal(
      protectedEnv.CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG,
      "1",
    );

    // Assert absence of any forbidden GitHub or agent variables
    assert.equal(protectedEnv.GH_TOKEN, undefined);
    assert.equal(protectedEnv.GITHUB_TOKEN, undefined);
    assert.equal(protectedEnv.GITHUB_ENTERPRISE_TOKEN, undefined);
    assert.equal(protectedEnv.GH_ENTERPRISE_TOKEN, undefined);
    assert.equal(protectedEnv.GH_HOST, undefined);
    assert.equal(protectedEnv.SSH_AUTH_SOCK, undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("v0.5 GitHub capability isolation: filesystem preparation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-test-fs-"));
  try {
    await prepareProtectedCodexHome(tmpDir);

    const homeConfig = path.join(tmpDir, "home", ".config");
    const homeShare = path.join(tmpDir, "home", ".local", "share");
    const runDir = path.join(tmpDir, "run");
    const gitconfigFile = path.join(tmpDir, "home", ".gitconfig");

    const configStat = await fs.stat(homeConfig);
    assert.ok(configStat.isDirectory());

    const shareStat = await fs.stat(homeShare);
    assert.ok(shareStat.isDirectory());

    const runStat = await fs.stat(runDir);
    assert.ok(runStat.isDirectory());
    // Mode should be 0700 (in octal: 40700)
    assert.equal(runStat.mode & 0o777, 0o700);

    const gitconfigContent = await fs.readFile(gitconfigFile, "utf8");
    assert.ok(gitconfigContent.includes("name = Protected Codex Executor"));
    assert.ok(gitconfigContent.includes("email = codex@protected.local"));
    assert.ok(gitconfigContent.includes("helper = "));
    assert.ok(
      gitconfigContent.includes(
        "sshCommand = ssh -F /dev/null -o IdentityFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes",
      ),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("v0.5 GitHub capability isolation: closed tool allowlist", () => {
  // Allowed native tools
  assert.equal(PROTECTED_TOOL_ALLOWLIST.isToolAllowed("read"), true);
  assert.equal(PROTECTED_TOOL_ALLOWLIST.isToolAllowed("write"), true);
  assert.equal(PROTECTED_TOOL_ALLOWLIST.isToolAllowed("edit"), true);
  assert.equal(PROTECTED_TOOL_ALLOWLIST.isToolAllowed("exec"), true);

  // Allowed gateway publication request tool
  assert.equal(PROTECTED_TOOL_ALLOWLIST.isToolAllowed("github_publish"), true);

  // Disallowed write-capable GitHub tools or MCP servers
  assert.equal(
    PROTECTED_TOOL_ALLOWLIST.isToolAllowed("mcp__github__create_issue"),
    false,
  );
  assert.equal(
    PROTECTED_TOOL_ALLOWLIST.isToolAllowed("mcp__github__push"),
    false,
  );
  assert.equal(
    PROTECTED_TOOL_ALLOWLIST.isToolAllowed("github_create_pull_request"),
    false,
  );
  assert.equal(
    PROTECTED_TOOL_ALLOWLIST.isToolAllowed("connector__github__mutate"),
    false,
  );
  assert.equal(
    PROTECTED_TOOL_ALLOWLIST.isToolAllowed("unverified_arbitrary_tool"),
    false,
  );
});

test("v0.5 GitHub capability isolation: live bypass audit matrix", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-audit-live-"));
  const wsDir = path.join(tmpDir, "workspace");
  await fs.mkdir(wsDir, { recursive: true });

  try {
    await prepareProtectedCodexHome(tmpDir);
    const env = createProtectedCodexEnvironment({ rootDir: tmpDir });

    const matrix = await auditNegativeGitHubCapabilities({ env, cwd: wsDir });

    // Assert that every path in the negative capability audit passes (i.e. is blocked/unavailable)
    assert.equal(matrix.envTokens.status, "PASS", matrix.envTokens.detail);
    assert.equal(matrix.ghAuthStatus.status, "PASS", matrix.ghAuthStatus.detail);
    assert.equal(matrix.ghAuthToken.status, "PASS", matrix.ghAuthToken.detail);
    assert.equal(
      matrix.gitCredentialHelper.status,
      "PASS",
      matrix.gitCredentialHelper.detail,
    );
    assert.equal(matrix.sshAgent.status, "PASS", matrix.sshAgent.detail);
    assert.equal(matrix.sshWrite.status, "PASS", matrix.sshWrite.detail);
    assert.equal(
      matrix.homeXdgIsolation.status,
      "PASS",
      matrix.homeXdgIsolation.detail,
    );
    assert.equal(matrix.keyringDbus.status, "PASS", matrix.keyringDbus.detail);
    assert.equal(
      matrix.rawApiMutation.status,
      "PASS",
      matrix.rawApiMutation.detail,
    );
    assert.equal(matrix.gitPush.status, "PASS", matrix.gitPush.detail);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("v0.5 GitHub capability isolation: normal coding behavior preserved", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-coding-live-"));
  const wsDir = path.join(tmpDir, "workspace");
  await fs.mkdir(wsDir, { recursive: true });

  try {
    await prepareProtectedCodexHome(tmpDir);
    const env = createProtectedCodexEnvironment({ rootDir: tmpDir });

    // 1. Local file write and edit
    const filePath = path.join(wsDir, "calc.js");
    await fs.writeFile(
      filePath,
      "export function multiply(a, b) { return a * b; }\n",
      "utf8",
    );
    assert.ok(await fs.stat(filePath));

    // 2. Local git repository operations (init, add, commit)
    await execFileAsync("git", ["init", "."], { cwd: wsDir, env });
    await execFileAsync("git", ["add", "calc.js"], { cwd: wsDir, env });
    const commitRes = await execFileAsync(
      "git",
      ["commit", "-m", "feat: add calculator"],
      { cwd: wsDir, env },
    );
    assert.ok(commitRes.stdout.includes("feat: add calculator"));

    // 3. Local git status & diff
    await fs.appendFile(filePath, "// addition\n", "utf8");
    const statusRes = await execFileAsync("git", ["status", "--short"], {
      cwd: wsDir,
      env,
    });
    assert.ok(statusRes.stdout.includes("M calc.js"));

    const diffRes = await execFileAsync("git", ["diff"], { cwd: wsDir, env });
    assert.ok(diffRes.stdout.includes("+// addition"));

    // 4. Local test/build command
    const testScript = path.join(wsDir, "test.js");
    await fs.writeFile(
      testScript,
      "import { multiply } from './calc.js';\nif (multiply(6, 7) !== 42) process.exit(1);\nconsole.log('TEST_OK');\n",
      "utf8",
    );
    const nodeRes = await execFileAsync("node", ["test.js"], {
      cwd: wsDir,
      env,
    });
    assert.ok(nodeRes.stdout.includes("TEST_OK"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
