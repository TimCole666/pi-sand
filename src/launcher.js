#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_POLL_INTERVAL_MS = 50;
const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function productUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** Wait until the local service has completed bootstrap and serves health. */
export async function waitForService({ baseUrl, fetchImpl = fetch, child, timeoutMs = SERVICE_START_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error("The Local Agent Service stopped during product launch.");
    }
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(`The Local Agent Service could not be reached during product launch${lastError ? `: ${lastError.message}` : "."}`);
}

/** Open the supported browser Desktop without making the browser the worker owner. */
export function openDesktop(url, { command = process.env.PI_SAND_BROWSER ?? "xdg-open", spawnImpl = spawn } = {}) {
  const browser = spawnImpl(command, [url], { detached: true, stdio: "ignore" });
  browser.unref?.();
  return browser;
}

/**
 * Start or connect to the fixed loopback product endpoint, then open the
 * supported Linux Desktop. The service is detached before this function
 * returns, so closing the browser cannot stop active Pi work.
 */
export async function launchProduct({
  port = Number(process.env.PORT ?? 4317),
  dbPath = process.env.PI_SAND_DB,
  fetchImpl = fetch,
  spawnImpl = spawn,
  openDesktopImpl = openDesktop,
  timeoutMs = SERVICE_START_TIMEOUT_MS,
  openBrowser = process.env.PI_SAND_NO_BROWSER !== "1",
} = {}) {
  const baseUrl = productUrl(port);
  let serviceProcess;
  let started = false;
  try {
    const health = await fetchImpl(`${baseUrl}/api/health`);
    if (!health.ok) throw new Error(`health check returned ${health.status}`);
  } catch {
    const environment = { ...process.env, PORT: String(port) };
    if (dbPath) environment.PI_SAND_DB = dbPath;
    serviceProcess = spawnImpl(process.execPath, [serverPath], { detached: true, stdio: "ignore", env: environment });
    serviceProcess.unref?.();
    started = true;
    await waitForService({ baseUrl, fetchImpl, child: serviceProcess, timeoutMs });
  }
  if (openBrowser) openDesktopImpl(baseUrl);
  return { url: baseUrl, started, pid: serviceProcess?.pid ?? null };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  launchProduct()
    .then(({ url }) => console.log(`pi-sand Desktop available at ${url}`))
    .catch((error) => {
      console.error(`pi-sand could not launch: ${error.message}`);
      process.exitCode = 1;
    });
}
