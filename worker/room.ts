import { DurableObject } from "cloudflare:workers";
import { NOT_A_MEMBER_CLOSE, type ChatMessage } from "../src/chat-model";
import { NOT_ON_LINEUP_CLOSE, type GigPeers } from "../src/links/link";
import type { Person } from "./directory-http";
import type { Env } from "./index";
import { handleBackup, myLibraryPerAccount } from "./room-backup";
import { chatRoom, createChatTables, type Card, type Posted } from "./room-chat";
import { exportBand, importBandFile } from "./room-export";
import { bandLibrary, createLibraryTables, selfCopies, type SentSetlist, type SetlistFields, type SetlistSend, type SetlistShare, type SongChange, type SongShare } from "./room-library";
import { createGigTables, gigRoom, type GigFields } from "./room-gig";
import { bandRoom, createMemberTables, shutOut } from "./room-members";
import { createNoteTables, noteRoom, type NoteFields } from "./room-notes";
import { Refused } from "./refused";
import type { RouteChoice } from "../src/routes";
import type { StoredShare } from "./share-guard";

/** `link` carries the server route (src/links/server-link.ts); `intro` carries the introductions that make a data channel. */
const RELAYED = ["intro", "ping", "pong", "link"] as const;
type RelayKind = (typeof RELAYED)[number];

type Inbound = { kind: RelayKind; to: string; body: unknown } | { kind: "join-gig"; gigId: string };

type Outbound =
  | { kind: "hello"; you: string; peers: string[] }
  | { kind: RelayKind; from: string; body: unknown; rx: number; tx: number }
  | { kind: "message"; message: ChatMessage }
  | GigPeers
  | { kind: "error"; error: "bad-message" | "no-peer" | "not-on-lineup"; to?: string };

/** What a socket carries across hibernation: its session version, and the gig it joined (and when) once the lineup check passed. */
type Attachment = { version: number; gigId?: string; joinedAt?: number };

