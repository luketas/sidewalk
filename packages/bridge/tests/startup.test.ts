import { test } from "node:test";
import assert from "node:assert/strict";
import { localDevelopmentNotice } from "../src/startup.js";
const notice = `WARNING: Loading development channels
--dangerously-load-development-channels is for local channel development only. Do not use this
option to run channels you have downloaded off the internet.
Please use --channels to run a list of approved channels.
Channels: server:sidewalk
❯ 1. I am using this for local development
2. Exit
Enter to confirm · Esc to cancel`;
test("only the exact selected Sidewalk local-development notice is eligible for acknowledgement", () => {
  assert.equal(localDevelopmentNotice(notice), true);
  assert.equal(localDevelopmentNotice(notice.replaceAll(" ", "\x1b[3G")), true);
  assert.equal(localDevelopmentNotice(notice.slice(0, -20)), false);
  assert.equal(
    localDevelopmentNotice(
      notice.replace("server:sidewalk", "server:untrusted"),
    ),
    false,
  );
  assert.equal(
    localDevelopmentNotice(
      notice.replace("server:sidewalk", "server:sidewalk,server:other"),
    ),
    false,
  );
  assert.equal(
    localDevelopmentNotice(
      notice.replace("❯ 1.", "1.").replace("2. Exit", "❯ 2. Exit"),
    ),
    false,
  );
  assert.equal(
    localDevelopmentNotice(notice + "\nblocked by org policy"),
    false,
  );
  for (const prompt of [
    "Trust this workspace? Enter to confirm",
    "Allow Bash to run this command?",
    "Sign in to Claude",
    "Enable Remote Control?",
    "New MCP server found: sidewalk",
  ])
    assert.equal(localDevelopmentNotice(prompt), false);
});
