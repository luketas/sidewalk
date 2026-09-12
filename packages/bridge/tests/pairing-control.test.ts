import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core.js";
import { Auth } from "../src/auth.js";
import { pairingControl } from "../src/pairing-control.js";

test("local QR renewal preserves the public address and already-paired credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sw-local-pair-"));
  const store = new Store(join(directory, "journal.sqlite"));
  const auth = new Auth(store);
  const device = auth.pair(auth.pairingCode, "Phone");
  const old = auth.pairingCode;
  const path = join(directory, "pairing.json");
  writeFileSync(
    path,
    JSON.stringify({
      url: "https://mac.example.com",
      code: old,
      expiresAt: auth.expiresAt,
    }),
  );
  const watcher = pairingControl(directory, auth);
  try {
    const id = randomUUID();
    writeFileSync(join(directory, "request.tmp"), JSON.stringify({ id }));
    renameSync(
      join(directory, "request.tmp"),
      join(directory, "pairing-request.json"),
    );
    const deadline = Date.now() + 2000;
    while (auth.pairingCode === old && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const result = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(result.requestID, id);
    assert.equal(result.url, "https://mac.example.com");
    assert.notEqual(result.code, old);
    assert.equal(auth.verify("Bearer " + device.token), device.deviceID);
    assert.throws(() => auth.pair(old, "old"));
    assert.ok(auth.pair(result.code, "New phone").token);
    assert.throws(() => auth.pair(result.code, "Duplicate"));
  } finally {
    watcher.close();
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
