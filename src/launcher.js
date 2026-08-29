#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_POLL_INTERVAL_MS = 50;
const SUPPORTED_CHROMIUM_PATHS = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
const SUPPORTED_CHROMIUM_COMMANDS = ["chromium", "chromium-browser"];
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

/** Locate the one supported Linux Desktop runtime: Chromium. */
export function locateChromium({ pathEnv = process.env.PATH, accessImpl = accessSync } = {}) {
  const candidates = [
    ...SUPPORTED_CHROMIUM_PATHS,
    ...String(pathEnv ?? "").split(":").filter(Boolean).flatMap((directory) => SUPPORTED_CHROMIUM_COMMANDS.map((name) => join(directory, name))),
  ];
  for (const candidate of candidates) {
    try {
      accessImpl(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next supported installation location. */ }
  }
  throw new Error("The supported Chromium Desktop runtime was not found. Install Chromium and make it available on PATH.");
}

/** Open the supported Chromium Desktop without making it the worker owner. */
export function openDesktop(url, { command = locateChromium(), spawnImpl = spawn } = {}) {
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
  openDesktopOptions = {},
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
    try {
      serviceProcess = spawnImpl(process.execPath, [serverPath], { detached: true, stdio: "ignore", env: environment });
      serviceProcess.unref?.();
      started = true;
    } catch (error) {
      // The Desktop is the product surface for bootstrap failures too. Open it
      // before surfacing the launcher error so it can render Connecting/Error
      // and Retry instead of leaving the user with only launcher stderr.
      if (openBrowser) openDesktopImpl(baseUrl, openDesktopOptions);
      throw error;
    }
    if (openBrowser) openDesktopImpl(baseUrl, openDesktopOptions);
    await waitForService({ baseUrl, fetchImpl, child: serviceProcess, timeoutMs });
  }
  if (!started && openBrowser) openDesktopImpl(baseUrl, openDesktopOptions);
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
