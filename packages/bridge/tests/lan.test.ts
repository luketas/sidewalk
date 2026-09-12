import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { lanIdentity, privateIPv4 } from "../src/lan.js";

test("LAN identity persists for the same Mac address and never accepts public bind addresses", () => {
  const directory = mkdtempSync(join(tmpdir(), "sw-lan-"));
  try {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "8.8.8.8",
      "172.32.0.1",
      "10.0.0.999",
      "bad.10.0.0.1",
    ])
      assert.equal(privateIPv4(host), false);
    assert.throws(() => lanIdentity(directory, "8.8.8.8"));
    const first = lanIdentity(directory, "10.23.45.67");
    const second = lanIdentity(directory, "10.23.45.67");
    assert.equal(first.certificateSHA256, second.certificateSHA256);
    assert.equal(
      new X509Certificate(first.cert).checkIP("10.23.45.67"),
      "10.23.45.67",
    );
    assert.equal(
      new X509Certificate(first.cert).checkIP("10.23.45.68"),
      undefined,
    );
    assert.equal(
      statSync(join(directory, "lan", "private-key.pem")).mode & 0o777,
      0o600,
    );
    assert.match(first.certificateSHA256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
