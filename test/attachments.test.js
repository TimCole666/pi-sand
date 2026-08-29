import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/service.js";
import { createAgentServer } from "../src/server.js";

function withAttachmentPi(capture, { fail = false } = {}) {
  return ({ onEvent, onClose }) => ({
    prompt({ message }) {
      capture.push(message);
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I used the attachment." } });
      onEvent({ type: "message_end", message: { role: "assistant", content: "I used the attachment.", stopReason: fail ? "error" : "stop", errorMessage: fail ? "provider failed" : undefined } });
      onEvent({ type: "agent_settled" });
      if (fail) onClose({ code: null, signal: "SIGKILL" });
      else onClose({ code: 0, signal: null });
    },
    abort() {},
    close() {},
  });
}

async function withService(fn, piFactory) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-attachments-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory });
  try { await fn(service, directory); } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("stages attachment bytes, commits them to a durable user message, and gives Pi a stable path", async () => {
  const prompts = [];
  await withService(async (service) => {
    const agent = service.createAgent({ name: "Attachments", workspace: "/tmp" });
    const attachment = service.stageAttachment(agent.agent.id, {
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: Buffer.from("attachment contents"),
    });
    assert.equal(attachment.state, "staged");
    const storedPath = service.db.prepare("SELECT storage_path AS path FROM attachments WHERE id = ?").get(attachment.id).path;
    assert.ok(storedPath && existsSync(storedPath));
    assert.equal(readFileSync(storedPath, "utf8"), "attachment contents");

    service.sendMessage(agent.agent.id, "Summarize this file", { attachments: [attachment.id] });
    const snapshot = service.getAgent(agent.agent.id);
    assert.deepEqual(snapshot.messages[0].attachments.map(({ id, filename, contentType, byteSize }) => ({ id, filename, contentType, byteSize })), [
      { id: attachment.id, filename: "notes.txt", contentType: "text/plain", byteSize: 19 },
    ]);
    assert.equal(service.attachmentSnapshot(attachment.id).state, "committed");
    assert.match(prompts[0], /notes\.txt/);
    assert.ok(prompts[0].includes(storedPath));
  }, withAttachmentPi(prompts));
});

test("failed pre-commit submission leaves staged bytes live, while released orphans are bounded-cleaned", async () => {
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const attachment = service.stageAttachment(agent.agent.id, { filename: "draft.txt", bytes: Buffer.from("keep me") });
    assert.throws(() => service.sendMessage(agent.agent.id, "Do not commit", { attachments: ["missing-attachment"] }), /attachment not found/);
    assert.equal(service.attachmentSnapshot(attachment.id).state, "staged");
    const storedPath = service.db.prepare("SELECT storage_path AS path FROM attachments WHERE id = ?").get(attachment.id).path;
    assert.ok(existsSync(storedPath));

    service.releaseAttachment(agent.agent.id, attachment.id);
    assert.equal(service.cleanupOrphanedAttachments({ olderThanMs: 0 }), 1);
    assert.equal(service.attachmentSnapshot(attachment.id), null);
    assert.equal(existsSync(storedPath), false);
  }, withAttachmentPi([]));
});

test("the Desktop upload and send endpoints stage bytes and reject arbitrary origins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-attachment-http-"));
  const service = new AgentService({ dbPath: join(directory, "state.sqlite"), piFactory: withAttachmentPi([]) });
  const server = createAgentServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const agent = service.createAgent({ workspace: directory });
    const form = new FormData();
    form.append("file", new Blob(["from browser"], { type: "text/plain" }), "browser.txt");
    const staged = await fetch(`${base}/api/agents/${agent.agent.id}/attachments`, { method: "POST", body: form });
    assert.equal(staged.status, 201, await staged.clone().text());
    const attachment = (await staged.json()).attachment;
    const deniedForm = new FormData();
    deniedForm.append("file", new Blob(["blocked"], { type: "text/plain" }), "blocked.txt");
    const denied = await fetch(`${base}/api/agents/${agent.agent.id}/attachments`, { method: "POST", headers: { origin: "https://attacker.example" }, body: deniedForm });
    assert.equal(denied.status, 403);
    const sent = await fetch(`${base}/api/agents/${agent.agent.id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Read it", attachments: [attachment.id] }) });
    assert.equal(sent.status, 201);
    assert.equal(service.getAgent(agent.agent.id).messages[0].attachments[0].filename, "browser.txt");
  } finally {
    service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-commit Pi failure preserves the durable attachment relationship", async () => {
  await withService(async (service) => {
    const agent = service.createAgent({ workspace: "/tmp" });
    const attachment = service.stageAttachment(agent.agent.id, { filename: "failure.txt", bytes: Buffer.from("durable") });
    const turn = service.sendMessage(agent.agent.id, "Use this then fail", { attachments: [attachment.id] });
    assert.equal(turn.status, "failed");
    const snapshot = service.getAgent(agent.agent.id);
    assert.equal(snapshot.turns[0].status, "failed");
    assert.equal(snapshot.messages[0].attachments[0].id, attachment.id);
    assert.equal(service.attachmentSnapshot(attachment.id).state, "committed");
  }, withAttachmentPi([], { fail: true }));
});
