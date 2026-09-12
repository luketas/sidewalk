import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// node-pty 1.1.0's packaged Darwin helper can arrive without its executable bit.
// Repair only this project's installed, pinned helper, never a system binary.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = join(
    root,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
