import { BURST, PING_EVERY_MS, addPing, newClock, rebase, type BandMs, type Clock, type LinkRoute } from "../band-time";
import { internetRow } from "./internet-link";
import type { Attempt, GigPeers, JoinGig, Link } from "./link";
import { answerPeer, dialPeer, type Intro, type Peer, type PeerRow } from "./peer-link";
import { NO_SIGNAL, WAITING_FOR_LEADER, refusedWords, serverLink, type RoomIn, type RoomLine } from "./server-link";
import { SIGN_IN_FIRST, WIFI_ROW, signInPage } from "./wifi-link";
import { LINK_LOST, asWire, localNow, type WiredLink } from "./wire";

/**
 * The Attempt table, best first (PLAN.md 7.2). Each direct row says which addresses it offers. A route that fails its
 * real-phone spike (C1 for the Wi-Fi link, C2 for the internet) comes out of this table and nothing else changes.
 */
export const ROUTES: readonly LinkRoute[] = ["wifi", "internet", "server"];
const PEER_ROWS: Record<Exclude<LinkRoute, "server">, (stun: readonly string[]) => PeerRow> = { wifi: () => WIFI_ROW, internet: internetRow };

/** No answer to any ping for this long and the link counts as lost (PLAN.md 7.13's 10 s). */
export const LOST_AFTER_MS = 10_000;
/** A beat between losing a link and asking the room again, so a room that refuses fast is not asked in a tight loop. */
const ASK_AGAIN_MS = 1000;

export interface LinkOptions {
  room: RoomLine;
  gigId: string;
  /** Free public STUN URLs for the internet row. Anything that is not `stun:` or `stuns:` is dropped. */
  stun: readonly string[];
  /** Which rows of the table to try, for a forced route or a no-go. Every row by default. */
  rows?: readonly LinkRoute[];
  /** Where the sign-in page check asks. */
  healthUrl?: string;
  /** The leader's band time, read only if the room makes this phone the leader. */
  bandNow?: () => BandMs;
  onChange?: () => void;
}

export interface GigLinks {
  attempt(): Attempt;
  /** The follower's estimate of the leader's clock. It carries across links: a new link rebases it and never restarts it. */
  clock(): Clock;
  leading(): boolean;
  /** On the leader's phone, one link per follower and route. */
  followers(): Link[];
  close(): void;
}

const rank = (route: LinkRoute) => ROUTES.indexOf(route);

/**
 * Join gig: ask the room for tonight's leader, then make one attempt with every address type at once and fall to the
 * server if no direct link opens in time. A lost link is introduced again through the room with no tap from the person.
 * If the room says this phone leads, it answers instead.
 */
