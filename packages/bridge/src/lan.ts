import https from "node:https";
import http from "node:http";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Auth } from "./auth.js";

export function privateIPv4(host: string) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const p = host.split(".").map(Number);
  if (p.some((n) => n < 0 || n > 255)) return false;
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}

export function lanIdentity(directory: string, host: string) {
  if (!privateIPv4(host))
    throw Error("Same-Wi-Fi pairing requires this Mac's private IPv4 address.");
  const path = join(directory, "lan");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const certPath = join(path, "certificate.pem"),
    keyPath = join(path, "private-key.pem");
  let current: X509Certificate | undefined;
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      current = new X509Certificate(readFileSync(certPath));
    } catch {
      /* regenerate our invalid identity */
    }
  }
  if (
    !current ||
    !current.checkIP(host) ||
    Date.parse(current.validTo) < Date.now() + 86400000
  ) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-noenc",
        "-days",
        "365",
        "-subj",
        "/CN=Sidewalk Mac",
        "-addext",
        `subjectAltName=IP:${host}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyCertSign",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-keyout",
        keyPath + ".new",
        "-out",
        certPath + ".new",
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    chmodSync(keyPath + ".new", 0o600);
    chmodSync(certPath + ".new", 0o600);
    renameSync(keyPath + ".new", keyPath);
    renameSync(certPath + ".new", certPath);
  }
  chmodSync(keyPath, 0o600);
  const cert = readFileSync(certPath),
    key = readFileSync(keyPath);
  const certificateSHA256 = new X509Certificate(cert).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  return { cert, key, certificateSHA256 };
}

export async function startLAN(
  directory: string,
  bridgePort: number,
  auth: Auth,
) {
  const interfaces = networkInterfaces();
  const host =
    process.env.SIDEWALK_LAN_HOST ??
    (interfaces.en0 ?? []).find(
      (a) => a.family === "IPv4" && privateIPv4(a.address),
    )?.address;
  if (
    !host ||
    !Object.values(interfaces)
      .flat()
      .some((a) => a?.address === host)
  )
    throw Error(
      "Connect this Mac to Wi-Fi, or set SIDEWALK_LAN_HOST to its private network address.",
    );
  const identity = lanIdentity(directory, host);
  const port = Number(process.env.SIDEWALK_LAN_PORT ?? 17843);
  const server = https.createServer(
    { key: identity.key, cert: identity.cert, minVersion: "TLSv1.2" },
    (req, res) => {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: bridgePort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const url = `https://${host}:${port}`;
  writeFileSync(
    join(directory, "pairing.json"),
    JSON.stringify({
      url,
      code: auth.pairingCode,
      expiresAt: auth.expiresAt,
      certificateSHA256: identity.certificateSHA256,
    }),
    { mode: 0o600 },
  );
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
