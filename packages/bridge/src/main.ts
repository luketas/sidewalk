import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { createBridge } from "./server.js";
import { openAIKey } from "./secrets.js";
import { startLAN } from "./lan.js";
import { startRemote } from "./remote.js";
import { pairingControl } from "./pairing-control.js";
const cfg = config();
const key = openAIKey();
const bridge = createBridge(cfg, () => key);
const port = await bridge.start();
let lan: Awaited<ReturnType<typeof startLAN>> | undefined;
let remote: Awaited<ReturnType<typeof startRemote>> | undefined;
try {
  if (process.env.SIDEWALK_LAN === "1")
    lan = await startLAN(cfg.directory, port, bridge.auth);
  if (process.env.SIDEWALK_REMOTE === "1")
    remote = await startRemote(cfg.directory, port, bridge.auth);
} catch (error) {
  await lan?.close();
  await bridge.stop();
  throw error;
}
console.log(
  `Sidewalk bridge: http://127.0.0.1:${port}\nPairing payload saved privately to ${cfg.directory}/pairing.json\nVoice key: ${key ? "available" : "not configured"}\nClaude launch: ${cfg.allowLaunch ? "enabled" : "setup required"}`,
);
if (remote)
  console.log(
    `Internet connection: ${remote.url}. Works over cellular and other Wi-Fi networks. ${remote.temporary ? "Test address: keep this companion running; restarting creates a new address." : "Persistent named tunnel."}`,
  );
if (lan)
  console.log(
    `Same-Wi-Fi connection: ${lan.url}. Scan this Mac's QR in Sidewalk.`,
  );
// Refresh only the short-lived onboarding code; existing devices remain paired.
process.on("SIGUSR1", () => {
  bridge.auth.renewPairing();
  const path = join(cfg.directory, "pairing.json");
  const previous = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    JSON.stringify({
      ...previous,
      code: bridge.auth.pairingCode,
      expiresAt: bridge.auth.expiresAt,
    }),
    { mode: 0o600 },
  );
});
const pairingWatcher = pairingControl(cfg.directory, bridge.auth);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    pairingWatcher.close();
    void (async () => {
      await lan?.close();
      await remote?.close();
      await bridge.stop();
      process.exit(0);
    })();
  });
