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
  let source = null;

  async function request(url, options) {
    const response = await fetchImpl(`${apiBase}${url}`, { headers: { "content-type": "application/json" }, ...options });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  }

  async function refreshAgents() {
    const agents = await request("/api/agents");
    $("#agents").innerHTML = '<option value="">Open an existing Agent…</option>' + agents.map((item) => `<option value="${item.id}">${item.name} — ${item.workspace}</option>`).join("");
  }

  function terminalStatus(snapshot) {
    const latest = snapshot.turns.at(-1);
    if (!latest || latest.status === "running") return "";
    if (latest.status === "completed") return "Turn completed.";
    return `Turn ${latest.status}: ${latest.terminalDetail || "No further detail is available."}`;
  }

  function render(snapshot) {
    agent = snapshot.agent;
    $("#setup").hidden = false;
    $("#conversation").hidden = false;
    $("#agent-meta").textContent = `${agent.name} · ${agent.workspace}`;
    $("#messages").innerHTML = snapshot.messages.map((message) => `<div class="message ${message.role}" data-id="${message.id}">${escapeHtml(message.content)}</div>`).join("");
    $("#status").textContent = snapshot.state === "active" ? "Pi is working…" : terminalStatus(snapshot);
    $("#status").className = snapshot.state === "active" ? "running" : snapshot.turns.at(-1)?.status === "failed" ? "error" : "";
    $("#interrupt").hidden = !snapshot.activeTurnId;
  }

  function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  async function openAgent(id) {
    source?.close();
    const snapshot = await request(`/api/agents/${id}`);
    localStorage.setItem("pi-sand-agent", id);
    render(snapshot);
    source = new EventSourceImpl(`${apiBase}/api/agents/${id}/events`);
    source.onmessage = (event) => {
      const update = JSON.parse(event.data);
      if (update.snapshot) render(update.snapshot);
    };
  }

  $("#create").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = await request("/api/agents", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormDataImpl(event.target))) });
      await refreshAgents();
      await openAgent(data.agent.id);
    } catch (error) { alertImpl(error.message); }
  };
  $("#agents").onchange = (event) => event.target.value && openAgent(event.target.value).catch((error) => alertImpl(error.message));
  $("#send").onsubmit = async (event) => {
    event.preventDefault();
    if (!agent) return;
    const input = event.target.message;
    try {
      await request(`/api/agents/${agent.id}/turns`, { method: "POST", body: JSON.stringify({ message: input.value }) });
      input.value = "";
    } catch (error) { alertImpl(error.message); }
  };
  $("#interrupt").onclick = async () => {
    const active = (await request(`/api/agents/${agent.id}`)).activeTurnId;
    if (active) await request(`/api/agents/${agent.id}/interrupt`, { method: "POST", body: JSON.stringify({ turnId: active }) });
  };

  const ready = refreshAgents().then(async () => {
    const remembered = localStorage.getItem("pi-sand-agent");
    if (remembered && [...$("#agents").options].some((option) => option.value === remembered)) {
      $("#agents").value = remembered;
      await openAgent(remembered);
    }
  }).catch((error) => alertImpl(error.message));

  return { openAgent, render, ready };
}

if (typeof window !== "undefined") mountDesktop();
