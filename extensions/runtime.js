import { RuntimeClient } from "../src/runtime-client.js";

const defaultRuntimeClientFactory = () => new RuntimeClient();
const STATUS_KEY = "pi-sand";
const WIDGET_KEY = "pi-sand";
const ACTIVITY = { IDLE: "idle", RUNNING: "running", WAITING_FOR_USER: "waiting_for_user" };
const getSessionId = (ctx) => ctx.sessionManager.getSessionId();

class SessionRuntime {
  #sessionId; #activity = ACTIVITY.IDLE; #agentWorkActive = false; #closed = false;
  constructor(ctx) { this.#sessionId = getSessionId(ctx); }
  get activity() { return this.#activity; }
  matches(ctx) { return !this.#closed && this.#sessionId === getSessionId(ctx); }
  render(ctx) { if (!this.#closed && this.matches(ctx)) { ctx.ui.setStatus(STATUS_KEY, `pi-sand: ${this.#activity}`); ctx.ui.setWidget(WIDGET_KEY, [`pi-sand activity: ${this.#activity}`]); } }
  setActivity(ctx, activity) { if (!this.#closed && this.matches(ctx)) { this.#activity = activity; this.render(ctx); } }
  beginUserPrompt(ctx) { this.setActivity(ctx, ACTIVITY.WAITING_FOR_USER); }
  endUserPrompt(ctx) { if (!this.#closed && this.matches(ctx)) this.setActivity(ctx, this.#agentWorkActive ? ACTIVITY.RUNNING : ACTIVITY.IDLE); }
  setAgentWorkActive(ctx, active) { if (!this.#closed && this.matches(ctx)) this.#agentWorkActive = active; }
  close(ctx) { if (!this.#closed) { this.#closed = true; ctx.ui.setStatus(STATUS_KEY, undefined); ctx.ui.setWidget(WIDGET_KEY, undefined); } }
}

function notifyResult(ctx, result) { ctx.ui.notify(JSON.stringify(result), result.ok ? "info" : "error"); return result; }
function configuredAuthAvailable(ctx) { const signal = ctx.modelRegistry?.hasConfiguredAuth; return typeof signal !== "function" || signal.call(ctx.modelRegistry, ctx.model) !== false; }
async function createTask(client, args, ctx) {
  if (typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted() !== true) return notifyResult(ctx, { ok: false, error: "/task requires a trusted Pi project." });
  if (!configuredAuthAvailable(ctx)) return notifyResult(ctx, { ok: false, error: "/task requires configured authentication for the selected provider." });
  try { return notifyResult(ctx, { ok: true, task: await client.createTask({ goal: args, cwd: ctx.cwd, trusted: true, model: { provider: ctx.model?.provider, id: ctx.model?.id }, thinkingLevel: ctx.thinkingLevel }) }); }
  catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); }
}

export function registerPiSandExtension(pi, { runtimeClientFactory } = {}) {
  let runtime;
  const injectedClient = runtimeClientFactory ? runtimeClientFactory() : undefined;
  let runtimeClient = injectedClient;
  const currentRuntime = (ctx) => (runtime?.matches(ctx) ? runtime : undefined);
  const currentRuntimeClient = () => (runtimeClient ??= (runtimeClientFactory ?? defaultRuntimeClientFactory)());

  pi.registerCommand("tasks", { description: "List durable background Tasks", handler: async (_args, ctx) => { try { return notifyResult(ctx, { ok: true, tasks: await currentRuntimeClient().listTasks() }); } catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); } } });
  const supportsTaskMutations = !runtimeClientFactory || typeof injectedClient?.createTask === "function";
  if (supportsTaskMutations) {
    pi.registerCommand("task", { description: "Start one durable background Task in an isolated Fresh Executor", handler: async (args, ctx) => createTask(currentRuntimeClient(), args, ctx) });
    pi.registerCommand("task-show", { description: "Show one durable background Task", handler: async (args, ctx) => { try { return notifyResult(ctx, { ok: true, task: await currentRuntimeClient().getTask(String(args).trim()) }); } catch (error) { return notifyResult(ctx, { ok: false, error: error.message }); } } });
  }
  pi.on("project_trust", async () => ({ trusted: "undecided" }));
  pi.on("session_start", async (_event, ctx) => { runtime = new SessionRuntime(ctx); runtime.render(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { const current = currentRuntime(ctx); if (current) { current.close(ctx); runtime = undefined; } });
  pi.on("agent_start", async (_event, ctx) => { currentRuntime(ctx)?.setAgentWorkActive(ctx, true); currentRuntime(ctx)?.setActivity(ctx, ACTIVITY.RUNNING); });
  pi.on("agent_end", async (_event, ctx) => currentRuntime(ctx)?.render(ctx));
  pi.on("agent_settled", async (_event, ctx) => { currentRuntime(ctx)?.setAgentWorkActive(ctx, false); currentRuntime(ctx)?.setActivity(ctx, ACTIVITY.IDLE); });
  pi.on("ui_prompt_start", async (_event, ctx) => currentRuntime(ctx)?.beginUserPrompt(ctx));
  pi.on("ui_prompt_end", async (_event, ctx) => currentRuntime(ctx)?.endUserPrompt(ctx));
  pi.registerCommand("pi-sand", { description: "Show pi-sand host status", handler: async (_args, ctx) => { const current = currentRuntime(ctx); if (!current) return; current.render(ctx); ctx.ui.notify(JSON.stringify({ extension: "pi-sand", mode: ctx.mode, cwd: ctx.cwd, session: getSessionId(ctx), activity: current.activity }), "info"); } });
}
export { ACTIVITY };
