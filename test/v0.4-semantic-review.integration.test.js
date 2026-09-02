import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../src/runtime-store.js";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const eventually = async (read, predicate) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for semantic reviewer");
};

async function fixture({ completionContract, reviewerFactory, workerFactory, budget } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-sand-v04-semantic-review-"));
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  const piCommand = join(parent, "pi-version");
  await writeFile(piCommand, "#!/bin/sh\nprintf '0.84.4\\n'\n");
  await chmod(piCommand, 0o755);
  const calls = [];
  const defaultWorker = async ({ role, cwd, onEvent, taskPrompt }) => {
    calls.push({ role, cwd, taskPrompt });
    if (role === "reviewer") {
      calls.at(-1).candidateAtStart = git(cwd, ["rev-parse", "HEAD"]);
      onEvent({ type: "message_end", message: { role: "assistant", content: JSON.stringify({ candidateSha: calls.at(-1).candidateAtStart, verdicts: [{ criterion: "semantic criterion", verdict: "pass", evidenceRefs: ["deterministic-gates"] }], findings: [{ severity: "info", detail: "No semantic discrepancies found.", evidenceRefs: ["deterministic-gates"] }], uncertainty: "", recommendation: "accept" }), stopReason: "stop" } });
    } else {
      await writeFile(join(cwd, "candidate.txt"), "candidate\n");
      onEvent({ type: "message_end", message: { role: "assistant", content: "IMPLEMENTER_TRANSCRIPT_MARKER", stopReason: "stop" } });
    }
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, executionSnapshot: { sessionId: `${role}-session` }, close() {} };
  };
  const dbPath = join(parent, "runtime.sqlite");
  const worktreeRoot = join(parent, "worktrees");
  const runtime = new RuntimeStore({ dbPath, piCommand, worktreeRoot, workerFactory: workerFactory ?? defaultWorker, reviewerFactory });
  const task = await runtime.createTask({ cwd: source, trusted: true, goal: "implement fixture", model: { provider: "provider", id: "model" }, thinkingLevel: "low", completionContract: completionContract ?? { objective: "implement fixture", localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] }, budget });
  return { parent, source, runtime, task, calls, dbPath, worktreeRoot, piCommand };
}

async function closeFixture(value) {
  try { await value.runtime.shutdown(); } catch {}
  try { value.runtime.release(); } catch {}
  await rm(value.parent, { recursive: true, force: true });
}

test("no semantic trigger creates no reviewer Attempt", async () => {
  const value = await fixture();
  try {
    const completed = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "completed");
    assert.equal(completed.attempts.filter((attempt) => attempt.role === "reviewer").length, 0);
    assert.deepEqual(value.calls.map(({ role }) => role), ["executor"]);
  } finally { await closeFixture(value); }
});

test("conditional review is a fresh exact-candidate Attempt with bounded context and isolated mutation", async () => {
  const value = await fixture({ completionContract: { objective: "implement fixture", semanticReview: true, semanticCriteria: ["semantic criterion"], localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] } });
  try {
    const completed = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "completed");
    const reviewer = completed.attempts.find((attempt) => attempt.role === "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.cause, "review");
    assert.equal(completed.terminalReason, "verified_semantic_review");
    assert.equal(completed.finalResult, "IMPLEMENTER_TRANSCRIPT_MARKER");
    const executor = value.calls.find(({ role }) => role === "executor");
    const reviewCall = value.calls.find(({ role }) => role === "reviewer");
    assert.notEqual(reviewCall.cwd, executor.cwd);
    assert.equal(reviewCall.candidateAtStart, completed.finalRevision);
    assert.equal(reviewCall.taskPrompt.includes("IMPLEMENTER_TRANSCRIPT_MARKER"), false);
    assert.equal(reviewCall.taskPrompt.includes(completed.baseCommit), true);
    assert.equal(reviewCall.taskPrompt.includes(completed.finalRevision), true);
    assert.equal(await readFile(join(completed.taskWorktree, "reviewer-only.txt")).catch(() => null), null);
    assert.equal(completed.evidence.filter((evidence) => evidence.kind === "semantic_review").length, 1);
  } finally { await closeFixture(value); }
});

test("daemon restart retires a persisted reviewer and cleans its ephemeral view", async () => {
  const value = await fixture({
    reviewerFactory: async () => ({ callbacksAttached: true, executionSnapshot: { sessionId: "review-session" }, close() {} }),
    completionContract: { objective: "restart reviewer", semanticReview: true, semanticCriteria: ["semantic criterion"], localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] },
  });
  let restarted;
  try {
    const running = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.attempts.some((attempt) => attempt.role === "reviewer" && attempt.state === "running"));
    const reviewer = running.attempts.find((attempt) => attempt.role === "reviewer");
    assert.ok(reviewer.reviewWorktree);
    assert.ok(reviewer.reviewWorktreeRoot);
    assert.equal(await readFile(join(reviewer.reviewWorktree, "base.txt"), "utf8"), "base\n");
    value.runtime.db.prepare("UPDATE attempts SET state = 'completed', worker_terminated = 1 WHERE id = ?").run(reviewer.id);
    value.runtime.release();
    restarted = new RuntimeStore({ dbPath: value.dbPath, piCommand: value.piCommand, worktreeRoot: value.worktreeRoot, workerFactory: async () => ({ callbacksAttached: true, executionSnapshot: { sessionId: "unused" }, close() {} }) });
    const restored = restarted.getTask(value.task.id);
    const restoredReviewer = restored.attempts.find((attempt) => attempt.id === reviewer.id);
    assert.equal(restoredReviewer.reviewWorktree, null);
    assert.equal(restoredReviewer.reviewWorktreeRoot, null);
    assert.equal(existsSync(reviewer.reviewWorktree), false);
  } finally {
    restarted?.release();
    await closeFixture(value);
  }
});

