import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../src/launcher.js";
import { Store } from "../src/core.js";

test(
  "a replacement channel must prove a fresh nonce before queued work is sent",
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "sw-rebind-"));
    const store = new Store();
    const launcher = new Launcher(store, {
      directory,
      port: 0,
      socket: join(directory, "bridge.sock"),
      projects: [],
      claude: "unused",
      allowLaunch: false,
      intentModel: "unused",
    });
    const thread = store.createThread("device", "create", "Test", "p", true);
    store.updateThread(thread.id, "unknown", "Disconnected");
    const task = store.enqueue(
      "device",
      "request",
      thread.id,
      "Read-only test",
      1,
    );
    launcher.bindings.set(thread.id, {
      token: "fixture",
      started: true,
      initialized: true,
      probed: true,
      probeID: "old-probe",
      nonce: "old-nonce",
      epoch: thread.epoch,
    });
    let socket: net.Socket | undefined;
    try {
      await launcher.listen();
      socket = net.connect(launcher.cfg.socket);
      const messages: any[] = [];
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          messages.push(JSON.parse(buffer.slice(0, i)));
          buffer = buffer.slice(i + 1);
        }
      });
      await once(socket, "connect");
      const send = (data: object) =>
        socket!.write(
          JSON.stringify({
            token: "fixture",
            threadID: thread.id,
            epoch: thread.epoch,
            ...data,
          }) + "\n",
        );
      const waitFor = async (predicate: () => boolean) => {
        const end = Date.now() + 2000;
        while (!predicate()) {
          if (Date.now() > end) throw Error("IPC fixture timed out");
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      send({ type: "register" });
      await waitFor(() => messages.some((m) => m.type === "probe"));
      assert.equal(store.thread(thread.id).status, "unknown");
      assert.equal(store.task(task.id).status, "queued");
      assert.equal(messages.filter((m) => m.type === "request").length, 0);
      const binding = launcher.bindings.get(thread.id)!;
      assert.notEqual(binding.probeID, "old-probe");
      assert.notEqual(binding.nonce, "old-nonce");
      send({
        type: "report",
        taskID: binding.probeID,
        kind: "accepted",
        text: "old-nonce",
        eventID: "stale",
      });
      await waitFor(() => messages.some((m) => m.eventID === "stale"));
      assert.equal(store.thread(thread.id).status, "unknown");
      send({
        type: "report",
        taskID: binding.probeID,
        kind: "accepted",
        text: binding.nonce,
        eventID: "fresh",
      });
      await waitFor(() => messages.some((m) => m.eventID === "fresh"));
      assert.equal(store.task(task.id).status, "queued");
      assert.equal(messages.filter((m) => m.type === "request").length, 0);
      const stop = net.connect(launcher.cfg.socket);
      stop.on("data", () => {});
      await once(stop, "connect");
      stop.write(
        JSON.stringify({
          token: "fixture",
          threadID: thread.id,
          epoch: thread.epoch,
          type: "hook",
          event: "Stop",
          sessionID: thread.sessionID,
        }) + "\n",
      );
      await once(stop, "close");
      await waitFor(() => messages.some((m) => m.type === "request"));
      assert.equal(store.thread(thread.id).status, "ready");
      assert.equal(store.task(task.id).status, "delivered");
    } finally {
      socket?.destroy();
      await launcher.close();
      store.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
