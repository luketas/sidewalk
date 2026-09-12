import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/server.js";

test("real HTTP boundary authenticates, deduplicates and reports missing voice configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-http-"));
  const bridge = createBridge(
    {
      port: 0,
      directory: dir,
      socket: join(dir, "bridge.sock"),
      projects: [{ id: "test", name: "Test", path: dir }],
      claude: "claude",
      allowLaunch: false,
      intentModel: "gpt-5.6-luna",
    },
    () => undefined,
  );
  const port = await bridge.start();
  const root = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(root + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(root + "/v1/state")).status, 401);
    const pair = await post("/v1/pair", {
      code: bridge.auth.pairingCode,
      name: "Phone",
    });
    const { token } = (await pair.json()) as { token: string };
    assert.equal(pair.status, 201);
    assert.equal(
      (
        await post(
          "/v1/threads",
          { commandID: "c", projectID: "../../", name: "Bad" },
          token,
        )
      ).status,
      400,
    );
    const body = {
      commandID: "c",
      projectID: "test",
      name: "Login",
      brief: "Inspect login",
      focus: true,
    };
    const first = await post("/v1/threads", body, token);
    const created = (await first.json()) as { id: string; status: string };
    assert.equal(first.status, 201);
    assert.equal(created.status, "blocked");
    const duplicate = (await (
      await post("/v1/threads", body, token)
    ).json()) as { id: string };
    assert.equal(duplicate.id, created.id);
    assert.equal(
      (await post("/v1/voice", { sdp: "a valid-looking offer" }, token)).status,
      503,
    );
    const state = (await (
      await fetch(root + "/v1/state", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { threads: unknown[]; tasks: unknown[] };
    assert.equal(state.threads.length, 1);
    assert.equal(state.tasks.length, 1);
    // Exercise HTTP -> durable answer -> launcher pump with only the Claude socket replaced.
    const thread = bridge.store.thread(created.id);
    bridge.store.register(thread.id, thread.sessionID, thread.epoch);
    const task = bridge.store.claimNext()!.task;
    const question = bridge.store.report(
      thread.id,
      thread.epoch,
      task.id,
      "question",
      "Which file?",
      "question-event",
    );
    const device = bridge.auth.verify("Bearer " + token);
    const answers: import("../src/core.js").Delivery[] = [];
    bridge.launcher.send = (delivery) => {
      answers.push(delivery);
    };
    const answerBody = {
      commandID: "answer-http",
      threadID: thread.id,
      taskID: task.id,
      questionID: question.questionID,
      text: "login.ts",
      focusEpoch: bridge.store.focus(device).epoch,
    };
    assert.equal((await post("/v1/answers", answerBody)).status, 401);
    assert.equal(
      (await post("/v1/answers", { ...answerBody, questionID: "wrong" }, token))
        .status,
      409,
    );
    assert.equal((await post("/v1/answers", answerBody, token)).status, 200);
    assert.equal((await post("/v1/answers", answerBody, token)).status, 200);
    assert.equal(answers.length, 0);
    bridge.store.observeStop(thread.id);
    bridge.launcher.pump();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.answer?.text, "login.ts");
    assert.equal(answers[0]!.task.text, "Inspect login");
    assert.equal(
      (
        await post(
          "/v1/answers",
          { ...answerBody, text: "different.ts" },
          token,
        )
      ).status,
      409,
    );
    bridge.store.recover();
    bridge.store.register(thread.id, thread.sessionID, thread.epoch);
    const checkBody = { commandID: "check-http", taskID: task.id };
    assert.equal((await post("/v1/reconcile", checkBody)).status, 401);
    assert.equal((await post("/v1/reconcile", checkBody, token)).status, 200);
    assert.equal((await post("/v1/reconcile", checkBody, token)).status, 200);
    assert.equal(bridge.store.all("recovery").length, 1);
    assert.equal(
      (
        await post(
          "/v1/reconcile",
          { ...checkBody, commandID: "check-too-soon" },
          token,
        )
      ).status,
      409,
    );
    const historyPath =
      root + "/v1/conversation?threadID=" + encodeURIComponent(thread.id);
    assert.equal((await fetch(historyPath)).status, 401);
    const history = (await (
      await fetch(historyPath, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { messages: { text: string }[]; cursor: number };
    assert.deepEqual(
      history.messages.map((m) => m.text),
      ["Inspect login", "Which file?", "login.ts"],
    );
    const nextPage = (await (
      await fetch(historyPath + "&after=" + history.cursor, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { messages: unknown[] };
    assert.equal(nextPage.messages.length, 0);
    const hostile = await fetch(root + "/v1/state", {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://example.com",
      },
    });
    assert.equal(hostile.status, 403);
    assert.equal((await post("/v1/revoke", {}, token)).status, 200);
    assert.equal(
      (
        await fetch(root + "/v1/state", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  } finally {
    await bridge.stop();
    rmSync(dir, { recursive: true });
  }
});

test("Live receives Claude replies without a competing MP3 synthesis path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-prewarm-"));
  const bridge = createBridge(
    {
      port: 0,
      directory: dir,
      socket: join(dir, "bridge.sock"),
      projects: [],
      claude: "claude",
      allowLaunch: false,
      intentModel: "test",
    },
    () => "test-key",
  );
  const original = globalThis.fetch;
  let calls = 0;
  try {
    await bridge.start();
    globalThis.fetch = async () => {
      calls++;
      return new Response(new Uint8Array([73, 68, 51]));
    };
    const t = bridge.store.createThread("phone", "t", "Voice", "p", true);
    bridge.store.register(t.id, t.sessionID, t.epoch);
    const spoken: any[] = [];
    bridge.live.sessions.set("test", {
      id: "test",
      device: "phone",
      closed: false,
      closing: false,
      ws: { readyState: 1, send: (s: string) => spoken.push(JSON.parse(s)) },
      lastCursor: 0,
    } as any);
    const task = bridge.store.enqueue("phone", "work", t.id, "Hello", 1);
    bridge.store.claimNext();
    bridge.store.report(t.id, t.epoch, task.id, "result", "Hello there.", "r");
    assert.equal(
      calls,
      0,
      "Live owns in-call playback; no competing MP3 is generated",
    );
    assert.equal(
      spoken.filter(
        (e) =>
          e.type === "session.commentary.append" &&
          e.content.includes("Hello there."),
      ).length,
      1,
    );
    bridge.store.atomic(() => {});
    assert.equal(
      spoken.filter(
        (e) =>
          e.type === "session.commentary.append" &&
          e.content.includes("Hello there."),
      ).length,
      1,
    );
    assert.equal(
      calls,
      0,
      "Other state changes do not synthesize duplicate audio",
    );
    bridge.live.sessions.clear();
    bridge.store.observeStop(t.id);
    const task2 = bridge.store.enqueue(
      "phone",
      "offline-work",
      t.id,
      "Another",
      2,
    );
    bridge.store.claimNext();
    bridge.store.report(
      t.id,
      t.epoch,
      task2.id,
      "result",
      "Not in a call.",
      "r2",
    );
    assert.equal(calls, 0, "Do not synthesize when nobody is in a call");
  } finally {
    globalThis.fetch = original;
    bridge.live.sessions.clear();
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
