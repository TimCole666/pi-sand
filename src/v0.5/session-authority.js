/**
 * v0.5 Required Session Authority & Ingress Generation Fence (Issue #66).
 *
 * Implements the minimal upstream host seam for v0.5 One-Chat Responsibility:
 * 1. Atomically links durable Telegram ingress acceptance with accepted_generation++;
 * 2. Enforces input_pending := (accepted_generation !== admitted_generation);
 * 3. Fences protected actions (GitHub mutation, authoritative Telegram final dispatch);
 * 4. Fails closed on missing/incompatible authority contract or unadmitted ingress after restart.
 *
 * Spec: docs/specs/v0.5-one-chat-responsibility.md (Sections 4, 5, 14, 16)
 * ADR: docs/adr/0002-one-chat-responsibility-boundary.md
 */

import { DatabaseSync } from "node:sqlite";

export const PINNED_AUTHORITY_OWNER = "pi-sand";
export const PINNED_AUTHORITY_CONTRACT = "v0.5-one-chat-responsibility";
export const PINNED_OPENCLAW_REVISION = "ff63da7237e5f99e9fc03a86daf56e3c3e8f5356";
export const PINNED_CODEX_REVISION = "a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67";

export class SessionAuthorityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SessionAuthorityError";
    this.code = code;
  }
}

export class SessionAuthorityFencedError extends SessionAuthorityError {
  constructor(message = "Protected action fenced: unadmitted durable input pending") {
    super(message, "ERR_AUTHORITY_FENCED");
  }
}

export class StaleTurnAuthorityError extends SessionAuthorityError {
  constructor(message = "Action rejected: turn identity is retired or stale") {
    super(message, "ERR_STALE_TURN");
  }
}

export class StaleRevisionAuthorityError extends SessionAuthorityError {
  constructor(message = "Action rejected: revision is stale") {
    super(message, "ERR_STALE_REVISION");
  }
}

export class IncompatibleAuthorityError extends SessionAuthorityError {
  constructor(message = "Protected session rejected: incompatible or missing authority owner/contract") {
    super(message, "ERR_INCOMPATIBLE_AUTHORITY");
  }
}

/**
 * Initializes the SQLite schema for session authority and durable ingress.
 * Reuses SQLite strict tables for atomic transaction guarantees.
 *
 * @param {DatabaseSync} db
 */
