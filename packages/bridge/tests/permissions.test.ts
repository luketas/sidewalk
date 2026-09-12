import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { Permissions, type Permission } from "../src/permissions.js";
import { Store } from "../src/core.js";
class Connection extends EventEmitter {
  output = "";
  setTimeout() {}
  end(data: string) {
    this.output += data;
  }
}
function setup() {
  const store = new Store();
  const thread = store.createThread("phone", "new", "Voice", "project", true);
  store.register(thread.id, thread.sessionID, thread.epoch);
  const task = store.enqueue(
    "phone",
    "work",
    thread.id,
    "Read the README",
    1,
    store.focus("phone").epoch,
  );
  store.claimNext();
  const permissions = new Permissions(store);
  const socket = new Connection();
  permissions.open(
    thread,
    task,
    "Read",
    { file_path: "/project/README.md" },
    socket as unknown as Socket,
  );
  const permission = store.all<Permission>("permission")[0]!;
  return { store, thread, task, permissions, socket, permission };
}
test("phone approval grants only the captured action once and is idempotent", () => {
  const f = setup();
  try {
    const epoch = f.store.focus("phone").epoch;
    const result = f.permissions.decide(
      "phone",
      "yes",
      f.permission.id,
      "allow",
      epoch,
    );
    assert.equal(result.state, "allow");
    assert.deepEqual(JSON.parse(f.socket.output), {
      ok: true,
      permissionDecision: "allow",
    });
    assert.ok(!f.socket.output.includes("updatedPermissions"));
    f.permissions.decide("phone", "yes", f.permission.id, "allow", epoch);
    assert.throws(
      () =>
        f.permissions.decide("phone", "again", f.permission.id, "allow", epoch),
      /no longer pending/,
    );
    assert.throws(
      () =>
        f.permissions.decide("phone", "yes", f.permission.id, "deny", epoch),
      /different content/,
    );
  } finally {
    f.permissions.close();
    f.store.db.close();
  }
});
test("focus changes, unknown work, expired requests and dead hooks cannot approve", () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.permissions.decide("phone", "stale", f.permission.id, "allow", 999),
      /conversation or request changed/,
    );
    const task = f.store.task(f.task.id);
    task.status = "unknown";
    f.store.put("task", task.id, task);
    assert.throws(
      () =>
        f.permissions.decide(
          "phone",
          "unknown",
          f.permission.id,
          "allow",
          f.store.focus("phone").epoch,
        ),
      /changed/,
    );
    f.socket.emit("close");
    assert.equal(
      f.store.get<Permission>("permission", f.permission.id)?.state,
      "expired",
    );
    assert.throws(
      () =>
        f.permissions.decide(
          "phone",
          "closed",
          f.permission.id,
          "allow",
          f.store.focus("phone").epoch,
        ),
      /no longer pending/,
    );
    assert.equal(JSON.parse(f.socket.output).permissionDecision, "deny");
    assert.match(
      JSON.parse(f.socket.output).permissionMessage,
      /not a user denial/,
    );
  } finally {
    f.permissions.close();
    f.store.db.close();
  }
});
test("denial and bridge shutdown never persist blanket permission", () => {
  const f = setup();
  try {
    f.permissions.decide(
      "phone",
      "no",
      f.permission.id,
      "deny",
      f.store.focus("phone").epoch,
    );
    assert.equal(JSON.parse(f.socket.output).permissionDecision, "deny");
    const next = new Connection();
    f.permissions.open(
      f.thread,
      f.task,
      "Bash",
      { command: "cat README.md" },
      next as unknown as Socket,
    );
    f.permissions.close();
    assert.equal(JSON.parse(next.output).permissionDecision, "deny");
    assert.ok(
      f.store.all<Permission>("permission").every((p) => p.state !== "pending"),
    );
  } finally {
    f.permissions.close();
    f.store.db.close();
  }
});

test("approval expiry unblocks Claude with an explicit denial instead of an invisible native wait", () => {
  const f = setup();
  try {
    const task = f.store.task(f.task.id);
    task.permissionRequired = "Read";
    f.store.put("task", task.id, task);
    f.permissions.expire(f.permission.id);
    assert.equal(JSON.parse(f.socket.output).permissionDecision, "deny");
    assert.equal(f.store.task(task.id).permissionRequired, undefined);
    assert.match(f.store.task(task.id).activity!, /Approval expired/);
    const result = f.store.report(
      f.thread.id,
      f.thread.epoch,
      task.id,
      "result",
      "I could not read that file without approval.",
      "expired-result",
    );
    assert.equal(result.status, "completed");
    f.store.observeStop(f.thread.id);
    assert.equal(f.store.all("lease").length, 0);
  } finally {
    f.permissions.close();
    f.store.db.close();
  }
});
