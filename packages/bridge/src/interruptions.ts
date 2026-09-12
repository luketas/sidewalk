import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.js";
import { Store, type Task } from "./core.js";
export function interruptedAfter(
  text: string,
  sessionID: string,
  since: number,
) {
  return text.split("\n").some((line) => {
    try {
      const e = JSON.parse(line);
      return (
        e.type === "user" &&
        e.sessionId === sessionID &&
        !e.isSidechain &&
        typeof e.interruptedMessageId === "string" &&
        Date.parse(e.timestamp) >= since &&
        e.message?.content?.some(
          (c: any) =>
            c.type === "text" && c.text === "[Request interrupted by user]",
        )
      );
    } catch {
      return false;
    }
  });
}
export class Interruptions {
  constructor(
    private store: Store,
    private cfg: Config,
  ) {}
  refresh() {
    for (const task of this.store.all<Task>("task")) {
      if (!["delivered", "working"].includes(task.status)) continue;
      const thread = this.store.thread(task.threadID);
      const project = this.cfg.projects.find((p) => p.id === thread.projectID);
      if (!project) continue;
      const path = join(
        this.cfg.claudeProfile?.configDirectory ?? join(homedir(), ".claude"),
        "projects",
        project.path.replace(/[^a-zA-Z0-9]/g, "-"),
        thread.sessionID + ".jsonl",
      );
      try {
        const size = statSync(path).size,
          length = Math.min(size, 256000),
          buffer = Buffer.alloc(length);
        const fd = openSync(path, "r");
        try {
          readSync(fd, buffer, 0, length, size - length);
        } finally {
          closeSync(fd);
        }
        if (
          !interruptedAfter(
            buffer.toString("utf8"),
            thread.sessionID,
            task.deliveredAt ?? task.createdAt,
          )
        )
          continue;
        this.store.atomic(() => {
          task.status = "unknown";
          task.permissionRequired = undefined;
          task.result =
            "Claude was interrupted on the Mac. Checking the outcome before continuing.";
          this.store.put("task", task.id, task);
          this.store.event("task.interrupted", task);
        });
      } catch {
        /* Native metadata unavailable: do not guess that work stopped. */
      }
    }
  }
}
