import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, type Task } from "../packages/bridge/src/core.js";
import { openAIKey } from "../packages/bridge/src/secrets.js";
import {
  decisionSchema,
  grounded,
  interpret,
} from "../packages/bridge/src/intent.js";
const corpus = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    cases: z.array(
      z.object({
        id: z.string(),
        state: z.enum([
          "empty",
          "focused",
          "ambiguous",
          "question",
          "background_question",
          "queued",
          "working",
          "unknown",
          "offline",
        ]),
        pending: z.string().min(1),
        history: z.string().optional(),
        expectedActions: z.array(decisionSchema.shape.action),
        expectedThread: z.string().optional(),
        expectedComplete: z.boolean().optional(),
        expectedEmptyBrief: z.boolean().optional(),
        review: z.string(),
      }),
    ),
  })
  .parse(
    JSON.parse(readFileSync("docs/evals/natural-conversation.json", "utf8")),
  );
if (new Set(corpus.cases.map((c) => c.id)).size !== corpus.cases.length)
  throw Error("Duplicate scenario ID");
function fixture(variant: (typeof corpus.cases)[number]["state"]) {
  const store = new Store();
  if (variant === "empty") return store;
  const onboarding = store.createThread(
    "eval",
    "onboarding",
    "Onboarding",
    "fixture-project",
    true,
  );
  const login = store.createThread(
    "eval",
    "login",
    "Login",
    "fixture-project",
    false,
  );
  store.register(onboarding.id, onboarding.sessionID, onboarding.epoch);
  store.register(login.id, login.sessionID, login.epoch);
  if (variant === "ambiguous")
    store.createThread(
      "eval",
      "login-other",
      "Login",
      "fixture-project",
      false,
    );
  if (
    [
      "question",
      "background_question",
      "queued",
      "working",
      "unknown",
    ].includes(variant)
  ) {
    const target = variant === "background_question" ? login : onboarding;
    const task = store.enqueue(
      "eval",
      "fixture-task",
      target.id,
      "Inspect signup.ts",
      1,
    );
    if (variant !== "queued") {
      store.claimNext();
      if (variant === "question" || variant === "background_question")
        store.report(
          target.id,
          target.epoch,
          task.id,
          "question",
          "Which flow should I inspect: iPhone or Mac? You can also name its file.",
          "fixture-question",
        );
      if (variant === "working")
        store.report(
          target.id,
          target.epoch,
          task.id,
          "accepted",
          "Inspecting",
          "fixture-accepted",
        );
      if (variant === "unknown")
        store.put("task", task.id, {
          ...store.task(task.id),
          status: "unknown",
        } satisfies Task);
    }
  }
  if (variant === "offline")
    store.updateThread(login.id, "offline", "Session ended");
  return store;
}
const live = process.argv.includes("--live");
const key = openAIKey();
if (live && !key)
  throw Error(
    "Set OPENAI_API_KEY in the evaluator process; no model calls were made",
  );
const model = process.env.SIDEWALK_INTENT_MODEL ?? "gpt-5.6-luna";
const rows = [];
for (const scenario of corpus.cases) {
  const store = fixture(scenario.state);
  try {
    const state = store.snapshot("eval");
    if (!live) {
      rows.push({ id: scenario.id, fixtureValid: true });
      continue;
    }
    const decision = await interpret(
      key!,
      model,
      scenario.pending,
      scenario.history ?? "",
      state,
      AbortSignal.timeout(20000),
    );
    const actualThread =
      state.threads.find((t) => t.id === decision.threadID)?.name ??
      state.threads.find((t) => t.id === state.focus.threadID)?.name;
    const actionPass = scenario.expectedActions.includes(decision.action);
    const completePass =
      scenario.expectedComplete === undefined ||
      decision.complete === scenario.expectedComplete;
    const targetPass =
      !scenario.expectedThread || actualThread === scenario.expectedThread;
    const briefPass =
      !scenario.expectedEmptyBrief || decision.text.trim() === "";
    const isAction = !["discuss", "wait", "clarify"].includes(decision.action);
    const sourcePass = !isAction || grounded(decision, scenario.pending);
    const idsPass =
      (!decision.threadID ||
        state.threads.some((t) => t.id === decision.threadID)) &&
      (!decision.taskID || state.tasks.some((t) => t.id === decision.taskID)) &&
      (!decision.questionID ||
        state.tasks.some((t) => t.questionID === decision.questionID)) &&
      (!["answer", "cancel", "correct", "check_request"].includes(
        decision.action,
      ) ||
        !!state.tasks.find(
          (t) =>
            t.id === decision.taskID &&
            t.threadID === (decision.threadID ?? state.focus.threadID),
        )) &&
      (decision.action !== "answer" ||
        !!state.tasks.find(
          (t) =>
            t.id === decision.taskID &&
            t.status === "question" &&
            t.questionID &&
            t.questionID === decision.questionID,
        ));
    rows.push({
      id: scenario.id,
      actionPass,
      completePass,
      targetPass,
      sourcePass,
      idsPass,
      briefPass,
      pass:
        actionPass &&
        completePass &&
        targetPass &&
        sourcePass &&
        idsPass &&
        briefPass,
      manualBriefReviewRequired: true,
      pending: scenario.pending,
      decision,
    });
    console.log(
      `${scenario.id}: ${rows.at(-1)!.pass ? "checks passed; review brief" : "needs review"}`,
    );
  } catch (error) {
    rows.push({
      id: scenario.id,
      pass: false,
      error: error instanceof Error ? error.message : "Evaluation failed",
    });
  } finally {
    store.db.close();
  }
}
mkdirSync(".local", { recursive: true, mode: 0o700 });
const path = `.local/intent-eval-${randomUUID()}.json`;
writeFileSync(
  path,
  JSON.stringify(
    {
      mode: live ? "live-text-model" : "fixture-validation-only",
      model: live ? model : null,
      scope: corpus.scope,
      count: rows.length,
      rows,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `${rows.length} scenarios: ${live ? "text-model results" : "fixtures validated; no model calls or semantic scores"}. Report: ${path}`,
);
if (live && rows.some((row) => "pass" in row && !row.pass))
  process.exitCode = 1;
