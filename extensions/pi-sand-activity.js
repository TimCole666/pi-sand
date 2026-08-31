const STATUS_KEY = "pi-sand";
const WIDGET_KEY = "pi-sand";

/** @typedef {"idle" | "running" | "waiting_for_user"} PiSandActivity */

/**
 * Register the pi-sand foreground activity projection.
 *
 * The projection is deliberately session-scoped: Pi lifecycle events are its
 * input, and the status/widget plus /pi-sand command are its output.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function registerPiSandActivity(pi) {
  /** @type {PiSandActivity | undefined} */
  let activity;
  let agentWorkActive = false;

  /**
   * @param {import("@earendil-works/pi-coding-agent").ExtensionContext} ctx
   */
  function render(ctx) {
    if (activity === undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `pi-sand: ${activity}`);
    ctx.ui.setWidget(WIDGET_KEY, [`pi-sand activity: ${activity}`]);
  }

  /**
   * @param {PiSandActivity} nextActivity
   * @param {import("@earendil-works/pi-coding-agent").ExtensionContext} ctx
   */
  function transitionTo(nextActivity, ctx) {
    activity = nextActivity;
    render(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    agentWorkActive = false;
    transitionTo("idle", ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentWorkActive = true;
    transitionTo("running", ctx);
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    transitionTo("waiting_for_user", ctx);
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    transitionTo(agentWorkActive ? "running" : "idle", ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    // A low-level run ending does not mean that Pi has settled.
    render(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    agentWorkActive = false;
    transitionTo("idle", ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    agentWorkActive = false;
    activity = undefined;
    render(ctx);
  });

  pi.registerCommand("pi-sand", {
    description: "Show pi-sand host status",
    handler: async (_args, ctx) => {
      if (activity === undefined) return;

      render(ctx);
      ctx.ui.notify(JSON.stringify({
        extension: "pi-sand",
        mode: ctx.mode,
        cwd: ctx.cwd,
        session: ctx.sessionManager.getSessionId(),
        activity,
      }), "info");
    },
  });
}
