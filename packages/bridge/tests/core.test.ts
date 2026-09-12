import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core.js";
import { Auth } from "../src/auth.js";
import { grounded, decisionSchema } from "../src/intent.js";
function ready(s: Store, id: string, name = id, project = "project") {
  const t = s.createThread("phone", id, name, project, true);
  s.register(t.id, t.sessionID, t.epoch);
  return t;
}

test("creation is idempotent and rejects a command with changed meaning", () => {
  const s = new Store();
  const t = s.createThread("p", "c", "Login", "project", true, "Inspect login");
  assert.equal(
    s.createThread("p", "c", "Login", "project", true, "Inspect login").id,
    t.id,
  );
  assert.equal(s.all("thread").length, 1);
  assert.equal(s.all("task").length, 1);
  assert.throws(
    () => s.createThread("p", "c", "Other", "project", true),
    /different content/,
  );
  s.db.close();
});
test("new focus waits for real readiness, and cannot override a later manual switch", () => {
  const s = new Store();
  const a = ready(s, "a");
  const b = s.createThread("phone", "b", "Second", "project", true);
  assert.equal(s.focus("phone").threadID, a.id);
  s.setFocus("phone", a.id, "refocus");
  s.register(b.id, b.sessionID, b.epoch);
  assert.equal(s.focus("phone").threadID, a.id);
  s.db.close();
});
test("switching threads does not retarget queued or active work", () => {
  const s = new Store();
  const a = ready(s, "a");
  const b = ready(s, "b");
  const task = s.enqueue("phone", "task", a.id, "Check onboarding", 1);
  s.claimNext();
  s.setFocus("phone", b.id, "focus");
  assert.equal(s.task(task.id).threadID, a.id);
  assert.equal(s.task(task.id).status, "delivered");
  s.db.close();
});
test("shared workspace remains leased after a result until the matching Stop observation", () => {
  const s = new Store();
  const a = ready(s, "a");
  const b = ready(s, "b");
  const x = s.enqueue("phone", "x", a.id, "Work A", 1);
  s.enqueue("phone", "y", b.id, "Work B", 2);
  assert.equal(s.claimNext()?.task.id, x.id);
  assert.equal(s.claimNext(), undefined);
  s.report(a.id, a.epoch, x.id, "result", "Done", "result");
  assert.equal(s.claimNext(), undefined);
  s.observeStop(a.id);
  assert.equal(s.claimNext()?.thread.id, b.id);
  s.db.close();
});
test("one pending follow-up per thread; canceled item is never delivered", () => {
  const s = new Store();
  const a = ready(s, "a");
  s.enqueue("phone", "x", a.id, "First", 1);
  s.claimNext();
  const next = s.enqueue("phone", "y", a.id, "Next", 2);
  assert.throws(() => s.enqueue("phone", "z", a.id, "Third", 3), /already has/);
  s.cancel("cancel", next.id);
  assert.equal(s.task(next.id).status, "canceled");
  assert.equal(s.claimNext(), undefined);
  s.db.close();
});
test("old or wrong-thread questions cannot be answered after focus moves", () => {
  const s = new Store();
  const a = ready(s, "a");
  const b = ready(s, "b");
  s.setFocus("phone", a.id, "focus-a");
  const task = s.enqueue("phone", "x", a.id, "Inspect", 1);
  s.claimNext();
  const question = s.report(
    a.id,
    a.epoch,
    task.id,
    "question",
    "Which file?",
    "q",
  );
  const epoch = s.focus("phone").epoch;
  s.setFocus("phone", b.id, "focus-b");
  assert.throws(
    () =>
      s.answer(
        "phone",
        "ans",
        a.id,
        task.id,
        question.questionID!,
        "login.ts",
        epoch,
      ),
    /no longer/,
  );
  assert.equal(s.task(task.id).status, "question");
  s.db.close();
});
test("reply from a different session or epoch is rejected", () => {
  const s = new Store();
  const a = ready(s, "a");
  const b = ready(s, "b");
  const task = s.enqueue("phone", "x", a.id, "Inspect", 1);
  s.claimNext();
  assert.throws(
    () => s.report(b.id, b.epoch, task.id, "result", "Wrong", "bad"),
    /different/,
  );
  assert.throws(
    () => s.report(a.id, 99, task.id, "result", "Stale", "bad2"),
    /different/,
  );
  s.db.close();
});
test("crash recovery holds uncertain delivery without duplicating the task or releasing workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidewalk-test-"));
  const path = join(dir, "journal");
  let s = new Store(path);
  const a = ready(s, "a");
  const task = s.enqueue("phone", "x", a.id, "Edit once", 1);
  s.claimNext();
  s.db.close();
  s = new Store(path);
  s.recover();
  assert.equal(s.task(task.id).status, "unknown");
  assert.equal(s.thread(a.id).status, "unknown");
  assert.equal(s.enqueue("phone", "x", a.id, "Edit once", 1).id, task.id);
  assert.equal(s.claimNext(), undefined);
  assert.equal(s.all("lease").length, 1);
  s.db.close();
  rmSync(dir, { recursive: true });
});
test("stale focus is rejected transactionally before persisting a request", () => {
  const s = new Store();
  const a = ready(s, "a");
  const epoch = s.focus("phone").epoch;
  s.setFocus("phone", a.id, "again");
  assert.throws(
    () => s.enqueue("phone", "x", a.id, "Inspect", 1, epoch),
    /focus changed/,
  );
  assert.equal(s.all("task").length, 0);
  s.db.close();
});
test("pairing is single-use, stored as token hash, and revocable", () => {
  const s = new Store();
  const auth = new Auth(s);
  const d = auth.pair(auth.pairingCode, "Phone");
  assert.equal(auth.verify("Bearer " + d.token), d.deviceID);
  assert.throws(() => auth.pair(auth.pairingCode, "Other"), /already used/);
  assert.ok(!JSON.stringify(s.all("device")).includes(d.token));
  auth.revoke(d.deviceID);
  assert.throws(() => auth.verify("Bearer " + d.token), /Pair/);
  s.db.close();
});
test("source provenance rejects hallucinated quote or incomplete utterance", () => {
  const d = decisionSchema.parse({
    action: "request",
    complete: true,
    threadID: null,
    name: "",
    text: "Check login",
    sourceQuote: "Check login",
    background: false,
    taskID: null,
    questionID: null,
    reply: "",
  });
  assert.ok(grounded(d, "Can you Check login please"));
  assert.ok(!grounded(d, "Maybe later"));
  assert.ok(!grounded({ ...d, complete: false }, "Check login"));
});
test("pairing-code expiry and bridge restart do not expire an already paired phone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-pair-"));
  const path = join(dir, "journal");
  let s = new Store(path);
  let auth = new Auth(s);
  const phone = auth.pair(auth.pairingCode, "Phone");
  auth.expiresAt = Date.now() - 1;
  assert.equal(auth.verify("Bearer " + phone.token), phone.deviceID);
  s.db.close();
  s = new Store(path);
  s.recover();
  auth = new Auth(s);
  assert.equal(auth.verify("Bearer " + phone.token), phone.deviceID);
  s.db.close();
  rmSync(dir, { recursive: true });
});

