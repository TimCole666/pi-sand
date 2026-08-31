export function createExtensionHarness({ cwd = (session) => `/workspace/${session}` } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const status = [];
  const widgets = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };

  const context = (session = "session-1", idle = true) => ({
    mode: "tui",
    cwd: cwd(session),
    sessionManager: { getSessionId: () => session },
    isIdle: () => idle,
    ui: {
      setStatus(key, text) {
        const call = { method: "setStatus", key, text };
        calls.push(call);
        status.push({ session, key, text });
      },
      setWidget(key, lines) {
        const call = { method: "setWidget", key, lines };
        calls.push(call);
        widgets.push({ session, key, lines });
      },
      notify(message, type) {
        const call = { method: "notify", message, type };
        calls.push(call);
        notifications.push({ session, message, type });
      },
    },
  });

  async function invoke(event, eventData, ctx) {
    for (const handler of handlers.get(event) ?? []) {
      await handler(eventData, ctx);
    }
  }

  async function emit(event, ctx) {
    await invoke(event, { type: event }, ctx);
  }

  function surface() {
    const latestStatus = [...calls].reverse().find((call) => call.method === "setStatus");
    const latestWidget = [...calls].reverse().find((call) => call.method === "setWidget");
    return {
      status: latestStatus && { key: latestStatus.key, text: latestStatus.text },
      widget: latestWidget && { key: latestWidget.key, lines: latestWidget.lines },
    };
  }

  async function report(ctx) {
    await commands.get("pi-sand").handler("", ctx);
    const notification = [...calls].reverse().find((call) => call.method === "notify");
    return notification ? JSON.parse(notification.message) : undefined;
  }

  return {
    calls,
    commands,
    context,
    emit,
    handlers,
    invoke,
    notifications,
    pi,
    report,
    status,
    surface,
    widgets,
  };
}
