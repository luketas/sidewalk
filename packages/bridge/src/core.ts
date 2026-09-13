import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";

export type ThreadStatus =
  "starting" | "registered" | "ready" | "blocked" | "unknown" | "offline";
export type TaskStatus =
  | "queued"
  | "delivered"
  | "working"
  | "question"
  | "answer_queued"
  | "completed"
  | "failed"
  | "canceled"
  | "continued"
  | "unknown";
export interface Thread {
  id: string;
  name: string;
  projectID: string;
  sessionID: string;
  epoch: number;
  status: ThreadStatus;
  detail: string;
  createdAt: number;
  launchMode?: "new" | "resume";
  hasSession?: boolean;
  nameFromClaude?: boolean;
}
export interface LaunchReceipt {
  threadID: string;
  epoch: number;
  phase: "launching" | "running" | "exited" | "failed";
  pid?: number;
}
export interface Task {
  id: string;
  threadID: string;
  commandID: string;
  text: string;
  sourceRevision: number;
  status: TaskStatus;
  result: string;
  speech?: string;
  replyID?: string;
  replyKind?: string;
  reportedAt?: number;
  deliveredAt?: number;
  permissionRequired?: string;
  questionID: string | null;
  questionTurnOpen?: boolean;
  continuedTaskID?: string;
  activity?: string;
  activityAt?: number;
  answerID?: string;
  createdAt: number;
}
export interface Focus {
  threadID: string | null;
  epoch: number;
}
export interface Delivery {
  task: Task;
  thread: Thread;
  answer?: Answer;
}
export interface Answer {
  id: string;
  taskID: string;
  threadID: string;
  questionID: string;
  text: string;
  state: "pending" | "attempted" | "superseded";
}
export interface Recovery {
  id: string;
  taskID: string;
  threadID: string;
  epoch: number;
  nonce: string;
  state: "pending" | "attempted" | "reported";
  createdAt: number;
}
export interface RecoveryDelivery {
  recovery: Recovery;
  task: Task;
  lastAnswer?: Answer;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const activeStates = new Set<TaskStatus>([
  "delivered",
  "working",
  "question",
  "answer_queued",
  "unknown",
]);

// A question whose native turn has stopped is waiting for the user, not running work.
const occupiesWorkspace = (task: Task) =>
  activeStates.has(task.status) &&
  !(
    ["question", "answer_queued"].includes(task.status) &&
    task.questionTurnOpen === false
  );

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(path = ":memory:") {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? (JSON.parse(String(r.body)) as T) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.body)) as T);
  }
  put(kind: string, id: string, body: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)")
      .run(kind, id, JSON.stringify(body));
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      this.emit("change");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(kind: string, body: unknown) {
    this.db
      .prepare("INSERT INTO events(kind,body,at) VALUES (?,?,?)")
      .run(kind, JSON.stringify(body), Date.now());
  }
  command<T>(id: string, payload: unknown, action: () => T): T {
    if (!id || id.length > 200)
      throw new DomainError(
        "invalid_command",
        "A bounded command ID is required",
        400,
      );
    return this.atomic(() => {
      const prior = this.db
        .prepare("SELECT * FROM commands WHERE id=?")
        .get(id);
      const hash = digest(payload);
      if (prior) {
        if (prior.hash !== hash)
          throw new DomainError(
            "id_conflict",
            "Command ID already used for different content",
          );
        return JSON.parse(String(prior.result)) as T;
      }
      const result = action();
      this.db
        .prepare("INSERT INTO commands VALUES (?,?,?)")
        .run(id, hash, JSON.stringify(result));
      return result;
    });
  }
  thread(id: string): Thread {
    const t = this.get<Thread>("thread", id);
    if (!t) throw new DomainError("thread_missing", "Thread not found", 404);
    return t;
  }
  task(id: string): Task {
    const t = this.get<Task>("task", id);
    if (!t) throw new DomainError("task_missing", "Request not found", 404);
    return t;
  }
  focus(device: string): Focus {
    return this.get<Focus>("focus", device) ?? { threadID: null, epoch: 0 };
  }
  setFocus(device: string, id: string, commandID: string): Focus {
    return this.command(commandID, { kind: "focus", device, id }, () => {
      this.thread(id);
      const f = { threadID: id, epoch: this.focus(device).epoch + 1 };
      this.put("focus", device, f);
      this.event("focus", { device, ...f });
      return f;
    });
  }
  createThread(
    device: string,
    commandID: string,
    name: string,
    projectID: string,
    focus: boolean,
    brief = "",
  ): Thread {
    if (name.length > 100 || brief.length > 16000)
      throw new DomainError(
        "invalid_thread",
        "Use a short thread name and task brief",
        400,
      );
    return this.command(
      commandID,
      { kind: "create", device, name, projectID, focus, brief },
      () => {
        const thread: Thread = {
          id: randomUUID(),
          name: name.trim() || "New thread",
          nameFromClaude: !name.trim(),
          projectID,
          sessionID: randomUUID(),
          epoch: 1,
          status: "starting",
          detail: "Starting Claude on your Mac",
          createdAt: Date.now(),
          launchMode: "new",
          hasSession: false,
        };
        this.put("thread", thread.id, thread);
        if (focus)
          this.put("pending_focus", device, {
            device,
            threadID: thread.id,
            expectedEpoch: this.focus(device).epoch,
          });
        if (brief.trim())
          this.insertTask(thread, commandID + ":initial", brief, 0);
        this.event("thread.created", thread);
        return thread;
      },
    );
  }
  claimLaunch(id: string, epoch: number): boolean {
    return this.atomic(() => {
      if (this.thread(id).epoch !== epoch)
        throw new DomainError("stale_binding", "Session binding changed");
      const prior = this.get<LaunchReceipt>("process", id);
      if (prior?.epoch === epoch) return false;
      this.put("process", id, {
        threadID: id,
        epoch,
        phase: "launching",
      } satisfies LaunchReceipt);
      return true;
    });
  }
  recordProcess(
    id: string,
    epoch: number,
    phase: LaunchReceipt["phase"],
    pid?: number,
  ) {
    const changed = this.atomic(() => {
      if (this.thread(id).epoch !== epoch) return false;
      const prior = this.get<LaunchReceipt>("process", id);
      this.put("process", id, {
        threadID: id,
        epoch,
        phase,
        pid: pid ?? prior?.pid,
      } satisfies LaunchReceipt);
      this.event("process." + phase, { threadID: id, epoch });
      return true;
    });
    if (changed && phase === "exited") this.observeStop(id);
  }
  sessionStarted(id: string, epoch: number) {
    this.atomic(() => {
      const t = this.thread(id);
      if (t.epoch !== epoch)
        throw new DomainError("stale_binding", "Session binding changed");
      t.hasSession = true;
      this.put("thread", id, t);
    });
  }
  resume(device: string, commandID: string, id: string): Thread {
    return this.command(commandID, { kind: "resume", device, id }, () => {
      const t = this.thread(id);
      const receipt = this.get<LaunchReceipt>("process", id);
      if (!["offline", "blocked", "unknown"].includes(t.status))
        throw new DomainError(
          "session_active",
          "This session is running or already reconnecting",
        );
      if (
        receipt
          ? !["exited", "failed"].includes(receipt.phase)
          : t.launchMode !== "new"
      )
        throw new DomainError(
          "process_unverified",
          "The previous Claude process has not been confirmed stopped. Check it on your Mac before resuming.",
        );
      t.epoch += 1;
      t.launchMode = t.hasSession ? "resume" : "new";
      t.status = "starting";
      t.detail = t.hasSession
        ? "Resuming this Claude conversation"
        : "Retrying Claude startup";
      this.put("thread", id, t);
      this.put("pending_focus", device, {
        device,
        threadID: id,
        expectedEpoch: this.focus(device).epoch,
      });
      this.event("thread.resuming", t);
      return t;
    });
  }
  updateThread(id: string, status: ThreadStatus, detail: string) {
    return this.atomic(() => {
      const t = this.thread(id);
      t.status = status;
      t.detail = detail;
      this.put("thread", id, t);
      this.event("thread.status", t);
      return t;
    });
  }
  register(id: string, sessionID: string, epoch: number) {
    const t = this.thread(id);
    if (t.sessionID !== sessionID || t.epoch !== epoch)
      throw new DomainError("stale_binding", "Session binding does not match");
    const uncertain = this.all<Task>("task").some(
      (task) => task.threadID === id && task.status === "unknown",
    );
    const ready = this.updateThread(
      id,
      "ready",
      uncertain
        ? "Claude reconnected. Checking what happened to earlier work."
        : "Claude is ready",
    );
    this.atomic(() => {
      for (const pending of this.all<{
        device: string;
        threadID: string;
        expectedEpoch: number;
      }>("pending_focus")) {
        if (pending.threadID === id) {
          if (this.focus(pending.device).epoch === pending.expectedEpoch) {
            const focus = { threadID: id, epoch: pending.expectedEpoch + 1 };
            this.put("focus", pending.device, focus);
            this.event("focus", { device: pending.device, ...focus });
          }
          this.db
            .prepare("DELETE FROM records WHERE kind=? AND id=?")
            .run("pending_focus", pending.device);
        }
      }
    });
    return ready;
  }
  enqueue(
    device: string,
    commandID: string,
    threadID: string,
    text: string,
    revision: number,
    expectedFocus?: number,
  ): Task {
    if (!text.trim() || text.length > 16000)
      throw new DomainError(
        "invalid_text",
        "Request must contain 1–16000 characters",
        400,
      );
    return this.command(
      commandID,
      { kind: "task", device, threadID, text, revision, expectedFocus },
      () => {
        if (
          expectedFocus !== undefined &&
          this.focus(device).epoch !== expectedFocus
        )
          throw new DomainError(
            "focus_changed",
            "Conversation focus changed; reinterpret the request",
          );
        const t = this.thread(threadID);
        if (
          this.all<Task>("task").some(
            (x) => x.threadID === threadID && x.status === "queued",
          )
        )
          throw new DomainError(
            "queue_full",
            "This thread already has a request waiting; revise or cancel it first",
          );
        return this.insertTask(t, commandID, text, revision);
      },
    );
  }
  private insertTask(
    t: Thread,
    commandID: string,
    text: string,
    revision: number,
  ) {
    const task: Task = {
      id: randomUUID(),
      threadID: t.id,
      commandID,
      text,
      sourceRevision: revision,
      status: "queued",
      result: "",
      questionID: null,
      createdAt: Date.now(),
    };
    this.put("task", task.id, task);
    this.event("task.queued", task);
    return task;
  }
  claimNext(): Delivery | undefined {
    return this.atomic(() => {
      const tasks = this.all<Task>("task");
      this.releaseParkedQuestions();
      const busy = tasks.filter(occupiesWorkspace);
      if (busy.length >= 2) return undefined;
      const leases = this.all<{
        projectID: string;
        threadID: string;
        taskID: string;
      }>("lease");
      if (leases.length >= 2) return undefined;
      const workspaces = new Set([
        ...busy.map((x) => this.thread(x.threadID).projectID),
        ...leases.map((x) => x.projectID),
      ]);
      const task = tasks.find(
        (x) =>
          x.status === "queued" &&
          this.thread(x.threadID).status === "ready" &&
          !this.get("voice_sync", x.threadID) &&
          !tasks.some(
            (other) =>
              other.threadID === x.threadID &&
              ["question", "answer_queued"].includes(other.status),
          ) &&
          !workspaces.has(this.thread(x.threadID).projectID),
      );
      if (!task) return undefined;
      task.status = "delivered";
      task.deliveredAt = Date.now();
      this.put("task", task.id, task);
      const thread = this.thread(task.threadID);
      this.put("lease", thread.projectID, {
        projectID: thread.projectID,
        threadID: thread.id,
        taskID: task.id,
      });
      this.event("task.delivered", task);
      return { task, thread: this.thread(task.threadID) };
    });
  }
  report(
    threadID: string,
    epoch: number,
    taskID: string,
    kind: "accepted" | "progress" | "question" | "result" | "failure",
    text: string,
    eventID: string,
    speech?: string,
    threadTitle?: string,
  ): Task {
    return this.command(
      eventID,
      {
        kind: "report",
        threadID,
        epoch,
        taskID,
        reportKind: kind,
        text,
        speech,
        threadTitle,
      },
      () => {
        const thread = this.thread(threadID),
          task = this.task(taskID);
        if (thread.epoch !== epoch || task.threadID !== threadID)
          throw new DomainError(
            "stale_reply",
            "Reply belongs to a different thread or binding",
          );
        if (!activeStates.has(task.status))
          throw new DomainError(
            "terminal_request",
            "Request is no longer active",
          );
        if (["question", "result", "failure"].includes(kind))
          task.permissionRequired = undefined;
        if (kind === "question") {
          task.status = "question";
          task.questionID = randomUUID();
          task.questionTurnOpen = true;
          task.answerID = undefined;
        } else if (kind === "result") {
          task.status = "completed";
          task.questionID = null;
        } else if (kind === "failure") {
          task.status = "failed";
          task.questionID = null;
        } else if (!["question", "answer_queued"].includes(task.status))
          task.status = "working";
        // A late progress update must not hide the question the user still owes.
        if (
          kind === "question" ||
          !["accepted", "progress"].includes(kind) ||
          !["question", "answer_queued"].includes(task.status)
        ) {
          task.result = text;
          task.replyID = eventID;
          task.replyKind = kind;
          task.reportedAt = Date.now();
          task.speech = speech?.trim().slice(0, 4000);
        }
        // Claude's channel replies do not always produce native ai-title records.
        // Name only an untitled thread, inside the validated report transaction.
        const title = typeof threadTitle === "string" ? threadTitle.trim() : "";
        if (
          thread.nameFromClaude &&
          thread.name === "New thread" &&
          title &&
          title.length <= 100 &&
          !/[\x00-\x1f\x7f]/.test(title)
        ) {
          thread.name = title;
          this.put("thread", thread.id, thread);
          this.event("thread.renamed", { id: thread.id, name: title });
        }
        this.put("task", task.id, task);
        this.event("task." + kind, task);
        return task;
      },
    );
  }
  answer(
    device: string,
    commandID: string,
    threadID: string,
    taskID: string,
    questionID: string,
    text: string,
    focusEpoch: number,
  ): Task {
    if (!text.trim() || text.length > 16000)
      throw new DomainError(
        "invalid_text",
        "Answer must contain 1–16000 characters",
        400,
      );
    return this.command(
      commandID,
      {
        kind: "answer",
        device,
        threadID,
        taskID,
        questionID,
        text,
        focusEpoch,
      },
      () => {
        const task = this.task(taskID);
        const focus = this.focus(device);
        if (
          task.threadID !== threadID ||
          task.status !== "question" ||
          task.questionID !== questionID ||
          focus.epoch !== focusEpoch ||
          focus.threadID !== threadID
        )
          throw new DomainError(
            "stale_question",
            "That question is no longer the active conversational question",
          );
        this.queueAnswer(task, commandID, questionID, text);
        return task;
      },
    );
  }
  private queueAnswer(
    task: Task,
    id: string,
    questionID: string,
    text: string,
  ) {
    task.status = "answer_queued";
    task.questionID = null;
    task.answerID = id;
    this.put("answer", id, {
      id,
      taskID: task.id,
      threadID: task.threadID,
      questionID,
      text,
      state: "pending",
    } satisfies Answer);
    this.put("task", task.id, task);
    this.event("task.answer", task);
  }
  private releaseParkedQuestions() {
    for (const lease of this.all<{ projectID: string; taskID: string }>(
      "lease",
    )) {
      const task = this.task(lease.taskID);
      if (
        ["question", "answer_queued"].includes(task.status) &&
        task.questionTurnOpen === false
      )
        this.db
          .prepare("DELETE FROM records WHERE kind=? AND id=?")
          .run("lease", lease.projectID);
    }
  }
  claimAnswer(): Delivery | undefined {
    return this.atomic(() => {
      this.releaseParkedQuestions();
      // A follow-up already admitted to this conversation answers Claude, even if
      // it arrived just before the question or the intent model called it a request.
      for (const queued of this.all<Task>("task").filter(
        (t) => t.status === "queued",
      )) {
        const question = this.all<Task>("task").find(
          (t) =>
            t.threadID === queued.threadID &&
            t.status === "question" &&
            t.questionID,
        );
        if (!question) continue;
        this.queueAnswer(
          question,
          "continuation:" + queued.id,
          question.questionID!,
          queued.text,
        );
        queued.status = "continued";
        queued.continuedTaskID = question.id;
        this.put("task", queued.id, queued);
        this.event("task.continued", queued);
      }
      const leases = this.all<{ projectID: string }>("lease");
      const busy = this.all<Task>("task").filter(occupiesWorkspace);
      if (leases.length >= 2 || busy.length >= 2) return undefined;
      const answer = this.all<Answer>("answer").find(
        (a) =>
          a.state === "pending" &&
          this.thread(a.threadID).status === "ready" &&
          !this.get("voice_sync", a.threadID) &&
          this.task(a.taskID).status === "answer_queued" &&
          this.task(a.taskID).answerID === a.id &&
          !this.task(a.taskID).questionTurnOpen &&
          !leases.some(
            (l) => l.projectID === this.thread(a.threadID).projectID,
          ) &&
          !busy.some(
            (t) =>
              this.thread(t.threadID).projectID ===
              this.thread(a.threadID).projectID,
          ),
      );
      if (!answer) return undefined;
      // Persist the attempt before IPC. An uncertain send must never be replayed.
      answer.state = "attempted";
      this.put("answer", answer.id, answer);
      const task = this.task(answer.taskID);
      task.status = "delivered";
      task.deliveredAt = Date.now();
      task.result = "";
      task.speech = undefined;
      task.replyID = undefined;
      task.replyKind = undefined;
      task.activity = "Claude received your follow-up.";
      task.activityAt = Date.now();
      const projectID = this.thread(task.threadID).projectID;
      this.put("lease", projectID, {
        projectID,
        threadID: task.threadID,
        taskID: task.id,
      });
      this.put("task", task.id, task);
      this.event("answer.attempted", {
        answerID: answer.id,
        taskID: answer.taskID,
      });
      return {
        task: this.task(answer.taskID),
        thread: this.thread(answer.threadID),
        answer,
      };
    });
  }
  private newRecovery(task: Task): Recovery {
    const thread = this.thread(task.threadID);
    const recovery: Recovery = {
      id: randomUUID(),
      taskID: task.id,
      threadID: thread.id,
      epoch: thread.epoch,
      nonce: randomUUID(),
      state: "pending",
      createdAt: Date.now(),
    };
    this.put("recovery", recovery.id, recovery);
    this.put("recovery_binding", task.id + ":" + thread.epoch, {
      id: recovery.id,
    });
    return recovery;
  }
  requestRecovery(device: string, commandID: string, taskID: string): Task {
    return this.command(
      commandID,
      { kind: "check_request", device, taskID },
      () => {
        const task = this.task(taskID),
          thread = this.thread(task.threadID);
        if (task.status !== "unknown" || thread.status !== "ready")
          throw new DomainError(
            "recovery_unavailable",
            "Reconnect this thread before checking its uncertain request",
          );
        const binding = this.get<{ id: string }>(
          "recovery_binding",
          task.id + ":" + thread.epoch,
        );
        const prior = binding && this.get<Recovery>("recovery", binding.id);
        if (
          prior &&
          prior.state !== "reported" &&
          Date.now() - prior.createdAt < 30000
        )
          throw new DomainError(
            "recovery_pending",
            "Claude is already checking this request",
          );
        this.newRecovery(task);
        this.event("recovery.requested", { taskID });
        return task;
      },
    );
  }
  claimRecovery(): RecoveryDelivery | undefined {
    return this.atomic(() => {
      for (const task of this.all<Task>("task")) {
        const thread = this.thread(task.threadID);
        if (task.status !== "unknown" || thread.status !== "ready") continue;
        if (this.get("voice_sync", thread.id)) continue;
        const binding = this.get<{ id: string }>(
          "recovery_binding",
          task.id + ":" + thread.epoch,
        );
        const recovery = binding
          ? this.get<Recovery>("recovery", binding.id)!
          : this.newRecovery(task);
        if (recovery.state !== "pending") continue;
        recovery.state = "attempted";
        this.put("recovery", recovery.id, recovery);
        this.event("recovery.checking", {
          taskID: task.id,
          threadID: thread.id,
        });
        const lastAnswer = this.all<Answer>("answer")
          .filter((a) => a.taskID === task.id)
          .at(-1);
        return { recovery, task, lastAnswer };
      }
      return undefined;
    });
  }
  reconcile(
    threadID: string,
    epoch: number,
    recoveryID: string,
    nonce: string,
    outcome: "question" | "completed" | "failed" | "unknown",
    text: string,
  ): Task {
    if (
      !["question", "completed", "failed", "unknown"].includes(outcome) ||
      !text.trim() ||
      text.length > 16000
    )
      throw new DomainError("invalid_recovery", "Invalid recovery report", 400);
    // A report is repeatable only with identical content, even if its IPC event ID changes.
    return this.command(
      "recovery-report:" + recoveryID,
      { threadID, epoch, recoveryID, nonce, outcome, text },
      () => {
        const recovery = this.get<Recovery>("recovery", recoveryID);
        const thread = this.thread(threadID);
        if (
          !recovery ||
          recovery.threadID !== threadID ||
          recovery.epoch !== epoch ||
          recovery.nonce !== nonce ||
          thread.epoch !== epoch ||
          thread.status !== "ready" ||
          recovery.state !== "attempted" ||
          this.get<{ id: string }>(
            "recovery_binding",
            recovery.taskID + ":" + epoch,
          )?.id !== recoveryID
        )
          throw new DomainError(
            "stale_recovery",
            "Recovery report does not match the current session check",
          );
        const task = this.task(recovery.taskID);
        if (task.status !== "unknown")
          throw new DomainError(
            "stale_recovery",
            "Request already has a newer state",
          );
        task.status = outcome;
        task.result = text;
        task.speech = undefined;
        task.permissionRequired = undefined;
        task.questionID = outcome === "question" ? randomUUID() : null;
        task.questionTurnOpen = outcome === "question";
        task.answerID = undefined;
        recovery.state = "reported";
        for (const answer of this.all<Answer>("answer")) {
          if (answer.taskID === task.id && answer.state === "pending") {
            answer.state = "superseded";
            this.put("answer", answer.id, answer);
          }
        }
        this.put("task", task.id, task);
        this.put("recovery", recovery.id, recovery);
        this.event("task.reconciled", task);
        thread.detail =
          outcome === "unknown"
            ? "Claude could not establish the earlier outcome. Check the request on your Mac."
            : "Claude is ready";
        this.put("thread", thread.id, thread);
        this.event("thread.status", thread);
        // Completed/failed work still holds its lease until the subsequent Stop observation.
        return task;
      },
    );
  }
  cancel(commandID: string, taskID: string): Task {
    return this.command(commandID, { kind: "cancel", taskID }, () => {
      const task = this.task(taskID);
      if (task.status !== "queued")
        throw new DomainError(
          "stop_unavailable",
          "Active stopping is not yet verified. Stop this work in Claude on your Mac.",
        );
      task.status = "canceled";
      this.put("task", task.id, task);
      this.event("task.canceled", task);
      return task;
    });
  }
  revise(commandID: string, taskID: string, text: string): Task {
    return this.command(commandID, { kind: "revise", taskID, text }, () => {
      const t = this.task(taskID);
      if (t.status !== "queued")
        throw new DomainError(
          "steering_unavailable",
          "This work was already delivered. Active steering needs a verified Claude adapter.",
        );
      t.text = text;
      this.put("task", t.id, t);
      this.event("task.revised", t);
      return t;
    });
  }
  observeStop(threadID: string) {
    this.atomic(() => {
      const thread = this.thread(threadID);
      const lease = this.get<{ threadID: string; taskID: string }>(
        "lease",
        thread.projectID,
      );
      if (!lease || lease.threadID !== threadID) return;
      const task = this.task(lease.taskID);
      if (["completed", "failed"].includes(task.status)) {
        this.db
          .prepare("DELETE FROM records WHERE kind=? AND id=?")
          .run("lease", thread.projectID);
      } else if (["question", "answer_queued"].includes(task.status)) {
        task.questionTurnOpen = false;
        this.put("task", task.id, task);
        this.db
          .prepare("DELETE FROM records WHERE kind=? AND id=?")
          .run("lease", thread.projectID);
      } else {
        task.status = "unknown";
        this.put("task", task.id, task);
      }
      this.event("claude.stop_observed", { threadID });
    });
  }
  recover() {
    this.atomic(() => {
      for (const t of this.all<Thread>("thread")) {
        if (["ready", "starting", "registered"].includes(t.status)) {
          t.status = "unknown";
          t.detail =
            "Bridge restarted. Reconcile the existing Claude session before restarting it.";
          this.put("thread", t.id, t);
        }
      }
      for (const t of this.all<Task>("task"))
        if (occupiesWorkspace(t)) {
          t.status = "unknown";
          this.put("task", t.id, t);
        }
      this.releaseParkedQuestions();
      this.event("bridge.recovered", {});
    });
  }
  snapshot(device: string) {
    return {
      threads: this.all<Thread>("thread"),
      permissions: this.all<import("./permissions.js").Permission>(
        "permission",
      ).filter((p) => p.state === "pending" && p.expiresAt > Date.now()),
      tasks: this.all<Task>("task")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((task) => {
          if (task.permissionRequired)
            return {
              ...task,
              waitingReason: `Claude needs approval for ${task.permissionRequired}. Review the permission request.`,
            };
          if (!["queued", "answer_queued"].includes(task.status)) return task;
          const thread = this.thread(task.threadID);
          const lease = this.get<{ threadID: string; taskID: string }>(
            "lease",
            thread.projectID,
          );
          const waitingReason =
            thread.status !== "ready"
              ? thread.detail
              : lease
                ? `Waiting for ${this.thread(lease.threadID).name}: ${this.task(lease.taskID).permissionRequired ? "permission needed" : this.task(lease.taskID).status === "unknown" ? "connection needs checking" : "Claude is finishing another request"}.`
                : "Waiting for Claude to receive your message.";
          return { ...task, waitingReason };
        }),
      notice: this.get<{ text: string }>("voice_notice", device)?.text,
      focus: this.focus(device),
    };
  }
  events(after = 0) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 200")
      .all(after)
      .map((x) => ({
        seq: Number(x.seq),
        kind: String(x.kind),
        body: JSON.parse(String(x.body)),
        at: Number(x.at),
      }));
  }
}