test("answer retries preserve one delivery, original brief and crash uncertainty", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-answer-"));
  const path = join(dir, "journal");
  let s = new Store(path);
  const a = ready(s, "a");
  const task = s.enqueue("phone", "x", a.id, "Inspect login", 1);
  s.claimNext();
  const q = s.report(a.id, a.epoch, task.id, "question", "Which file?", "q");
  const epoch = s.focus("phone").epoch;
  const answer = () =>
    s.answer(
      "phone",
      "answer",
      a.id,
      task.id,
      q.questionID!,
      "login.ts",
      epoch,
    );
  answer();
  answer();
  assert.equal(s.all("answer").length, 1);
  assert.equal(
    s.claimAnswer(),
    undefined,
    "A quick answer waits for the question turn to finish",
  );
  s.report(
    a.id,
    a.epoch,
    task.id,
    "progress",
    "Late progress",
    "late-progress",
  );
  assert.equal(s.task(task.id).status, "answer_queued");
  s.observeStop(a.id);
  const delivery = s.claimAnswer()!;
  assert.equal(delivery.answer?.text, "login.ts");
  assert.equal(delivery.answer?.questionID, q.questionID);
  assert.equal(delivery.task.text, "Inspect login");
  assert.equal(s.claimAnswer(), undefined);
  s.db.close();
  s = new Store(path);
  s.recover();
  answer();
  assert.equal(s.claimAnswer(), undefined);
  assert.equal(s.task(task.id).status, "unknown");
  assert.equal(s.all("lease").length, 1);
  s.db.close();
  rmSync(dir, { recursive: true });
});

test("late progress preserves the pending question and its answer binding", () => {
  const s = new Store();
  const a = ready(s, "a");
  const task = s.enqueue("phone", "x", a.id, "Inspect", 1);
  s.claimNext();
  const q = s.report(a.id, a.epoch, task.id, "question", "Which file?", "q");
  s.report(a.id, a.epoch, task.id, "progress", "Found two files", "p");
  assert.equal(s.task(task.id).status, "question");
  assert.equal(s.task(task.id).result, "Which file?");
  assert.equal(s.task(task.id).questionID, q.questionID);
  s.answer(
    "phone",
    "ans",
    a.id,
    task.id,
    q.questionID!,
    "login.ts",
    s.focus("phone").epoch,
  );
  s.observeStop(a.id);
  assert.ok(s.claimAnswer());
  s.db.close();
});

