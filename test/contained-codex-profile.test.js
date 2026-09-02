import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTECTED_CONTAINED_PROFILE,
  PROTECTED_CONTAINED_POLICY_TYPE,
  UNCONTAINED_PROFILES,
  resolveProtectedCodexExecutionProfile,
  createProtectedThreadStartParams,
  createProtectedTurnStartParams,
} from "../src/contained-codex-profile.js";

test("resolveProtectedCodexExecutionProfile defaults to pinned workspace-write profile", () => {
  const profile = resolveProtectedCodexExecutionProfile();
  assert.equal(profile, PROTECTED_CONTAINED_PROFILE);
  assert.equal(profile, "workspace-write");
});

test("resolveProtectedCodexExecutionProfile accepts explicit workspace-write", () => {
  const profile = resolveProtectedCodexExecutionProfile({ sandbox: "workspace-write" });
  assert.equal(profile, "workspace-write");
});

test("resolveProtectedCodexExecutionProfile rejects uncontained profiles with fail-closed error", () => {
  for (const uncontained of UNCONTAINED_PROFILES) {
    assert.throws(
      () => resolveProtectedCodexExecutionProfile({ sandbox: uncontained }),
      (err) => {
        assert.match(err.message, /Protected Writer Class A violation/);
        assert.match(err.message, /uncontained execution profile/);
        return true;
      },
    );
  }
});

test("resolveProtectedCodexExecutionProfile rejects unknown profiles", () => {
  assert.throws(
    () => resolveProtectedCodexExecutionProfile({ sandbox: "read-only" }),
    (err) => {
      assert.match(err.message, /unknown or unverified execution profile/);
      return true;
    },
  );
});

test("createProtectedThreadStartParams constructs valid thread/start payload", () => {
  const params = createProtectedThreadStartParams({
    cwd: "/path/to/workspace",
    model: "gpt-5.6-sol",
    modelProvider: "codex_local_access",
  });

  assert.deepEqual(params, {
    cwd: "/path/to/workspace",
    model: "gpt-5.6-sol",
    modelProvider: "codex_local_access",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
});

test("createProtectedThreadStartParams rejects missing cwd or uncontained profile", () => {
  assert.throws(
    () => createProtectedThreadStartParams({}),
    /requires a non-empty cwd/,
  );

  assert.throws(
    () =>
      createProtectedThreadStartParams({
        cwd: "/path/to/workspace",
        sandbox: "danger-full-access",
      }),
    /Protected Writer Class A violation/,
  );
});

test("createProtectedTurnStartParams constructs canonical turn/start payload with pinned workspaceWrite policy", () => {
  const params = createProtectedTurnStartParams({
    threadId: "th_123",
    workspace: "/path/to/workspace",
    text: "Implement task",
    clientUserMessageId: "turn_1",
    effort: "medium",
  });

  assert.deepEqual(params, {
    threadId: "th_123",
    input: [{ type: "text", text: "Implement task" }],
    clientUserMessageId: "turn_1",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: PROTECTED_CONTAINED_POLICY_TYPE,
      writableRoots: ["/path/to/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    effort: "medium",
  });
});

test("createProtectedTurnStartParams enforces required parameters", () => {
  assert.throws(
    () => createProtectedTurnStartParams({ workspace: "/path" }),
    /requires threadId/,
  );
  assert.throws(
    () => createProtectedTurnStartParams({ threadId: "th_1" }),
    /requires workspace/,
  );
});
