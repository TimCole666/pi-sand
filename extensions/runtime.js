const STATUS_KEY = "pi-sand";
const WIDGET_KEY = "pi-sand";
const ACTIVITY = {
  IDLE: "idle",
  RUNNING: "running",
  WAITING_FOR_USER: "waiting_for_user",
};

function getSessionId(ctx) {
  return ctx.sessionManager.getSessionId();
}

class SessionRuntime {
  #sessionId;
  #activity = ACTIVITY.IDLE;
  #agentWorkActive = false;
  #closed = false;

  constructor(ctx) {
    this.#sessionId = getSessionId(ctx);
  }

  get sessionId() {
    return this.#sessionId;
  }

  get activity() {
    return this.#activity;
  }

  matches(ctx) {
    return !this.#closed && this.#sessionId === getSessionId(ctx);
  }

  render(ctx) {
    if (this.#closed || !this.matches(ctx)) return;
    ctx.ui.setStatus(STATUS_KEY, `pi-sand: ${this.#activity}`);
    ctx.ui.setWidget(WIDGET_KEY, [`pi-sand activity: ${this.#activity}`]);
  }

  setActivity(ctx, activity) {
    if (this.#closed || !this.matches(ctx)) return;
    this.#activity = activity;
    this.render(ctx);
  }

  beginUserPrompt(ctx) {
    if (this.#closed || !this.matches(ctx)) return;
    this.#activity = ACTIVITY.WAITING_FOR_USER;
    this.render(ctx);
  }

  endUserPrompt(ctx) {
    if (this.#closed || !this.matches(ctx)) return;
    this.#activity = this.#agentWorkActive ? ACTIVITY.RUNNING : ACTIVITY.IDLE;
    this.render(ctx);
  }

  setAgentWorkActive(ctx, active) {
    if (this.#closed || !this.matches(ctx)) return;
    this.#agentWorkActive = active;
  }

  close(ctx) {
    if (this.#closed) return;
    const matches = this.matches(ctx);
    this.#closed = true;
    if (matches) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }
}

function createStatus(runtime, ctx) {
  return {
    extension: "pi-sand",
    mode: ctx.mode,
    cwd: ctx.cwd,
    session: getSessionId(ctx),
    activity: runtime.activity,
  };
}

function formatStatus(status) {
  return JSON.stringify(status);
}

export function registerPiSandExtension(pi) {
  let runtime;

  const currentRuntime = (ctx) => (runtime?.matches(ctx) ? runtime : undefined);

  // pi-sand has no project-local configuration yet. Defer trust decisions to
  // Pi so a future configuration reader cannot accidentally bypass this boundary.
  pi.on("project_trust", async () => ({ trusted: "undecided" }));

  pi.on("session_start", async (_event, ctx) => {
    runtime?.close(ctx);
    runtime = new SessionRuntime(ctx);
    runtime.render(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = currentRuntime(ctx);
    if (current) {
      current.close(ctx);
      runtime = undefined;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    const current = currentRuntime(ctx);
    current?.setAgentWorkActive(ctx, true);
    current?.setActivity(ctx, ACTIVITY.RUNNING);
  });

  // A low-level run ending does not mean that Pi has settled. Pi can retry,
  // compact, or continue after this event, so preserve the current activity.
  pi.on("agent_end", async (_event, ctx) => {
    currentRuntime(ctx)?.render(ctx);
  });

  // agent_settled is the completion boundary for the foreground projection.
  pi.on("agent_settled", async (_event, ctx) => {
    const current = currentRuntime(ctx);
    current?.setAgentWorkActive(ctx, false);
    current?.setActivity(ctx, ACTIVITY.IDLE);
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    currentRuntime(ctx)?.beginUserPrompt(ctx);
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    currentRuntime(ctx)?.endUserPrompt(ctx);
  });

  pi.registerCommand("pi-sand", {
    description: "Show pi-sand host status",
    handler: async (_args, ctx) => {
      const current = currentRuntime(ctx);
      if (!current) return;
      const status = createStatus(current, ctx);
      current.render(ctx);
      ctx.ui.notify(formatStatus(status), "info");
    },
  });

  pi.registerCommand("pi-sand-reload", {
    description: "Reload pi-sand through Pi's extension runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });
}

export { ACTIVITY };
