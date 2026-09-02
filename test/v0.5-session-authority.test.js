import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initSessionAuthoritySchema,
  getOrCreateSessionAuthority,
  recordDurableTelegramIngress,
  admitSessionIngress,
  assertActionAuthorized,
  getSessionAuthority,
  SessionAuthorityFencedError,
  StaleTurnAuthorityError,
  StaleRevisionAuthorityError,
  IncompatibleAuthorityError,
  PINNED_AUTHORITY_OWNER,
  PINNED_AUTHORITY_CONTRACT,
} from "../src/v0.5/session-authority.js";

async function createTempDb() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sand-auth-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new DatabaseSync(dbPath);
  initSessionAuthoritySchema(db);
  return {
    db,
    dbPath,
    cleanup: async () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Issue #66: initializes session authority with pinned contract", async () => {
  const { db, cleanup } = await createTempDb();
  try {
    const auth = getOrCreateSessionAuthority(db, { sessionId: "sess-1" });
    assert.equal(auth.sessionId, "sess-1");
    assert.equal(auth.requiredAuthorityOwner, PINNED_AUTHORITY_OWNER);
    assert.equal(auth.requiredAuthorityContract, PINNED_AUTHORITY_CONTRACT);
    assert.equal(auth.acceptedGeneration, 0);
    assert.equal(auth.admittedGeneration, 0);
    assert.equal(auth.inputPending, false);
  } finally {
    await cleanup();
  }
});

test("Issue #66 Trace V05-01: durable ingress atomically advances generation and fences protected action", async () => {
  const { db, cleanup } = await createTempDb();
  try {
    getOrCreateSessionAuthority(db, { sessionId: "sess-1" });

    // Enqueue correction
    const ingressResult = recordDurableTelegramIngress(db, {
      sessionId: "sess-1",
      inputId: "in-101",
      updateId: 1001,
      payload: { text: "不要改数据库 schema" },
    });

    assert.equal(ingressResult.isDuplicate, false);
    assert.equal(ingressResult.generation, 1);
    assert.equal(ingressResult.authority.acceptedGeneration, 1);
    assert.equal(ingressResult.authority.admittedGeneration, 0);
    assert.equal(ingressResult.authority.inputPending, true);

    // Protected action must be fenced
    assert.throws(
      () => assertActionAuthorized(ingressResult.authority, { action: "github_publish" }),
      (err) => err instanceof SessionAuthorityFencedError
    );

    // After pi-sand classifies and establishes fresh turn T2 at revision 2
    const admitted = admitSessionIngress(db, {
      sessionId: "sess-1",
      inputId: "in-101",
      resultingRevision: 2,
      newTurnId: "turn-t2",
    });

    assert.equal(admitted.acceptedGeneration, 1);
    assert.equal(admitted.admittedGeneration, 1);
    assert.equal(admitted.inputPending, false);
    assert.equal(admitted.activeRevision, 2);
    assert.equal(admitted.activeTurnId, "turn-t2");

    // Action now authorized for T2 / rev 2
    assert.doesNotThrow(() =>
      assertActionAuthorized(admitted, { turnId: "turn-t2", revision: 2, action: "github_publish" })
    );

    // Stale turn T1 rejected
    assert.throws(
      () => assertActionAuthorized(admitted, { turnId: "turn-t1", revision: 2 }),
      (err) => err instanceof StaleTurnAuthorityError
    );

    // Stale revision 1 rejected
    assert.throws(
      () => assertActionAuthorized(admitted, { turnId: "turn-t2", revision: 1 }),
      (err) => err instanceof StaleRevisionAuthorityError
    );
  } finally {
    await cleanup();
  }
});

