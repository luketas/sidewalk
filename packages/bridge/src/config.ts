import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import {
  bindProfile,
  readIndividualIdentity,
  type ClaudeProfile,
} from "./account.js";
export interface Config {
  port: number;
  directory: string;
  socket: string;
  projects: { id: string; name: string; path: string }[];
  claude: string;
  allowLaunch: boolean;
  intentModel: string;
  claudeProfile?: ClaudeProfile;
  acknowledgeLocalDevelopmentNotice?: boolean;
}
export function config(): Config {
  const directory = resolve(process.env.SIDEWALK_DATA_DIR ?? ".local");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const claude = process.env.SIDEWALK_CLAUDE ?? "claude";
  let claudeProfile: ClaudeProfile | undefined;
  if (process.env.SIDEWALK_PERSONAL_MODE === "1") {
    if (!process.env.CLAUDE_CONFIG_DIR || !process.env.SIDEWALK_DATA_DIR)
      throw Error(
        "Use npm run personal -- start to select the isolated personal profile.",
      );
    const configDirectory = realpathSync(process.env.CLAUDE_CONFIG_DIR);
    claudeProfile = {
      configDirectory,
      identity: readIndividualIdentity(claude, configDirectory),
    };
  }
  bindProfile(directory, claudeProfile);
  const projectFile = join(directory, "projects.json");
  const projectData = existsSync(projectFile)
    ? JSON.parse(readFileSync(projectFile, "utf8"))
    : [];
  const paths = new Set<string>();
  const projects = projectData.map(
    (p: { id: string; name: string; path: string }) => {
      const path = realpathSync(p.path);
      if (paths.has(path)) throw Error("Duplicate project workspace");
      paths.add(path);
      return { ...p, path };
    },
  );
  const socketDir = join(
    tmpdir(),
    "sidewalk-" +
      createHash("sha256").update(directory).digest("hex").slice(0, 12),
  );
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  return {
    directory,
    port: Number(process.env.SIDEWALK_PORT ?? 17841),
    socket: join(socketDir, "bridge.sock"),
    projects,
    claude,
    claudeProfile,
    acknowledgeLocalDevelopmentNotice:
      process.env.SIDEWALK_LOCAL_DEVELOPMENT === "1",
    allowLaunch: process.env.SIDEWALK_ALLOW_LAUNCH === "1",
    intentModel: process.env.SIDEWALK_INTENT_MODEL ?? "gpt-5.6-luna",
  };
}
export function fileSecret(path: string) {
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(path, "utf8").trim();
}
