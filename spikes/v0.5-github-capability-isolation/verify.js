#!/usr/bin/env node
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
} from "../../src/v0.5/github-capability-isolation.js";

const execFileAsync = promisify(execFile);

async function main() {
  console.log("# v0.5 Codex GitHub Write-Capability Isolation Verification");
  console.log(`OpenClaw commit: ${PROTECTED_PINNED_CONTRACT.openClawCommit}`);
  console.log(`Codex commit: ${PROTECTED_PINNED_CONTRACT.codexCommit}`);
  console.log(`Codex CLI binary: ${PROTECTED_PINNED_CONTRACT.codexManagedBinary}`);
  console.log();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-verify-isolation-"));
  const wsDir = path.join(tmpDir, "workspace");
  await fs.mkdir(wsDir, { recursive: true });

  try {
    await prepareProtectedCodexHome(tmpDir);
    const env = createProtectedCodexEnvironment({ rootDir: tmpDir });

    console.log("## Negative-Capability Audit Matrix");
    const matrix = await auditNegativeGitHubCapabilities({ env, cwd: wsDir });

    // Table rows:
    const rows = [
      {
        path: "GH_TOKEN",
        expected: "unavailable",
        actual: env.GH_TOKEN ? "present" : "unavailable",
        status: matrix.envTokens.status,
      },
      {
        path: "GITHUB_TOKEN",
        expected: "unavailable",
        actual: env.GITHUB_TOKEN ? "present" : "unavailable",
        status: matrix.envTokens.status,
      },
      {
        path: "gh authenticated profile",
        expected: "unavailable",
        actual: matrix.ghAuthStatus.status === "PASS" ? "unauthenticated" : "active profile",
        status: matrix.ghAuthStatus.status,
      },
      {
        path: "HTTPS credential helper",
        expected: "unusable",
        actual: matrix.gitCredentialHelper.status === "PASS" ? "prompt disabled (fill failed)" : "returned credential",
        status: matrix.gitCredentialHelper.status,
      },
      {
        path: "SSH private key",
        expected: "unavailable",
        actual: matrix.sshWrite.status === "PASS" ? "permission denied" : "authenticated",
        status: matrix.sshWrite.status,
      },
      {
        path: "SSH_AUTH_SOCK",
        expected: "unavailable",
        actual: matrix.sshAgent.status === "PASS" ? "no agent connection" : "active agent",
        status: matrix.sshAgent.status,
      },
      {
        path: "operator HOME credentials",
        expected: "unavailable",
        actual: matrix.homeXdgIsolation.status === "PASS" ? `isolated (${path.basename(env.HOME)})` : "leaked",
        status: matrix.homeXdgIsolation.status,
      },
      {
        path: "GitHub write MCP/App",
        expected: "unavailable",
        actual: PROTECTED_TOOL_ALLOWLIST.isToolAllowed("mcp__github__create_issue") ? "allowed" : "tool allowlist rejected",
        status: !PROTECTED_TOOL_ALLOWLIST.isToolAllowed("mcp__github__create_issue") ? "PASS" : "FAIL",
      },
      {
        path: "raw authenticated API",
        expected: "unavailable",
        actual: matrix.rawApiMutation.status === "PASS" ? "HTTP 401 / unauthenticated" : "authenticated write",
        status: matrix.rawApiMutation.status,
      },
      {
        path: "git push authentication/write",
        expected: "denied",
        actual: matrix.gitPush.status === "PASS" ? "prompt disabled (auth failed)" : "push succeeded",
        status: matrix.gitPush.status,
      },
    ];

    console.log("| PATH | EXPECTED | ACTUAL | STATUS |");
    console.log("| --- | --- | --- | --- |");
    for (const r of rows) {
      console.log(`| ${r.path} | ${r.expected} | ${r.actual} | ${r.status} |`);
    }

    const allPassed = rows.every((r) => r.status === "PASS");
    console.log();
    if (!allPassed) {
      console.error("❌ Verification FAILED: Some negative capabilities were not isolated.");
      process.exit(1);
    }

    console.log("## Normal Coding Capability Proof");
    // Verify file write
    const testFile = path.join(wsDir, "calc.js");
    await fs.writeFile(testFile, "export const add = (a, b) => a + b;\n");
    console.log("✔ Local file write: calc.js written");

    // Verify git init & commit
    await execFileAsync("git", ["init", "."], { cwd: wsDir, env });
    await execFileAsync("git", ["add", "calc.js"], { cwd: wsDir, env });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: wsDir, env });
    console.log("✔ Local git commit: created commit with isolated dummy author");

    // Verify git status & diff
    await fs.appendFile(testFile, "export const sub = (a, b) => a - b;\n");
    const diffRes = await execFileAsync("git", ["diff"], { cwd: wsDir, env });
    if (!diffRes.stdout.includes("+export const sub")) {
      throw new Error("git diff did not reflect modification");
    }
    console.log("✔ Local git status/diff: changes tracked cleanly");

    // Verify build/test command
    const runRes = await execFileAsync("node", ["-e", "import('./calc.js').then(m => console.log(m.add(20, 22)))"], {
      cwd: wsDir,
      env,
    });
    if (!runRes.stdout.includes("42")) {
      throw new Error("Local test command output unexpected: " + runRes.stdout);
    }
    console.log("✔ Local shell build/test command: executed successfully (output: 42)");

    console.log();
    console.log("✅ STATUS: PASS - All negative GitHub write capabilities are physically absent and normal coding behavior is preserved.");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Verification failed with error:", err);
  process.exit(1);
});
