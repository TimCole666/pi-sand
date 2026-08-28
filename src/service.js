import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { spawnPi } from "./pi.js";

const TERMINAL = new Set(["completed", "failed", "interrupted"]);

function now() { return new Date().toISOString(); }

export class AgentService {
  constructor({ dbPath = "./pi-sand.sqlite", piFactory = spawnPi } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.piFactory = piFactory;
    this.events = new EventEmitter();
    this.executions = new Map();
    this.interruptingTurns = new Set();
    this.closed = false;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
        user_message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
        started_at TEXT NOT NULL, finished_at TEXT, pi_session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT REFERENCES turns(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_agent_sequence ON messages(agent_id, sequence);
      CREATE INDEX IF NOT EXISTS turns_agent_started ON turns(agent_id, started_at);
    `);
    this.reconcileUnfinishedTurns();
  }

  // Pi execution cannot safely be resumed or adopted after this service starts.
  // Every persisted running Turn therefore becomes a durable interruption.
  reconcileUnfinishedTurns() {
    this.db.prepare("UPDATE turns SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
  }

  close() {
    if (this.closed) return;
    // Running Pi children belong to this service lifetime. Their persisted
    // Turns remain running until the next service reconciles them; no work is
    // adopted or replayed by this instance after its database closes.
    this.closed = true;
    for (const execution of this.executions.values()) execution.close?.();
    this.executions.clear();
    this.interruptingTurns.clear();
    this.db.close();
  }

  createAgent({ name = "Agent", workspace }) {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("workspace is required");
    const id = randomUUID(); const timestamp = now();
    this.db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(id, name.trim() || "Agent", workspace, timestamp, timestamp);
    return this.getAgent(id);
  }

  listAgents() { return this.db.prepare("SELECT id, name, workspace, created_at AS createdAt, updated_at AS updatedAt FROM agents ORDER BY created_at").all(); }

  getAgent(id) {
    const agent = this.db.prepare("SELECT id, name, workspace, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ?").get(id);
    if (!agent) return null;
    return this.snapshot(id, agent);
  }

  snapshot(id, agent = this.db.prepare("SELECT id, name, workspace, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ?").get(id)) {
    if (!agent) return null;
    const turns = this.db.prepare("SELECT id, agent_id AS agentId, user_message AS userMessage, status, started_at AS startedAt, finished_at AS finishedAt, pi_session_id AS piSessionId FROM turns WHERE agent_id = ? ORDER BY started_at").all(id);
    const messages = this.db.prepare("SELECT id, turn_id AS turnId, role, content, created_at AS createdAt, updated_at AS updatedAt FROM messages WHERE agent_id = ? ORDER BY sequence").all(id);
    const activeTurn = turns.find((turn) => turn.status === "running") ?? null;
    return { agent, turns, messages, state: activeTurn ? "active" : "idle", activeTurnId: activeTurn?.id ?? null };
  }

  subscribe(agentId, listener) {
    const event = (update) => { if (update.agentId === agentId) listener(update); };
    this.events.on("update", event);
    return () => this.events.off("update", event);
  }

  sendMessage(agentId, message) {
    if (this.closed) throw new Error("service is closed");
    const agent = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!agent) throw new Error("agent not found");
    const active = this.db.prepare("SELECT id FROM turns WHERE agent_id = ? AND status = 'running'").get(agentId);
    if (active) throw new Error("agent already has an active turn");
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    const turnId = randomUUID(); const timestamp = now(); const messageId = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(turnId, agentId, message, timestamp);
      this.db.prepare("INSERT INTO messages (id, agent_id, turn_id, role, content, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").run(messageId, agentId, turnId, message, timestamp, timestamp);
      this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(timestamp, agentId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.publish(agentId, "turn_started", { turnId });
    const execution = this.piFactory({
      cwd: agent.workspace,
      onEvent: (event) => this.handlePiEvent(agentId, turnId, event),
      onClose: (result) => this.handlePiClose(agentId, turnId, result),
    });
    this.executions.set(turnId, execution);
    try { execution.prompt(message); } catch (error) { this.finishTurn(agentId, turnId, "failed", error.message); }
    return this.db.prepare("SELECT id, agent_id AS agentId, user_message AS userMessage, status, started_at AS startedAt, finished_at AS finishedAt, pi_session_id AS piSessionId FROM turns WHERE id = ?").get(turnId);
  }

  interrupt(agentId, turnId) {
    const turn = this.db.prepare("SELECT status FROM turns WHERE id = ? AND agent_id = ?").get(turnId, agentId);
    if (!turn || turn.status !== "running") return this.getAgent(agentId);
    const execution = this.executions.get(turnId);
    if (!execution) { this.finishTurn(agentId, turnId, "interrupted"); return this.getAgent(agentId); }
    if (this.interruptingTurns.has(turnId)) return this.getAgent(agentId);
    this.interruptingTurns.add(turnId);
    try {
      execution.abort();
    } catch (error) {
      this.interruptingTurns.delete(turnId);
      throw error;
    }
    return this.getAgent(agentId);
  }

  handlePiEvent(agentId, turnId, event) {
    if (this.closed) return;
    const turn = this.db.prepare("SELECT status FROM turns WHERE id = ? AND agent_id = ?").get(turnId, agentId);
    if (!turn || turn.status !== "running") return;
    if (event.type === "session" && event.id) this.db.prepare("UPDATE turns SET pi_session_id = ? WHERE id = ?").run(event.id, turnId);
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.upsertAssistant(agentId, turnId, event.assistantMessageEvent.delta);
      this.publish(agentId, "assistant_delta", { turnId, delta: event.assistantMessageEvent.delta });
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = assistantText(event.message);
      if (content) this.setAssistant(agentId, turnId, content);
    }
    if (event.type === "agent_end" || event.type === "agent_settled") {
      const assistant = this.db.prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'").get(turnId);
      this.finishTurn(agentId, turnId, this.interruptingTurns.has(turnId) ? "interrupted" : "completed", assistant?.content || "");
    }
  }

  handlePiClose(agentId, turnId, { code = null, signal = null, error } = {}) {
    if (this.closed) return;
    const turn = this.db.prepare("SELECT status FROM turns WHERE id = ?").get(turnId);
    if (turn?.status !== "running") return;
    const detail = error
      ? `Pi failed to start: ${error.message}`
      : signal
        ? `Pi exited with ${signal}`
        : `Pi exited with code ${code}`;
    this.finishTurn(agentId, turnId, this.interruptingTurns.has(turnId) ? "interrupted" : "failed", detail);
  }

  upsertAssistant(agentId, turnId, delta) {
    const existing = this.db.prepare("SELECT id, content FROM messages WHERE turn_id = ? AND role = 'assistant'").get(turnId);
    const timestamp = now();
    if (existing) this.db.prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?").run(existing.content + delta, timestamp, existing.id);
    else this.db.prepare("INSERT INTO messages (id, agent_id, turn_id, role, content, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)").run(randomUUID(), agentId, turnId, delta, timestamp, timestamp);
  }

  setAssistant(agentId, turnId, content) {
    const existing = this.db.prepare("SELECT id FROM messages WHERE turn_id = ? AND role = 'assistant'").get(turnId);
    const timestamp = now();
    if (existing) this.db.prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?").run(content, timestamp, existing.id);
    else this.db.prepare("INSERT INTO messages (id, agent_id, turn_id, role, content, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)").run(randomUUID(), agentId, turnId, content, timestamp, timestamp);
    this.publish(agentId, "assistant_updated", { turnId, content });
  }

  finishTurn(agentId, turnId, status, detail = "") {
    const turn = this.db.prepare("SELECT status FROM turns WHERE id = ? AND agent_id = ?").get(turnId, agentId);
    if (!turn || TERMINAL.has(turn.status)) return;
    const finishedAt = now();
    this.db.prepare("UPDATE turns SET status = ?, finished_at = ? WHERE id = ?").run(status, finishedAt, turnId);
    const execution = this.executions.get(turnId);
    this.executions.delete(turnId);
    this.interruptingTurns.delete(turnId);
    if (execution?.close) execution.close();
    this.publish(agentId, "turn_finished", { turnId, status, detail });
  }

  publish(agentId, type, data) { this.events.emit("update", { id: randomUUID(), agentId, type, ...data, snapshot: this.snapshot(agentId) }); }
}

function assistantText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}
