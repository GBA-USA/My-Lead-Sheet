import { DurableObject } from "cloudflare:workers";
import { NOT_A_MEMBER_CLOSE, type ChatMessage } from "../src/chat-model";
import { GIG_SEND_MAX_CHARS, asGigSend, type GigCopy, type GigRefused, type GigSend } from "../src/leader-fanout";
import { NOT_ON_LINEUP_CLOSE, type GigPeers, type Hello, type JoinGig, type OnLineup } from "../src/links/link";
import type { Person } from "./directory-http";
import type { Env } from "./index";
import { handleBackup, myLibraryPerAccount } from "./room-backup";
import { chatRoom, createChatTables, type Card, type Posted } from "./room-chat";
import { exportBand, importBandFile } from "./room-export";
import { bandLibrary, createLibraryTables, selfCopies, type SentSetlist, type SetlistFields, type SetlistSend, type SetlistShare, type SongChange, type SongShare } from "./room-library";
import { createGigTables, gigRoom, type GigFields } from "./room-gig";
import { createGuestTables, guestRoom, liveGuestGigs, type PassFields } from "./room-guest";
import { gigRelay } from "./room-relay";
import { bandRoom, createMemberTables, readsChat, shutOut } from "./room-members";
import { createNoteTables, noteRoom, type NoteFields } from "./room-notes";
import { Refused } from "./refused";
import type { RouteChoice } from "../src/routes";
import type { StoredShare } from "./share-guard";

/** `link` carries the server route (src/links/server-link.ts); `intro` carries the introductions that make a data channel. */
const RELAYED = ["intro", "ping", "pong", "link"] as const;
type RelayKind = (typeof RELAYED)[number];

/** `gig-state` asks for the room's copy of the gig's state; `gig-op` and `gig-start` carry the leader's new state. */
type Inbound = { kind: RelayKind; to: string; body: unknown } | JoinGig | { kind: "gig-state"; gigId: string } | GigSend;

type Outbound =
  | Hello
  | { kind: RelayKind; from: string; body: unknown; rx: number; tx: number }
  | { kind: "message"; message: ChatMessage }
  | GigPeers
  | GigCopy
  | GigRefused
  | OnLineup
  | { kind: "error"; error: "bad-message" | "no-peer" | "not-on-lineup"; to?: string };

/** What a socket carries across hibernation: its session version, and the gig it joined (and when its phone opened it) once the lineup check passed. */
type Attachment = { version: number; gigId?: string; openedAt?: number };

