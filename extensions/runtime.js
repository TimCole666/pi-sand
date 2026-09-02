import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { RuntimeClient } from "../src/runtime-client.js";
import { resolveGitRepositoryRoot } from "../src/runtime-store.js";

const defaultRuntimeClientFactory = () => new RuntimeClient();
const STATUS_KEY = "pi-sand";
const WIDGET_KEY = "pi-sand";
const ACTIVITY = { IDLE: "idle", RUNNING: "running", WAITING_FOR_USER: "waiting_for_user" };
const getSessionId = (ctx) => ctx.sessionManager.getSessionId();

class SessionRuntime {
  #sessionId; #activity = ACTIVITY.IDLE; #agentWorkActive = false; #closed = false;
  #resultPollTimer = null; #resultPollInFlight = false;
  constructor(ctx) { this.#sessionId = getSessionId(ctx); }
  get activity() { return this.#activity; }
  matches(ctx) { return !this.#closed && this.#sessionId === getSessionId(ctx); }
  render(ctx) { if (!this.#closed && this.matches(ctx)) { ctx.ui.setStatus(STATUS_KEY, `pi-sand: ${this.#activity}`); ctx.ui.setWidget(WIDGET_KEY, [`pi-sand activity: ${this.#activity}`]); } }
  setActivity(ctx, activity) { if (!this.#closed && this.matches(ctx)) { this.#activity = activity; this.render(ctx); } }
  beginUserPrompt(ctx) { this.setActivity(ctx, ACTIVITY.WAITING_FOR_USER); }
  endUserPrompt(ctx) { if (!this.#closed && this.matches(ctx)) this.setActivity(ctx, this.#agentWorkActive ? ACTIVITY.RUNNING : ACTIVITY.IDLE); }
  setAgentWorkActive(ctx, active) { if (!this.#closed && this.matches(ctx)) this.#agentWorkActive = active; }
  async #pollResult(ctx, client, clientInstanceId) {
    if (this.#closed || !this.matches(ctx) || this.#resultPollInFlight) return;
    // Result polling must not make an ordinary Pi session start a brand-new
    // runtime. If a durable database already exists, however, reconnecting
    // Manager A/B may restart the daemon in order to claim its pending Result.
    if (client.socketPath && !existsSync(client.socketPath) &&
        client.dbPath && !existsSync(client.dbPath)) return;
    this.#resultPollInFlight = true;
    try {
      const result = await client.claimResult(clientInstanceId);
      if (!result || !this.matches(ctx)) return;
      try {
        ctx.ui.notify(JSON.stringify(result), result.outcome === "completed" ? "info" : "error");
      } catch { return; }
      if (!this.matches(ctx)) return;
      await client.ackResult(result.id, result.claimHandle);
    } catch { /* The next deterministic poll retries after an unavailable daemon or lease expiry. */ }
    finally { this.#resultPollInFlight = false; }
  }
  async startResultPolling(ctx, client, clientInstanceId) {
    if (typeof client?.claimResult !== "function" || typeof client?.ackResult !== "function") return;
    const initialPoll = this.#pollResult(ctx, client, clientInstanceId);
    this.#resultPollTimer = setInterval(() => void this.#pollResult(ctx, client, clientInstanceId), 5_000);
    this.#resultPollTimer.unref?.();
    await initialPoll;
  }
  close(ctx) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#resultPollTimer) clearInterval(this.#resultPollTimer);
    this.#resultPollTimer = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

function notifyResult(ctx, result) { ctx.ui.notify(JSON.stringify(result), result.ok ? "info" : "error"); return result; }
async function ipcResult(ctx, key, operation) {
  try { return notifyResult(ctx, { ok: true, [key]: await operation() }); }
  catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); }
}
function configuredAuthAvailable(ctx) { const signal = ctx.modelRegistry?.hasConfiguredAuth; return typeof signal !== "function" || signal.call(ctx.modelRegistry, ctx.model) !== false; }
function trustedProject(ctx, command) {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true
    ? null
    : `${command} requires a trusted Pi project.`;
}

function modelSnapshot(ctx) {
  return { provider: ctx.model?.provider, id: ctx.model?.id };
}

function taskRequest(args) {
  const text = String(args ?? "").trim();
  if (!text.startsWith("{")) return { goal: text };
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new Error("/task structured input must be valid JSON.");
  }
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("/task structured input must be a JSON object.");
  return {
    goal: request.goal,
    completionContract: request.completionContract,
    authority: request.authority,
    budget: request.budget,
    returnRoute: request.returnRoute,
    userRequestedReview: request.userRequestedReview,
    reviewRequested: request.reviewRequested,
    policyRiskMarker: request.policyRiskMarker,
    supervisorCoverageGap: request.supervisorCoverageGap,
  };
}

async function createTask(client, args, ctx) {
  const trustError = trustedProject(ctx, "/task");
  if (trustError) return notifyResult(ctx, { ok: false, error: trustError });
  if (!configuredAuthAvailable(ctx)) return notifyResult(ctx, { ok: false, error: "/task requires configured authentication for the selected provider." });
  try {
    const request = taskRequest(args);
    return notifyResult(ctx, {
      ok: true,
      task: await client.createTask({
        ...request,
        cwd: ctx.cwd,
        trusted: true,
        model: modelSnapshot(ctx),
        thinkingLevel: ctx.thinkingLevel,
      }),
    });
  } catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); }
}

async function retryTask(client, args, ctx) {
  const trustError = trustedProject(ctx, "/task-retry");
  if (trustError) return notifyResult(ctx, { ok: false, error: trustError });
  if (!configuredAuthAvailable(ctx)) return notifyResult(ctx, { ok: false, error: "/task-retry requires configured authentication for the selected provider." });
  const id = String(args ?? "").trim();
  try {
    // Inspection is intentionally separate from the mutation. It lets the
    // first-party client enforce the parent #38 same-source trust boundary
    // without giving the daemon a second project-trust authority.
    const task = await client.getTask(id);
    if (resolveGitRepositoryRoot(ctx.cwd) !== task.sourceRepoRoot) {
      return notifyResult(ctx, { ok: false, error: "/task-retry requires the current trusted Pi project to be the Task source repository." });
    }
    return notifyResult(ctx, { ok: true, task: await client.retryTask({ id, trusted: true, model: modelSnapshot(ctx), thinkingLevel: ctx.thinkingLevel }) });
  } catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); }
}

export function registerPiSandExtension(pi, { runtimeClientFactory } = {}) {
  let runtime;
  const injectedClient = runtimeClientFactory ? runtimeClientFactory() : undefined;
  let runtimeClient = injectedClient;
  const resultClientInstanceId = randomUUID();
  const currentRuntime = (ctx) => (runtime?.matches(ctx) ? runtime : undefined);
  const currentRuntimeClient = () => (runtimeClient ??= (runtimeClientFactory ?? defaultRuntimeClientFactory)());

  pi.registerCommand("tasks", { description: "List durable background Tasks", handler: async (_args, ctx) => ipcResult(ctx, "tasks", () => currentRuntimeClient().listTasks()) });
  const supportsTaskMutations = !runtimeClientFactory || typeof injectedClient?.createTask === "function";
  const supportsTaskControls = !runtimeClientFactory || (typeof injectedClient?.stopTask === "function" && typeof injectedClient?.retryTask === "function");
  const supportsResultDelivery = !runtimeClientFactory || (typeof injectedClient?.claimResult === "function" && typeof injectedClient?.ackResult === "function");
  if (supportsTaskMutations) {
    pi.registerCommand("task", { description: "Start one durable background Task in an isolated Fresh Executor", handler: async (args, ctx) => createTask(currentRuntimeClient(), args, ctx) });
    pi.registerCommand("task-show", { description: "Show one durable background Task", handler: async (args, ctx) => ipcResult(ctx, "task", () => currentRuntimeClient().getTask(String(args ?? "").trim())) });
    if (supportsTaskControls) {
      pi.registerCommand("task-stop", { description: "Stop an active durable background Task", handler: async (args, ctx) => ipcResult(ctx, "task", () => currentRuntimeClient().stopTask(String(args ?? "").trim())) });
      pi.registerCommand("task-retry", { description: "Retry a failed, stopped, or interrupted Task with a fresh executor", handler: async (args, ctx) => retryTask(currentRuntimeClient(), args, ctx) });
    }
  }
  pi.on("project_trust", async () => ({ trusted: "undecided" }));
  pi.on("session_start", async (_event, ctx) => {
    runtime = new SessionRuntime(ctx);
    runtime.render(ctx);
    if (supportsResultDelivery)
      await runtime.startResultPolling(ctx, currentRuntimeClient(), resultClientInstanceId);
  });
  pi.on("session_shutdown", async (_event, ctx) => { const current = currentRuntime(ctx); if (current) { current.close(ctx); runtime = undefined; } });
  pi.on("agent_start", async (_event, ctx) => { currentRuntime(ctx)?.setAgentWorkActive(ctx, true); currentRuntime(ctx)?.setActivity(ctx, ACTIVITY.RUNNING); });
  pi.on("agent_end", async (_event, ctx) => currentRuntime(ctx)?.render(ctx));
  pi.on("agent_settled", async (_event, ctx) => { currentRuntime(ctx)?.setAgentWorkActive(ctx, false); currentRuntime(ctx)?.setActivity(ctx, ACTIVITY.IDLE); });
  pi.on("ui_prompt_start", async (_event, ctx) => currentRuntime(ctx)?.beginUserPrompt(ctx));
  pi.on("ui_prompt_end", async (_event, ctx) => currentRuntime(ctx)?.endUserPrompt(ctx));
  pi.registerCommand("pi-sand", { description: "Show pi-sand host status", handler: async (_args, ctx) => { const current = currentRuntime(ctx); if (!current) return; current.render(ctx); ctx.ui.notify(JSON.stringify({ extension: "pi-sand", mode: ctx.mode, cwd: ctx.cwd, session: getSessionId(ctx), activity: current.activity }), "info"); } });
}
export { ACTIVITY };
