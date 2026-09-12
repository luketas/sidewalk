import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Store, DomainError } from "./core.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
interface Device {
  id: string;
  name: string;
  tokenHash: string;
  revoked: boolean;
}
export class Auth {
  pairingCode = randomBytes(24).toString("base64url");
  expiresAt = Date.now() + 5 * 60_000;
  used = false;
  constructor(private store: Store) {}
  renewPairing() {
    this.pairingCode = randomBytes(24).toString("base64url");
    this.expiresAt = Date.now() + 5 * 60_000;
    this.used = false;
  }
  pair(code: string, name: string) {
    if (
      this.used ||
      Date.now() > this.expiresAt ||
      !equal(code, this.pairingCode)
    )
      throw new DomainError(
        "invalid_pairing",
        "Pairing code expired or already used",
        401,
      );
    this.used = true;
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: randomBytes(16).toString("hex"),
      name: name.slice(0, 100),
      tokenHash: hash(token),
      revoked: false,
    };
    this.store.put("device", device.id, device);
    return { deviceID: device.id, token };
  }
  verify(header?: string) {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const d = this.store
      .all<Device>("device")
      .find((x) => !x.revoked && equal(x.tokenHash, hash(token)));
    if (!d)
      throw new DomainError(
        "unauthorized",
        "Pair this phone with the Mac",
        401,
      );
    return d.id;
  }
  revoke(id: string) {
    const d = this.store.get<Device>("device", id);
    if (d) {
      d.revoked = true;
      this.store.put("device", id, d);
    }
  }
}