export function linkToLeader(options: LinkOptions): GigLinks {
  const { room, gigId } = options;
  const routes = options.rows ?? ROUTES;
  const rows = routes.filter((route) => route !== "server").map((route) => PEER_ROWS[route as keyof typeof PEER_ROWS](options.stun));
  const bandNow = options.bandNow ?? (() => localNow() as number as BandMs);
  const healthUrl = options.healthUrl ?? "/api/health";

  let closed = false;
  let leading = false;
  let leader: string | null = null;
  /** When the room says this phone opened the gig, sent back on each reconnect so a leader's phone keeps its place. */
  let openedAt: number | null = null;
  let tried: LinkRoute[] = [];
  let reasons: Attempt["reasons"] = {};
  let chosen: WiredLink | null = null;
  let trying: { to: string; peer: Peer | null } | null = null;
  let clock = newClock();
  let hadLink = false;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let askTimer: ReturnType<typeof setTimeout> | null = null;
  const followers = new Map<string, { peer: Peer | null; server: WiredLink | null }>();

  const changed = () => {
    if (!closed) options.onChange?.();
  };
  const stopTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
    return null;
  };

  const ask = () => {
    askTimer = stopTimer(askTimer);
    if (!closed) room.send({ kind: "join-gig", gigId, ...(openedAt === null ? {} : { openedAt }) } satisfies JoinGig);
  };
  const askSoon = () => {
    askTimer = stopTimer(askTimer);
    if (!closed) askTimer = setTimeout(ask, ASK_AGAIN_MS);
  };

  function startPings(link: WiredLink) {
    let burst = BURST.pings;
    let heard = localNow();
    const tick = () => {
      pingTimer = stopTimer(pingTimer);
      if (link !== chosen || link.state !== "open") return;
      if (localNow() - heard > LOST_AFTER_MS) return link.end(LINK_LOST);
      link.ping().then(
        (ping) => {
          if (link !== chosen) return;
          heard = localNow();
          clock = addPing(clock, ping, null);
          changed();
        },
        () => {},
      );
      pingTimer = setTimeout(tick, burst-- > 0 ? BURST.everyMs : PING_EVERY_MS[link.route]);
    };
    tick();
  }

  /** Make before break: the new link is open before the old one closes, and the clock carries across with `rebase`. */
  function choose(link: WiredLink | null) {
    if (link === chosen) return;
    const old = chosen;
    chosen = link;
    pingTimer = stopTimer(pingTimer);
    if (link) {
      if (hadLink) clock = rebase(clock);
      hadLink = true;
      for (const row of rows) if (rank(row.route) >= rank(link.route) && reasons[row.route] === row.failed) delete reasons[row.route];
      startPings(link);
    }
    old?.close();
    changed();
  }

  function lostChosen(link: WiredLink) {
    if (chosen !== link) return;
    chosen = null;
    pingTimer = stopTimer(pingTimer);
    changed();
    askSoon();
  }

  function stopTrying() {
    deadlineTimer = stopTimer(deadlineTimer);
    trying?.peer?.link.close();
    trying = null;
  }

  function fallToServer(to: string) {
    if (!routes.includes("server") || closed) return changed();
    if (!tried.includes("server")) tried = [...tried, "server"];
    const link = serverLink(room, to, null);
    link.onState((state) => state === "closed" && lostChosen(link));
    if (link.state === "open" && (!chosen || chosen.state !== "open")) choose(link);
    else link.close();
  }

  /** At each row's deadline: say why the row is not in use, and after the last one fall to the server. The direct try keeps going. */
  function judge(steps: PeerRow[], at: number, now: { to: string; peer: Peer | null }) {
    deadlineTimer = null;
    const row = steps[at];
    const last = at === steps.length - 1;
    const linked = () => now.peer?.link.state === "open";
    void (now.peer && linked() ? now.peer.relabel() : Promise.resolve()).then(() => {
      if (closed || trying !== now) return;
      const route = now.peer!.link.route;
      if (!linked() || rank(route) > rank(row.route)) reasons = { ...reasons, [row.route]: row.failed };
      if (last && !linked()) fallToServer(now.to);
      else if (!last) deadlineTimer = setTimeout(() => judge(steps, at + 1, now), steps[at + 1].deadlineMs - row.deadlineMs);
      changed();
    });
  }

  function attempt(to: string) {
    stopTrying();
    tried = rows.map((row) => row.route);
    reasons = {};
    const now: { to: string; peer: Peer | null } = { to, peer: null };
    trying = now;
    if (rows.length === 0) {
      fallToServer(to);
      return changed();
    }
    const peer = dialPeer(crypto.randomUUID(), rows, (intro) => room.send({ kind: "intro", to, body: intro }));
    now.peer = peer;
    peer.link.onState((state) => {
      if (state === "open" && trying === now) choose(peer.link);
      if (state === "closed") lostChosen(peer.link);
      changed();
    });
    if (rows.some((row) => row.route === "wifi")) {
      void signInPage(healthUrl).then((portal) => {
        if (!portal || closed || trying !== now || reasons.wifi) return;
        reasons = { ...reasons, wifi: SIGN_IN_FIRST };
        changed();
      });
    }
    const steps = [...rows].sort((x, y) => x.deadlineMs - y.deadlineMs);
    deadlineTimer = setTimeout(() => judge(steps, 0, now), steps[0].deadlineMs);
    changed();
  }

  function onGig(message: GigPeers) {
    if (message.gigId !== gigId) return;
    openedAt = message.openedAt;
    if (message.leader === message.you) return lead();
    if (leading) dropFollowers();
    leading = false;
    leader = message.leader;
    if (!leader) {
      if (!chosen || chosen.route === "server") {
        stopTrying();
        choose(null);
        tried = [];
        reasons = { server: WAITING_FOR_LEADER };
      }
      return changed();
    }
    if (chosen?.state === "open" && (chosen.route !== "server" || trying?.to === leader)) return;
    if (trying?.to === leader && deadlineTimer && trying.peer?.link.state !== "closed") return;
    attempt(leader);
  }

  /** Also on a room that came back: the leader's "No signal" from the drop clears. */
  function lead() {
    reasons = {};
    if (!leading) {
      leading = true;
      leader = null;
      stopTrying();
      choose(null);
      tried = [];
    }
    changed();
  }

  function follower(from: string) {
    let entry = followers.get(from);
    if (!entry) followers.set(from, (entry = { peer: null, server: null }));
    return entry;
  }

  /** A follower whose links have all closed is forgotten, so a long gig of reconnects keeps nothing behind. */
  function forget(from: string, entry: { peer: Peer | null; server: WiredLink | null }) {
    if (!entry.peer && !entry.server && followers.get(from) === entry) followers.delete(from);
    changed();
  }

  function answer(from: string, intro: Intro) {
    const entry = follower(from);
    if (intro.sdp && entry.peer?.a !== intro.a) {
      entry.peer?.link.close();
      const peer = answerPeer(intro.a, rows, (reply) => room.send({ kind: "intro", to: from, body: reply }), bandNow);
      entry.peer = peer;
      peer.link.onState((state) => {
        if (state === "closed" && entry.peer === peer) entry.peer = null;
        forget(from, entry);
      });
    }
    if (entry.peer?.a === intro.a) entry.peer.hear(intro);
  }

  function carry(from: string, message: RoomIn) {
    const entry = follower(from);
    if (entry.server?.state === "open") return;
    const link = serverLink(room, from, bandNow);
    entry.server = link;
    link.onState((state) => {
      if (state === "closed" && entry.server === link) entry.server = null;
      forget(from, entry);
    });
    const wire = asWire(message.body);
    if (wire) link.receive(wire);
    changed();
  }

  const isIntro = (body: unknown): body is Intro => typeof body === "object" && body !== null && typeof (body as Intro).a === "string";

  const unlisten = room.listen((message) => {
    if (closed) return;
    if (message.kind === "hello") return ask();
    if (message.kind === "gig") return onGig(message as unknown as GigPeers);
    if (message.kind === "intro" && typeof message.from === "string" && isIntro(message.body)) {
      if (leading) return answer(message.from, message.body);
      if (trying?.to === message.from && trying.peer?.a === message.body.a) trying.peer.hear(message.body);
      return;
    }
    if (message.kind === "link" && leading && typeof message.from === "string") return carry(message.from, message);
    if (message.kind === "error" && !leading && trying && message.to === trying.to && trying.peer?.link.state !== "open") {
      stopTrying();
      return askSoon();
    }
    if (message.kind === "room-down" && (!chosen || chosen.state !== "open")) {
      reasons = { ...reasons, server: NO_SIGNAL };
      return changed();
    }
    if (message.kind === "room-refused") {
      stop();
      reasons = { server: refusedWords(Number(message.code)) };
      changed();
    }
  });
  if (room.state === "open") ask();

  function stop() {
    askTimer = stopTimer(askTimer);
    pingTimer = stopTimer(pingTimer);
    stopTrying();
    const was = chosen;
    chosen = null;
    was?.close();
    dropFollowers();
    tried = [];
  }

  function dropFollowers() {
    for (const entry of followers.values()) {
      entry.peer?.link.close();
      entry.server?.close();
    }
    followers.clear();
  }

  return {
    attempt: () => ({ tried: [...tried], chosen, reasons: { ...reasons } }),
    clock: () => clock,
    leading: () => leading,
    followers: () => [...followers.values()].flatMap((entry) => [entry.peer?.link, entry.server].filter((link): link is WiredLink => !!link)),
    close() {
      if (closed) return;
      closed = true;
      stop();
      unlisten();
    },
  };
}
