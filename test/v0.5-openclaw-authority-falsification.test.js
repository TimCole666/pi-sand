import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const summaryPath = path.join(__dirname, "..", "spikes", "v0.5-openclaw-authority-probe", "traces", "summary.json");

describe("v0.5 OpenClaw Native Session Authority Falsification (Issue #75)", () => {
  it("proves native OpenClaw authority mechanisms are FALSIFIED for Issue #66", async () => {
    const raw = await fs.readFile(summaryPath, "utf8");
    const summary = JSON.parse(raw);

    assert.equal(summary.verdict, "FALSIFIED");
    assert.match(summary.justification, /decoupled/i);
    assert.match(summary.justification, /fails wide open/i);

    const { metrics } = summary;

    // Metric 1: Pinned revisions
    assert.equal(metrics.metric_1_commits.openclaw, "ff63da7237e5f99e9fc03a86daf56e3c3e8f5356");
    assert.equal(metrics.metric_1_commits.codex, "a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67");

    // Metric 2: Pause injection point
    assert.equal(metrics.metric_2_pause_injection_point.file, "src/channels/message/ingress-queue.ts");
    assert.match(metrics.metric_2_pause_injection_point.boundary, /runOpenClawStateWriteTransaction/);

    // Metric 3: Facts read by authority checks
    const tgCheck = metrics.metric_3_facts_read_by_authority_checks.telegram_final_dispatch_check;
    assert.equal(tgCheck.inspects_ingress_queue, false);
    assert.equal(tgCheck.reads_sqlite_channel_ingress_events, false);

    const ghCheck = metrics.metric_3_facts_read_by_authority_checks.github_publication_authority_check;
    assert.equal(ghCheck.inspects_ingress_queue, false);
    assert.equal(ghCheck.reads_sqlite_channel_ingress_events, false);

    // Metric 4: Persisted pending ingress row is queryable
    assert.equal(metrics.metric_4_ingress_row_queryable.queryable, true);
    assert.equal(metrics.metric_4_ingress_row_queryable.persisted_row.status, "pending");

    // Metric 5: Consumption timing
    assert.match(metrics.metric_5_ingress_row_consumption_timing.completion_time, /queue\.complete/);

    // Metric 6: Crash / restart fails open (not fenced)
    assert.equal(metrics.metric_6_crash_restart_stale_fence.fenced, false);
    assert.equal(metrics.metric_6_crash_restart_stale_fence.post_restart_telegram_dispatch_allowed, true);
    assert.equal(metrics.metric_6_crash_restart_stale_fence.post_restart_github_claim_valid, true);

    // Metric 7: Status query does not close protected action window in native OpenClaw
    assert.equal(metrics.metric_7_status_query_behavior.closes_protected_window_in_openclaw_native, false);
    assert.equal(metrics.metric_7_status_query_behavior.status_query_telegram_allowed, true);
    assert.equal(metrics.metric_7_status_query_behavior.status_query_github_claim_valid, true);
  });
});
