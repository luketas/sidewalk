import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Store, DomainError } from "./core.js";
import { Auth } from "./auth.js";
import { Launcher } from "./launcher.js";
import { Live } from "./live.js";
import { Speech } from "./speech.js";
import { Interruptions } from "./interruptions.js";
import { SessionTitles } from "./titles.js";
import type { Config } from "./config.js";
const id = z.string().min(1).max(200),
  text = z.string().trim().min(1).max(16000);
export function createBridge(
  cfg: Config,
  key: () => string | undefined = () => process.env.OPENAI_API_KEY,
) {
  const store = new Store(join(cfg.directory, "journal.sqlite"));
  store.recover();
  const auth = new Auth(store),
    launcher = new Launcher(store, cfg),
    live = new Live(store, cfg, launcher, key);
  const attempts = new Map<string, { at: number; count: number }>();
  const titles = new SessionTitles(store, cfg);
  const speech = new Speech(),
    interruptions = new Interruptions(store, cfg);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      // Native clients have no Origin. Never offer a browser-accessible bearer proxy.
      if (req.headers.origin)
        throw new DomainError(
          "origin_denied",
          "Browser requests are not supported",
          403,
        );
      const url = new URL(req.url ?? "/", "http://localhost");
      let body: unknown = {};
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new DomainError("content_type", "Use application/json", 415);
        let data = "";
        for await (const chunk of req) {
          data += chunk;
          if (Buffer.byteLength(data) > 100000)
            throw new DomainError("too_large", "Request too large", 413);
        }
        body = JSON.parse(data || "{}");
      }
      if (req.method === "GET" && url.pathname === "/health") {
        send(200, { ok: true, version: "0.1.0" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        const address = req.socket.remoteAddress ?? "unknown";
        let a = attempts.get(address);
        if (!a || Date.now() - a.at > 60000) {
          a = { at: Date.now(), count: 0 };
          attempts.set(address, a);
        }
        if (++a.count > 5)
          throw new DomainError(
            "rate_limited",
            "Too many pairing attempts",
            429,
          );
        const b = z.object({ code: id, name: z.string().max(100) }).parse(body);
        send(201, auth.pair(b.code, b.name));
        return;
      }
      const device = auth.verify(req.headers.authorization);
      if (req.method === "GET" && url.pathname === "/v1/state") {
        titles.refresh();
        interruptions.refresh();
        launcher.pump();
        send(200, {
          ...store.snapshot(device),
          projects: cfg.projects.map(({ id, name }) => ({ id, name })),
          readiness: {
            voiceKey: !!key(),
            claudeLaunch: cfg.allowLaunch,
            liveVerified: false,
            stopSupported: false,
          },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/permissions") {
        const b = z
          .object({
            permissionID: id,
            commandID: id,
            decision: z.enum(["allow", "deny"]),
            focusEpoch: z.number().int().nonnegative(),
          })
          .strict()
          .parse(body);
        send(
          200,
          launcher.permissions.decide(
            device,
            b.commandID,
            b.permissionID,
            b.decision,
            b.focusEpoch,
          ),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/conversation") {
        const threadID = id.parse(url.searchParams.get("threadID"));
        store.thread(threadID);
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(url.searchParams.get("after") ?? 0);
        const messages = live.journal.read(threadID, after);
        send(200, {
          threadID,
          messages,
          cursor: messages.at(-1)?.seq ?? after,
          hasMore: messages.length === 200,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/speech") {
        const b = z
          .object({ taskID: id, replyID: id.optional() })
          .strict()
          .parse(body);
        const task = store.task(b.taskID);
        if (b.replyID && b.replyID !== task.replyID)
          throw new DomainError(
            "reply_changed",
            "A newer reply is available",
            409,
          );
        const audio = await speech.audio(task, key());
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(audio);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const cursor = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(url.searchParams.get("after") ?? 0);
        send(200, { events: store.events(cursor) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/threads") {
        const b = z
          .object({
            commandID: id,
            name: z.string().trim().max(100).default(""),
            projectID: id,
            focus: z.boolean().default(true),
            brief: z.string().max(16000).default(""),
          })
          .parse(body);
        if (!cfg.projects.some((p) => p.id === b.projectID))
          throw new DomainError(
            "project_missing",
            "Choose a configured project",
            400,
          );
        const thread = store.createThread(
          device,
          b.commandID,
          b.name,
          b.projectID,
          b.focus,
          b.brief,
        );
        launcher.launch(store.thread(thread.id));
        if (!b.name && b.focus)
          store.setFocus(device, thread.id, b.commandID + ":focus");
        send(201, store.thread(thread.id));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/reconcile") {
        const b = z.object({ commandID: id, taskID: id }).parse(body);
        store.requestRecovery(device, b.commandID, b.taskID);
        launcher.pump();
        send(200, store.task(b.taskID));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/resume") {
        const b = z.object({ commandID: id, threadID: id }).parse(body);
        send(200, launcher.resume(device, b.commandID, b.threadID));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/focus") {
        const b = z.object({ commandID: id, threadID: id }).parse(body);
        send(200, store.setFocus(device, b.threadID, b.commandID));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/tasks") {
        const b = z
          .object({
            commandID: id,
            threadID: id,
            text,
            sourceRevision: z.number().int().nonnegative(),
            focusEpoch: z.number().int().nonnegative(),
          })
          .parse(body);
        const t = store.enqueue(
          device,
          b.commandID,
          b.threadID,
          b.text,
          b.sourceRevision,
          b.focusEpoch,
        );
        launcher.pump();
        send(201, store.task(t.id));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/answers") {
        const b = z
          .object({
            commandID: id,
            threadID: id,
            taskID: id,
            questionID: id,
            text,
            focusEpoch: z.number().int().nonnegative(),
          })
          .parse(body);
        const task = store.answer(
          device,
          b.commandID,
          b.threadID,
          b.taskID,
          b.questionID,
          b.text,
          b.focusEpoch,
        );
        launcher.pump();
        send(200, store.task(task.id));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/cancel") {
        const b = z.object({ commandID: id, taskID: id }).parse(body);
        send(200, store.cancel(b.commandID, b.taskID));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/voice") {
        const b = z.object({ sdp: z.string().min(10).max(64000) }).parse(body);
        send(201, await live.create(device, b.sdp));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/voice/repeat") {
        const b = z
          .object({ sessionID: id, taskID: id, replyID: z.string() })
          .parse(body);
        live.repeat(device, b.sessionID, b.taskID, b.replyID);
        send(200, { requested: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/voice/end") {
        const b = z.object({ sessionID: id }).parse(body);
        live.close(device, b.sessionID);
        send(202, { status: "closing" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/voice/mute") {
        const b = z.object({ sessionID: id, muted: z.boolean() }).parse(body);
        live.mute(device, b.sessionID, b.muted);
        send(200, { muted: b.muted });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/revoke") {
        auth.revoke(device);
        live.revoke(device);
        send(200, { revoked: true });
        return;
      }
      send(404, { error: "not_found", message: "Endpoint not found" });
    } catch (e) {
      if (e instanceof DomainError)
        send(e.status, { error: e.code, message: e.message });
      else if (e instanceof z.ZodError || e instanceof SyntaxError)
        send(400, {
          error: "invalid_request",
          message: "Request does not match the app protocol",
        });
      else
        send(500, {
          error: "internal_error",
          message:
            "The Mac could not complete this request. Check local diagnostics.",
        });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    store,
    auth,
    launcher,
    live,
    server,
    async start() {
      await launcher.listen();
      await new Promise<void>((r, j) => {
        server.once("error", j);
        server.listen(cfg.port, "127.0.0.1", r);
      });
      const port = (server.address() as import("node:net").AddressInfo).port;
      writeFileSync(
        join(cfg.directory, "pairing.json"),
        JSON.stringify({
          url: process.env.SIDEWALK_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
          code: auth.pairingCode,
          expiresAt: auth.expiresAt,
        }),
        { mode: 0o600 },
      );
      return port;
    },
    async stop() {
      await live.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await launcher.close();
      store.db.close();
    },
  };
}
