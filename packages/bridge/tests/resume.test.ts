import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type LaunchReceipt } from "../src/core.js";
import { Launcher } from "../src/launcher.js";

function until(store: Store, predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onChange = () => {
      if (predicate()) {
        clearTimeout(timer);
        store.off("change", onChange);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      store.off("change", onChange);
      reject(Error("Local fixture did not reach the expected state"));
    }, 5000);
    store.on("change", onChange);
  });
}

test(
  "PTY reconnect uses the existing session, requires process exit and launches once per command",
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-resume-"));
    const executable = join(dir, "fixture.mjs");
    // This is a local protocol fixture, not Claude or a model response.
    writeFileSync(
      executable,
      `#!${process.execPath}
import net from 'node:net';
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "launches.jsonl"))},JSON.stringify(args)+'\\n');
const config=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'));
const credentials=JSON.parse(readFileSync(config.mcpServers.sidewalk.args[1],'utf8'));
const hook=net.connect(credentials.socket,()=>hook.write(JSON.stringify({...credentials,type:'hook',event:'SessionStart'})+'\\n'));
hook.on('data',()=>{});
hook.on('end',()=>{
 const channel=net.connect(credentials.socket,()=>channel.write(JSON.stringify({...credentials,type:'register'})+'\\n'));
 let buffer='';
 channel.on('data',data=>{
  buffer+=data.toString(); let i;
  while((i=buffer.indexOf('\\n'))>=0){
   const message=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
   if(message.type==='recovery' || message.type==='request') appendFileSync(${JSON.stringify(join(dir, "deliveries.jsonl"))},JSON.stringify(message)+'\\n');
   if(message.type==='recovery') channel.write(JSON.stringify({...credentials,type:'recovery_report',recoveryID:message.recovery.id,nonce:message.recovery.nonce,outcome:'question',text:'Which file should I inspect?',eventID:'fixture-recovery'})+'\\n');
   if(message.type==='request' && message.answer) channel.write(JSON.stringify({...credentials,type:'report',taskID:message.task.id,kind:'result',text:'Received answer: '+message.answer.text,eventID:'fixture-answer'})+'\\n');
   if(message.type==='ack' && ['fixture-probe','fixture-recovery','fixture-answer'].includes(message.eventID)) {
     const stop=net.connect(credentials.socket,()=>stop.write(JSON.stringify({...credentials,type:'hook',event:'Stop'})+'\\n'));
     stop.on('data',()=>{}); stop.on('error',()=>{});
   }
   if(message.type==='probe') channel.write(JSON.stringify({...credentials,type:'report',taskID:message.task.id,kind:'accepted',text:message.task.text.match(/text exactly ([\\w-]+)\\./)[1],eventID:'fixture-probe'})+'\\n');
  }
 });
 channel.on('error',()=>{});
});
process.stdin.on('data',()=>process.exit(0));
`,
      { mode: 0o700 },
    );
    const store = new Store(join(dir, "journal"));
    let launcher = new Launcher(store, {
      port: 0,
      directory: dir,
      socket: join(dir, "bridge.sock"),
      projects: [{ id: "project", name: "Fixture", path: dir }],
      claude: executable,
      allowLaunch: true,
      intentModel: "unused",
    });
    const instances = [launcher];
    await launcher.listen();
    const thread = store.createThread(
      "phone",
      "create",
      "Fixture",
      "project",
      true,
    );
    try {
      launcher.launch(thread);
      await until(store, () => store.thread(thread.id).status === "ready");
      assert.equal(store.thread(thread.id).hasSession, true);
      assert.throws(
        () => launcher.resume("phone", "resume", thread.id),
        /running/,
      );
      const task = store.enqueue(
        "phone",
        "task",
        thread.id,
        "Inspect login",
        1,
      );
      store.claimNext();
      const originalQuestion = store.report(
        thread.id,
        thread.epoch,
        task.id,
        "question",
        "Which file?",
        "original-question",
      );
      const originalChild = launcher.bindings.get(thread.id)!.child!;
      const cfg = launcher.cfg;
      await launcher.close();
      store.recover();
      launcher = new Launcher(store, cfg);
      instances.push(launcher);
      await launcher.listen();
      assert.throws(
        () => launcher.resume("phone", "resume", thread.id),
        /not been confirmed/,
      );
      originalChild.write("exit\n");
      await until(store, () => store.thread(thread.id).status === "offline");
      assert.equal(
        store.get<LaunchReceipt>("process", thread.id)?.phase,
        "exited",
      );
      launcher.resume("phone", "resume", thread.id);
      launcher.resume("phone", "resume", thread.id);
      await until(store, () => store.thread(thread.id).status === "ready");
      const launches = readFileSync(join(dir, "launches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(launches.length, 2);
      assert.equal(
        launches[0]![launches[0]!.indexOf("--session-id") + 1],
        thread.sessionID,
      );
      assert.equal(
        launches[1]![launches[1]!.indexOf("--resume") + 1],
        thread.sessionID,
      );
      assert.ok(!launches[1]!.includes("--session-id"));
      assert.ok(!launches[1]!.includes("--fork-session"));
      assert.equal(store.thread(thread.id).epoch, thread.epoch + 1);
      await until(store, () => store.task(task.id).status === "question");
      const restored = store.task(task.id);
      assert.notEqual(restored.questionID, originalQuestion.questionID);
      store.answer(
        "phone",
        "answer",
        thread.id,
        task.id,
        restored.questionID!,
        "login.ts",
        store.focus("phone").epoch,
      );
      launcher.pump();
      await until(
        store,
        () =>
          store.task(task.id).status === "completed" &&
          store.all("lease").length === 0,
      );
      assert.equal(store.task(task.id).result, "Received answer: login.ts");
      const deliveries = readFileSync(join(dir, "deliveries.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(deliveries.filter((d) => d.type === "recovery").length, 1);
      const requests = deliveries.filter((d) => d.type === "request");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].answer.text, "login.ts");
    } finally {
      for (const instance of instances)
        for (const binding of instance.bindings.values()) binding.child?.kill();
      await until(store, () =>
        instances.every((instance) => instance.bindings.size === 0),
      );
      await launcher.close();
      store.db.close();
      rmSync(dir, { recursive: true });
    }
  },
);