function parseInbound(message: string | ArrayBuffer): Inbound | null {
  if (typeof message !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, to, body, gigId } = value as Record<string, unknown>;
  if (kind === "join-gig") return typeof gigId === "string" ? { kind, gigId } : null;
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
const attachment = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_floors (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
    createMemberTables(ctx.storage.sql);
    createChatTables(ctx.storage.sql);
    createLibraryTables(ctx.storage.sql);
    createGigTables(ctx.storage.sql);
    createNoteTables(ctx.storage.sql);
  }

  private floor(userId: string): number {
    return this.ctx.storage.sql.exec<{ version: number }>(`SELECT version FROM session_floors WHERE user_id = ?`, userId).toArray()[0]?.version ?? 0;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    const version = Number(request.headers.get(SESSION_HEADER));
    if (!userId || !(version >= this.floor(userId))) return Response.json({ error: "signed-out" }, { status: 401 });
    if (shutOut(this.ctx.storage.sql, userId)) return Response.json({ error: "not-a-member" }, { status: 403 });
    if (new URL(request.url).pathname === BACKUP_PATH) return handleBackup(request, this.ctx.storage, this.ctx.id.name, userId, myLibraryPerAccount(this.env.MY_SONGS_PER_ACCOUNT));
    if (request.method === "POST") return importBandFile(request, this.ctx.storage, this.band, userId, this.env.APP_ORIGIN);
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
      if (attachment(ws).version < version) ws.close(SIGNED_OUT_CLOSE, "signed-out");
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
    gigRoom.dropMember(this.band, userId);
    this.closeMember(userId);
    return band;
  }

  leaveBand(userId: string, now: number) {
    bandRoom.leave(this.band, userId, now);
    gigRoom.dropMember(this.band, userId);
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

  createDm(people: [Person, Person], now: number) {
    chatRoom.createDm(this.band, people, now);
  }

  chatMessages(userId: string, after: number) {
    return chatRoom.messages(this.band, userId, after);
  }

  /** Stores the post, and a post this call stored goes to every phone on the room's socket. */
  chatPost(author: Person, msgId: string, text: string, now: number, card: Card | null = null) {
    return this.broadcast(chatRoom.post(this.band, author, msgId, text, now, card));
  }

  private broadcast(posted: Posted) {
    if (posted.stored) for (const ws of this.ctx.getWebSockets()) send(ws, { kind: "message", message: posted.message });
    return posted;
  }

  planGig(planner: Person, fields: GigFields, now: number) {
    const planned = gigRoom.plan(this.band, planner, fields, now);
    this.broadcast(planned.posted);
    return planned;
  }

  gigList(userId: string) {
    return gigRoom.list(this.band, userId);
  }

  gigOpen(userId: string, gigId: string) {
    return gigRoom.open(this.band, userId, gigId);
  }

  gigLineup(userId: string, gigId: string, lineup: string[]) {
    const view = gigRoom.setLineup(this.band, userId, gigId, lineup);
    for (const ws of this.gigSockets(gigId)) if (!view.gig.lineup.includes(this.userOf(ws))) ws.close(NOT_ON_LINEUP_CLOSE, "not-on-lineup");
    return view;
  }

  gigBackup(userId: string, gigId: string, backup: string | null) {
    return gigRoom.setBackup(this.band, userId, gigId, backup);
  }

  gigRoute(userId: string, gigId: string, route: RouteChoice) {
    return gigRoom.setRoute(this.band, userId, gigId, route);
  }

  gigSongs(userId: string, gigId: string, songIds: string[]) {
    return gigRoom.setSongs(this.band, userId, gigId, songIds);
  }

  gigEnd(userId: string, gigId: string, now: number) {
    return gigRoom.end(this.band, userId, gigId, now);
  }

  gigPack(userId: string, gigId: string, now: number) {
    return gigRoom.pack(this.band, this.env.SESSION_SECRET, userId, gigId, now);
  }

  gigViaLink(userId: string, gigId: string) {
    return gigRoom.viaLink(this.band, userId, gigId);
  }

  requireGigAdmin(userId: string, gigId: string) {
    gigRoom.requireGigAdmin(this.band, userId, gigId);
  }

  songNotes(userId: string, songId: string) {
    return noteRoom.list(this.band, userId, songId);
  }

  addSongNote(author: Person, fields: NoteFields, now: number) {
    const added = noteRoom.add(this.band, author, fields, now);
    this.broadcast(added.posted);
    return added;
  }

  deleteSongNote(userId: string, noteId: string, now: number) {
    return noteRoom.remove(this.band, userId, noteId, now);
  }

  bandLibrary(userId: string) {
    return bandLibrary.view(this.band, userId);
  }

  exportBand(userId: string, now: number) {
    return exportBand(this.band, userId, this.env.APP_ORIGIN, now);
  }

  requireMember(userId: string) {
    bandLibrary.requireMember(this.band, userId);
  }

  shareSong(userId: string, share: SongShare, from: StoredShare[] | null, now: number) {
    return bandLibrary.shareSong(this.band, userId, share, from, now);
  }

  shareSetlist(userId: string, fields: SetlistShare, now: number) {
    return bandLibrary.shareSetlist(this.band, userId, fields, now);
  }

  editBandSong(userId: string, songId: string, base: number, change: SongChange | null, now: number) {
    return bandLibrary.editSong(this.band, userId, songId, base, change, now);
  }

  editBandSetlist(userId: string, setlistId: string, base: number, fields: SetlistFields, now: number) {
    return bandLibrary.editSetlist(this.band, userId, setlistId, base, fields, now);
  }

  bandSetlistHolding(userId: string, setlistId: string) {
    return bandLibrary.setlistHolding(this.band, userId, setlistId);
  }

  openSetlistByCode(userId: string, setlistId: string) {
    bandLibrary.openByCode(this.band, userId, setlistId);
  }

  heldByPrint(userId: string, print: string, except: string | null, takenFrom: string[] | null) {
    return bandLibrary.heldByPrint(this.band, userId, print, except, takenFrom);
  }

  receiveCopy(from: StoredShare[], print: string) {
    selfCopies.receive(this.ctx.storage.sql, from, print);
  }

  copyChains(copyId: string | null, print: string) {
    return selfCopies.chains(this.ctx.storage.sql, copyId, print);
  }

  sendSetlist(ownerId: string, send: SetlistSend, now: number) {
    return selfCopies.sendSetlist(this.ctx.storage.sql, ownerId, send, now);
  }

  setlistSend(shareId: string): SentSetlist | null {
    return selfCopies.setlistSend(this.ctx.storage.sql, shareId);
  }

  receiveSetlist(setlist: StoredShare[], songs: { chain: StoredShare[]; print: string }[]) {
    selfCopies.receiveSetlist(this.ctx.storage.sql, setlist, songs);
  }

  heldChain(copyId: string) {
    return selfCopies.held(this.ctx.storage.sql, copyId);
  }

  private socketId = (ws: WebSocket) => this.ctx.getTags(ws)[0];
  private userOf = (ws: WebSocket) => this.ctx.getTags(ws)[1].slice("user:".length);
  private gigSockets = (gigId: string) => this.ctx.getWebSockets().filter((ws) => attachment(ws).gigId === gigId);

  /** A band or DM room gates its relay on tonight's lineup. A bare room with no members relays between any two sockets. */
  private get gated() {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM meta`).toArray().length > 0;
  }

  /** The gig's leader, if `userId` is on its lineup. Membership alone is not enough (PLAN.md 7.14), and an admin who isn't playing is not let in. */
  private lineupLeader(userId: string, gigId: string): string | null {
    try {
      const { gig } = gigRoom.open(this.band, userId, gigId);
      return gig.lineup.includes(userId) ? gig.leader : null;
    } catch (error) {
      if (error instanceof Refused) return null;
      throw error;
    }
  }

  /** Lineup players are told where the leader's socket is, and when the leader arrives the waiting players are told too. */
  private joinGig(ws: WebSocket, gigId: string) {
    const leader = this.lineupLeader(this.userOf(ws), gigId);
    if (!leader) return ws.close(NOT_ON_LINEUP_CLOSE, "not-on-lineup");
    ws.serializeAttachment({ ...attachment(ws), gigId, joinedAt: Date.now() });
    const sockets = this.gigSockets(gigId);
    const newest = (a: WebSocket, b: WebSocket) => (attachment(a).joinedAt ?? 0) - (attachment(b).joinedAt ?? 0);
    const leaderSocket = sockets.filter((other) => this.userOf(other) === leader).sort(newest).at(-1);
    const tell = (to: WebSocket) => send(to, { kind: "gig", gigId, you: this.socketId(to), leader: leaderSocket ? this.socketId(leaderSocket) : null });
    if (leaderSocket === ws) for (const other of sockets) if (other !== ws) tell(other);
    tell(ws);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const rx = Date.now();
    const inbound = parseInbound(message);
    if (!inbound) return send(ws, { kind: "error", error: "bad-message" });
    if (inbound.kind === "join-gig") return this.joinGig(ws, inbound.gigId);
    const target = this.ctx.getWebSockets(inbound.to).find((ws) => this.socketId(ws) === inbound.to);
    if (!target) return send(ws, { kind: "error", error: "no-peer", to: inbound.to });
    const gigId = attachment(ws).gigId;
    if (this.gated && (!gigId || attachment(target).gigId !== gigId)) return send(ws, { kind: "error", error: "not-on-lineup", to: inbound.to });
    send(target, { kind: inbound.kind, from: this.socketId(ws), body: inbound.body, rx, tx: Date.now() });
  }
}
