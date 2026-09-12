import { createHash } from "node:crypto";
import { DomainError, type Task } from "./core.js";
export function spokenText(task: Task) {
  return (task.speech || task.result)
    .replace(/```[\s\S]*?```/g, " Code is available in the conversation. ")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_`>|]/g, "")
    .trim()
    .slice(0, 4000);
}
export class Speech {
  private cache = new Map<string, Promise<Buffer>>();
  async audio(task: Task, key: string | undefined) {
    if (
      !["completed", "failed", "question"].includes(task.status) &&
      !(
        task.status === "working" &&
        ["accepted", "progress"].includes(task.replyKind ?? "") &&
        task.replyID
      )
    )
      throw new DomainError("reply_pending", "Claude has not replied yet", 409);
    if (!key)
      throw new DomainError(
        "voice_key_missing",
        "Set up voice on the Mac",
        503,
      );
    const input = spokenText(task);
    if (!input)
      throw new DomainError("reply_empty", "No spoken reply is available", 409);
    const id = createHash("sha256")
      .update(task.id + input)
      .digest("hex");
    let audio = this.cache.get(id);
    if (!audio) {
      audio = (async () => {
        const r = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: "marin",
            input,
            response_format: "mp3",
            instructions:
              "Read the supplied text faithfully in a warm, natural conversational voice. Do not add acknowledgments, introductions, or extra content.",
          }),
        });
        if (!r.ok)
          throw new DomainError(
            "speech_unavailable",
            "Could not read Claude's reply aloud. The text is still available.",
            502,
          );
        return Buffer.from(await r.arrayBuffer());
      })();
      this.cache.set(id, audio);
      if (this.cache.size > 16)
        this.cache.delete(this.cache.keys().next().value!);
      audio.catch(() => this.cache.delete(id));
    }
    return audio;
  }
}
