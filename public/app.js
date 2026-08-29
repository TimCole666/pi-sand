const SELECTED_AGENT_KEY = "pi-sand-agent";
const DRAFTS_KEY = "pi-sand-drafts";

function readDrafts(storage) {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, draft]) => {
      if (typeof draft === "string") return [[id, { text: draft, attachments: [] }]];
      if (!draft || typeof draft !== "object") return [];
      const attachments = Array.isArray(draft.attachments) ? draft.attachments.filter((attachment) => attachment?.id && attachment.filename) : [];
      return [[id, { text: typeof draft.text === "string" ? draft.text : "", attachments }]];
    }));
  } catch {
    return {};
  }
}

export function mountDesktop({
  document = window.document,
  fetchImpl = window.fetch.bind(window),
  EventSourceImpl = window.EventSource,
  localStorage = window.localStorage,
  alertImpl = window.alert.bind(window),
  FormDataImpl = window.FormData,
  apiBase = "",
} = {}) {
  const $ = (selector) => document.querySelector(selector);
  let agent = null;
  let selectedAgentId = null;
  let activeTurnId = null;
  let source = null;
  let roster = [];
  let sendInFlight = false;
  const drafts = readDrafts(localStorage);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function composerInput() {
    return $("#send")?.message || $("#message") || $("#send")?.querySelector?.('[name="message"]');
  }

  function persistDrafts() {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* Storage may be unavailable; the current input remains usable. */ }
  }

  function currentDraft(agentId = selectedAgentId) {
    return drafts[agentId] ?? { text: "", attachments: [] };
  }

  function setDraft(agentId, value) {
    if (!agentId) return;
    const draft = currentDraft(agentId);
    draft.text = value;
    if (!draft.text && draft.attachments.length === 0) delete drafts[agentId];
    else drafts[agentId] = draft;
    persistDrafts();
    renderAgentList(roster);
  }

  function setDraftAttachments(agentId, attachments) {
    if (!agentId) return;
    const draft = currentDraft(agentId);
    draft.attachments = attachments;
    if (!draft.text && draft.attachments.length === 0) delete drafts[agentId];
    else drafts[agentId] = draft;
    persistDrafts();
    renderAgentList(roster);
    renderAttachments(draft.attachments);
  }

  function setConnectionState(state, message) {
    const element = $("#connection");
    const retry = $("#retry");
    if (element) {
      element.hidden = state === "connected";
      element.textContent = message;
      element.className = state;
    }
    if (retry) retry.hidden = state === "connected";
  }

  async function request(url, options = {}) {
    const headers = { ...options.headers };
    if (options.body === undefined || typeof options.body === "string") headers["content-type"] ??= "application/json";
    const response = await fetchImpl(`${apiBase}${url}`, { ...options, headers });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  }

  function previewFor(item) {
    const draft = currentDraft(item.id);
    return draft.text?.trim() ? draft.text : item.recentPreview?.trim() || "No messages yet.";
  }

  function renderAgentList(agents) {
    roster = agents;
    const selected = selectedAgentId || agent?.id;
    const select = $("#agents");
    if (select) {
      select.innerHTML = '<option value="">Open an existing Agent…</option>' + agents.map((item) =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} — ${escapeHtml(previewFor(item))}</option>`
      ).join("");
      if (selected) select.value = selected;
    }

    const list = $("#agent-list");
    if (list) {
      list.innerHTML = agents.map((item) => {
        const name = item.name?.trim() || "Agent";
        const marker = name[0]?.toUpperCase() || "A";
        const active = item.id === selected ? " selected" : "";
        return `<button type="button" class="agent-row${active}" data-agent-id="${escapeHtml(item.id)}" aria-pressed="${item.id === selected}">`+
          `<span class="agent-marker" aria-hidden="true">${escapeHtml(marker)}</span>`+
          `<span class="agent-row-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(previewFor(item))}</small></span>`+
          `</button>`;
      }).join("");
      for (const button of list.querySelectorAll?.("[data-agent-id]") ?? []) {
        button.addEventListener("click", () => openAgent(button.dataset.agentId).catch((error) => alertImpl(error.message)));
      }
    }
    const empty = $("#empty-state");
    if (empty) empty.hidden = agents.length !== 0;
  }

  async function refreshAgents() {
    setConnectionState("connecting", "Connecting to your computer…");
    try {
      const agents = await request("/api/agents");
      renderAgentList(agents);
      setConnectionState("connected", "");
      return agents;
    } catch (error) {
      setConnectionState("error", "Can’t reach your computer");
      throw error;
    }
  }

  function terminalStatus(snapshot) {
    const latest = snapshot.turns.at(-1);
    if (!latest || latest.status === "running") return "";
    if (latest.status === "completed") return "Turn completed.";
    return `Turn ${latest.status}: ${latest.terminalDetail || "No further detail is available."}`;
  }

  function updateComposerState(active = Boolean(activeTurnId)) {
    const submit = $("#send-submit");
    if (submit) submit.disabled = active || sendInFlight;
  }

  function renderAttachments(attachments = currentDraft().attachments) {
    const list = $("#attachments");
    if (!list) return;
    list.innerHTML = attachments.map((attachment) =>
      `<span class="attachment-chip" data-attachment-id="${escapeHtml(attachment.id)}">${escapeHtml(attachment.filename)} <button type="button" aria-label="Remove ${escapeHtml(attachment.filename)}">×</button></span>`
    ).join("");
    for (const button of list.querySelectorAll?.("[data-attachment-id] button") ?? []) {
      button.addEventListener("click", async () => {
        const chip = button.closest("[data-attachment-id]");
        const id = chip?.dataset.attachmentId;
        if (!id || !agent) return;
        try {
          await request(`/api/agents/${encodeURIComponent(agent.id)}/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
          setDraftAttachments(agent.id, currentDraft(agent.id).attachments.filter((attachment) => attachment.id !== id));
        } catch (error) { alertImpl(error.message); }
      });
    }
  }

  function render(snapshot) {
    agent = snapshot.agent;
    selectedAgentId = snapshot.agent.id;
    activeTurnId = snapshot.activeTurnId;
    $("#setup").hidden = false;
    $("#conversation").hidden = false;
    $("#agent-meta").textContent = `${agent.name} · ${agent.workspace}`;
    $("#messages").innerHTML = snapshot.messages.map((message) =>
      `<div class="message ${escapeHtml(message.role)}" data-id="${escapeHtml(message.id)}">${escapeHtml(message.content)}${(message.attachments ?? []).map((attachment) => `<span class="message-attachment">📎 ${escapeHtml(attachment.filename)}</span>`).join("")}</div>`
    ).join("");
    $("#status").textContent = snapshot.state === "active" ? "Pi is working…" : terminalStatus(snapshot);
    $("#status").className = snapshot.state === "active" ? "running" : snapshot.turns.at(-1)?.status === "failed" ? "error" : "";
    $("#interrupt").hidden = !snapshot.activeTurnId;
    updateComposerState(Boolean(snapshot.activeTurnId));
    renderAttachments();
    renderAgentList(roster);
  }

  async function openAgent(id) {
    source?.close();
    source = null;
    const snapshot = await request(`/api/agents/${encodeURIComponent(id)}`);
    selectedAgentId = id;
    localStorage.setItem(SELECTED_AGENT_KEY, id);
    render(snapshot);
    const input = composerInput();
    if (input) input.value = currentDraft(id).text;
    renderAttachments(currentDraft(id).attachments);
    source = new EventSourceImpl(`${apiBase}/api/agents/${encodeURIComponent(id)}/events`);
    source.onopen = () => setConnectionState("connected", "");
    source.onerror = () => setConnectionState("reconnecting", "Reconnecting to your computer…");
    source.onmessage = (event) => {
      const update = JSON.parse(event.data);
      if (update.snapshot) render(update.snapshot);
    };
  }

  const create = $("#create");
  create.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = await request("/api/agents", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormDataImpl(event.target))) });
      await refreshAgents();
      await openAgent(data.agent.id);
    } catch (error) { alertImpl(error.message); }
  };

  $("#new-chat")?.addEventListener("click", () => {
    $("#create")?.classList.remove("hidden");
    $("#name")?.focus();
  });
  $("#agents").onchange = (event) => event.target.value && openAgent(event.target.value).catch((error) => alertImpl(error.message));
  if ($("#retry")) $("#retry").onclick = () => refreshAgents().then((agents) => restoreSelection(agents)).catch(() => {});

  const input = composerInput();
  input?.addEventListener?.("input", () => setDraft(selectedAgentId, input.value));
  $("#pick-file")?.addEventListener?.("click", () => $("#file-input")?.click());
  $("#file-input")?.addEventListener?.("change", async (event) => {
    if (!agent) return;
    const existing = currentDraft(agent.id).attachments;
    try {
      const uploaded = [];
      for (const file of [...event.target.files]) {
        const form = new FormDataImpl();
        form.append("file", file, file.name);
        const result = await request(`/api/agents/${encodeURIComponent(agent.id)}/attachments`, { method: "POST", body: form });
        uploaded.push(result.attachment);
      }
      setDraftAttachments(agent.id, [...existing, ...uploaded]);
    } catch (error) { alertImpl(error.message); }
    finally { event.target.value = ""; }
  });
  $("#send").onsubmit = async (event) => {
    event.preventDefault();
    if (!agent || activeTurnId || sendInFlight) return;
    const messageInput = composerInput();
    const message = messageInput?.value ?? "";
    sendInFlight = true;
    updateComposerState();
    try {
      await request(`/api/agents/${encodeURIComponent(agent.id)}/turns`, { method: "POST", body: JSON.stringify({ message, attachments: currentDraft(agent.id).attachments.map((attachment) => attachment.id) }) });
      if (messageInput) messageInput.value = "";
      setDraft(agent.id, "");
      setDraftAttachments(agent.id, []);
    } catch (error) { alertImpl(error.message); }
    finally {
      sendInFlight = false;
      updateComposerState();
    }
  };
  $("#interrupt").onclick = async () => {
    const active = (await request(`/api/agents/${encodeURIComponent(agent.id)}`)).activeTurnId;
    if (active) await request(`/api/agents/${encodeURIComponent(agent.id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId: active }) });
  };

  async function restoreSelection(agents) {
    const remembered = localStorage.getItem(SELECTED_AGENT_KEY);
    const selected = agents.some((item) => item.id === remembered) ? remembered : agents[0]?.id;
    if (selected) {
      if ($("#agents")) $("#agents").value = selected;
      await openAgent(selected);
    }
  }

  const ready = refreshAgents().then((agents) => restoreSelection(agents)).catch(() => {});

  function destroy() {
    source?.close();
    source = null;
  }

  return { openAgent, render, destroy, ready };
}

if (typeof window !== "undefined") mountDesktop();
