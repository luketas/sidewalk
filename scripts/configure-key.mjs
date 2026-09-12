import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  console.error(
    "Run this command in an interactive terminal. The key is entered without echo.",
  );
  process.exit(1);
}
const file = resolve(
  process.env.SIDEWALK_OPENAI_KEY_FILE ?? ".local/secrets/openai-api-key",
);
process.stdout.write("Paste your OpenAI API key (hidden), then press Return: ");
process.stdin.setRawMode(true);
process.stdin.resume();
let value = "";
function finish(code) {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
  process.exitCode = code;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const c of chunk) {
    if (c === "\u0003") {
      finish(1);
      return;
    }
    if (c === "\r" || c === "\n") {
      const key = value.trim();
      if (!key.startsWith("sk-") || /\s/.test(key)) {
        console.error(
          "\nThat does not look like an OpenAI API key. Nothing saved.",
        );
        finish(1);
        return;
      }
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, key, { mode: 0o600 });
        chmodSync(file, 0o600);
        console.log(
          "\nSaved privately on this Mac. Restart the companion to load it.",
        );
        finish(0);
      } catch {
        console.error("\nCould not save the private key file.");
        finish(1);
      }
      return;
    }
    if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
    else if (c >= " ") value += c;
  }
});
