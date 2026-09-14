import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  personalEnvironment,
  readIndividualIdentity,
  bindProfile,
  profileDirectory,
} from "./account.js";

const root = resolve(".local/accounts/personal");
const requestedConfigDirectory = join(root, "claude");
const directory = join(root, "bridge");
const workspace = join(root, "playground");
for (const path of [root, requestedConfigDirectory, directory, workspace])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const configDirectory = profileDirectory(directory, requestedConfigDirectory);
const claude = process.env.SIDEWALK_CLAUDE ?? "claude";
const env: NodeJS.ProcessEnv = {
  ...personalEnvironment(configDirectory),
  SIDEWALK_PERSONAL_MODE: "1",
  SIDEWALK_DATA_DIR: directory,
  SIDEWALK_PORT: process.env.SIDEWALK_PERSONAL_PORT ?? "17842",
};
const action = process.argv[2];
function run(
  executable: string,
  args: string[],
  cwd = workspace,
): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(executable, args, { env, cwd, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", () => {
      console.error("Could not start the requested local process.");
      resolveExit(1);
    });
    child.once("exit", (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      resolveExit(code ?? 1);
    });
  });
}
try {
  switch (action) {
    case "login":
      console.log(
        "Sign in with your individual Claude Pro or Max account. This uses a separate Claude profile from your Team login.",
      );
      const loginArgs = ["auth", "login", "--claudeai"];
      if (process.argv[3] === "--email" && process.argv[4]) {
        loginArgs.push("--email", process.argv[4]);
      } else if (process.argv[3]) {
        throw Error(
          "Usage: npm run personal -- login [--email your-personal-email]",
        );
      }
      process.exitCode = await run(claude, loginArgs);
      if (process.exitCode === 0) {
        const identity = readIndividualIdentity(claude, configDirectory);
        bindProfile(directory, { configDirectory, identity });
        console.log(
          "Individual login verified. Next: npm run personal -- start",
        );
      }
      break;
    case "status":
      readIndividualIdentity(claude, configDirectory);
      console.log(
        "Individual Pro/Max login available. Real Channels delivery still needs a session check.",
      );
      break;
    case "start":
    case "wifi":
    case "remote":
      readIndividualIdentity(claude, configDirectory);
      if (
        (await run(process.execPath, [
          resolve("dist/bridge/src/setup.js"),
          workspace,
        ])) !== 0
      )
        throw Error("Personal playground registration failed.");
      env.SIDEWALK_ALLOW_LAUNCH = "1";
      env.SIDEWALK_LOCAL_DEVELOPMENT = "1";
      if (action === "wifi") env.SIDEWALK_LAN = "1";
      if (action === "remote") {
        env.SIDEWALK_REMOTE = "1";
        for (const key of [
          "SIDEWALK_REMOTE_URL",
          "SIDEWALK_TUNNEL_TOKEN_FILE",
          "SIDEWALK_CLOUDFLARED",
        ])
          if (process.env[key]) env[key] = process.env[key];
      }
      process.exitCode = await run(
        process.execPath,
        [resolve("dist/bridge/src/main.js")],
        process.cwd(),
      );
      break;
    case "terminal":
      if (!process.argv[3])
        throw Error("Usage: npm run personal -- terminal THREAD_UUID");
      process.exitCode = await run(
        process.execPath,
        [resolve("dist/bridge/src/terminal.js"), process.argv[3]],
        process.cwd(),
      );
      break;
    default:
      console.log(
        "Usage: npm run personal -- login|status|start|wifi|remote|terminal THREAD_UUID\nUses a separate Claude login, a blank playground, a separate task journal and port 17842. remote uses cloudflared for cellular and other Wi-Fi networks. wifi adds QR-pinned HTTPS on the Mac's private Wi-Fi address, port 17843. Real Channels, no simulated Claude responses. Your existing bridge stays on port 17841.",
      );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Personal setup failed.",
  );
  process.exitCode = 1;
}
