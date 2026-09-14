import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeProfile {
  configDirectory: string;
  identity: string;
}

// Claude uses the literal config path as its Keychain namespace. Preserve the
// bound path after a repo move when a compatibility link reaches the same files.
export function profileDirectory(directory: string, requested: string): string {
  const canonical = realpathSync(requested);
  const binding = join(directory, "claude-profile.json");
  if (existsSync(binding)) {
    const prior = JSON.parse(readFileSync(binding, "utf8")) as ClaudeProfile;
    if (
      existsSync(prior.configDirectory) &&
      realpathSync(prior.configDirectory) === canonical
    )
      return prior.configDirectory;
  }
  return canonical;
}

// The personal profile uses Claude's own login and Keychain namespace. Never
// export credentials or inherit an API token that could select another account.
export function personalEnvironment(
  configDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_CODE_OAUTH") ||
      [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDECODE",
      ].includes(key)
    )
      delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDirectory;
  return env;
}

export function individualIdentity(value: unknown): string {
  const a = value as Record<string, unknown> | null;
  if (
    !a ||
    a.loggedIn !== true ||
    a.authMethod !== "claude.ai" ||
    !["pro", "max"].includes(String(a.subscriptionType).toLowerCase()) ||
    typeof a.email !== "string" ||
    !a.email ||
    typeof a.orgId !== "string" ||
    !a.orgId
  )
    throw Error(
      "Sign in to your individual Claude Pro or Max account with npm run personal -- login. Team, Console and signed-out profiles cannot start personal test sessions.",
    );
  return createHash("sha256")
    .update(JSON.stringify([a.email.toLowerCase(), a.orgId]))
    .digest("hex");
}

export function readIndividualIdentity(
  claude: string,
  configDirectory: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(
      execFileSync(claude, ["auth", "status", "--json"], {
        env: personalEnvironment(configDirectory),
        cwd: configDirectory,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw Error(
      "Personal Claude login is unavailable. Run npm run personal -- login, then retry.",
    );
  }
  return individualIdentity(value);
}

export function bindProfile(directory: string, profile?: ClaudeProfile) {
  const path = join(directory, "claude-profile.json");
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, "utf8")) as ClaudeProfile;
    if (
      !profile ||
      prior.configDirectory !== profile.configDirectory ||
      prior.identity !== profile.identity
    )
      throw Error(
        "This Sidewalk data directory belongs to a different Claude profile. Use its original profile; do not move sessions between accounts.",
      );
  } else if (profile) {
    if (existsSync(join(directory, "journal.sqlite")))
      throw Error(
        "Personal testing requires a fresh Sidewalk data directory. Existing sessions cannot be reassigned to another account.",
      );
    writeFileSync(path, JSON.stringify(profile), { mode: 0o600, flag: "wx" });
  }
}

export function verifyProfile(claude: string, profile: ClaudeProfile) {
  if (
    readIndividualIdentity(claude, profile.configDirectory) !== profile.identity
  )
    throw Error(
      "The personal Claude account changed. Sign back into the original account before starting or reconnecting these sessions.",
    );
}
