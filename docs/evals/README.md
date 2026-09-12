# Natural conversation evaluation

The 56 scenarios in `natural-conversation.json` exercise ordinary requests, unfinished speech, speculation, negations, corrections, creation and switching, scoped answers, and session recovery. They use synthetic project/thread/task state, not personal workspace content.

`npm run eval:intent` validates the fixtures without calling a model. This is not a semantic score and cannot establish natural voice behavior.

After configuring `OPENAI_API_KEY` or the private `.local/secrets/openai-api-key` file, `npm run eval:intent -- --live` sends the text fixtures to the same tool-free intent interpreter used by the app. It executes no tasks and starts no Claude sessions. It checks action, target, completeness, source quote and referenced IDs, and saves the full decisions privately under `.local/intent-eval-*.json`. Each task brief still requires review for preserved constraints, meaning and negation; passing mechanical checks is not a complete quality assessment.

Live audio evaluation must additionally cover ASR mistakes, slow speech, interruptions, self-corrections after pauses, background voices, microphone mute, screen lock, route changes and two real Claude sessions. Text evaluation alone cannot prove those behaviors.

The September 11 live text runs found and corrected several routing/brief issues. The latest full run passed 54/56 mechanical checks, including explicit empty-thread briefs. Remaining cases: a topic-only conversation transition was routed as a task, and a case-changed source quote failed exact grounding (the runtime would reject that correction). Full brief review and real audio acceptance remain required.
