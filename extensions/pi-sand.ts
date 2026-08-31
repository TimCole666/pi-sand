import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type PiSandActivity = "idle" | "running";

type PiSandStatus = {
  extension: "pi-sand";
  mode: ExtensionCommandContext["mode"];
  cwd: string;
  session: string;
  activity: PiSandActivity;
};

function getStatus(ctx: ExtensionCommandContext): PiSandStatus {
  return {
    extension: "pi-sand",
    mode: ctx.mode,
    cwd: ctx.cwd,
    session: ctx.sessionManager.getSessionId(),
    activity: ctx.isIdle() ? "idle" : "running",
  };
}

function formatStatus(status: PiSandStatus): string {
  return JSON.stringify(status);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-sand", {
    description: "Show pi-sand host status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const status = getStatus(ctx);
      ctx.ui.setStatus("pi-sand", `pi-sand: ${status.activity}`);
      ctx.ui.notify(formatStatus(status), "info");
    },
  });
}
