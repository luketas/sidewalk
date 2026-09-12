import { readFileSync } from "node:fs";
import net from "node:net";
const c = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 131072) process.exit(1);
}
const event = JSON.parse(input);
const socket = net.connect(c.socket);
socket.on("connect", () =>
  socket.write(
    JSON.stringify({
      ...c,
      type: "hook",
      sessionID: event.session_id,
      event: event.hook_event_name,
      toolName: event.tool_name,
      toolInput:
        event.hook_event_name === "PermissionRequest"
          ? event.tool_input
          : undefined,
      stopHookActive: event.stop_hook_active === true,
    }) + "\n",
  ),
);
let response = "";
let answered = false;
function fail() {
  if (answered) return;
  if (event.hook_event_name === "PreToolUse") {
    console.error(
      "Sidewalk could not verify whether transcript-only mode is active. Reconnect the Mac bridge before using tools.",
    );
    process.exitCode = 2;
  } else process.exitCode = 1;
}
socket.on("data", (chunk) => {
  response += chunk;
  if (!response.includes("\n")) return;
  try {
    const result = JSON.parse(response.split("\n")[0]!);
    if (!result.ok) throw Error("Hook rejected");
    answered = true;
    if (
      event.hook_event_name === "PermissionRequest" &&
      ["allow", "deny"].includes(result.permissionDecision)
    )
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: result.permissionDecision,
              ...(result.permissionDecision === "deny"
                ? {
                    message:
                      result.permissionMessage ??
                      "The user declined this action in Sidewalk. Do not retry it without new authorization.",
                  }
                : {}),
            },
          },
        }),
      );
    if (event.hook_event_name === "Stop" && result.block)
      console.log(JSON.stringify({ decision: "block", reason: result.block }));
    if (event.hook_event_name === "PreToolUse" && result.deny) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: result.deny,
          },
        }),
      );
    }
  } catch {
    fail();
  }
  socket.end();
});
socket.on("error", fail);
socket.on("close", () => {
  if (!answered) fail();
});
socket.setTimeout(
  event.hook_event_name === "PermissionRequest" ? 125000 : 3000,
  () => {
    socket.destroy();
    fail();
  },
);
