import { DurableObject } from "cloudflare:workers";

const RELAYED = ["intro", "ping", "pong"] as const;
type RelayKind = (typeof RELAYED)[number];

type Inbound = { kind: RelayKind; to: string; body: unknown };

export type Outbound =
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

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ room: this.ctx.id.name, peers: this.ctx.getWebSockets().length });
    }
    const peers = this.ctx.getWebSockets().map((ws) => this.ctx.getTags(ws)[0]);
    const you = crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [you]);
    send(server, { kind: "hello", you, peers });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const rx = Date.now();
    const inbound = parseInbound(message);
    if (!inbound) return send(ws, { kind: "error", error: "bad-message" });
    const target = this.ctx.getWebSockets(inbound.to)[0];
    if (!target) return send(ws, { kind: "error", error: "no-peer", to: inbound.to });
    const from = this.ctx.getTags(ws)[0];
    send(target, { kind: inbound.kind, from, body: inbound.body, rx, tx: Date.now() });
  }
}
