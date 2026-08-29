import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDatabaseLock } from "./database-lock.js";
import { spawnPi } from "./pi.js";

const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const WORKER_STOP_TIMEOUT_MS = 2_000;

function now() { return new Date().toISOString(); }

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Linux exposes a process start identity in /proc. A PID alone can be reused;
// retaining this value lets restart reconciliation distinguish the former Pi
// child from an unrelated process that inherited its number.
function processStartIdentity(pid) {
  try {
    const stat = requireProcStat(pid);
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function requireProcStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

function workerMetadata(execution) {
  const pid = Number(execution?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const processGroupId = Number(execution?.processGroupId ?? pid);
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return null;
  return { pid, processGroupId, startIdentity: processStartIdentity(pid) };
}

function processGroupIsAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function workerIsGone(worker) {
  if (!processIsAlive(worker.workerPid)) return !processGroupIsAlive(worker.workerPgid);
  const currentIdentity = processStartIdentity(worker.workerPid);
  if (worker.workerStartIdentity && currentIdentity && currentIdentity !== worker.workerStartIdentity) return true;
  return false;
}

function signalWorker(worker, signal) {
  try {
    process.kill(-worker.workerPgid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    try { process.kill(worker.workerPid, signal); } catch (fallbackError) { return fallbackError.code === "ESRCH"; }
  }
  return true;
}

function stopPriorWorker(worker) {
  if (!Number.isInteger(worker.workerPid) || !Number.isInteger(worker.workerPgid)) return false;
  if (workerIsGone(worker)) return true;
  if (!signalWorker(worker, "SIGTERM")) return false;
  const deadline = Date.now() + WORKER_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (workerIsGone(worker)) return true;
    sleepSync(25);
  }
  if (!signalWorker(worker, "SIGKILL")) return false;
  const killDeadline = Date.now() + WORKER_STOP_TIMEOUT_MS;
  while (Date.now() < killDeadline) {
    if (workerIsGone(worker)) return true;
    sleepSync(25);
  }
  return workerIsGone(worker);
}

export function defaultDatabasePath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "pi-sand", "pi-sand.sqlite");
}

function canonicalWorkspace(workspace) {
  if (typeof workspace !== "string" || !workspace.trim()) throw new Error("workspace is required");
  const expanded = workspace === "~" ? homedir() : workspace.startsWith("~/") ? join(homedir(), workspace.slice(2)) : workspace;
  try {
    const canonical = realpathSync.native(resolve(expanded));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error("workspace must exist and be a directory");
  }
}

export class AgentService {
  constructor({ dbPath = process.env.PI_SAND_DB ?? defaultDatabasePath(), piFactory = spawnPi } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.databaseLock = acquireDatabaseLock(dbPath);
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (error) {
      this.databaseLock?.release();
      this.databaseLock = null;
      throw new Error(`The Local Agent Service could not open its database: ${error.message}`, { cause: error });
    }
    this.piFactory = piFactory;
    this.attachmentDirectory = dbPath === ":memory:"
      ? join(tmpdir(), `pi-sand-attachments-${randomUUID()}`)
      : `${resolve(dbPath)}.attachments`;
    mkdirSync(this.attachmentDirectory, { recursive: true, mode: 0o700 });
    this.events = new EventEmitter();
    // A Pi RPC process owns conversational context for one Agent while it is
    // alive. The process is an execution detail, not the durable Agent
    // identity; it may be replaced after an unsupported process boundary.
    this.agentExecutions = new Map();
    this.activeTurns = new Map();
    // Keep the active-turn map public for the existing service integration
    // seam, while agentExecutions retains an idle RPC session for follow-ups.
    this.executions = new Map();
    this.promptRequestIds = new Map();
    this.assistantOutcomes = new Map();
    this.interruptingTurns = new Set();
    this.closed = false;
    this.unsafeWorkspaces = new Set();
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
        user_message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
        started_at TEXT NOT NULL, finished_at TEXT, pi_session_id TEXT, terminal_detail TEXT,
        worker_pid INTEGER, worker_pgid INTEGER, worker_start_identity TEXT,
        worker_terminated INTEGER NOT NULL DEFAULT 1 CHECK(worker_terminated IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), turn_id TEXT REFERENCES turns(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_agent_sequence ON messages(agent_id, sequence);
      CREATE INDEX IF NOT EXISTS turns_agent_started ON turns(agent_id, started_at);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('staged','committed','released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        position INTEGER NOT NULL,
        PRIMARY KEY(message_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS attachments_agent_state ON attachments(agent_id, state);
      CREATE INDEX IF NOT EXISTS message_attachments_message_position ON message_attachments(message_id, position);
    `);
    this.ensureTerminalDetailColumn();
    this.ensureWorkerColumns();
    this.canonicalizeStoredWorkspaces();
    this.reconcilePriorWorkers();
    this.reconcileUnfinishedTurns();
  }

  ensureTerminalDetailColumn() {
    const columns = this.db.prepare("PRAGMA table_info(turns)").all();
    if (!columns.some((column) => column.name === "terminal_detail")) this.db.exec("ALTER TABLE turns ADD COLUMN terminal_detail TEXT");
  }

  ensureWorkerColumns() {
    const columns = this.db.prepare("PRAGMA table_info(turns)").all();
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("worker_pid")) this.db.exec("ALTER TABLE turns ADD COLUMN worker_pid INTEGER");
    if (!names.has("worker_pgid")) this.db.exec("ALTER TABLE turns ADD COLUMN worker_pgid INTEGER");
    if (!names.has("worker_start_identity")) this.db.exec("ALTER TABLE turns ADD COLUMN worker_start_identity TEXT");
    if (!names.has("worker_terminated")) this.db.exec("ALTER TABLE turns ADD COLUMN worker_terminated INTEGER NOT NULL DEFAULT 0");
  }

  markWorkerTerminated(turnId) {
    this.db.prepare("UPDATE turns SET worker_terminated = 1 WHERE id = ?").run(turnId);
    const turn = this.db.prepare(`
      SELECT agents.workspace AS workspace
      FROM turns JOIN agents ON agents.id = turns.agent_id
      WHERE turns.id = ?
    `).get(turnId);
    if (turn) this.unsafeWorkspaces.delete(turn.workspace);
  }

  reconcilePriorWorkers() {
    const workers = this.db.prepare(`
      SELECT turns.id, turns.worker_pid AS workerPid, turns.worker_pgid AS workerPgid,
             turns.worker_start_identity AS workerStartIdentity, agents.workspace
      FROM turns JOIN agents ON agents.id = turns.agent_id
      WHERE turns.worker_terminated = 0
    `).all();
    for (const worker of workers) {
      if (stopPriorWorker(worker)) this.markWorkerTerminated(worker.id);
      else this.unsafeWorkspaces.add(worker.workspace);
    }
  }

  ensureWorkspaceSafe(workspace) {
    const workers = this.db.prepare(`
      SELECT turns.id, turns.worker_pid AS workerPid, turns.worker_pgid AS workerPgid,
             turns.worker_start_identity AS workerStartIdentity
      FROM turns JOIN agents ON agents.id = turns.agent_id
      WHERE agents.workspace = ? AND turns.worker_terminated = 0
    `).all(workspace);
    for (const worker of workers) {
      if (stopPriorWorker(worker)) this.markWorkerTerminated(worker.id);
      else this.unsafeWorkspaces.add(workspace);
    }
    if (this.unsafeWorkspaces.has(workspace)) {
      throw new Error("This workspace remains unavailable while a prior Pi worker may still be running.");
    }
  }

  // Older databases can hold a pre-canonical workspace spelling. Normalize
  // valid paths eagerly, but leave an unavailable legacy workspace visible so
  // its owner gets a clear error when attempting to start work.
  canonicalizeStoredWorkspaces() {
    const agents = this.db.prepare("SELECT id, workspace FROM agents").all();
    const update = this.db.prepare("UPDATE agents SET workspace = ?, updated_at = ? WHERE id = ?");
    for (const agent of agents) {
      try {
        const workspace = canonicalWorkspace(agent.workspace);
        if (workspace !== agent.workspace) update.run(workspace, now(), agent.id);
      } catch { /* A legacy association is not silently replaced or deleted. */ }
    }
  }

  // Pi execution cannot safely be resumed or adopted after this service starts.
  // Every persisted running Turn therefore becomes a durable interruption.
  reconcileUnfinishedTurns() {
    const detail = "The Local Agent Service restarted before Pi finished. The unfinished work was not resumed.";
    this.db.prepare("UPDATE turns SET status = 'interrupted', finished_at = ?, terminal_detail = COALESCE(terminal_detail, ?) WHERE status = 'running'").run(now(), detail);
  }

  close() {
    if (this.closed) return;
    // Running Pi children belong to this service lifetime. Their persisted
    // Turns remain running until the next service reconciles them; no work is
    // adopted or replayed by this instance after its database closes.
    this.closed = true;
    const activeExecutions = new Map(this.executions);
    for (const execution of this.agentExecutions.values()) execution.close?.();
    for (const [turnId, execution] of activeExecutions.entries()) {
      // Deterministic in-process fakes do not cross an OS lifetime boundary.
      // A real Pi child remains unconfirmed until its close is observed or the
      // next service lifetime proves it gone.
      if (!workerMetadata(execution)) this.markWorkerTerminated(turnId);
    }
    this.agentExecutions.clear();
    this.activeTurns.clear();
    this.executions.clear();
    this.promptRequestIds.clear();
    this.assistantOutcomes.clear();
    this.interruptingTurns.clear();
    this.db.close();
    this.databaseLock?.release();
    this.databaseLock = null;
  }

  createAgent({ name = "Agent", workspace }) {
    const canonicalWorkspacePath = canonicalWorkspace(workspace);
    const id = randomUUID(); const timestamp = now();
    this.db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(id, name.trim() || "Agent", canonicalWorkspacePath, timestamp, timestamp);
    return this.getAgent(id);
  }

  stageAttachment(agentId, { filename, contentType = "application/octet-stream", bytes } = {}) {
    if (this.closed) throw new Error("service is closed");
    if (!this.db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId)) throw new Error("agent not found");
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes instanceof Uint8Array ? bytes : bytes ?? "");
    if (!data.length) throw new Error("attachment is empty");
    if (data.length > 25 * 1024 * 1024) throw new Error("attachment exceeds the 25 MB limit");
    const originalName = typeof filename === "string" ? basename(filename).trim() : "";
    if (!originalName) throw new Error("attachment filename is required");
    const id = randomUUID();
    const safeName = originalName.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
    const storagePath = join(this.attachmentDirectory, `${id}-${safeName}`);
    const temporaryPath = `${storagePath}.tmp`;
    const timestamp = now();
    writeFileSync(temporaryPath, data, { mode: 0o600 });
    try {
      renameSync(temporaryPath, storagePath);
      this.db.prepare(`
        INSERT INTO attachments (id, agent_id, filename, content_type, byte_size, storage_path, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)
      `).run(id, agentId, originalName, String(contentType || "application/octet-stream"), data.length, storagePath, timestamp, timestamp);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
      try { unlinkSync(storagePath); } catch { /* best effort cleanup */ }
      throw error;
    }
    return this.attachmentSnapshot(id);
  }

  attachmentSnapshot(id) {
    const row = this.db.prepare(`
      SELECT id, filename, content_type AS contentType, byte_size AS byteSize,
             state, created_at AS createdAt, updated_at AS updatedAt
      FROM attachments WHERE id = ?
    `).get(id);
    return row ? { ...row } : null;
  }

  attachmentForSend(agentId, id) {
    const row = this.db.prepare(`
      SELECT id, agent_id AS agentId, filename, content_type AS contentType,
             byte_size AS byteSize, storage_path AS storagePath, state
      FROM attachments WHERE id = ? AND agent_id = ?
    `).get(id, agentId);
    if (!row) throw new Error("attachment not found");
    if (row.state !== "staged") throw new Error("attachment is no longer available in the draft");
    if (!existsSync(row.storagePath)) throw new Error("staged attachment bytes are unavailable");
    return row;
  }

  releaseAttachment(agentId, attachmentId) {
    const attachment = this.db.prepare("SELECT state FROM attachments WHERE id = ? AND agent_id = ?").get(attachmentId, agentId);
    if (!attachment) throw new Error("attachment not found");
    if (attachment.state === "committed") throw new Error("sent attachments cannot be removed from the transcript");
    this.db.prepare("UPDATE attachments SET state = 'released', updated_at = ? WHERE id = ?").run(now(), attachmentId);
    return this.attachmentSnapshot(attachmentId);
  }

  cleanupOrphanedAttachments({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
    const rows = this.db.prepare("SELECT id, storage_path AS storagePath, updated_at AS updatedAt FROM attachments WHERE state = 'released'").all();
    let removed = 0;
    for (const row of rows) {
      if (Date.parse(row.updatedAt) > cutoff) continue;
      try { unlinkSync(row.storagePath); } catch (error) { if (error.code !== "ENOENT") continue; }
      this.db.prepare("DELETE FROM attachments WHERE id = ? AND state = 'released'").run(row.id);
      removed += 1;
    }
    return removed;
  }

  listAgents() {
    return this.db.prepare(`
      SELECT
        agents.id,
        agents.name,
        agents.workspace,
        agents.created_at AS createdAt,
        agents.updated_at AS updatedAt,
        (
          SELECT messages.content
          FROM messages
          WHERE messages.agent_id = agents.id
          ORDER BY messages.sequence DESC
          LIMIT 1
        ) AS recentPreview
      FROM agents
      ORDER BY agents.created_at, agents.rowid
    `).all();
  }

  getAgent(id) {
    const agent = this.db.prepare("SELECT id, name, workspace, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ?").get(id);
    if (!agent) return null;
    return this.snapshot(id, agent);
  }

  snapshot(id, agent = this.db.prepare("SELECT id, name, workspace, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ?").get(id)) {
    if (!agent) return null;
    const turns = this.db.prepare("SELECT id, agent_id AS agentId, user_message AS userMessage, status, started_at AS startedAt, finished_at AS finishedAt, pi_session_id AS piSessionId, terminal_detail AS terminalDetail FROM turns WHERE agent_id = ? ORDER BY started_at").all(id);
    const messages = this.db.prepare("SELECT id, turn_id AS turnId, role, content, created_at AS createdAt, updated_at AS updatedAt FROM messages WHERE agent_id = ? ORDER BY sequence").all(id).map((message) => ({
      ...message,
      attachments: this.db.prepare(`
        SELECT attachments.id, attachments.filename, attachments.content_type AS contentType,
               attachments.byte_size AS byteSize, attachments.created_at AS createdAt
        FROM message_attachments
        JOIN attachments ON attachments.id = message_attachments.attachment_id
        WHERE message_attachments.message_id = ?
        ORDER BY message_attachments.position
      `).all(message.id),
    }));
    const activeTurn = turns.find((turn) => turn.status === "running") ?? null;
    return { agent, turns, messages, state: activeTurn ? "active" : "idle", activeTurnId: activeTurn?.id ?? null };
  }

  subscribe(agentId, listener) {
    const event = (update) => { if (update.agentId === agentId) listener(update); };
    this.events.on("update", event);
    return () => this.events.off("update", event);
  }

  sendMessage(agentId, message, options = {}) {
    if (this.closed) throw new Error("service is closed");
    const attachmentIds = Array.isArray(options) ? options : options?.attachments ?? options?.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string")) throw new Error("attachments must be attachment IDs");
    const uniqueAttachmentIds = [...new Set(attachmentIds)];
    const agent = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!agent) throw new Error("agent not found");
    const workspace = canonicalWorkspace(agent.workspace);
    this.ensureWorkspaceSafe(workspace);
    const attachments = uniqueAttachmentIds.map((id) => this.attachmentForSend(agentId, id));
    if (workspace !== agent.workspace) {
      this.db.prepare("UPDATE agents SET workspace = ?, updated_at = ? WHERE id = ?").run(workspace, now(), agentId);
      agent.workspace = workspace;
    }
    const activeForAgent = this.db.prepare("SELECT id FROM turns WHERE agent_id = ? AND status = 'running'").get(agentId);
    if (activeForAgent) throw new Error("Agent already has a running Turn.");
    const activeForWorkspace = this.db.prepare(`
      SELECT turns.id FROM turns
      JOIN agents ON agents.id = turns.agent_id
      WHERE turns.status = 'running' AND agents.workspace = ?
    `).get(workspace);
    if (activeForWorkspace) throw new Error("This workspace already has a running Turn.");
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    const turnId = randomUUID(); const timestamp = now(); const messageId = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO turns (id, agent_id, user_message, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(turnId, agentId, message, timestamp);
      this.db.prepare("INSERT INTO messages (id, agent_id, turn_id, role, content, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").run(messageId, agentId, turnId, message, timestamp, timestamp);
      for (const [position, attachment] of attachments.entries()) {
        this.db.prepare("INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)").run(messageId, attachment.id, position);
        this.db.prepare("UPDATE attachments SET state = 'committed', updated_at = ? WHERE id = ? AND state = 'staged'").run(timestamp, attachment.id);
      }
      this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(timestamp, agentId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.publish(agentId, "turn_started", { turnId });
    const promptRequestId = `prompt-${randomUUID()}`;
    let execution = this.agentExecutions.get(agentId);
    if (!execution) {
      execution = this.piFactory({
        cwd: agent.workspace,
        // One long-lived RPC process is Pi's native conversation context for
        // this Agent. Route every event to the currently active product Turn;
        // durable transcript content is never sent back to Pi by pi-sand.
        onEvent: (event) => {
          const activeTurnId = this.activeTurns.get(agentId);
          if (activeTurnId) this.handlePiEvent(agentId, activeTurnId, event);
        },
        onClose: (result) => this.handlePiClose(agentId, this.activeTurns.get(agentId), result),
      });
      this.agentExecutions.set(agentId, execution);
    }
    this.executions.set(turnId, execution);
    this.activeTurns.set(agentId, turnId);
    this.promptRequestIds.set(turnId, promptRequestId);
    const worker = workerMetadata(execution);
    if (worker) {
      this.db.prepare("UPDATE turns SET worker_pid = ?, worker_pgid = ?, worker_start_identity = ?, worker_terminated = 0 WHERE id = ? AND status = 'running'").run(worker.pid, worker.processGroupId, worker.startIdentity, turnId);
    } else {
      this.markWorkerTerminated(turnId);
    }
    try {
      execution.prompt({ id: promptRequestId, message: promptWithAttachments(message, attachments) });
    } catch (error) {
      this.finishTurn(agentId, turnId, "failed", error.message);
    }
    return this.db.prepare("SELECT id, agent_id AS agentId, user_message AS userMessage, status, started_at AS startedAt, finished_at AS finishedAt, pi_session_id AS piSessionId, terminal_detail AS terminalDetail FROM turns WHERE id = ?").get(turnId);
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
    if (event.type === "response" && event.command === "prompt" && event.id === this.promptRequestIds.get(turnId) && event.success === false) {
      this.finishTurn(agentId, turnId, "failed", promptRejectionDetail(event));
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = assistantText(event.message);
      this.assistantOutcomes.set(turnId, { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage });
      if (content) this.setAssistant(agentId, turnId, content);
    }
    // agent_end can precede a retry, compaction retry, or queued continuation.
    // agent_settled is the point at which Pi's autonomous loop is truly done.
    if (event.type === "agent_settled") {
      const assistant = this.db.prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'").get(turnId);
      const interrupted = this.interruptingTurns.has(turnId);
      const outcome = this.assistantOutcomes.get(turnId);
      const failed = outcome?.stopReason === "error";
      this.finishTurn(
        agentId,
        turnId,
        interrupted ? "interrupted" : failed ? "failed" : "completed",
        interrupted ? "The Turn was interrupted by the user." : failed ? assistantErrorDetail(outcome) : assistant?.content || "",
      );
    }
  }

  handlePiClose(agentId, turnId, { code = null, signal = null, error } = {}) {
    if (this.closed) return;
    // A session can close while idle between Turns. There is no product Turn
    // to fail in that case; the next request will establish a new Pi context.
    if (!turnId) {
      this.agentExecutions.delete(agentId);
      return;
    }
    const turn = this.db.prepare("SELECT status FROM turns WHERE id = ?").get(turnId);
    if (turn?.status !== "running") {
      this.agentExecutions.delete(agentId);
      return;
    }
    const detail = error
      ? `Pi failed to start: ${error.message}`
      : signal
        ? `Pi exited with ${signal}`
        : `Pi exited with code ${code}`;
    const interruptedBeforeSettlement = this.interruptingTurns.has(turnId);
    this.agentExecutions.delete(agentId);
    this.markWorkerTerminated(turnId);
    this.finishTurn(
      agentId,
      turnId,
      "failed",
      interruptedBeforeSettlement ? `${detail} after interruption was requested before Pi settled.` : detail,
    );
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
    const terminalDetail = detail || (status === "interrupted" ? "The Turn was interrupted by the user." : "");
    this.db.prepare("UPDATE turns SET status = ?, finished_at = ?, terminal_detail = ? WHERE id = ?").run(status, finishedAt, terminalDetail, turnId);
    this.executions.delete(turnId);
    if (this.activeTurns.get(agentId) === turnId) this.activeTurns.delete(agentId);
    this.promptRequestIds.delete(turnId);
    this.assistantOutcomes.delete(turnId);
    this.interruptingTurns.delete(turnId);
    // Keep the Pi RPC process alive after settlement. Subsequent prompts sent
    // to that same process use Pi's native in-memory session context. The
    // process remains an implementation detail and is closed with the service
    // or replaced after an unsupported process boundary.
    this.publish(agentId, "turn_finished", { turnId, status, detail });
  }

  publish(agentId, type, data) { this.events.emit("update", { id: randomUUID(), agentId, type, ...data, snapshot: this.snapshot(agentId) }); }
}

function promptWithAttachments(message, attachments) {
  if (!attachments.length) return message;
  const files = attachments.map((attachment) => `- ${attachment.filename}: ${attachment.storagePath}`).join("\n");
  return `${message}\n\nThe user attached these local files. Read them from the listed paths when relevant:\n${files}`;
}

function assistantText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function promptRejectionDetail(event) {
  const detail = event.error?.message ?? event.error ?? event.message;
  return detail ? `Pi rejected the prompt: ${detail}` : "Pi rejected the prompt before starting work.";
}

function assistantErrorDetail(outcome) {
  return outcome?.errorMessage ? `Pi assistant error: ${outcome.errorMessage}` : "Pi assistant ended with an error.";
}
