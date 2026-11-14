import { DurableObject } from "cloudflare:workers";

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{1,64})(\/stats)?$/;
const HIBERNATE_AFTER_MS = 10_000;

export default {
  fetch(request, env) {
    const match = new URL(request.url).pathname.match(ROOM_PATH);
    if (!match) return new Response("not found", { status: 404 });
    return env.ROOM.getByName(match[1]).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS gig (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    this.stats = { upgrades: 0, leader: 0, follower: 0, awakeMs: 0, lastAt: 0 };
  }

  touch() {
    const now = Date.now();
    if (this.stats.lastAt) this.stats.awakeMs += Math.min(now - this.stats.lastAt, HIBERNATE_AFTER_MS);
    this.stats.lastAt = now;
  }

  latest() {
    return this.ctx.storage.sql.exec("SELECT rev, body FROM gig WHERE id = 1").toArray()[0] ?? null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/stats")) return Response.json(this.stats);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    this.touch();
    this.stats.upgrades++;
    const role = url.searchParams.get("role") === "leader" ? "leader" : "follower";
    const id = url.searchParams.get("id") || crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role, `id:${id}`]);
    const latest = this.latest();
    if (role === "follower" && latest) server.send(JSON.stringify({ ...JSON.parse(latest.body), snapshot: true }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    this.touch();
    const role = this.ctx.getTags(ws)[0];
    this.stats[role]++;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof msg?.k !== "string") return;
    if (role === "leader" && msg.k === "state") {
      if (!Number.isSafeInteger(msg.rev)) return ws.send(JSON.stringify({ k: "refused", rev: msg.rev }));
      const have = this.latest()?.rev ?? 0;
      if (msg.rev <= have) return ws.send(JSON.stringify({ k: "refused", rev: msg.rev, have }));
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gig (id, rev, body) VALUES (1, ?, ?)", msg.rev, message);
      for (const peer of this.ctx.getWebSockets("follower")) peer.send(message);
    } else if (role === "leader" && msg.k === "pong") {
      for (const peer of this.ctx.getWebSockets(`id:${msg.to}`)) peer.send(message);
    } else if (role === "follower" && msg.k === "ping") {
      const id = this.ctx.getTags(ws)[1].slice(3);
      const relayed = JSON.stringify({ k: "ping", from: id, t0: msg.t0 });
      for (const peer of this.ctx.getWebSockets("leader")) peer.send(relayed);
    }
  }
}
