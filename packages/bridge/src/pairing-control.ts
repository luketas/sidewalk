import { readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { Auth } from "./auth.js";

// Owner-only local mailbox, deliberately not an HTTP endpoint. Remote callers
// cannot mint onboarding credentials. Poll as well: filesystem notifications
// may be coalesced or missed around watcher startup on macOS.
export function pairingControl(directory: string, auth: Auth) {
  const requestPath = join(directory, "pairing-request.json");
  const readRequest = () => {
    try {
      return JSON.parse(readFileSync(requestPath, "utf8")).id;
    } catch {
      return undefined;
    }
  };
  // Do not replay an old renewal request when the companion restarts.
  let handled: unknown = readRequest();
  const renew = () => {
    try {
      const id = readRequest();
      if (
        typeof id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(id) ||
        id === handled
      )
        return;
      const path = join(directory, "pairing.json");
      const previous = JSON.parse(readFileSync(path, "utf8"));
      if (previous.requestID !== id) {
        auth.renewPairing();
        writeFileSync(
          path,
          JSON.stringify({
            ...previous,
            code: auth.pairingCode,
            expiresAt: auth.expiresAt,
            requestID: id,
          }),
          { mode: 0o600 },
        );
      }
      handled = id;
    } catch {
      /* Retry a partial local write; invalid input never renews. */
    }
  };
  const watcher = watch(directory, (_event, filename) => {
    if (filename === "pairing-request.json") renew();
  });
  const fallback = setInterval(renew, 500);
  fallback.unref();
  return {
    close() {
      watcher.close();
      clearInterval(fallback);
    },
  };
}
