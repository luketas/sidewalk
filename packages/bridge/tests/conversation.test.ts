import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core.js";
import { ConversationJournal } from "../src/conversation.js";
import { Live, speechChunks } from "../src/live.js";

test("full answers and questions survive continuation, progress overwrites and restart; reading never dispatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-history-"));
  let store = new Store(join(dir, "journal.sqlite"));
  try {
    const thread = store.createThread("p", "new", "Chat", "project", true);
    store.register(thread.id, thread.sessionID, thread.epoch);
    let journal = new ConversationJournal(store);
    const task = store.enqueue("p", "request", thread.id, "Research", 1);
    store.claimNext();
    const question = store.report(
      thread.id,
      thread.epoch,
      task.id,
      "question",
      "Which city?",
      "q",
    );
    store.observeStop(thread.id);
    store.answer(
      "p",
      "a",
      thread.id,
      task.id,
      question.questionID!,
      "Lisbon",
      store.focus("p").epoch,
    );
    store.claimAnswer();
    store.report(thread.id, thread.epoch, task.id, "progress", "Checking", "p");
    store.report(
      thread.id,
      thread.epoch,
      task.id,
      "result",
      "Full answer with https://example.com and details",
      "r",
      "Short answer",
    );
    const expected = [
      "Research",
      "Which city?",
      "Lisbon",
      "Full answer with https://example.com and details",
    ];
    assert.deepEqual(
      journal.read(thread.id).map((m) => m.text),
      expected,
    );
    store.db.close();
    store = new Store(join(dir, "journal.sqlite"));
    journal = new ConversationJournal(store);
    assert.deepEqual(
      journal.read(thread.id).map((m) => m.text),
      expected,
    );
    assert.equal(store.all("task").length, 1);
    assert.deepEqual(journal.read("other"), []);
    const first = journal.read(thread.id, 0, 2);
    assert.equal(journal.read(thread.id, first.at(-1)!.seq).length, 2);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spoken fragments deduplicate and never dispatch assistant speech; background results remain silent", () => {
  const store = new Store();
  const live = new Live(
    store,
    {} as any,
    {
      pump() {
        throw Error("must not dispatch");
      },
    } as any,
    () => undefined,
  );
  try {
    const a = store.createThread("p", "a", "A", "project-a", true);
    store.register(a.id, a.sessionID, a.epoch);
    const b = store.createThread("p", "b", "B", "project-b", false);
    store.register(b.id, b.sessionID, b.epoch);
    const outputs: any[] = [];
    const s: any = {
      id: "session",
      device: "p",
      closed: false,
      closing: false,
      seen: new Set(),
      history: "",
      lastCursor: store.events().at(-1)!.seq,
      transcriptThreadID: a.id,
      ws: { readyState: 1, send: (x: string) => outputs.push(JSON.parse(x)) },
    };
    live.sessions.set(s.id, s);
    const e = {
      type: "session.output_transcript.delta",
      event_id: "voice1",
      delta: "Let me look into it.",
      start_ms: 100,
      end_ms: 500,
    };
    (live as any).event(s, e);
    (live as any).event(s, e);
    assert.equal(live.journal.read(a.id).length, 1);
    assert.equal(store.all("task").length, 0);
    const task = store.enqueue("p", "work", b.id, "Research B", 1);
    store.claimNext();
    store.report(
      b.id,
      b.epoch,
      task.id,
      "result",
      "PRIVATE BACKGROUND RESULT",
      "result-b",
    );
    assert.ok(!JSON.stringify(outputs).includes("PRIVATE BACKGROUND RESULT"));
    assert.throws(() => live.repeat("p", s.id, task.id, "result-b"), /changed/);
  } finally {
    live.sessions.clear();
    store.db.close();
  }
});

test("voice input is not duplicated by task admission and result text is never truncated", () => {
  const store = new Store();
  try {
    const journal = new ConversationJournal(store);
    const t = store.createThread("p", "t", "A", "p", true);
    store.put("conversation_session", "call", {});
    journal.append({
      id: "i",
      threadID: t.id,
      role: "user",
      kind: "input",
      text: "Hello",
      at: 1,
    });
    journal.append({
      id: "i",
      threadID: t.id,
      role: "user",
      kind: "input",
      text: "Hello",
      at: 1,
    });
    store.enqueue("p", "voice:call:1", t.id, "Hello", 1);
    assert.equal(journal.read(t.id).filter((m) => m.role === "user").length, 1);
    const long = "One sentence. ".repeat(400).trim();
    const chunks = speechChunks(long);
    assert.ok(chunks.every((c) => c.length <= 1000));
    assert.equal(chunks.join(" "), long);
  } finally {
    store.db.close();
  }
});
