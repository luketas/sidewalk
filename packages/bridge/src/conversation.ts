import type { Store, Task, Answer } from "./core.js";

export interface ConversationMessage {
  seq: number;
  id: string;
  threadID: string;
  role: "user" | "voice" | "claude";
  kind: string;
  text: string;
  at: number;
  sessionID?: string;
  startMS?: number;
  endMS?: number;
  taskID?: string;
}

// The durable transcript is display/context data. Reading it never admits work.
export class ConversationJournal {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversation (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_thread ON conversation(thread_id,seq);`);
  }
  append(message: Omit<ConversationMessage, "seq">) {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO conversation(id,thread_id,body) VALUES (?,?,?)",
      )
      .run(message.id, message.threadID, JSON.stringify(message));
  }
  sync() {
    let cursor =
      this.store.get<{ seq: number }>("conversation_cursor", "events")?.seq ??
      0;
    for (;;) {
      const events = this.store.events(cursor);
      if (!events.length) break;
      for (const e of events) {
        cursor = e.seq;
        const t = e.body as Task;
        if (!t.threadID || !t.id) continue;
        let text: string | undefined;
        let role: ConversationMessage["role"] = "claude";
        if (e.kind === "task.queued") {
          // New voice calls already journal the original input fragments.
          if (
            t.commandID.startsWith("voice:") &&
            this.hasVoiceInput(t.commandID)
          )
            continue;
          text = t.text;
          role = "user";
        } else if (e.kind === "task.answer") {
          const answer =
            t.answerID && this.store.get<Answer>("answer", t.answerID);
          if (!answer || answer.id.startsWith("continuation:")) continue;
          if (answer.id.startsWith("voice:") && this.hasVoiceInput(answer.id))
            continue;
          text = answer.text;
          role = "user";
        } else if (
          [
            "task.result",
            "task.question",
            "task.failure",
            "task.reconciled",
          ].includes(e.kind)
        ) {
          text = t.result;
        }
        if (text)
          this.append({
            id: `event:${e.seq}`,
            threadID: t.threadID,
            role,
            kind: e.kind,
            text,
            at: e.at,
            taskID: t.id,
          });
      }
      this.store.put("conversation_cursor", "events", { seq: cursor });
    }
  }
  private hasVoiceInput(command: string) {
    const sessionID = command.slice(6, command.lastIndexOf(":"));
    return !!this.store.get("conversation_session", sessionID);
  }
  read(threadID: string, after = 0, limit = 200): ConversationMessage[] {
    this.sync();
    return this.store.db
      .prepare(
        "SELECT seq,body FROM conversation WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(threadID, after, limit)
      .map((r) => ({ ...JSON.parse(String(r.body)), seq: Number(r.seq) }));
  }
  context(threadID: string) {
    this.sync();
    return this.store.db
      .prepare(
        "SELECT body FROM conversation WHERE thread_id=? ORDER BY seq DESC LIMIT 30",
      )
      .all(threadID)
      .reverse()
      .map((r) => {
        const m = JSON.parse(String(r.body)) as ConversationMessage;
        return `${m.role}: ${m.text}`;
      })
      .join("\n")
      .slice(-6000);
  }
}
