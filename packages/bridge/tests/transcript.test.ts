import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core.js";
import { VoiceJournal, type VoiceFragment } from "../src/transcript.js";
import { Live } from "../src/live.js";

function ready(store: Store, name = "Voice") {
  const t = store.createThread("phone", name, name, "p", true);
  store.register(t.id, t.sessionID, t.epoch);
  return store.thread(t.id);
}
test("transcript retains exact words, speakers and timing without becoming task input", () => {
  const store = new Store();
  try {
    const thread = ready(store);
    const journal = new VoiceJournal(store);
    const input = {
      event_id: "a",
      delta: "Actually, ",
      start_ms: 100,
      end_ms: 500,
    };
    journal.capture("call", "phone", thread.id, "user", input);
    journal.capture("call", "phone", thread.id, "user", input);
    journal.capture("call", "phone", thread.id, "user", {
      event_id: "b",
      delta: "do not change it.",
      start_ms: 500,
      end_ms: 900,
    });
    journal.capture("call", "phone", thread.id, "companion", {
      event_id: "c",
      delta: "We can just discuss it.",
      start_ms: 700,
      end_ms: 1100,
    });
    assert.equal(journal.claim(thread), undefined);
    journal.flush("call");
    const delivery = journal.claim(thread)!;
    assert.match(delivery.content, /Actually, do not change it\./);
    assert.match(delivery.content, /Sidewalk \(voice assistant\)/);
    assert.equal(store.all("task").length, 0);
    assert.equal(store.all<VoiceFragment>("voice_fragment").length, 3);
    assert.equal(journal.claim(thread), undefined);
    assert.throws(() =>
      journal.acknowledge(thread.id, thread.epoch + 1, delivery.batch.id),
    );
    assert.throws(() => journal.acknowledge(thread.id, thread.epoch, "wrong"));
    journal.acknowledge(thread.id, thread.epoch, delivery.batch.id);
    const task = store.enqueue(
      "phone",
      "work",
      thread.id,
      "Actual separately admitted work",
      1,
    );
    assert.equal(
      store.claimNext(),
      undefined,
      "task waits for transcript Stop even after acknowledgement",
    );
    assert.equal(journal.stop(thread.id), true);
    assert.equal(store.claimNext()?.task.id, task.id);
  } finally {
    store.db.close();
  }
});
test("transcripts wait for active work and its Stop; failed sends are not replayed after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-voice-"));
  let store = new Store(join(dir, "journal.sqlite"));
  try {
    let journal = new VoiceJournal(store);
    const thread = ready(store);
    const task = store.enqueue("phone", "work", thread.id, "Work", 1);
    store.claimNext();
    journal.capture("call", "phone", thread.id, "user", {
      event_id: "a",
      delta: "Work",
    });
    journal.flush("call");
    assert.equal(journal.claim(thread), undefined);
    store.report(
      thread.id,
      thread.epoch,
      task.id,
      "result",
      "Finished",
      "result",
    );
    assert.equal(
      journal.claim(thread),
      undefined,
      "result alone does not release work lease",
    );
    store.observeStop(thread.id);
    assert.ok(journal.claim(thread));
    journal.capture("call", "phone", thread.id, "companion", {
      event_id: "b",
      delta: "This final fragment survives a crash.",
    });
    store.db.close();
    store = new Store(join(dir, "journal.sqlite"));
    journal = new VoiceJournal(store);
    journal.recover();
    assert.equal(
      store.all<VoiceFragment>("voice_fragment").find((f) => f.text === "Work")
        ?.state,
      "unknown",
    );
    const next = journal.claim(thread)!;
    assert.match(next.content, /final fragment survives/);
    assert.doesNotMatch(next.content, /\nWork/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("Live retains only user input locally without competing assistant replies or archival queue traffic", () => {
  const store = new Store();
  try {
    const first = ready(store, "First"),
      second = ready(store, "Second");
    store.setFocus("phone", first.id, "focus-first");
    const journal = new VoiceJournal(store);
    const launcher = { transcripts: journal, pump() {} };
    const live = new Live(store, {} as any, launcher as any, () => undefined);
    const session: any = {
      id: "call",
      device: "phone",
      ws: { readyState: 0, close() {} },
      revision: 0,
      pending: "",
      history: "",
      closed: false,
      closing: false,
      muted: false,
      seen: new Set(),
      lastCursor: Number(
        store.db.prepare("SELECT MAX(seq) AS seq FROM events").get()!.seq,
      ),
      costSeconds: 0,
      transcriptThreadID: first.id,
      transcriptCharacters: 0,
    };
    live.sessions.set(session.id, session);
    const event = (live as any).event.bind(live);
    const input = {
      type: "session.input_transcript.delta",
      event_id: "1",
      delta: "Just thinking aloud.",
      start_ms: 10,
      end_ms: 100,
    };
    event(session, input);
    event(session, input);
    event(session, {
      type: "session.output_transcript.delta",
      event_id: "2",
      delta: "Tell me more.",
    });
    store.setFocus("phone", second.id, "focus-second");
    event(session, {
      type: "session.input_transcript.delta",
      event_id: "3",
      delta: "Now the other topic.",
    });
    live.mute("phone", "call", true);
    event(session, {
      type: "session.input_transcript.delta",
      event_id: "muted",
      delta: "Not captured",
    });
    event(session, {
      type: "session.output_transcript.delta",
      event_id: "4",
      delta: "We can take our time.",
    });
    event(session, {
      type: "session.closed",
      event_id: "end",
      usage: { seconds: 2 },
    });
    const fragments = store.all<{ threadID: string; delta: string }>(
      "voice_input",
    );
    assert.equal(fragments.length, 2);
    assert.deepEqual(
      fragments.map((f) => f.threadID),
      [first.id, second.id],
    );
    assert.equal(store.all("voice_fragment").length, 0);
    assert.ok(!session.history.includes("Tell me more"));
    assert.equal(store.all("task").length, 0);
    assert.equal(live.sessions.size, 0);
  } finally {
    store.db.close();
  }
});

test("overlapping speech stays readable without losing either speaker's fragments", () => {
  const store = new Store();
  try {
    const thread = ready(store);
    const journal = new VoiceJournal(store);
    journal.capture("overlap", "phone", thread.id, "user", {
      event_id: "1",
      delta: "I was ",
      start_ms: 100,
      end_ms: 500,
    });
    journal.capture("overlap", "phone", thread.id, "companion", {
      event_id: "2",
      delta: "Mm",
      start_ms: 300,
      end_ms: 400,
    });
    journal.capture("overlap", "phone", thread.id, "user", {
      event_id: "3",
      delta: "thinking about a walk.",
      start_ms: 500,
      end_ms: 1000,
    });
    journal.capture("overlap", "phone", thread.id, "companion", {
      event_id: "4",
      delta: " hmm.",
      start_ms: 400,
      end_ms: 550,
    });
    journal.flush("overlap");
    const content = journal.claim(thread)!.content;
    assert.match(content, /I was thinking about a walk\./);
    assert.match(content, /Mm hmm\./);
    assert.equal(content.match(/You \(voice\)/g)?.length, 1);
    assert.equal(content.match(/Sidewalk \(voice assistant\)/g)?.length, 1);
  } finally {
    store.db.close();
  }
});
