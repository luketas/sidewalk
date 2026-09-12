import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin, quickTunnelOrigin, startRemote } from "../src/remote.js";
import { Store } from "../src/core.js";
import { Auth } from "../src/auth.js";

test("remote pairing requires a clean public HTTPS origin", () => {
  assert.equal(
    publicOrigin("https://mac.example.com/"),
    "https://mac.example.com",
  );
  for (const value of [
    "http://mac.example.com",
    "https://localhost",
    "https://10.0.0.1",
    "https://mac.local",
    "https://mac.example.com/path",
    "https://user:secret@mac.example.com",
    "https://mac.example.com?key=x",
    "https://mac.example.com:444",
  ])
    assert.throws(() => publicOrigin(value));
  assert.equal(
    quickTunnelOrigin("Visit https://blue-quiet-cat.trycloudflare.com now"),
    "https://blue-quiet-cat.trycloudflare.com",
  );
  assert.equal(
    quickTunnelOrigin("https://blue.trycloudflare.com.evil.example"),
    undefined,
  );
});
test("a fresh setup code invalidates the old code without unpairing devices", () => {
  const store = new Store();
  try {
    const auth = new Auth(store);
    const original = auth.pairingCode;
    const phone = auth.pair(original, "phone");
    auth.renewPairing();
    assert.throws(() => auth.pair(original, "other"));
    assert.equal(auth.verify("Bearer " + phone.token), phone.deviceID);
    assert.ok(auth.pair(auth.pairingCode, "remote phone").deviceID);
    assert.throws(() => auth.pair(auth.pairingCode, "replay"));
  } finally {
    store.db.close();
  }
});
test(
  "missing internet connector fails promptly without hanging shutdown",
  { timeout: 2000 },
  async () => {
    const previous = process.env.SIDEWALK_CLOUDFLARED;
    const store = new Store();
    try {
      process.env.SIDEWALK_CLOUDFLARED = "/nonexistent/sidewalk-cloudflared";
      await assert.rejects(
        startRemote("/tmp", 12345, new Auth(store)),
        /Install cloudflared/,
      );
    } finally {
      if (previous === undefined) delete process.env.SIDEWALK_CLOUDFLARED;
      else process.env.SIDEWALK_CLOUDFLARED = previous;
      store.db.close();
    }
  },
);