test("automatic focus after readiness emits the same event as a manual switch", () => {
  const s = new Store();
  const a = ready(s, "a");
  const events = s.events().filter((e) => e.kind === "focus");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.body, { device: "phone", ...s.focus("phone") });
  assert.equal(s.focus("phone").threadID, a.id);
  s.db.close();
});

test("resume preserves session identity, bumps the binding once and holds uncertain requests", () => {
  const s = new Store();
  const a = ready(s, "a");
  s.claimLaunch(a.id, a.epoch);
  s.sessionStarted(a.id, a.epoch);
  s.recordProcess(a.id, a.epoch, "running", 99999);
  const task = s.enqueue("phone", "task", a.id, "Edit once", 1);
  s.claimNext();
  s.recover();
  assert.throws(() => s.resume("phone", "resume", a.id), /not been confirmed/);
  s.recordProcess(a.id, a.epoch, "exited");
  const resumed = s.resume("phone", "resume", a.id);
  assert.equal(resumed.sessionID, a.sessionID);
  assert.equal(resumed.id, a.id);
  assert.equal(resumed.epoch, a.epoch + 1);
  assert.equal(resumed.launchMode, "resume");
  assert.equal(s.resume("phone", "resume", a.id).epoch, resumed.epoch);
  assert.throws(() => s.register(a.id, a.sessionID, a.epoch), /binding/);
  s.register(resumed.id, resumed.sessionID, resumed.epoch);
  assert.equal(s.task(task.id).status, "unknown");
  assert.match(s.thread(a.id).detail, /Checking what happened/);
  assert.equal(s.claimNext(), undefined);
  assert.equal(s.all("lease").length, 1);
  s.db.close();
});

test("a crash between spawn reservation and PID recording never permits a blind relaunch", () => {
  const s = new Store();
  const a = s.createThread("phone", "a", "Login", "project", true);
  assert.ok(s.claimLaunch(a.id, a.epoch));
  assert.equal(s.claimLaunch(a.id, a.epoch), false);
  s.recover();
  assert.throws(() => s.resume("phone", "resume", a.id), /not been confirmed/);
  assert.equal(s.thread(a.id).epoch, a.epoch);
  s.db.close();
});

test("recovery restores a scoped question with fresh identity and never sends an old pending answer", () => {
  const s = new Store();
  const a = ready(s, "a");
  const task = s.enqueue("phone", "task", a.id, "Inspect login", 1);
  s.claimNext();
  const original = s.report(
    a.id,
    a.epoch,
    task.id,
    "question",
    "Which file?",
    "q",
  );
  s.answer(
    "phone",
    "old-answer",
    a.id,
    task.id,
    original.questionID!,
    "old.ts",
    s.focus("phone").epoch,
  );
  s.recover();
  s.register(a.id, a.sessionID, a.epoch);
  const check = s.claimRecovery()!;
  assert.equal(check.task.status, "unknown");
  assert.equal(check.lastAnswer?.text, "old.ts");
  assert.equal(s.claimRecovery(), undefined);
  const r = check.recovery;
  assert.throws(
    () => s.reconcile(a.id, a.epoch, r.id, "wrong", "question", "Which file?"),
    /does not match/,
  );
  assert.throws(
    () =>
      s.reconcile(a.id, a.epoch + 1, r.id, r.nonce, "question", "Which file?"),
    /does not match/,
  );
  const restored = s.reconcile(
    a.id,
    a.epoch,
    r.id,
    r.nonce,
    "question",
    "Which file should I inspect?",
  );
  assert.notEqual(restored.questionID, original.questionID);
  assert.equal(s.all("lease").length, 1);
  assert.throws(
    () =>
      s.answer(
        "phone",
        "stale",
        a.id,
        task.id,
        original.questionID!,
        "wrong.ts",
        s.focus("phone").epoch,
      ),
    /no longer/,
  );
  s.answer(
    "phone",
    "fresh",
    a.id,
    task.id,
    restored.questionID!,
    "login.ts",
    s.focus("phone").epoch,
  );
  assert.equal(s.claimAnswer(), undefined);
  s.observeStop(a.id);
  assert.equal(s.claimAnswer()?.answer?.text, "login.ts");
  assert.equal(s.claimAnswer(), undefined);
  s.db.close();
});

