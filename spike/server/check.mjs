import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

async function socket(base, role) {
  const url = new URL(`/room/junk?role=${role}&id=${role}`, base);
  url.protocol = url.protocol.replace("http", "ws");
  const ws = new WebSocket(url);
  const inbox = [];
  ws.onmessage = ({ data }) => inbox.push(JSON.parse(data));
  await once(ws, "open");
  return { ws, inbox };
}

async function junkFromLeaderLeavesTheRoomWorking(base) {
  const leader = await socket(base, "leader");
  const follower = await socket(base, "follower");
  for (const junk of ["not json", "null", "[]", '{"k":"state"}', '{"k":"state","rev":"7"}']) leader.ws.send(junk);
  leader.ws.send(JSON.stringify({ k: "state", rev: 1, sentAt: 0, body: {} }));
  for (let waited = 0; !follower.inbox.length && waited < 3000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(follower.inbox.map((m) => m.rev), [1], "after junk from the leader, the next real change still reaches the follower");
  assert.equal(leader.inbox.filter((m) => m.k === "refused").length, 2, "a state without an integer rev is refused");
  leader.ws.close();
  follower.ws.close();
}
const worker = await unstable_startWorker({
  config: here("wrangler.jsonc"),
  dev: { server: { port: 0 }, inspector: false, persist: false, watch: false },
});
let status = 1;
try {
  await worker.ready;
  const url = String(await worker.url);
  await junkFromLeaderLeavesTheRoomWorking(url);
  const drill = spawn(
    process.execPath,
    [here("drill.mjs"), url, "--changes", "40", "--every-ms", "50", "--kill-s", "3", "--ping-ms", "100"],
    { stdio: "inherit" },
  );
  [status] = await once(drill, "exit");
} finally {
  await worker.dispose();
}
console.log(status === 0 ? "check:spike-server ok" : "check:spike-server FAILED");
process.exit(status);
