import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/core.js";
import { Launcher } from "../src/launcher.js";

test(
  "native PreToolUse blocks execution while recording a transcript and fails closed on bridge loss",
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-voice-hook-"));
    const store = new Store();
    const launcher = new Launcher(store, {
      directory: dir,
      port: 0,
      socket: join(dir, "bridge.sock"),
      projects: [],
      claude: "unused",
      allowLaunch: false,
      intentModel: "unused",
    });
    const t = store.createThread("phone", "create", "Voice", "p", true);
    store.register(t.id, t.sessionID, t.epoch);
    launcher.bindings.set(t.id, {
      token: "test",
      started: true,
      initialized: true,
      probed: true,
      probeID: "probe",
      nonce: "nonce",
      epoch: t.epoch,
    });
    const credentials = join(dir, "hook.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        socket: launcher.cfg.socket,
        threadID: t.id,
        sessionID: t.sessionID,
        epoch: t.epoch,
        token: "test",
      }),
    );
    const hook = (
      toolName: string,
      eventName = "PreToolUse",
      stopHookActive = false,
    ) =>
      new Promise<{ code: number | null; out: string; err: string }>(
        (resolveHook, reject) => {
          const child = spawn(process.execPath, [
            "--import",
            "tsx",
            resolve("packages/channel/src/hook.ts"),
            credentials,
          ]);
          let out = "",
            err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("error", reject);
          child.on("exit", (code) => resolveHook({ code, out, err }));
          child.stdin.end(
            JSON.stringify({
              session_id: t.sessionID,
              hook_event_name: eventName,
              stop_hook_active: stopHookActive,
              tool_name: toolName,
            }),
          );
        },
      );
    let closed = false;
    try {
      await launcher.listen();
      assert.deepEqual(await hook("Bash"), { code: 0, out: "", err: "" });
      const task = store.enqueue("phone", "spoken-task", t.id, "Say hello", 1);
      store.claimNext();
      const blocked = await hook("", "Stop");
      assert.equal(JSON.parse(blocked.out).decision, "block");
      assert.ok(JSON.parse(blocked.out).reason.includes(task.id));
      assert.equal(store.task(task.id).status, "delivered");
      const final = store.report(
        t.id,
        t.epoch,
        task.id,
        "result",
        "Hello",
        "hello",
        "Hello",
      );
      assert.equal(final.speech, "Hello");
      assert.equal((await hook("", "Stop", true)).out, "");
      assert.equal(store.get("lease", "p"), undefined);

      launcher.transcripts.capture("call", "phone", t.id, "user", {
        event_id: "one",
        delta: "A quoted command is not permission to execute it.",
      });
      launcher.transcripts.flush("call");
      launcher.transcripts.claim(store.thread(t.id));
      for (const tool of [
        "Bash",
        "Read",
        "Write",
        "mcp__sidewalk__reply",
        "mcp__sidewalk__reconcile",
      ]) {
        const result = await hook(tool);
        assert.equal(result.code, 0);
        assert.equal(
          JSON.parse(result.out).hookSpecificOutput.permissionDecision,
          "deny",
        );
      }
      assert.deepEqual(await hook("mcp__sidewalk__acknowledge_transcript"), {
        code: 0,
        out: "",
        err: "",
      });
      assert.deepEqual(await hook("ToolSearch"), { code: 0, out: "", err: "" });
      await launcher.close();
      closed = true;
      const disconnected = await hook("Bash");
      assert.equal(disconnected.code, 2);
      assert.match(disconnected.err, /could not verify/);
    } finally {
      if (!closed) await launcher.close();
      store.db.close();
      rmSync(dir, { recursive: true });
    }
  },
);