test("recovered completion releases its workspace only after Stop and never reruns the original task", () => {
  const s = new Store();
  const a = ready(s, "a");
  const task = s.enqueue("phone", "task", a.id, "Edit once", 1);
  s.claimNext();
  const next = s.enqueue("phone", "next", a.id, "Next change", 2);
  s.recover();
  s.register(a.id, a.sessionID, a.epoch);
  const { recovery: r } = s.claimRecovery()!;
  s.reconcile(
    a.id,
    a.epoch,
    r.id,
    r.nonce,
    "completed",
    "The original change was completed.",
  );
  assert.equal(s.claimNext(), undefined);
  s.observeStop(a.id);
  assert.equal(s.claimNext()?.task.id, next.id);
  s.reconcile(
    a.id,
    a.epoch,
    r.id,
    r.nonce,
    "completed",
    "The original change was completed.",
  );
  assert.equal(s.task(task.id).status, "completed");
  assert.equal(s.all("task").length, 2);
  s.db.close();
});

test("unknown recovery stays held; explicit retry rejects reports from a superseded check", () => {
  const s = new Store();
  const a = ready(s, "a");
  const task = s.enqueue("phone", "task", a.id, "Inspect", 1);
  s.claimNext();
  s.recover();
  s.register(a.id, a.sessionID, a.epoch);
  const { recovery: r } = s.claimRecovery()!;
  assert.throws(
    () => s.requestRecovery("phone", "retry", task.id),
    /already checking/,
  );
  s.put("recovery", r.id, { ...r, createdAt: Date.now() - 31000 });
  s.requestRecovery("phone", "retry", task.id);
  s.requestRecovery("phone", "retry", task.id);
  const fresh = s.claimRecovery()!.recovery;
  assert.notEqual(fresh.nonce, r.nonce);
  assert.throws(
    () =>
      s.reconcile(a.id, a.epoch, r.id, r.nonce, "completed", "Late old reply"),
    /does not match/,
  );
  s.reconcile(
    a.id,
    a.epoch,
    fresh.id,
    fresh.nonce,
    "unknown",
    "The retained conversation cannot establish the outcome.",
  );
  assert.equal(s.task(task.id).status, "unknown");
  assert.equal(s.claimRecovery(), undefined);
  assert.equal(s.claimNext(), undefined);
  assert.equal(s.all("lease").length, 1);
  s.db.close();
});

test("ordinary follow-ups answer a parked question verbatim and release other conversations", () => {
  const s = new Store();
  const a = ready(s, "qa");
  const first = s.enqueue("phone", "q-work", a.id, "Research voice", 1);
  s.claimNext();
  s.report(
    a.id,
    a.epoch,
    first.id,
    "question",
    "What are you waiting on?",
    "question",
  );
  const next = s.enqueue(
    "phone",
    "keep-going",
    a.id,
    "Yeah, just keep going, tell me how they use it",
    2,
  );
  assert.equal(
    s.claimAnswer(),
    undefined,
    "Do not overlap Claude's open question turn",
  );
  assert.equal(s.task(next.id).status, "continued");
  s.observeStop(a.id);
  const b = ready(s, "qb");
  const other = s.enqueue("phone", "hello", b.id, "Hello", 1);
  assert.equal(
    s.claimNext()?.task.id,
    other.id,
    "A parked question must not lock another conversation",
  );
  assert.equal(
    s.claimAnswer(),
    undefined,
    "An answer must reacquire the workspace before running",
  );
  s.report(b.id, b.epoch, other.id, "result", "Hello", "hello-result");
  s.observeStop(b.id);
  const resumed = s.claimAnswer()!;
  assert.equal(resumed.task.id, first.id);
  assert.equal(resumed.answer?.text, next.text);
  assert.equal(
    resumed.task.result,
    "",
    "Do not replay the stale question during the next turn",
  );
  assert.equal(s.claimAnswer(), undefined);
  assert.equal(
    s.enqueue("phone", "keep-going", a.id, next.text, 2).id,
    next.id,
  );
  assert.equal(s.all("answer").length, 1);
  s.db.close();
});

test("a stopped unanswered question survives restart without occupying a workspace", () => {
  const s = new Store();
  const a = ready(s, "a");
  const task = s.enqueue("phone", "work", a.id, "Explain", 1);
  s.claimNext();
  s.report(a.id, a.epoch, task.id, "question", "Which one?", "q");
  s.observeStop(a.id);
  assert.equal(s.all("lease").length, 0);
  s.recover();
  assert.equal(s.task(task.id).status, "question");
  assert.equal(s.all("lease").length, 0);
  const b = ready(s, "b");
  s.enqueue("phone", "new-work", b.id, "Hello", 1);
  assert.equal(s.claimNext()?.thread.id, b.id);
  s.db.close();
});
