import type { LinkRoute } from "../band-time";
import type { PeerRow } from "./peer-link";

/** The Wi-Fi link row: a data channel over whatever Wi-Fi the phones share, made from host addresses alone (PLAN.md 7.2). */
export const WIFI_ROW: PeerRow = { route: "wifi", deadlineMs: 5000, candidate: "host", iceServers: [], failed: "This Wi-Fi keeps phones apart" };

export const SIGN_IN_FIRST = "This Wi-Fi wants you to sign in first";

type Side = { type: string; protocol: string; relayProtocol: string | null; address: string };
export type CandidatePair = { local: Side; remote: Side };

/** A `getStats` report, or anything shaped like one (a Map of stats by id). */
type Stats = { forEach(cb: (entry: Record<string, unknown>) => void): void; get(id: string): Record<string, unknown> | undefined };

function addressKind(address: unknown): string {
  if (typeof address !== "string" || !address) return "hidden";
  if (address.endsWith(".local")) return "local-name";
  return address.includes(":") ? "ipv6" : "ipv4";
}

/** The candidate pair a data channel is using: the transport's pick in Chrome, the nominated pair in Safari (spike/lan/links.js). */
export function selectedPair(stats: Stats): CandidatePair | null {
  let pair: Record<string, unknown> | undefined;
  stats.forEach((entry) => {
    if (entry.type === "transport" && typeof entry.selectedCandidatePairId === "string") pair = stats.get(entry.selectedCandidatePairId) ?? pair;
  });
  if (!pair) {
    stats.forEach((entry) => {
      if (!pair && entry.type === "candidate-pair" && (entry.selected === true || (entry.nominated === true && entry.state === "succeeded"))) pair = entry;
    });
  }
  if (!pair) return null;
  const side = (id: unknown): Side | null => {
    const candidate = typeof id === "string" ? stats.get(id) : undefined;
    if (!candidate) return null;
    return { type: String(candidate.candidateType), protocol: String(candidate.protocol), relayProtocol: (candidate.relayProtocol as string) ?? null, address: addressKind(candidate.address ?? candidate.ip) };
  };
  const local = side(pair.localCandidateId);
  const remote = side(pair.remoteCandidateId);
  return local && remote ? { local, remote } : null;
}

/**
 * Reaching the other phone's own address (host) is the Wi-Fi link, and so is reaching it from ours when it was seen only
 * by its checks (prflx). Its public address (srflx) went over the internet. No pair means the room carries it. The local
 * type alone can't decide: when STUN answers before a `.local` name is registered, Chrome lists the srflx candidate first.
 */
export function routeOfPair(pair: CandidatePair | null): LinkRoute {
  if (!pair) return "server";
  return pair.remote.type === "host" || (pair.remote.type === "prflx" && pair.local.type === "host") ? "wifi" : "internet";
}

/**
 * Whether a sign-in page (captive portal) sits in front of the internet: the health check is sent elsewhere or answers
 * with something that is not our server. No answer at all is not a sign-in page, and the room's state says that.
 */
export async function signInPage(healthUrl: string): Promise<boolean> {
  try {
    const reply = await fetch(healthUrl, { redirect: "manual", cache: "no-store" });
    if (reply.type === "opaqueredirect" || (reply.status >= 300 && reply.status < 400)) return true;
    const body = (await reply.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok !== true;
  } catch {
    return false;
  }
}
