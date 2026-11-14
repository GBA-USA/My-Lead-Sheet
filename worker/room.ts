import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { bandRoom, createMemberTables, NOT_A_MEMBER_CLOSE, shutOut } from "./room-members";

const RELAYED = ["intro", "ping", "pong"] as const;
type RelayKind = (typeof RELAYED)[number];

type Inbound = { kind: RelayKind; to: string; body: unknown };

type Outbound =
  | { kind: "hello"; you: string; peers: string[] }
  | { kind: RelayKind; from: string; body: unknown; rx: number; tx: number }
  | { kind: "error"; error: "bad-message" | "no-peer"; to?: string };

function parseInbound(message: string | ArrayBuffer): Inbound | null {
  if (typeof message !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, to, body } = value as Record<string, unknown>;
  if (!RELAYED.includes(kind as RelayKind) || typeof to !== "string") return null;
  return { kind: kind as RelayKind, to, body };
}

function send(ws: WebSocket, message: Outbound) {
  ws.send(JSON.stringify(message));
}

export const USER_HEADER = "X-MLS-User";
export const SESSION_HEADER = "X-MLS-Session";
export const SIGNED_OUT_CLOSE = 4401;

const userTag = (userId: string) => `user:${userId}`;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_floors (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
    createMemberTables(ctx.storage.sql);
  }

  private floor(userId: string): number {
    return this.ctx.storage.sql.exec<{ version: number }>(`SELECT version FROM session_floors WHERE user_id = ?`, userId).toArray()[0]?.version ?? 0;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    const version = Number(request.headers.get(SESSION_HEADER));
    if (!userId || !(version >= this.floor(userId))) return Response.json({ error: "signed-out" }, { status: 401 });
    if (shutOut(this.ctx.storage.sql, userId)) return Response.json({ error: "not-a-member" }, { status: 403 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ room: this.ctx.id.name, peers: this.ctx.getWebSockets().length });
    }
    const peers = this.ctx.getWebSockets().map((ws) => this.ctx.getTags(ws)[0]);
    const you = crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [you, userTag(userId)]);
    server.serializeAttachment({ version });
    send(server, { kind: "hello", you, peers });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sign out everywhere: close this user's sockets from older sessions, and refuse any that arrive late. */
  closeUser(userId: string, version: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO session_floors (user_id, version) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET version = max(version, excluded.version)`,
      userId,
      version,
    );
    for (const ws of this.ctx.getWebSockets(userTag(userId))) {
      if ((ws.deserializeAttachment() as { version: number }).version < version) ws.close(SIGNED_OUT_CLOSE, "signed-out");
    }
  }

  private closeMember(userId: string) {
    for (const ws of this.ctx.getWebSockets(userTag(userId))) ws.close(NOT_A_MEMBER_CLOSE, "not-a-member");
  }

  private get band() {
    return { sql: this.ctx.storage.sql, bandId: this.ctx.id.name! };
  }

  createBand(user: { userId: string; name: string }, name: string, now: number) {
    return bandRoom.create(this.band, user, name, now);
  }

  bandSummary(userId: string) {
    return bandRoom.summary(this.band, userId);
  }

  bandView(userId: string) {
    return bandRoom.view(this.band, userId);
  }

  bandPreview(inviterId: string, userId: string) {
    return bandRoom.preview(this.band, inviterId, userId);
  }

  joinBand(user: { userId: string; name: string }, code: { inviterId: string; madeAt: number }, now: number) {
    return bandRoom.join(this.band, user, code, now);
  }

  makeAdmin(adminId: string, userId: string) {
    return bandRoom.makeAdmin(this.band, adminId, userId);
  }

  removeMember(adminId: string, userId: string, now: number) {
    const band = bandRoom.remove(this.band, adminId, userId, now);
    this.closeMember(userId);
    return band;
  }

  leaveBand(userId: string, now: number) {
    bandRoom.leave(this.band, userId, now);
    this.closeMember(userId);
  }

  requireAdmin(userId: string) {
    bandRoom.requireAdmin(this.band, userId);
  }

  setScrollWithLeader(adminId: string, on: boolean) {
    return bandRoom.setScrollWithLeader(this.band, adminId, on);
  }

  bandPack(userId: string) {
    return bandRoom.pack(this.band, userId);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const rx = Date.now();
    const inbound = parseInbound(message);
    if (!inbound) return send(ws, { kind: "error", error: "bad-message" });
    const target = this.ctx.getWebSockets(inbound.to).find((ws) => this.ctx.getTags(ws)[0] === inbound.to);
    if (!target) return send(ws, { kind: "error", error: "no-peer", to: inbound.to });
    const from = this.ctx.getTags(ws)[0];
    send(target, { kind: inbound.kind, from, body: inbound.body, rx, tx: Date.now() });
  }
}
