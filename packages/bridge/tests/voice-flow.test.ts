import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core.js";
import { interruptedAfter } from "../src/interruptions.js";
import { Speech, spokenText } from "../src/speech.js";
import { Live } from "../src/live.js";

test("interruption observation requires native identity, session and a new timestamp", () => {
  const event = {
    type: "user",
    sessionId: "s",
    isSidechain: false,
    interruptedMessageId: "m",
    timestamp: "2026-09-12T16:12:05Z",
    message: {
      content: [{ type: "text", text: "[Request interrupted by user]" }],
    },
  };
  const match = (e: unknown, since = 0) =>
    interruptedAfter(JSON.stringify(e), "s", since);
  assert.equal(match(event), true);
  assert.equal(match({ ...event, interruptedMessageId: undefined }), false);
  assert.equal(match({ ...event, sessionId: "other" }), false);
  assert.equal(match({ ...event, isSidechain: true }), false);
  assert.equal(match(event, Date.parse(event.timestamp) + 1), false);
  assert.equal(
    interruptedAfter("partial\n" + JSON.stringify(event), "s", 0),
    true,
  );
});

test("voice audio uses Claude's recorded reply and deduplicates provider requests", async () => {
  const store = new Store();
  const original = globalThis.fetch;
  try {
    const t = store.createThread("p", "new", "Voice", "project", true);
    store.register(t.id, t.sessionID, t.epoch);
    const task = store.enqueue(
      "p",
      "request",
      t.id,
      "Check this",
      1,
      store.focus("p").epoch,
    );
    const speech = new Speech();
    await assert.rejects(speech.audio(task, "key"), /not replied/);
    store.claimNext();
    const result = store.report(
      t.id,
      t.epoch,
      task.id,
      "result",
      "# Full answer\n```js\ncode\n```",
      "result",
      "Here is Claude’s answer.",
    );
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).input, result.speech);
      return new Response(new Uint8Array([73, 68, 51]));
    };
    const [a, b] = await Promise.all([
      speech.audio(result, "key"),
      speech.audio(result, "key"),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.equal(spokenText(result), result.speech);
    assert.ok(!spokenText({ ...result, speech: undefined }).includes("```"));
  } finally {
    globalThis.fetch = original;
    store.db.close();
  }
});

test("a complete discussion reaches Claude verbatim, without authorizing invented work", async () => {
  const store = new Store(),
    original = globalThis.fetch;
  try {
    const thread = store.createThread("phone", "new", "Voice", "project", true);
    store.register(thread.id, thread.sessionID, thread.epoch);
    const decision = {
      action: "discuss",
      complete: true,
      threadID: null,
      name: "",
      text: "",
      sourceQuote: "",
      background: false,
      taskID: null,
      questionID: null,
      reply: "",
    };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify(decision),
          output: [
            {
              content: [
                { type: "output_text", text: JSON.stringify(decision) },
              ],
            },
          ],
        }),
      );
    let pumps = 0;
    const live = new Live(
      store,
      { intentModel: "test" } as any,
      {
        pump() {
          pumps++;
        },
      } as any,
      () => "key",
    );
    const s: any = {
      id: "call",
      ws: { readyState: 0 },
      device: "phone",
      pending: "Don’t change anything. Can we discuss the options?",
      history: "",
      revision: 1,
      closed: false,
      closing: false,
      muted: false,
    };
    await (live as any).route(s);
    const tasks = store.all<any>("task");
    assert.equal(tasks.length, 1);
    assert.equal(
      tasks[0].text,
      "Don’t change anything. Can we discuss the options?",
    );
    assert.equal(pumps, 1);
    assert.equal(s.pending, "");
  } finally {
    globalThis.fetch = original;
    store.db.close();
  }
});

test("acknowledgments can be spoken before work completes", async () => {
  const store = new Store();
  const original = globalThis.fetch;
  try {
    const thread = store.createThread("p", "new", "Voice", "project", true);
    store.register(thread.id, thread.sessionID, thread.epoch);
    const task = store.enqueue("p", "work", thread.id, "Research", 1);
    store.claimNext();
    const ack = store.report(
      thread.id,
      thread.epoch,
      task.id,
      "accepted",
      "Sure, let me look into that.",
      "ack",
    );
    globalThis.fetch = async () => new Response(new Uint8Array([73, 68, 51]));
    assert.equal(ack.status, "working");
    assert.equal(ack.replyID, "ack");
    assert.equal((await new Speech().audio(ack, "key")).length, 3);
  } finally {
    globalThis.fetch = original;
    store.db.close();
  }
});
