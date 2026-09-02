#!/usr/bin/env node
/**
 * Verification runner for Issue #75: Falsification Probe for OpenClaw Native Session Authority.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("# Executing Issue #75 OpenClaw Authority Falsification Probe...");

  const openClawDir = "/home/tiancaijb/tmp/pi-sand-openclaw";
  const tsxBin = path.join(openClawDir, "node_modules", ".bin", "tsx");
  const probeScript = path.join(__dirname, "probe.mts");

  const { stdout, stderr } = await execFileAsync(tsxBin, [probeScript], {
    cwd: openClawDir,
    maxBuffer: 10 * 1024 * 1024,
  });

  console.log(stdout);
  if (stderr) {
    console.error(stderr);
  }

  // Verify traces/summary.json
  const summaryPath = path.join(__dirname, "traces", "summary.json");
  const summaryContent = await fs.readFile(summaryPath, "utf8");
  const summary = JSON.parse(summaryContent);

  if (summary.verdict !== "FALSIFIED") {
    throw new Error(`Unexpected probe verdict: expected FALSIFIED, got ${summary.verdict}`);
  }

  const { metrics } = summary;
  if (!metrics.metric_1_commits.openclaw || !metrics.metric_1_commits.codex) {
    throw new Error("Metric 1 (commits) missing");
  }
  if (!metrics.metric_2_pause_injection_point.boundary) {
    throw new Error("Metric 2 (pause injection point) missing");
  }
  if (!metrics.metric_3_facts_read_by_authority_checks.telegram_final_dispatch_check) {
    throw new Error("Metric 3 (facts read) missing");
  }
  if (metrics.metric_4_ingress_row_queryable.queryable !== true) {
    throw new Error("Metric 4 (queryable) failed");
  }
  if (!metrics.metric_5_ingress_row_consumption_timing.completion_time) {
    throw new Error("Metric 5 (consumption timing) missing");
  }
  if (metrics.metric_6_crash_restart_stale_fence.fenced !== false) {
    throw new Error("Metric 6 (crash restart fence) failed");
  }
  if (metrics.metric_7_status_query_behavior.closes_protected_window_in_openclaw_native !== false) {
    throw new Error("Metric 7 (status query behavior) failed");
  }

  console.log("\n[SUCCESS] Issue #75 Falsification Probe passed all assertions. Verdict: FALSIFIED.");
}

main().catch((err) => {
  console.error("\n[FAILURE] Verification failed:", err);
  process.exit(1);
});
