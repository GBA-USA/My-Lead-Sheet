import assert from "node:assert/strict";
import { unstable_startWorker } from "wrangler";
import { onRequest } from "../functions/api/[[path]].ts";

type Message = Record<string, unknown> & { kind: string };

class Peer {
  readonly ws: WebSocket;
  private readonly inbox: Message[] = [];
  private waiting: ((m: Message) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (this.waiting) this.waiting(message);
      else this.inbox.push(message);
    });
  }

  next(label: string): Promise<Message> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000);
      this.waiting = (message) => {
        clearTimeout(timer);
        this.waiting = null;
        resolve(message);
      };
    });
  }

  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
}

const worker = await unstable_startWorker({
  config: "worker/wrangler.jsonc",
  dev: { server: { port: 0 }, inspector: false, persist: false, watch: false },
});
let failed = false;
const sockets: WebSocket[] = [];
try {
  await worker.ready;
  const base = await worker.url;
  const http = (path: string) => fetch(new URL(path, base));
  const join = async (room: string) => {
    const peer = new Peer(new URL(`/api/rooms/${room}`, base).href.replace(/^http/, "ws"));
    sockets.push(peer.ws);
    const hello = await peer.next(`hello in ${room}`);
    assert.equal(hello.kind, "hello", "a socket is greeted first");
    return { peer, id: String(hello.you), peers: hello.peers };
  };

  const health = await http("/api/health");
  assert.equal(health.status, 200, "health returns 200");
  assert.deepEqual(await health.json(), { ok: true });

  const forwarded = await onRequest({
    request: new Request(new URL("/api/health", base)),
    env: { API: { fetch: (request: Request) => fetch(request) } },
  } as unknown as Parameters<typeof onRequest>[0]);
  assert.equal(forwarded.status, 200, "the Pages Function forwards /api/health to the Worker");

  assert.equal((await http("/api/nope")).status, 404, "an unknown api path is 404");
  assert.equal((await http("/api/rooms/bad%20id")).status, 404, "a room id outside [A-Za-z0-9_-] is 404");

  const empty = await http("/api/rooms/band-a");
  assert.equal(empty.status, 200, "a Room answers");
  assert.deepEqual(await empty.json(), { room: "band-a", peers: 0 });

  const a = await join("band-a");
  assert.deepEqual(a.peers, [], "the first socket sees nobody");
  const b = await join("band-a");
  assert.deepEqual(b.peers, [a.id], "the second socket sees the first");
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await (await http("/api/rooms/band-a")).json(), { room: "band-a", peers: 2 });

  const offer = { sdp: "v=0 offer", fingerprint: "AB:CD" };
  b.peer.send({ kind: "intro", to: a.id, body: offer });
  const gotOffer = await a.peer.next("intro at a");
  assert.equal(gotOffer.kind, "intro");
  assert.equal(gotOffer.from, b.id, "the introduction names its sender");
  assert.deepEqual(gotOffer.body, offer, "the introduction body arrives unchanged");

  a.peer.send({ kind: "intro", to: b.id, body: { sdp: "v=0 answer" } });
  const gotAnswer = await b.peer.next("intro answer at b");
  assert.equal(gotAnswer.from, a.id);
  assert.deepEqual(gotAnswer.body, { sdp: "v=0 answer" }, "the answer comes back to the introducer");

  const before = Date.now();
  b.peer.send({ kind: "ping", to: a.id, body: { t0: 1234.5 } });
  const ping = await a.peer.next("ping at a");
  assert.equal(ping.kind, "ping");
  assert.equal(ping.from, b.id);
  assert.deepEqual(ping.body, { t0: 1234.5 });
  a.peer.send({ kind: "pong", to: b.id, body: { t0: 1234.5, band: 99 } });
  const pong = await b.peer.next("pong at b");
  const after = Date.now();
  assert.equal(pong.kind, "pong", "the relayed ping comes back as a pong");
  assert.equal(pong.from, a.id);
  assert.deepEqual(pong.body, { t0: 1234.5, band: 99 });
  for (const stamped of [ping, pong]) {
    const { rx, tx } = stamped as { rx: number; tx: number };
    assert.ok(before <= rx && rx <= tx && tx <= after, `room stamps rx ${rx} <= tx ${tx} inside the round trip`);
  }

  const other = await join("band-b");
  assert.deepEqual(other.peers, [], "rooms do not share sockets");
  other.peer.send({ kind: "intro", to: a.id, body: {} });
  assert.deepEqual(await other.peer.next("cross-room error"), { kind: "error", error: "no-peer", to: a.id }, "a socket cannot reach a peer in another room");

  for (const bad of ["not json", { kind: "chat", to: a.id }, { kind: "intro" }, [1]]) {
    b.peer.send(bad);
    assert.deepEqual(await b.peer.next(`error for ${JSON.stringify(bad)}`), { kind: "error", error: "bad-message" }, `refuses ${JSON.stringify(bad)}`);
  }

  b.peer.ws.close();
  const deadline = Date.now() + 5000;
  let peersAfterClose = 2;
  while (Date.now() < deadline && peersAfterClose !== 1) {
    peersAfterClose = ((await (await http("/api/rooms/band-a")).json()) as { peers: number }).peers;
  }
  assert.equal(peersAfterClose, 1, "a closed socket leaves the room");
  a.peer.send({ kind: "intro", to: b.id, body: {} });
  assert.deepEqual(await a.peer.next("error after close"), { kind: "error", error: "no-peer", to: b.id }, "a closed peer is gone");

  console.log("check:api passed: health, Pages forwarding, Room answers, intro relay, ping relay with stamps, room isolation, bad messages, close");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const ws of sockets) ws.close();
  await worker.dispose();
}
process.exit(failed ? 1 : 0);
