import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Keep the local key out of command arguments, terminal output and Claude's
// environment. An explicit process key takes precedence over the private file.
export function openAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const path = resolve(
    process.env.SIDEWALK_OPENAI_KEY_FILE ?? ".local/secrets/openai-api-key",
  );
  if (!existsSync(path)) return undefined;
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw Error(
      "The local OpenAI key file must be readable only by its owner (chmod 600).",
    );
  const key = readFileSync(path, "utf8").trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key))
    throw Error(
      "The local OpenAI key file does not contain a recognizable API key.",
    );
  return key;
}
