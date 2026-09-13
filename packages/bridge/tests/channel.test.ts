import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

test(
  "real channel subprocess emits answers separately and suppresses duplicate delivery IDs",
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-ch-"));
    const path = join(dir, "bridge.sock");
    const credentials = join(dir, "credentials.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        socket: path,
        token: "test-only",
        threadID: "thread-a",
      }),
    );
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    let bridgeSocket: net.Socket | undefined;
    const reports: Record<string, string>[] = [];
    const connected = new Promise<net.Socket>((resolve) =>
      server.once("connection", (socket) => {
        bridgeSocket = socket;
        let buffer = "";
        socket.on("data", (data) => {
          buffer += data.toString();
          let i;
          while ((i = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            if (message.type === "register") resolve(socket);
            if (
              ["report", "recovery_report", "transcript_ack"].includes(
                message.type,
              )
            ) {
              reports.push(message);
              socket.write(
                JSON.stringify(
                  message.text === "reject this report"
                    ? {
                        type: "error",
                        eventID: message.eventID,
                        message: "stale recovery",
                      }
                    : { type: "ack", eventID: message.eventID },
                ) + "\n",
              );
            }
          }
        });
      }),
    );
    const client = new Client({ name: "protocol-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../../channel/src/main.ts", import.meta.url)),
        credentials,
      ],
      stderr: "pipe",
    });
    const messages: { content: string; meta: Record<string, string> }[] = [];
    let delivered!: () => void;
    const complete = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({ content: z.string(), meta: z.record(z.string()) }),
      }),
      (notification) => {
        messages.push(notification.params);
        if (notification.params.meta.request_id === "end-marker") delivered();
      },
    );
    try {
      await client.connect(transport);
      const socket = await connected;
      const task = { id: "request-a", text: "Inspect login" };
      const request = { type: "request", task };
      const answer = {
        type: "request",
        task,
        answer: { id: "answer-a", text: "login.ts", questionID: "question-a" },
      };
      const recovery = {
        type: "recovery",
        task: { id: "unknown-request", text: "Earlier work", result: "" },
        recovery: { id: "recovery-a", nonce: "bound-nonce" },
      };
      const transcript = {
        type: "transcript",
        batch: { id: "voice-batch" },
        content:
          "Voice conversation · transcript copy\n\nYou (voice):\nJust discussing the idea.\n\nSidewalk (voice assistant):\nTell me more.",
      };
      socket.write(
        [
          request,
          request,
          answer,
          answer,
          recovery,
          recovery,
          transcript,
          transcript,
          { type: "probe", task: { id: "end-marker", text: "marker" } },
        ]
          .map((m) => JSON.stringify(m) + "\n")
          .join(""),
      );
      await complete;
      assert.equal(messages.length, 5);
      assert.equal(messages[0]!.content, "Inspect login");
      assert.deepEqual(messages[1], {
        content: "login.ts",
        meta: {
          request_id: "request-a",
          thread_id: "thread-a",
          kind: "answer",
          question_id: "question-a",
          answer_id: "answer-a",
        },
      });
      assert.equal(messages[2]!.meta.kind, "recovery");
      assert.match(messages[2]!.content, /Do not repeat or continue work/);
      assert.equal(messages[3]!.meta.kind, "voice_transcript");
      assert.equal(messages[3]!.content, transcript.content);
      assert.equal(messages[3]!.meta.request_id, undefined);
      await assert.rejects(
        () =>
          client.callTool({
            name: "reply",
            arguments: {
              request_id: "voice-batch",
              kind: "result",
              text: "No duplicate task result",
            },
          }),
        /not delivered/,
      );
      await assert.rejects(
        () =>
          client.callTool({
            name: "acknowledge_transcript",
            arguments: { batch_id: "unknown" },
          }),
        /not delivered/,
      );
      await assert.rejects(
        () =>
          client.callTool({
            name: "reply",
            arguments: {
              request_id: "unknown-request",
              kind: "result",
              text: "Cannot bypass recovery",
            },
          }),
        /not delivered/,
      );
      const report = {
        request_id: "unknown-request",
        recovery_id: "recovery-a",
        nonce: "bound-nonce",
        outcome: "question",
        text: "Which file?",
      };
      await assert.rejects(
        () =>
          client.callTool({
            name: "reconcile",
            arguments: { ...report, nonce: "wrong" },
          }),
        /not delivered/,
      );
      assert.equal(reports.length, 0);
      await client.callTool({ name: "reconcile", arguments: report });
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.type, "recovery_report");
      assert.equal(reports[0]!.recoveryID, "recovery-a");
      await assert.rejects(
        () =>
          client.callTool({
            name: "reconcile",
            arguments: { ...report, text: "reject this report" },
          }),
        /stale recovery/,
      );
      await client.callTool({
        name: "acknowledge_transcript",
        arguments: { batch_id: "voice-batch" },
      });
      assert.equal(reports.at(-1)!.type, "transcript_ack");
      assert.equal(reports.at(-1)!.batchID, "voice-batch");
      const tools = await client.listTools();
      assert.ok(
        tools.tools.find((t) => t.name === "reply")?.inputSchema.properties
          ?.thread_title,
      );
      await client.callTool({
        name: "reply",
        arguments: {
          request_id: "request-a",
          kind: "result",
          text: "Found the login issue",
          thread_title: "Login investigation",
        },
      });
      assert.equal(reports.at(-1)!.type, "report");
      assert.equal(reports.at(-1)!.threadTitle, "Login investigation");
      assert.equal(reports.at(-1)!.threadID, "thread-a");
      await client.callTool({
        name: "reply",
        arguments: {
          request_id: "request-a",
          kind: "result",
          text: "The answer still arrives",
          thread_title: "x".repeat(101),
        },
      });
      assert.equal(reports.at(-1)!.text, "The answer still arrives");
      assert.equal(reports.at(-1)!.threadTitle, undefined);
    } finally {
      await client.close();
      bridgeSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true });
    }
  },
);
