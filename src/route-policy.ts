import { ROUTES } from "./links/attempt";
import type { Attempt } from "./links/link";
import { CHOICE_WORDS, ROUTE_WORDS, type LinkRoute, type RouteChoice } from "./routes";

/** What the policy reads: this phone's setting, the gig's route while in a gig, the attempt in flight, and the clock. */
export type PolicyInput = { setting: RouteChoice; gigRoute: RouteChoice | null; attempt: Attempt; now: number; lastRetry: number };

/** What the phone does and says: the route in use (null for none yet), the strip's words, and when to try a better route. */
export type PolicyOutput = { use: LinkRoute | null; word: string; reason: string | null; retryAt: number | null };

/** When one route starts in an attempt, in ms after the attempt began. */
export type Step = { route: LinkRoute; at: number };

/** How long a route gets on its own before the next one in line starts (PLAN.md 7.5). */
export const TIMEOUT_MS: Record<LinkRoute, number> = { wifi: 5_000, internet: 8_000, server: 10_000 };
/** Auto starts the server if no direct link has opened by then. */
export const AUTO_SERVER_AFTER_MS = 10_000;
/** A phone on a fallback tries the chosen route, or a better one, this often. */
export const RETRY_EVERY_MS = 60_000;

export const CONNECTING = "Connecting";
export const CANT_CONNECT = "Can't connect";
export const KEEPING_THE_BEAT = "keeping the beat";
export const NOT_ON_WIFI = "This phone isn't on Wi-Fi";

const FORCED: Record<Exclude<RouteChoice, "auto">, LinkRoute> = { band_wifi: "wifi", direct_cell: "internet", server: "server" };

/**
 * When each route starts, best first for this choice. Auto starts every direct route at once and the server after
 * 10 s. A forced route starts alone and gets its timeout, then the others follow one at a time in the attempt table's order.
 */
export function schedule(choice: RouteChoice): Step[] {
  if (choice === "auto") return ROUTES.map((route) => ({ route, at: route === "server" ? AUTO_SERVER_AFTER_MS : 0 }));
  const first = FORCED[choice];
  let at = 0;
  return [first, ...ROUTES.filter((route) => route !== first)].map((route) => {
    const step = { route, at };
    at += TIMEOUT_MS[route];
    return step;
  });
}

const preference = (choice: RouteChoice) => schedule(choice).map((step) => step.route);

/** The routes better than `current` for this choice, best first: what a retry tries. */
export function retryRoutes(choice: RouteChoice, current: LinkRoute): LinkRoute[] {
  const order = preference(choice);
  return order.slice(0, Math.max(0, order.indexOf(current)));
}

/** How long an attempt runs before every route has had its time. */
function attemptLength(choice: RouteChoice): number {
  const steps = schedule(choice);
  const last = steps[steps.length - 1];
  return last.at + TIMEOUT_MS[last.route];
}

/**
 * The fallback policy. In a gig the admin's route wins; outside one the phone's own setting does. The route in use is
 * the attempt's open link, so a retry keeps the old link in use until the attempt opens a better one (make before break).
 * The reason names why the nearest better route is not in use.
 */
export function decide({ setting, gigRoute, attempt, now, lastRetry }: PolicyInput): PolicyOutput {
  const choice = gigRoute ?? setting;
  const order = preference(choice);
  const open = attempt.chosen?.state === "open" ? attempt.chosen.route : null;
  if (open) {
    const better = retryRoutes(choice, open);
    const reason = better.reverse().map((route) => attempt.reasons[route]).find(Boolean) ?? null;
    return { use: open, word: ROUTE_WORDS[open], reason, retryAt: better.length ? lastRetry + RETRY_EVERY_MS : null };
  }
  const allFailed = order.every((route) => attempt.reasons[route]) || (attempt.tried.length > 0 && now - lastRetry >= attemptLength(choice));
  if (allFailed) return { use: null, word: CANT_CONNECT, reason: KEEPING_THE_BEAT, retryAt: lastRetry + RETRY_EVERY_MS };
  return { use: null, word: CONNECTING, reason: order.map((route) => attempt.reasons[route]).find(Boolean) ?? null, retryAt: null };
}

/** The strip's words: the route, then the reason when there is one. */
export const stripLine = ({ word, reason }: PolicyOutput) => (reason ? `${word} · ${reason}` : word);

/** The Connection screen's line during a gig. */
export const tonightLine = (route: RouteChoice) => `Tonight the admin chose ${CHOICE_WORDS[route].name}`;

/** What this phone's own network rules out before trying, from `navigator.connection.type` where the browser gives it. */
export function networkReasons(type: string | undefined): Attempt["reasons"] {
  return type === "cellular" ? { wifi: NOT_ON_WIFI } : {};
}
