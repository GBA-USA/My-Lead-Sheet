import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { handleBackup } from "./room-backup";

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
export const BACKUP_PATH = "/api/backup";

const userTag = (userId: string) => `user:${userId}`;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_floors (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
  }

  private floor(userId: string): number {
    return this.ctx.storage.sql.exec<{ version: number }>(`SELECT version FROM session_floors WHERE user_id = ?`, userId).toArray()[0]?.version ?? 0;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    const version = Number(request.headers.get(SESSION_HEADER));
    if (!userId || !(version >= this.floor(userId))) return Response.json({ error: "signed-out" }, { status: 401 });
    if (new URL(request.url).pathname === BACKUP_PATH) return handleBackup(request, this.ctx.storage, this.ctx.id.name, userId);
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