function parseInbound(message: string | ArrayBuffer): Inbound | null {
  if (typeof message !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, to, body, gigId, openedAt } = value as Record<string, unknown>;
  if (kind === "gig-state") return typeof gigId === "string" ? { kind, gigId } : null;
  if (kind === "gig-op" || kind === "gig-start") return message.length <= GIG_SEND_MAX_CHARS ? asGigSend(value) : null;
  if (kind === "join-gig") return typeof gigId === "string" ? { kind, gigId, ...(Number.isFinite(openedAt) ? { openedAt: openedAt as number } : {}) } : null;
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
    createGuestTables(ctx.storage.sql);
  }

  private floor(userId: string): number {
    return this.ctx.storage.sql.exec<{ version: number }>(`SELECT version FROM session_floors WHERE user_id = ?`, userId).toArray()[0]?.version ?? 0;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    const version = Number(request.headers.get(SESSION_HEADER));
    if (!userId || !(version >= this.floor(userId))) return Response.json({ error: "signed-out" }, { status: 401 });
    if (shutOut(this.ctx.storage.sql, userId, request.headers.get("Upgrade") === "websocket")) return Response.json({ error: "not-a-member" }, { status: 403 });
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
    send(server, { kind: "hello", you, peers, lineups: [...this.lineups(userId).keys()] });
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
    if (posted.stored) for (const ws of this.ctx.getWebSockets()) if (readsChat(this.ctx.storage.sql, this.userOf(ws))) send(ws, { kind: "message", message: posted.message });
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
    for (const ws of this.ctx.getWebSockets()) {
      const joined = attachment(ws).gigId === gigId;
      const onLineup = view.gig.lineup.includes(this.userOf(ws));
      if (joined && !onLineup) ws.close(NOT_ON_LINEUP_CLOSE, "not-on-lineup");
      if (!joined && onLineup) send(ws, { kind: "on-lineup", gigId });
    }
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

  guestCreate(adminId: string, fields: PassFields, codeId: string) {
    return guestRoom.create(this.band, adminId, fields, codeId);
  }

  guestList(adminId: string, gigId: string) {
    return guestRoom.list(this.band, adminId, gigId);
  }

  /** Revoke closes the guest's link to the gig at once, and tells the lineup's phones to ask again for the new secret. */
  guestRevoke(adminId: string, passId: string) {
    const revoked = guestRoom.revoke(this.band, adminId, passId);
    const { gigId } = revoked.pass;
    const guest = revoked.claimedBy;
    const out = guest !== null && shutOut(this.ctx.storage.sql, guest, true);
    for (const ws of this.ctx.getWebSockets()) {
      const joined = attachment(ws).gigId === gigId;
      if (guest !== null && this.userOf(ws) === guest && (out || joined)) ws.close(NOT_ON_LINEUP_CLOSE, "pass-revoked");
      else if (joined) send(ws, { kind: "on-lineup", gigId });
    }
    return revoked;
  }

  guestOpen(userId: string, passId: string, now: number) {
    return guestRoom.open(this.band, userId, passId, now);
  }

  guestClaim(userId: string, passId: string, now: number) {
    return this.ctx.storage.transactionSync(() => guestRoom.claim(this.band, userId, passId, now));
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
  private gigSockets = (gigId: string) => this.ctx.getWebSockets().filter((ws) => attachment(ws).gigId === gigId && this.stillIn(ws, gigId));

  /** A guest's socket stays in the gig only while the pass lasts. One that ended is closed here, as revoke closes it, so no later move reaches it. */
  private stillIn(ws: WebSocket, gigId: string) {
    const userId = this.userOf(ws);
    if (!shutOut(this.ctx.storage.sql, userId) || liveGuestGigs(this.ctx.storage.sql, userId).has(gigId)) return true;
    ws.close(NOT_ON_LINEUP_CLOSE, "pass-ended");
    return false;
  }

  /** A band or DM room gates its relay on tonight's lineup. A bare room with no members relays between any two sockets. */
  private get gated() {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM meta`).toArray().length > 0;
  }

  /**
   * The gigs `userId` is on the lineup of, each with its leader. Membership alone is not enough (PLAN.md 7.14), and an
   * admin who isn't playing is not let in. `hello` and `join-gig` both read this, so the greeting never disagrees with the join.
   */
  private lineups(userId: string): Map<string, string> {
    try {
      return gigRoom.lineups(this.band, userId);
    } catch (error) {
      if (error instanceof Refused) return new Map();
      throw error;
    }
  }

  /**
   * Lineup players are told where the leader's socket is, and when the leader arrives the waiting players are told too.
   * Of the leader's phones, the one that opened the gig first leads until it leaves, so opening the gig on a second phone
   * moves nobody. A reconnecting phone sends back the `openedAt` it was given (only ever earlier than now), so a room
   * blip keeps its place.
   */
  private joinGig(ws: WebSocket, { gigId, openedAt }: JoinGig) {
    const leader = this.lineups(this.userOf(ws)).get(gigId);
    if (!leader) return ws.close(NOT_ON_LINEUP_CLOSE, "not-on-lineup");
    const now = Date.now();
    ws.serializeAttachment({ ...attachment(ws), gigId, openedAt: Math.min(openedAt ?? now, now) });
    const sockets = this.gigSockets(gigId);
    const opened = (socket: WebSocket) => attachment(socket).openedAt ?? now;
    const leaderSocket = sockets.filter((other) => this.userOf(other) === leader).sort((a, b) => opened(a) - opened(b))[0];
    const tell = (to: WebSocket) =>
      send(to, { kind: "gig", gigId, you: this.socketId(to), leader: leaderSocket ? this.socketId(leaderSocket) : null, openedAt: opened(to) });
    if (leaderSocket === ws) for (const other of sockets) if (other !== ws) tell(other);
    tell(ws);
  }

  /** A lineup player asks for the room's copy. That also joins the gig's socket list, so every later copy reaches it. */
  private askGig(ws: WebSocket, gigId: string) {
    if (!this.lineups(this.userOf(ws)).get(gigId)) return ws.close(NOT_ON_LINEUP_CLOSE, "not-on-lineup");
    if (attachment(ws).gigId !== gigId) ws.serializeAttachment({ ...attachment(ws), gigId, openedAt: Date.now() });
    send(ws, gigRelay.copy(this.ctx.storage.sql, gigId));
  }

  /** The leader's new state: kept and forwarded to the rest of the gig's sockets only when this send stored it. */
  private takeGig(ws: WebSocket, sent: GigSend) {
    if (shutOut(this.ctx.storage.sql, this.userOf(ws))) return send(ws, { kind: "gig-refused", opId: sent.kind === "gig-op" ? sent.op.opId : null, refused: "not-allowed" });
    const taken = gigRelay.take(this.ctx.storage.sql, attachment(ws).gigId ?? null, this.userOf(ws), sent, Date.now());
    if (!taken.stored) return send(ws, { kind: "gig-refused", opId: sent.kind === "gig-op" ? sent.op.opId : null, refused: taken.refused });
    for (const other of this.gigSockets(taken.copy.state.gigId)) if (other !== ws) send(other, taken.copy);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const rx = Date.now();
    const inbound = parseInbound(message);
    if (!inbound) return send(ws, { kind: "error", error: "bad-message" });
    if (inbound.kind === "join-gig") return this.joinGig(ws, inbound);
    if (inbound.kind === "gig-state") return this.askGig(ws, inbound.gigId);
    if (inbound.kind === "gig-op" || inbound.kind === "gig-start") return this.takeGig(ws, inbound);
    const target = this.ctx.getWebSockets(inbound.to).find((ws) => this.socketId(ws) === inbound.to);
    if (!target) return send(ws, { kind: "error", error: "no-peer", to: inbound.to });
    const gigId = attachment(ws).gigId;
    if (this.gated && (!gigId || attachment(target).gigId !== gigId)) return send(ws, { kind: "error", error: "not-on-lineup", to: inbound.to });
    send(target, { kind: inbound.kind, from: this.socketId(ws), body: inbound.body, rx, tx: Date.now() });
  }
}
