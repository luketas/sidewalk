import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Store, type Thread } from "./core.js";
import type { Config } from "./config.js";

// Read title metadata only from the selected account's known session file.
// Claude owns these records; Sidewalk never writes or generates their titles.
export function titleFromMetadata(text: string, sessionID: string) {
  let custom: string | undefined, generated: string | undefined;
  for (const line of text.split("\n")) {
    try {
      const item = JSON.parse(line);
      if (item.sessionId !== sessionID) continue;
      if (item.type === "custom-title" && typeof item.customTitle === "string")
        custom = item.customTitle;
      if (item.type === "ai-title" && typeof item.aiTitle === "string")
        generated = item.aiTitle;
    } catch {
      /* A trailing partial record is retried on the next read. */
    }
  }
  const title = (custom ?? generated)?.trim();
  return title && title.length <= 100 && !/[\x00-\x1f]/.test(title)
    ? title
    : undefined;
}
export class SessionTitles {
  private versions = new Map<string, string>();
  constructor(
    private store: Store,
    private cfg: Config,
  ) {}
  refresh() {
    const root =
      this.cfg.claudeProfile?.configDirectory ?? join(homedir(), ".claude");
    for (const thread of this.store.all<Thread>("thread")) {
      const project = this.cfg.projects.find((p) => p.id === thread.projectID);
      if (!project) continue;
      const path = join(
        root,
        "projects",
        project.path.replace(/[^a-zA-Z0-9]/g, "-"),
        thread.sessionID + ".jsonl",
      );
      try {
        if (!existsSync(path)) continue;
        const stat = statSync(path);
        const version = `${stat.size}:${stat.mtimeMs}`;
        if (this.versions.get(thread.id) === version) continue;
        // Metadata is appended at the tail; never scan a session's entire history.
        const length = Math.min(stat.size, 256000);
        const buffer = Buffer.alloc(length);
        const fd = openSync(path, "r");
        try {
          readSync(fd, buffer, 0, length, stat.size - length);
        } finally {
          closeSync(fd);
        }
        this.versions.set(thread.id, version);
        const title = titleFromMetadata(
          buffer.toString("utf8"),
          thread.sessionID,
        );
        if (title && title !== thread.name)
          this.store.atomic(() => {
            thread.name = title;
            this.store.put("thread", thread.id, thread);
            this.store.event("thread.renamed", { id: thread.id, name: title });
          });
      } catch {
        /* Keep the current title if Claude is rotating or writing its file. */
      }
    }
  }
}
