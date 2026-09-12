import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const directory = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    ".local/accounts/personal/bridge",
);
const payload = join(directory, "pairing.json");
try {
  if (!existsSync(payload))
    throw Error("Start the companion first: npm run personal -- remote");
  const id = randomUUID();
  const pending = join(directory, `pairing-request-${id}.tmp`);
  writeFileSync(pending, JSON.stringify({ id }), { mode: 0o600, flag: "wx" });
  renameSync(pending, join(directory, "pairing-request.json"));
  const deadline = Date.now() + 8000;
  let renewed = false;
  while (Date.now() < deadline) {
    try {
      renewed = JSON.parse(readFileSync(payload, "utf8")).requestID === id;
    } catch {}
    if (renewed) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!renewed)
    throw Error(
      "The companion did not respond. Start the current build and retry; no server restart is needed for QR renewal.",
    );
  const output = join(directory, "pairing.png");
  const generated = spawnSync(
    "swift",
    ["scripts/pairing-qr.swift", payload, output],
    { stdio: "inherit" },
  );
  if (generated.status !== 0)
    throw Error("QR generation failed. Check Xcode command-line tools.");
  if (!process.argv.includes("--no-open"))
    spawnSync("open", [output], { stdio: "ignore" });
  console.log(
    "Scan in Sidewalk → Settings → Update connection. Setup code lasts five minutes; paired phones stay paired.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
