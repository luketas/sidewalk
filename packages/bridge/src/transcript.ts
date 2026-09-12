import { randomUUID } from "node:crypto";
import { Store, type Task, type Thread } from "./core.js";

export interface VoiceFragment {
  id: string;
  callID: string;
  device: string;
  threadID: string;
  speaker: "user" | "companion";
  text: string;
  startMS?: number;
  endMS?: number;
  receivedAt: number;
  state: "captured" | "queued" | "attempted" | "delivered" | "unknown";
}
interface VoiceBatch {
  id: string;
  threadID: string;
  epoch: number;
  fragmentIDs: string[];
  acknowledged: boolean;
}

// Transcript delivery is separate from task admission. It never creates work.
export class VoiceJournal {
  constructor(private store: Store) {}
  capture(
    callID: string,
    device: string,
    threadID: string,
    speaker: VoiceFragment["speaker"],
    event: {
      event_id?: string;
      delta: string;
      start_ms?: number;
      end_ms?: number;
    },
  ) {
    this.store.thread(threadID);
    const eventID = event.event_id ?? randomUUID();
    // Preserve exact text, including whitespace, and retain original audio timing.
    for (let offset = 0; offset < event.delta.length; offset += 8000) {
      const id = `${callID}:${eventID}:${offset}`;
      if (this.store.get("voice_fragment", id)) continue;
      const fragment: VoiceFragment = {
        id,
        callID,
        device,
        threadID,
        speaker,
        text: event.delta.slice(offset, offset + 8000),
        startMS: event.start_ms,
        endMS: event.end_ms,
        receivedAt: Date.now(),
        state: "captured",
      };
      this.store.put("voice_fragment", id, fragment);
    }
  }
  flush(callID: string) {
    for (const f of this.store.all<VoiceFragment>("voice_fragment")) {
      if (f.callID === callID && f.state === "captured") {
        f.state = "queued";
        this.store.put("voice_fragment", f.id, f);
      }
    }
  }
  recover() {
    for (const f of this.store.all<VoiceFragment>("voice_fragment")) {
      if (f.state === "captured") f.state = "queued";
      else if (f.state === "attempted") f.state = "unknown";
      else continue;
      this.store.put("voice_fragment", f.id, f);
    }
    this.store.db.prepare("DELETE FROM records WHERE kind='voice_sync'").run();
  }
  claim(thread: Thread) {
    if (thread.status !== "ready" || this.store.get("voice_sync", thread.id))
      return;
    const lease = this.store.get("lease", thread.projectID);
    // Wait until work and its final Stop have finished. Transcripts cannot take
    // over a question turn or cause its Stop hook to release another task.
    if (
      lease ||
      this.store
        .all<Task>("task")
        .some(
          (t) =>
            t.threadID === thread.id &&
            !["completed", "failed", "canceled"].includes(t.status),
        )
    )
      return;
    const fragments: VoiceFragment[] = [];
    let size = 0;
    for (const f of this.store.all<VoiceFragment>("voice_fragment")) {
      if (f.threadID !== thread.id || f.state !== "queued") continue;
      if (size + f.text.length > 16000 || fragments.length >= 200) break;
      fragments.push(f);
      size += f.text.length;
    }
    if (!fragments.length) return;
    const batch: VoiceBatch = {
      id: randomUUID(),
      threadID: thread.id,
      epoch: thread.epoch,
      fragmentIDs: fragments.map((f) => f.id),
      acknowledged: false,
    };
    this.store.atomic(() => {
      this.store.put("voice_sync", thread.id, batch);
      for (const f of fragments) {
        f.state = "attempted";
        this.store.put("voice_fragment", f.id, f);
      }
    });
    return { batch, content: renderTranscript(fragments) };
  }
  acknowledge(threadID: string, epoch: number, batchID: string) {
    const batch = this.store.get<VoiceBatch>("voice_sync", threadID);
    if (!batch || batch.epoch !== epoch || batch.id !== batchID)
      throw Error("Transcript acknowledgment does not match this session");
    this.store.atomic(() => {
      batch.acknowledged = true;
      this.store.put("voice_sync", threadID, batch);
      for (const id of batch.fragmentIDs) {
        const f = this.store.get<VoiceFragment>("voice_fragment", id)!;
        f.state = "delivered";
        this.store.put("voice_fragment", id, f);
      }
    });
  }
  stop(threadID: string) {
    const batch = this.store.get<VoiceBatch>("voice_sync", threadID);
    if (!batch) return false;
    this.release(threadID);
    return true;
  }
  release(threadID: string) {
    const batch = this.store.get<VoiceBatch>("voice_sync", threadID);
    if (!batch) return;
    for (const id of batch.fragmentIDs) {
      const f = this.store.get<VoiceFragment>("voice_fragment", id)!;
      if (f.state === "attempted") {
        f.state = "unknown";
        this.store.put("voice_fragment", id, f);
      }
    }
    this.store.db
      .prepare("DELETE FROM records WHERE kind='voice_sync' AND id=?")
      .run(threadID);
  }
}

export function renderTranscript(fragments: VoiceFragment[]) {
  const groups: {
    callID: string;
    speaker: VoiceFragment["speaker"];
    text: string;
    startMS?: number;
    endMS?: number;
  }[] = [];
  const recent = new Map<string, (typeof groups)[number]>();
  // Each speaker grows independently during overlap. Keep exact words and
  // label start times; a display group is not a semantic turn or playback receipt.
  for (const f of fragments) {
    const key = `${f.callID}:${f.speaker}`;
    const last = recent.get(key);
    const nearby =
      last && f.startMS !== undefined && last.endMS !== undefined
        ? f.startMS >= (last.startMS ?? 0) && f.startMS - last.endMS <= 4000
        : last === groups.at(-1);
    if (last && nearby) {
      last.text += f.text;
      if (f.endMS !== undefined)
        last.endMS = Math.max(last.endMS ?? 0, f.endMS);
    } else {
      const group = {
        callID: f.callID,
        speaker: f.speaker,
        text: f.text,
        startMS: f.startMS,
        endMS: f.endMS,
      };
      groups.push(group);
      recent.set(key, group);
    }
  }
  return (
    "Voice conversation\n\n" +
    groups
      .map(
        (g) =>
          `${g.speaker === "user" ? "You (voice)" : "Sidewalk (voice assistant)"}:\n${g.text}`,
      )
      .join("\n\n")
  );
}