test("Issue #66 Trace V05-02: status query fences action until admitted with unchanged revision", async () => {
  const { db, cleanup } = await createTempDb();
  try {
    getOrCreateSessionAuthority(db, { sessionId: "sess-1" });

    // Initial goal admitted at rev 1, turn-t1
    recordDurableTelegramIngress(db, {
      sessionId: "sess-1",
      inputId: "in-1",
      updateId: 1,
      payload: { text: "帮我把这个修好" },
    });
    admitSessionIngress(db, {
      sessionId: "sess-1",
      inputId: "in-1",
      resultingRevision: 1,
      newTurnId: "turn-t1",
    });

    // Action authorized
    let auth = getSessionAuthority(db, "sess-1");
    assert.equal(auth.acceptedGeneration, 1);
    assert.equal(auth.admittedGeneration, 1);

    // Status query arrives
    recordDurableTelegramIngress(db, {
      sessionId: "sess-1",
      inputId: "in-2",
      updateId: 2,
      payload: { text: "当前进度如何？" },
    });

    auth = getSessionAuthority(db, "sess-1");
    assert.equal(auth.acceptedGeneration, 2);
    assert.equal(auth.admittedGeneration, 1);
    assert.equal(auth.inputPending, true);

    // Fenced during pending window
    assert.throws(
      () => assertActionAuthorized(auth, { turnId: "turn-t1", revision: 1 }),
      (err) => err instanceof SessionAuthorityFencedError
    );

    // Classified as ordinary_question_or_status -> revision unchanged (remains 1), turn unchanged
    auth = admitSessionIngress(db, {
      sessionId: "sess-1",
      inputId: "in-2",
      resultingRevision: 1,
      newTurnId: "turn-t1",
    });

    assert.equal(auth.acceptedGeneration, 2);
    assert.equal(auth.admittedGeneration, 2);
    assert.equal(auth.activeRevision, 1);
    assert.equal(auth.activeTurnId, "turn-t1");
    assert.equal(auth.inputPending, false);

    // Action reopened for turn-t1 / rev 1
    assert.doesNotThrow(() =>
      assertActionAuthorized(auth, { turnId: "turn-t1", revision: 1 })
    );
  } finally {
    await cleanup();
  }
});

test("Issue #66 Trace V05-03: duplicate telegram updates are deduplicated idempotently", async () => {
  const { db, cleanup } = await createTempDb();
  try {
    getOrCreateSessionAuthority(db, { sessionId: "sess-1" });

    const first = recordDurableTelegramIngress(db, {
      sessionId: "sess-1",
      inputId: "in-1",
      updateId: 5001,
      payload: { text: "hello" },
    });
    assert.equal(first.isDuplicate, false);
    assert.equal(first.generation, 1);

    const dup = recordDurableTelegramIngress(db, {
      sessionId: "sess-1",
      inputId: "in-1-retry",
      updateId: 5001, // same updateId
      payload: { text: "hello" },
    });
    assert.equal(dup.isDuplicate, true);
    assert.equal(dup.generation, 1);
    assert.equal(dup.authority.acceptedGeneration, 1);
  } finally {
    await cleanup();
  }
});

test("Issue #66 Trace V05-10: crash/restart preserves unadmitted fence and fails closed on incompatible owner", async () => {
  const { db, dbPath, cleanup } = await createTempDb();
  try {
    getOrCreateSessionAuthority(db, { sessionId: "sess-restart" });
    recordDurableTelegramIngress(db, {
      sessionId: "sess-restart",
      inputId: "in-crash",
      updateId: 999,
      payload: { text: "correction before crash" },
    });

    // Close db to simulate crash
    db.close();

    // Reopen db
    const db2 = new DatabaseSync(dbPath);
    try {
      const recoveredAuth = getSessionAuthority(db2, "sess-restart");
      assert.equal(recoveredAuth.acceptedGeneration, 1);
      assert.equal(recoveredAuth.admittedGeneration, 0);
      assert.equal(recoveredAuth.inputPending, true);

      // Remains strictly fenced after restart
      assert.throws(
        () => assertActionAuthorized(recoveredAuth, { action: "publish" }),
        (err) => err instanceof SessionAuthorityFencedError
      );

      // Incompatible owner simulation
      db2.prepare("UPDATE session_authority SET required_authority_owner = 'rogue' WHERE session_id = ?")
        .run("sess-restart");

      assert.throws(
        () => getOrCreateSessionAuthority(db2, { sessionId: "sess-restart" }),
        (err) => err instanceof IncompatibleAuthorityError
      );
    } finally {
      db2.close();
    }
  } finally {
    await cleanup();
  }
});
