import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
let failures = 0;
function report(name, ok, remedy) {
  console.log(`${ok ? "OK" : "MISSING"} ${name}${ok ? "" : ` — ${remedy}`}`);
  if (!ok) failures++;
}
report(
  "macOS",
  process.platform === "darwin",
  "The companion uses Claude Code and native macOS tooling.",
);
const [major, minor] = process.versions.node.split(".").map(Number);
report(
  "Node 22.13+",
  major > 22 || (major === 22 && minor >= 13),
  "Install a current Node LTS release.",
);
for (const [binary, args, remedy] of [
  [
    "claude",
    ["--version"],
    "Install Claude Code from code.claude.com/docs/en/setup.",
  ],
  ["cloudflared", ["--version"], "brew install cloudflared"],
  ["swift", ["--version"], "Install/select Xcode 26+ for the iPhone build."],
  ["xcodegen", ["--version"], "brew install xcodegen"],
])
  report(
    binary,
    spawnSync(binary, args, { stdio: "ignore" }).status === 0,
    remedy,
  );
report(
  "compiled companion",
  existsSync("dist/bridge/src/personal.js"),
  "npm run build",
);
report(
  "OpenAI key configured",
  !!process.env.OPENAI_API_KEY ||
    existsSync(
      process.env.SIDEWALK_OPENAI_KEY_FILE ?? ".local/secrets/openai-api-key",
    ),
  "npm run configure-key",
);
console.log(
  "This checks local prerequisites only, not provider access, billing, Channels policy or phone audio.",
);
process.exitCode = failures ? 1 : 0;
