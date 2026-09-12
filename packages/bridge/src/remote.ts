import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve4 } from "node:dns/promises";
import type { Auth } from "./auth.js";

export function publicOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) ||
    !url.hostname.includes(".") ||
    /^\d+(\.\d+){3}$/.test(url.hostname) ||
    /\.(localhost|local|internal)$/i.test(url.hostname)
  )
    throw Error(
      "Remote pairing needs a public HTTPS hostname, without a path or credentials.",
    );
  return url.origin;
}
export function quickTunnelOrigin(output: string) {
  const match = output.match(
    /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/]|$)/i,
  );
  return match ? publicOrigin(match[0]) : undefined;
}

// Only the authenticated HTTP bridge is exposed. Claude IPC remains a private
// Unix socket, and microphone media continues directly to OpenAI.
export async function startRemote(directory: string, port: number, auth: Auth) {
  const configuredURL = process.env.SIDEWALK_REMOTE_URL;
  const tokenFile = process.env.SIDEWALK_TUNNEL_TOKEN_FILE;
  if (!!tokenFile !== !!configuredURL)
    throw Error(
      "Set both SIDEWALK_REMOTE_URL and SIDEWALK_TUNNEL_TOKEN_FILE for a named tunnel.",
    );
  const fixed = configuredURL ? publicOrigin(configuredURL) : undefined;
  const child = spawn(
    process.env.SIDEWALK_CLOUDFLARED ?? "cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      ...(tokenFile
        ? ["run", "--token-file", tokenFile]
        : ["--url", `http://127.0.0.1:${port}`]),
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
    },
  );
  let buffer = "";
  let dead = false;
  child.once("exit", () => {
    dead = true;
  });
  const close = async () => {
    if (dead || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            Error(
              "Internet connection did not become ready. Check cloudflared and your network.",
            ),
          ),
        45000,
      );
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve(value!);
      };
      child.once("error", () =>
        finish(
          Error(
            "Install cloudflared on the Mac to enable internet connections: brew install cloudflared",
          ),
        ),
      );
      child.once("exit", () =>
        finish(Error("The internet connector stopped before it was ready.")),
      );
      child.stderr.on("data", (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-16000);
        const origin = fixed ?? quickTunnelOrigin(buffer);
        if (origin && /Registered tunnel connection/.test(buffer))
          finish(undefined, origin);
      });
    });
    // Cloudflare can register the connector before the new hostname reaches DNS.
    // Do not issue a phone code until a normal public HTTPS request succeeds.
    console.log(`Checking internet connection: ${url}`);
    let reachable = false;
    let failure = "not reachable";
    const deadline = Date.now() + 45000;
    while (!dead && Date.now() < deadline) {
      try {
        await resolve4(new URL(url).hostname);
        const result = await fetch(url + "/health", {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          cache: "no-store",
        });
        reachable =
          result.ok && !!((await result.json()) as { ok?: boolean }).ok;
        failure = `HTTP ${result.status}`;
        if (reachable) break;
      } catch (error) {
        failure =
          (error as { cause?: { code?: string }; code?: string }).cause?.code ??
          (error as { code?: string }).code ??
          "public HTTPS failed";
        /* Retry DNS propagation and initial tunnel registration. */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!reachable)
      throw Error(
        `The internet address did not reach Sidewalk (${failure}). Check DNS and the tunnel's origin configuration.`,
      );
    // Issue the setup code only after the tunnel is reachable.
    auth.renewPairing();
    const payload = { url, code: auth.pairingCode, expiresAt: auth.expiresAt };
    const path = join(directory, "pairing.json");
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
    chmodSync(path, 0o600);
    writeFileSync(
      join(directory, "remote.json"),
      JSON.stringify({ url, temporary: !tokenFile }),
      { mode: 0o600 },
    );
    child.once("exit", () =>
      console.error(
        "Internet connection stopped. Restart the companion to reconnect; saved Claude work is unchanged.",
      ),
    );
    return { url, temporary: !tokenFile, close };
  } catch (error) {
    await close();
    throw error;
  }
}
