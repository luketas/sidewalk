import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFromMetadata } from "../src/titles.js";
import { alreadySpoken } from "../src/live.js";
import { Store } from "../src/core.js";
test("blank creation has no brief or fixed Claude title", () => {
  const store = new Store();
  try {
    const t = store.createThread("phone", "create", "", "project", true);
    assert.equal(t.name, "New thread");
    assert.equal(t.nameFromClaude, true);
    assert.equal(store.all("task").length, 0);
  } finally {
    store.db.close();
  }
});
test("Claude metadata title respects session identity, rename priority, partial records and invalid values", () => {
  const record = (type: string, value: string, id = "session") =>
    JSON.stringify({ type, sessionId: id, customTitle: value, aiTitle: value });
  assert.equal(
    titleFromMetadata(
      [
        record("ai-title", "Generated topic"),
        record("custom-title", "Chosen in Claude"),
        record("ai-title", "Later summary"),
        record("custom-title", "Wrong session", "other"),
        "partial",
      ].join("\n"),
      "session",
    ),
    "Chosen in Claude",
  );
  assert.equal(
    titleFromMetadata(record("ai-title", "Generated topic"), "session"),
    "Generated topic",
  );
  assert.equal(
    titleFromMetadata(record("custom-title", "bad\nname"), "session"),
    undefined,
  );
});
test("short matching replies are not repeated, while other threads and older results are announced", () => {
  const s = { spoken: "Yes. Kitkat.", lastSpokenAt: Date.now() };
  assert.equal(alreadySpoken(s, "kitkat", "one", "one"), true);
  assert.equal(alreadySpoken(s, "kitkat", "two", "one"), false);
  assert.equal(
    alreadySpoken(
      { ...s, lastSpokenAt: Date.now() - 30000 },
      "kitkat",
      "one",
      "one",
    ),
    false,
  );
  assert.equal(alreadySpoken(s, "A different answer", "one", "one"), false);
});

test("Claude reply names an untitled thread atomically and preserves established names", () => {
  const s = new Store();
  try {
    const t = s.createThread("phone", "create", "", "project", true);
    s.register(t.id, t.sessionID, t.epoch);
    const task = s.enqueue("phone", "task", t.id, "Investigate login", 1);
    s.claimNext();
    s.report(
      t.id,
      t.epoch,
      task.id,
      "accepted",
      "Looking into it",
      "ack",
      undefined,
      "Login investigation",
    );
    assert.equal(s.thread(t.id).name, "Login investigation");
    s.report(
      t.id,
      t.epoch,
      task.id,
      "accepted",
      "Looking into it",
      "ack",
      undefined,
      "Login investigation",
    );
    assert.equal(
      s.events(0).filter((e) => e.kind === "thread.renamed").length,
      1,
    );
    s.report(
      t.id,
      t.epoch,
      task.id,
      "result",
      "Found the issue",
      "result",
      undefined,
      "Different title",
    );
    assert.equal(s.thread(t.id).name, "Login investigation");
    assert.equal(s.task(task.id).status, "completed");
  } finally {
    s.db.close();
  }
});

test("invalid titles cannot lose a reply or rename another session", () => {
  const s = new Store();
  try {
    const a = s.createThread("phone", "a", "", "project", true);
    const b = s.createThread("phone", "b", "Chosen title", "project", true);
    s.register(a.id, a.sessionID, a.epoch);
    s.register(b.id, b.sessionID, b.epoch);
    const task = s.enqueue("phone", "task", a.id, "Investigate login", 1);
    s.claimNext();
    assert.throws(
      () =>
        s.report(
          b.id,
          b.epoch,
          task.id,
          "accepted",
          "Looking",
          "wrong",
          undefined,
          "Hijacked",
        ),
      /different thread/,
    );
    assert.throws(
      () =>
        s.report(
          a.id,
          a.epoch + 1,
          task.id,
          "accepted",
          "Looking",
          "stale",
          undefined,
          "Stale",
        ),
      /different thread/,
    );
    assert.equal(s.thread(b.id).name, "Chosen title");
    s.report(
      a.id,
      a.epoch,
      task.id,
      "accepted",
      "Looking",
      "invalid",
      undefined,
      "Bad\nname",
    );
    assert.equal(s.thread(a.id).name, "New thread");
    s.report(
      a.id,
      a.epoch,
      task.id,
      "result",
      "Done",
      "long",
      undefined,
      "x".repeat(101),
    );
    assert.equal(s.task(task.id).status, "completed");
    assert.equal(s.thread(a.id).name, "New thread");
  } finally {
    s.db.close();
  }
});
