import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindProfile,
  individualIdentity,
  personalEnvironment,
  verifyProfile,
} from "../src/account.js";
import { Launcher } from "../src/launcher.js";
import { Store } from "../src/core.js";

const account = {
  loggedIn: true,
  authMethod: "claude.ai",
  subscriptionType: "max",
  email: "test@example.com",
  orgId: "personal-org",
};

test("personal launch removes inherited account overrides without changing the parent environment", () => {
  const source = {
    ANTHROPIC_API_KEY: "team-secret",
    ANTHROPIC_AUTH_TOKEN: "team-token",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "team-oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/team",
    OPENAI_API_KEY: "voice-key",
    PATH: "/bin",
    CLAUDECODE: "1",
  };
  const env = personalEnvironment("/personal", source);
  assert.deepEqual(env, {
    CLAUDE_CONFIG_DIR: "/personal",
    OPENAI_API_KEY: "voice-key",
    PATH: "/bin",
  });
  assert.equal(source.CLAUDE_CONFIG_DIR, "/team");
  for (const value of [
    { ...account, subscriptionType: "team" },
    { ...account, authMethod: "api_key" },
    { ...account, loggedIn: false },
  ])
    assert.throws(() => individualIdentity(value));
});

test("account binding prevents reassignment of a journal or restarting it with default login", () => {
  const directory = mkdtempSync(join(tmpdir(), "sw-profile-"));
  try {
    const profile = {
      configDirectory: "/personal",
      identity: individualIdentity(account),
    };
    bindProfile(directory, profile);
    writeFileSync(join(directory, "journal.sqlite"), "existing session data");
    bindProfile(directory, profile);
    assert.throws(() => bindProfile(directory));
    assert.throws(() =>
      bindProfile(directory, { ...profile, identity: "different-account" }),
    );
    assert.throws(() =>
      bindProfile(directory, { ...profile, configDirectory: "/team" }),
    );
    const saved = readFileSync(join(directory, "claude-profile.json"), "utf8");
    assert.ok(!saved.includes(account.email));
    assert.ok(!saved.includes(account.orgId));
    rmSync(join(directory, "claude-profile.json"));
    assert.throws(() => bindProfile(directory, profile), /fresh/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launcher checks the current individual account before reserving or spawning a session", () => {
  const directory = mkdtempSync(join(tmpdir(), "sw-profile-launch-"));
  const claude = join(directory, "claude-fixture");
  const auth = join(directory, "auth.json");
  const trace = join(directory, "spawned");
  writeFileSync(
    claude,
    `#!${process.execPath}\nconst fs = require('node:fs');\nif(process.argv[2] === 'auth') { process.stdout.write(fs.readFileSync(${JSON.stringify(auth)})); } else { fs.writeFileSync(${JSON.stringify(trace)}, 'unexpected launch'); }\n`,
    { mode: 0o700 },
  );
  const profile = {
    configDirectory: directory,
    identity: individualIdentity(account),
  };
  const store = new Store(join(directory, "journal.sqlite"));
  try {
    writeFileSync(auth, JSON.stringify(account));
    verifyProfile(claude, profile);
    writeFileSync(
      auth,
      JSON.stringify({ ...account, email: "other@example.com" }),
    );
    const launcher = new Launcher(store, {
      port: 0,
      directory,
      socket: join(directory, "bridge.sock"),
      projects: [{ id: "p", name: "Personal", path: directory }],
      claude,
      allowLaunch: true,
      intentModel: "unused",
      claudeProfile: profile,
    });
    const thread = store.createThread("device", "create", "Test", "p", true);
    launcher.launch(thread);
    assert.equal(store.thread(thread.id).status, "blocked");
    assert.match(store.thread(thread.id).detail, /account changed/);
    assert.equal(store.get("process", thread.id), undefined);
    assert.throws(() => readFileSync(trace));
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
