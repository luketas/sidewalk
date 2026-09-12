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
