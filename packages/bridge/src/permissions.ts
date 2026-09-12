import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Store, DomainError, type Task, type Thread } from "./core.js";
export interface Permission {
  id: string;
  threadID: string;
  taskID: string;
  epoch: number;
  tool: string;
  input: string;
  state: "pending" | "allow" | "deny" | "expired";
  expiresAt: number;
}
export class Permissions {
  private pending = new Map<
    string,
    { socket: Socket; timer: NodeJS.Timeout }
  >();
  constructor(private store: Store) {
    for (const p of store.all<Permission>("permission"))
      if (p.state === "pending") {
        p.state = "expired";
        store.put("permission", p.id, p);
      }
  }
  open(
    thread: Thread,
    task: Task,
    tool: string,
    input: unknown,
    socket: Socket,
  ) {
    const detail = JSON.stringify(input, null, 2);
    if (!detail || detail.length > 32000) return false; // Never approve a truncated action.
    const p: Permission = {
      id: randomUUID(),
      threadID: thread.id,
      taskID: task.id,
      epoch: thread.epoch,
      tool,
      input: detail,
      state: "pending",
      expiresAt: Date.now() + 120000,
    };
    this.store.put("permission", p.id, p);
    socket.setTimeout(0);
    const timer = setTimeout(() => this.expire(p.id), 120000);
    this.pending.set(p.id, { socket, timer });
    socket.once("close", () => this.expire(p.id));
    return true;
  }
  expire(id: string) {
    const binding = this.pending.get(id);
    if (!binding) return;
    clearTimeout(binding.timer);
    this.pending.delete(id);
    const p = this.store.get<Permission>("permission", id)!;
    p.state = "expired";
    this.store.put("permission", id, p);
    const task = this.store.task(p.taskID);
    if (["working", "delivered"].includes(task.status)) {
      task.permissionRequired = undefined;
      task.activity =
        "Approval expired. Claude is preparing a reply without that action.";
      task.activityAt = Date.now();
      this.store.put("task", task.id, task);
      this.store.event("task.permission_expired", task);
      this.store.emit("change");
    }
    // A vanished phone card must not leave an invisible native permission wait.
    // Deny only this action; Claude can explain the limitation and still reply.
    binding.socket.end(
      JSON.stringify({
        ok: true,
        permissionDecision: "deny",
        permissionMessage:
          "Sidewalk did not receive a permission decision before this approval expired or its connection closed. This is not a user denial. Do not run or retry this action. Reply through Sidewalk with what you can answer, explaining the limitation briefly; the user can request a retry.",
      }) + "\n",
    );
  }
  decide(
    device: string,
    commandID: string,
    id: string,
    decision: "allow" | "deny",
    focusEpoch: number,
  ) {
    const result = this.store.command(
      commandID,
      { device, id, decision, focusEpoch },
      () => {
        const p = this.store.get<Permission>("permission", id);
        const focus = this.store.focus(device);
        if (
          !p ||
          p.state !== "pending" ||
          p.expiresAt < Date.now() ||
          !this.pending.has(id)
        )
          throw new DomainError(
            "permission_expired",
            "This approval is no longer pending. Check Claude on your Mac.",
            409,
          );
        if (
          focus.threadID !== p.threadID ||
          focus.epoch !== focusEpoch ||
          this.store.thread(p.threadID).epoch !== p.epoch ||
          !["working", "delivered"].includes(this.store.task(p.taskID).status)
        )
          throw new DomainError(
            "permission_stale",
            "The conversation or request changed. Review the current permission again.",
            409,
          );
        p.state = decision;
        this.store.put("permission", id, p);
        const task = this.store.task(p.taskID);
        task.permissionRequired = undefined;
        this.store.put("task", task.id, task);
        this.store.event("permission.decided", { id, device, decision });
        return p;
      },
    );
    const binding = this.pending.get(id);
    if (binding) {
      clearTimeout(binding.timer);
      this.pending.delete(id);
      binding.socket.end(
        JSON.stringify({ ok: true, permissionDecision: result.state }) + "\n",
      );
    }
    return result;
  }
  closeThread(threadID: string) {
    for (const id of [...this.pending.keys()])
      if (this.store.get<Permission>("permission", id)?.threadID === threadID)
        this.expire(id);
  }
  close() {
    for (const id of [...this.pending.keys()]) this.expire(id);
  }
}
