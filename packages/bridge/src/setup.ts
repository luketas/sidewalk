import {
  mkdirSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
const directory = resolve(process.env.SIDEWALK_DATA_DIR ?? ".local");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const project = process.argv[2];
if (!project) {
  console.log(
    "Usage: npm run setup -- /absolute/path/to/project\nRegisters one local project. Does not start Claude or change its settings.",
  );
  process.exit(0);
}
const path = realpathSync(project);
const file = join(directory, "projects.json");
const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
if (!prior.some((p: { path: string }) => p.path === path)) {
  prior.push({ id: basename(path), name: basename(path), path });
  writeFileSync(file, JSON.stringify(prior, null, 2), { mode: 0o600 });
}
console.log(
  "Project registered. Start the bridge, then use its private pairing.json payload in the iPhone app.",
);
