import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core.js";
import { parseDecision, schemaForState } from "../src/intent.js";
import { Live } from "../src/live.js";
import type { Launcher } from "../src/launcher.js";
const request = {
  action: "request",
  complete: true,
  threadID: null,
  name: "",
  text: "Research ways that people use voice to talk to Claude.",
  sourceQuote: "Can you research ways that people use voice to talk to Claude",
  background: false,
  taskID: null,
  questionID: null,
  reply: "",
};
function fixture() {
  const store = new Store();
  const thread = store.createThread(
    "phone",
    "new",
    "New thread",
    "project",
    true,
  );
  store.register(thread.id, thread.sessionID, thread.epoch);
  return { store, thread };
}
test("the structured schema constrains routing references to complete known IDs", () => {
  const { store, thread } = fixture();
  try {
    const schema = schemaForState(store.snapshot("phone"));
    assert.deepEqual(schema.properties.threadID.enum, [null, thread.id]);
    assert.deepEqual(schema.properties.taskID.enum, [null]);
    assert.deepEqual(schema.properties.questionID.enum, [null]);
    assert.throws(
      () =>
        parseDecision(
          { ...request, threadID: "d546a4..." },
          store.snapshot("phone"),
        ),
      /invalid target/,
    );
    assert.throws(
      () =>
        parseDecision(
          { ...request, taskID: "invented" },
          store.snapshot("phone"),
        ),
      /invalid target/,
    );
    assert.equal(store.all("task").length, 0);
  } finally {
    store.db.close();
  }
});
test("the captured research request resolves current focus and starts exactly one task", () => {
  const { store, thread } = fixture();
  try {
    let pumps = 0;
    const live = new Live(
      store,
      {
        port: 0,
        directory: "",
        socket: "",
        projects: [],
        claude: "",
        allowLaunch: false,
        intentModel: "test",
      },
      {
        pump: () => {
          pumps++;
        },
      } as unknown as Launcher,
      () => undefined,
    );
    const decision = parseDecision(request, store.snapshot("phone"));
    const execute = (
      live as unknown as {
        execute: (
          s: unknown,
          d: typeof decision,
          revision: number,
          epoch: number,
        ) => void;
      }
    ).execute.bind(live);
    const session = {
      id: "captured-call",
      device: "phone",
      ws: { readyState: 0 },
    };
    const epoch = store.focus("phone").epoch;
    execute(session, decision, 12, epoch);
    execute(session, decision, 12, epoch);
    const tasks = store.snapshot("phone").tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.threadID, thread.id);
    assert.equal(tasks[0]?.text, request.text);
    assert.equal(pumps, 2);
    const other = store.createThread(
      "phone",
      "other",
      "Other",
      "project",
      false,
    );
    store.setFocus("phone", other.id, "switch");
    assert.throws(
      () => execute(session, decision, 13, epoch),
      /focus changed/i,
    );
    assert.equal(store.all("task").length, 1);
  } finally {
    store.db.close();
  }
});
