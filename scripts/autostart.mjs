import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { publicOrigin } from "../dist/bridge/src/remote.js";
const root = resolve(".");
const label = `org.sidewalk.personal.${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
const directory = join(homedir(), "Library/LaunchAgents");
const file = join(directory, label + ".plist");
const domain = `gui/${process.getuid()}`;
const action = process.argv[2];
function launch(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}
function xml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
try {
  if (process.platform !== "darwin")
    throw Error("Automatic login startup requires macOS.");
  if (action === "status") {
    console.log(
      launch("print", `${domain}/${label}`).status === 0
        ? "Sidewalk login service is loaded."
        : "Sidewalk login service is not loaded.",
    );
  } else if (action === "uninstall") {
    launch("bootout", domain, file);
    if (existsSync(file)) unlinkSync(file);
    console.log(
      "Removed Sidewalk login startup. Your login, paired devices and saved work are retained.",
    );
  } else if (action === "install") {
    const url = publicOrigin(process.env.SIDEWALK_REMOTE_URL ?? "");
    if (new URL(url).hostname.endsWith(".trycloudflare.com"))
      throw Error(
        "Use a stable named tunnel for automatic startup, not a temporary testing address.",
      );
    const token = resolve(process.env.SIDEWALK_TUNNEL_TOKEN_FILE ?? "");
    if (!process.env.SIDEWALK_TUNNEL_TOKEN_FILE || !existsSync(token))
      throw Error(
        "Set SIDEWALK_TUNNEL_TOKEN_FILE to your private named-tunnel token file.",
      );
    const port = process.env.SIDEWALK_PERSONAL_PORT ?? "17842";
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      throw Error("ALREADY_RUNNING");
    } catch (error) {
      if (error.message === "ALREADY_RUNNING")
        throw Error(
          "Stop the foreground companion with Ctrl-C before installing login startup.",
        );
    }
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      SIDEWALK_REMOTE_URL: url,
      SIDEWALK_TUNNEL_TOKEN_FILE: token,
      SIDEWALK_PERSONAL_PORT: port,
      SIDEWALK_OPENAI_KEY_FILE: resolve(
        process.env.SIDEWALK_OPENAI_KEY_FILE ?? ".local/secrets/openai-api-key",
      ),
    };
    for (const name of [
      "SIDEWALK_CLAUDE",
      "SIDEWALK_CLOUDFLARED",
      "SIDEWALK_INTENT_MODEL",
    ])
      if (process.env[name]) environment[name] = process.env[name];
    const logs = join(root, ".local/service");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const args = [
      process.execPath,
      join(root, "dist/bridge/src/personal.js"),
      "remote",
    ];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((x) => `<string>${xml(x)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
      .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
      .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
</dict></plist>\n`;
    if (process.argv.includes("--dry-run")) {
      const preview = join(logs, "launch-agent-preview.plist");
      writeFileSync(preview, plist, { mode: 0o600 });
      console.log("Wrote private preview only: " + preview);
    } else {
      mkdirSync(directory, { recursive: true });
      if (existsSync(file)) launch("bootout", domain, file);
      writeFileSync(file, plist, { mode: 0o600 });
      const result = launch("bootstrap", domain, file);
      if (result.status !== 0)
        throw Error(
          "macOS could not load login startup. Check launchctl and System Settings → Login Items.",
        );
      console.log(
        "Sidewalk starts after you log into this Mac. Run npm run pair after its public connection is ready. Logs: .local/service",
      );
    }
  } else
    console.log(
      "Usage: npm run autostart -- install [--dry-run] | status | uninstall\nRequires a stable named tunnel, file-based OpenAI key and an existing personal Claude login.",
    );
} catch (error) {
  console.error(
    error.message === "Invalid URL"
      ? "Set SIDEWALK_REMOTE_URL to your permanent HTTPS hostname."
      : error.message,
  );
  process.exitCode = 1;
}
