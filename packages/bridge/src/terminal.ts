import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { config } from "./config.js";
const cfg = config(),
  threadID = process.argv[2];
if (!threadID || !/^[a-f0-9-]{36}$/.test(threadID)) {
  console.error("Usage: npm run terminal -- <thread-id>");
  process.exit(1);
}
const credentials = JSON.parse(
  readFileSync(
    join(cfg.directory, "threads", threadID, "channel.json"),
    "utf8",
  ),
);
if (!process.stdin.isTTY) {
  console.error("Open this command in a real Mac terminal.");
  process.exit(1);
}
const socket = net.connect(credentials.socket);
const send = (m: unknown) =>
  socket.write(JSON.stringify({ ...credentials, ...(m as object) }) + "\n");
socket.on("connect", () => {
  send({ type: "terminal" });
  process.stdin.setRawMode(true);
  process.stdin.resume();
});
process.stdin.on("data", (chunk) => {
  if (chunk.length === 1 && chunk[0] === 29) {
    socket.end();
    return;
  }
  send({ type: "terminal_input", data: chunk.toString() });
});
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const m = JSON.parse(line);
    if (m.type === "terminal_output") process.stdout.write(m.data);
  }
});
function done() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
socket.on("close", done);
socket.on("error", (e) => {
  console.error(e.message);
  done();
});