export function initSessionAuthoritySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_authority (
      session_id TEXT PRIMARY KEY,
      required_authority_owner TEXT NOT NULL,
      required_authority_contract TEXT NOT NULL,
      accepted_generation INTEGER NOT NULL DEFAULT 0,
      admitted_generation INTEGER NOT NULL DEFAULT 0,
      active_turn_id TEXT,
      active_revision INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_durable_ingress (
      input_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      update_id INTEGER UNIQUE,
      generation INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (session_id) REFERENCES session_authority(session_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_session_ingress_status
      ON session_durable_ingress(session_id, status);
  `);
}

/**
 * Creates or recovers a protected session authority record.
 * Fails closed if the authority owner or contract is missing or mismatched.
 *
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} [params.owner=PINNED_AUTHORITY_OWNER]
 * @param {string} [params.contract=PINNED_AUTHORITY_CONTRACT]
 * @returns {object} Session authority snapshot
 */
export function getOrCreateSessionAuthority(db, {
  sessionId,
  owner = PINNED_AUTHORITY_OWNER,
  contract = PINNED_AUTHORITY_CONTRACT,
}) {
  if (!sessionId) {
    throw new SessionAuthorityError("sessionId is required", "ERR_INVALID_PARAMS");
  }

  const existing = db
    .prepare("SELECT * FROM session_authority WHERE session_id = ?")
    .get(sessionId);

  if (existing) {
    validateSessionAuthorityOnRecovery(existing);
    return mapAuthorityRow(existing);
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO session_authority (
      session_id,
      required_authority_owner,
      required_authority_contract,
      accepted_generation,
      admitted_generation,
      active_turn_id,
      active_revision,
      updated_at
    ) VALUES (?, ?, ?, 0, 0, NULL, 0, ?)
  `).run(sessionId, owner, contract, now);

  return {
    sessionId,
    requiredAuthorityOwner: owner,
    requiredAuthorityContract: contract,
    acceptedGeneration: 0,
    admittedGeneration: 0,
    activeTurnId: null,
    activeRevision: 0,
    updatedAt: now,
    inputPending: false,
  };
}

/**
 * Validates authority facts during recovery.
 * Protected mode refuses to operate if owner/contract is invalid.
 */
export function validateSessionAuthorityOnRecovery(authorityRow) {
  if (
    authorityRow.required_authority_owner !== PINNED_AUTHORITY_OWNER ||
    authorityRow.required_authority_contract !== PINNED_AUTHORITY_CONTRACT
  ) {
    throw new IncompatibleAuthorityError(
      `Incompatible authority: expected ${PINNED_AUTHORITY_OWNER} / ${PINNED_AUTHORITY_CONTRACT}, ` +
      `got ${authorityRow.required_authority_owner} / ${authorityRow.required_authority_contract}`
    );
  }
}

/**
 * Atomically enqueues a durable Telegram ingress update and advances accepted_generation.
 * Idempotent: duplicate update_id returns existing receipt without advancing generation.
 *
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.inputId
 * @param {number} params.updateId
 * @param {object|string} params.payload
 * @returns {{ authority: object, isDuplicate: boolean, generation: number }}
 */
export function recordDurableTelegramIngress(db, {
  sessionId,
  inputId,
  updateId,
  payload,
}) {
  if (!sessionId || !inputId) {
    throw new SessionAuthorityError("sessionId and inputId are required", "ERR_INVALID_PARAMS");
  }

  const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const now = Date.now();

  // Deduplication check
  const duplicate = db
    .prepare("SELECT * FROM session_durable_ingress WHERE input_id = ? OR (update_id IS NOT NULL AND update_id = ?)")
    .get(inputId, updateId ?? -1);

  if (duplicate) {
    const authority = getSessionAuthority(db, sessionId);
    return {
      authority,
      isDuplicate: true,
      generation: duplicate.generation,
      inputId: duplicate.input_id,
    };
  }

  // Atomic transaction: advance accepted_generation and persist ingress event
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare("SELECT * FROM session_authority WHERE session_id = ?")
      .get(sessionId);

    if (!current) {
      throw new SessionAuthorityError(`Session ${sessionId} not found`, "ERR_SESSION_NOT_FOUND");
    }

    validateSessionAuthorityOnRecovery(current);

    const nextGeneration = current.accepted_generation + 1;

    db.prepare(`
      UPDATE session_authority
      SET accepted_generation = ?, updated_at = ?
      WHERE session_id = ?
    `).run(nextGeneration, now, sessionId);

    db.prepare(`
      INSERT INTO session_durable_ingress (
        input_id,
        session_id,
        update_id,
        generation,
        payload_json,
        received_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(inputId, sessionId, updateId ?? null, nextGeneration, payloadJson, now);

    db.exec("COMMIT");

    const updatedAuthority = getSessionAuthority(db, sessionId);
    return {
      authority: updatedAuthority,
      isDuplicate: false,
      generation: nextGeneration,
      inputId,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback failed or not in transaction
    }
    throw err;
  }
}

/**
 * Admits an ingress generation after pi-sand classification and turn setup.
 *
 * @param {DatabaseSync} db
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.inputId
 * @param {number} [params.resultingRevision]
 * @param {string} [params.newTurnId]
 * @returns {object} updated authority snapshot
 */
export function admitSessionIngress(db, {
  sessionId,
  inputId,
  resultingRevision,
  newTurnId,
}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare("SELECT * FROM session_authority WHERE session_id = ?")
      .get(sessionId);

    if (!current) {
      throw new SessionAuthorityError(`Session ${sessionId} not found`, "ERR_SESSION_NOT_FOUND");
    }

    validateSessionAuthorityOnRecovery(current);

    const ingress = db
      .prepare("SELECT * FROM session_durable_ingress WHERE input_id = ? AND session_id = ?")
      .get(inputId, sessionId);

    if (!ingress) {
      throw new SessionAuthorityError(`Ingress ${inputId} not found for session ${sessionId}`, "ERR_INGRESS_NOT_FOUND");
    }

    const nextRevision = resultingRevision !== undefined ? resultingRevision : current.active_revision;
    const nextTurnId = newTurnId !== undefined ? newTurnId : current.active_turn_id;
    const targetGeneration = Math.max(current.admitted_generation, ingress.generation);
    const now = Date.now();

    db.prepare(`
      UPDATE session_authority
      SET admitted_generation = ?, active_revision = ?, active_turn_id = ?, updated_at = ?
      WHERE session_id = ?
    `).run(targetGeneration, nextRevision, nextTurnId, now, sessionId);

    db.prepare(`
      UPDATE session_durable_ingress
      SET status = 'admitted'
      WHERE input_id = ?
    `).run(inputId);

    db.exec("COMMIT");

    return getSessionAuthority(db, sessionId);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Asserts whether a protected action (GitHub mutation or Telegram final dispatch) is authorized.
 * Throws SessionAuthorityFencedError, StaleTurnAuthorityError, or StaleRevisionAuthorityError if not.
 *
 * @param {object} authority - Snapshot from getSessionAuthority()
 * @param {object} [context]
 * @param {string} [context.turnId]
 * @param {number} [context.revision]
 * @param {string} [context.action="protected_action"]
 */
export function assertActionAuthorized(authority, { turnId, revision, action = "protected_action" } = {}) {
  if (!authority) {
    throw new SessionAuthorityFencedError("No authority snapshot provided");
  }

  if (
    authority.requiredAuthorityOwner !== PINNED_AUTHORITY_OWNER ||
    authority.requiredAuthorityContract !== PINNED_AUTHORITY_CONTRACT
  ) {
    throw new IncompatibleAuthorityError(
      `Protected action rejected: authority owner/contract mismatch (${authority.requiredAuthorityOwner} / ${authority.requiredAuthorityContract})`
    );
  }

  if (authority.inputPending) {
    throw new SessionAuthorityFencedError(
      `Protected action '${action}' fenced: accepted_generation (${authority.acceptedGeneration}) ` +
      `> admitted_generation (${authority.admittedGeneration})`
    );
  }

  if (turnId !== undefined && authority.activeTurnId !== turnId) {
    throw new StaleTurnAuthorityError(
      `Protected action '${action}' rejected: turn ${turnId} is not current active turn (${authority.activeTurnId})`
    );
  }

  if (revision !== undefined && authority.activeRevision !== revision) {
    throw new StaleRevisionAuthorityError(
      `Protected action '${action}' rejected: revision ${revision} is not current active revision (${authority.activeRevision})`
    );
  }

  return true;
}

/**
 * Reads authority snapshot from database.
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @returns {object}
 */
export function getSessionAuthority(db, sessionId) {
  const row = db
    .prepare("SELECT * FROM session_authority WHERE session_id = ?")
    .get(sessionId);

  if (!row) {
    throw new SessionAuthorityError(`Session ${sessionId} not found`, "ERR_SESSION_NOT_FOUND");
  }

  return mapAuthorityRow(row);
}

function mapAuthorityRow(row) {
  return {
    sessionId: row.session_id,
    requiredAuthorityOwner: row.required_authority_owner,
    requiredAuthorityContract: row.required_authority_contract,
    acceptedGeneration: row.accepted_generation,
    admittedGeneration: row.admitted_generation,
    activeTurnId: row.active_turn_id,
    activeRevision: row.active_revision,
    updatedAt: row.updated_at,
    inputPending: row.accepted_generation !== row.admitted_generation,
  };
}