test("reviewer cleanup path traversal fails closed and retains the view", async () => {
  const value = await fixture({
    reviewerFactory: async () => ({ callbacksAttached: true, executionSnapshot: { sessionId: "review-session" }, close() {} }),
    completionContract: { objective: "cleanup fence", semanticReview: true, semanticCriteria: ["semantic criterion"], localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] },
  });
  let restarted;
  try {
    const running = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.attempts.some((attempt) => attempt.role === "reviewer" && attempt.state === "running"));
    const reviewer = running.attempts.find((attempt) => attempt.role === "reviewer");
    value.runtime.db.prepare("UPDATE attempts SET state = 'completed', worker_terminated = 1, review_worktree_root = ? WHERE id = ?").run(value.parent, reviewer.id);
    value.runtime.release();
    restarted = new RuntimeStore({ dbPath: value.dbPath, piCommand: value.piCommand, worktreeRoot: value.worktreeRoot, workerFactory: async () => ({ callbacksAttached: true, executionSnapshot: { sessionId: "unused" }, close() {} }) });
    const blocked = restarted.getTask(value.task.id);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.terminalReason, "semantic_review_cleanup_failed");
    assert.equal(existsSync(reviewer.reviewWorktree), true);
  } finally {
    restarted?.release();
    await closeFixture(value);
  }
});

test("malformed semantic receipts are durably blocked and never verified", async () => {
  for (const receipt of [
    { candidateSha: "MATCH", verdicts: [], findings: [], recommendation: "accept" },
    { candidateSha: "0".repeat(40), verdicts: [{ criterion: "semantic criterion", verdict: "pass", evidenceRefs: [] }], findings: [{ severity: "unknown", detail: "bad", evidenceRefs: ["x"] }], recommendation: "accept" },
  ]) {
    const value = await fixture({
      reviewerFactory: async ({ onEvent, taskPrompt }) => {
        const candidateSha = taskPrompt.match(/Candidate SHA: ([0-9a-f]{40})/)?.[1] ?? "";
        const actualReceipt = receipt.candidateSha === "MATCH" ? { ...receipt, candidateSha } : receipt;
        onEvent({ type: "message_end", message: { role: "assistant", content: JSON.stringify(actualReceipt), stopReason: "stop" } });
        onEvent({ type: "agent_settled" });
        return { callbacksAttached: true, executionSnapshot: { sessionId: "review-session" }, close() {} };
      },
      completionContract: { objective: "malformed receipt", semanticReview: true, semanticCriteria: ["semantic criterion"], localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] },
    });
    try {
      const blocked = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "blocked");
      assert.notEqual(blocked.terminalReason, "verified_semantic_review");
      assert.equal(blocked.evidence.some((evidence) => evidence.kind === "semantic_review"), true);
    } finally { await closeFixture(value); }
  }
});

test("repair recommendation uses a fresh executor and enforces the reviewer budget", async () => {
  let executorRuns = 0;
  let reviewRuns = 0;
  const workerFactory = async ({ role, cwd, onEvent }) => {
    if (role === "reviewer") return reviewerFactory({ cwd, onEvent });
    executorRuns += 1;
    await writeFile(join(cwd, `candidate-${executorRuns}.txt`), "candidate\n");
    onEvent({ type: "message_end", message: { role: "assistant", content: `executor-${executorRuns}`, stopReason: "stop" } });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, executionSnapshot: { sessionId: `executor-${executorRuns}` }, close() {} };
  };
  const reviewerFactory = async ({ onEvent, taskPrompt }) => {
    reviewRuns += 1;
    const candidateSha = taskPrompt.match(/Candidate SHA: ([0-9a-f]{40})/)?.[1] ?? "";
    const needsRepair = reviewRuns === 1;
    onEvent({ type: "message_end", message: { role: "assistant", content: JSON.stringify({ candidateSha, verdicts: [{ criterion: "semantic criterion", verdict: needsRepair ? "fail" : "pass", evidenceRefs: ["deterministic-gates"] }], findings: needsRepair ? [{ severity: "major", detail: "repair", evidenceRefs: ["deterministic-gates"] }] : [{ severity: "info", detail: "No semantic discrepancies found.", evidenceRefs: ["deterministic-gates"] }], uncertainty: "", recommendation: needsRepair ? "repair" : "accept" }), stopReason: "stop" } });
    onEvent({ type: "agent_settled" });
    return { callbacksAttached: true, executionSnapshot: { sessionId: `review-${reviewRuns}` }, close() {} };
  };
  const value = await fixture({ workerFactory, reviewerFactory, budget: { maxReviewerAttempts: 1 }, completionContract: { objective: "repair then review", semanticReview: true, semanticCriteria: ["semantic criterion"], localGates: [{ id: "green", command: [process.execPath, "-e", "process.exit(0)"] }] } });
  try {
    const failed = await eventually(() => value.runtime.getTask(value.task.id), (task) => task.state === "failed");
    assert.equal(failed.terminalReason, "budget_exhausted");
    assert.equal(reviewRuns, 1);
    assert.equal(executorRuns, 2);
    assert.equal(failed.attempts.some((attempt) => attempt.role === "executor" && attempt.cause === "repair"), true);
  } finally { await closeFixture(value); }
});
