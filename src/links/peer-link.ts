import type { BandMs, LinkRoute } from "../band-time";
import { routeOfPair, selectedPair } from "./wifi-link";
import { LINK_LOST, WiredLink, asWire } from "./wire";

/** One kind of direct link in the Attempt table: which local addresses it offers, which servers find them, and how long it gets. */
export type PeerRow = { route: Exclude<LinkRoute, "server">; deadlineMs: number; candidate: "host" | "srflx"; iceServers: RTCIceServer[]; failed: string };

/** What the room carries between the two phones to make a data channel. `a` names one attempt, so a late answer to an old one is dropped. */
export type Intro = { a: string; sdp?: string; candidate?: RTCIceCandidateInit };

export interface Peer {
  readonly a: string;
  readonly link: WiredLink;
  hear(intro: Intro): void;
  /** Reads the candidate pair again and relabels the link if it moved. */
  relabel(): Promise<void>;
}

/**
 * Internet addresses go out this long after the Wi-Fi addresses, so a Wi-Fi link that can form has formed before an
 * internet pair is offered. Without it a hairpin path through the router can win the race and the band rides the internet.
 */
export const WIFI_HEAD_START_MS = 1000;

/**
 * A pair that reached the other phone only as a peer-reflexive address may be its public address seen before its
 * candidate arrived. Chrome renames it once the candidate lands (measured 114 ms later), so the link waits before naming itself.
 */
export const PRFLX_SETTLE_MS = 500;

const typeOf = (candidate: RTCIceCandidate) => candidate.type ?? /\btyp (\w+)/.exec(candidate.candidate)?.[1];

/**
 * A data channel to one other phone. One connection gathers every row's addresses at once, and the link is labeled
 * from the candidate pair that connected, not from the row that asked (PLAN.md 7.5 Auto).
 */
function peer(a: string, rows: readonly PeerRow[], signal: (intro: Intro) => void, dialing: boolean, bandNow: (() => BandMs) | null): Peer {
  const pc = new RTCPeerConnection({ iceServers: rows.flatMap((row) => row.iceServers) });
  const offered = new Set<string>(rows.map((row) => row.candidate));
  let channel: RTCDataChannel | null = null;
  const held: RTCIceCandidateInit[] = [];
  let headStart: ReturnType<typeof setTimeout> | null = offered.has("host") && offered.has("srflx") ? setTimeout(() => {
    headStart = null;
    if (live()) held.splice(0).forEach((candidate) => signal({ a, candidate }));
  }, WIFI_HEAD_START_MS) : null;
  const link = new WiredLink(
    rows[0]?.route ?? "wifi",
    (wire) => {
      if (channel?.readyState === "open") channel.send(JSON.stringify(wire));
    },
    () => {
      if (headStart) clearTimeout(headStart);
      if (settle) clearTimeout(settle);
      headStart = settle = null;
      channel?.close();
      pc.close();
    },
    bandNow,
  );
  const live = () => link.state !== "closed";

  let settle: ReturnType<typeof setTimeout> | null = null;
  const relabel = async () => {
    const stats = await pc.getStats().catch(() => null);
    const pair = stats && selectedPair(stats as unknown as Parameters<typeof selectedPair>[0]);
    if (pair) link.relabel(routeOfPair(pair));
    return pair;
  };
  const open = async () => {
    const pair = await relabel();
    if (pair?.remote.type === "prflx" && live()) {
      await new Promise((done) => (settle = setTimeout(done, PRFLX_SETTLE_MS)));
      settle = null;
      await relabel();
    }
    link.opened();
  };

  const wire = (dc: RTCDataChannel) => {
    channel = dc;
    dc.addEventListener("open", () => void open());
    dc.addEventListener("close", () => link.end(LINK_LOST));
    dc.addEventListener("message", (event) => {
      const message = typeof event.data === "string" ? asWire(JSON.parse(event.data)) : null;
      if (message) link.receive(message);
    });
  };

  pc.addEventListener("icecandidate", (event) => {
    const candidate = event.candidate;
    const type = candidate && typeOf(candidate);
    if (!candidate || !live() || !offered.has(type ?? "")) return;
    if (type === "srflx" && headStart) held.push(candidate.toJSON());
    else signal({ a, candidate: candidate.toJSON() });
  });
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") link.end(LINK_LOST);
  });

  let heard = Promise.resolve();
  const handle = async (intro: Intro) => {
    if (!live()) return;
    if (intro.sdp) {
      await pc.setRemoteDescription({ type: dialing ? "answer" : "offer", sdp: intro.sdp });
      if (dialing || !live()) return;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (live()) signal({ a, sdp: answer.sdp });
    } else if (intro.candidate && pc.remoteDescription) {
      await pc.addIceCandidate(intro.candidate).catch(() => {});
      if (link.state === "open") await relabel();
    }
  };

  if (dialing) {
    wire(pc.createDataChannel("mls"));
    heard = (async () => {
      const offer = await pc.createOffer();
      if (!live()) return;
      await pc.setLocalDescription(offer);
      if (live()) signal({ a, sdp: offer.sdp });
    })().catch(() => link.end(LINK_LOST));
  } else {
    pc.addEventListener("datachannel", (event) => wire(event.channel));
  }

  return {
    a,
    link,
    relabel: async () => void (await relabel()),
    /** One at a time and in order, so a candidate never runs ahead of the description it belongs to. */
    hear(intro) {
      heard = heard.then(() => handle(intro)).catch(() => link.end(LINK_LOST));
    },
  };
}

/** A follower's side: makes the offer and pings the leader. */
export const dialPeer = (a: string, rows: readonly PeerRow[], signal: (intro: Intro) => void) => peer(a, rows, signal, true, null);

/** The leader's side: answers an offer and stamps band time on every ping. */
export const answerPeer = (a: string, rows: readonly PeerRow[], signal: (intro: Intro) => void, bandNow: () => BandMs) => peer(a, rows, signal, false, bandNow);
