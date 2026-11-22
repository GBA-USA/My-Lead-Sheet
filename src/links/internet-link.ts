import type { PeerRow } from "./peer-link";

/**
 * The over-the-internet row: a data channel between the phones' public addresses, found with free public STUN. Only
 * `stun:` and `stuns:` URLs pass, so no TURN relay can reach an ICE config. The URLs come from the caller.
 */
export function internetRow(stun: readonly string[]): PeerRow {
  const urls = stun.filter((url) => /^stuns?:/.test(url));
  return { route: "internet", deadlineMs: 8000, candidate: "srflx", iceServers: urls.length ? [{ urls }] : [], failed: "No direct path over the internet" };
}
