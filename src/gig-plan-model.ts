import type { RouteChoice } from "./routes";

export type GigStatus = "planned" | "live" | "ended";

/** A gig on stage or a rehearsal. Both use the same form, card and live screen. */
export type GigKind = "gig" | "rehearsal";
export const KIND_WORDS: Record<GigKind, string> = { gig: "Gig", rehearsal: "Rehearsal" };

/**
 * When and where, added after gigs first shipped. Times are 24-hour "HH:MM". Each is null when the planner left it blank,
 * and on every gig planned before these existed.
 */
export type GigDetails = { kind: GigKind; startTime: string | null; callTime: string | null; venue: string | null; address: string | null; notes: string | null };

/** The longest venue, address and notes the band room keeps. */
export const DETAIL_LIMITS = { venue: 120, address: 120, notes: 500 } as const;

/**
 * A gig as the band Room keeps it (PLAN.md 5 `gigs`). `date` is the calendar day as `YYYY-MM-DD`. `lineup`, `leader` and
 * `backup` are user ids. `route` is the admin's choice for the night, `auto` unless they picked one. The details are
 * optional because a gig pack downloaded before they existed has none.
 */
export type GigPlan = {
  gigId: string;
  bandId: string;
  setlistId: string;
  name: string;
  date: string;
  lineup: string[];
  leader: string;
  backup: string | null;
  route: RouteChoice;
  status: GigStatus;
} & Partial<GigDetails>;

/** A player's newest download of a gig's pack (PLAN.md 5 `pack_receipts`). */
export type PackReceipt = { userId: string; packRev: number; at: number };

/** What the gig routes answer: the plan, the pack rev a fresh download gets, the lineup's receipts, and how many songs the set has. */
export type GigView = { gig: GigPlan; packRev: number; receipts: PackReceipt[]; songCount: number };

/** `gig/list`: the gigs not yet ended, soonest first, and the ended ones, newest first. */
export type GigList = { gigs: GigView[]; past: GigView[] };

/** Whether `userId` holds the pack as it is now, so the card can say Downloaded ✓ once per player, however many phones they have. */
export const downloaded = (view: GigView, userId: string) => view.receipts.some((receipt) => receipt.userId === userId && receipt.packRev === view.packRev);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const half = (time: string) => (Number(time.slice(0, 2)) < 12 ? "AM" : "PM");
const clock = (time: string) => `${Number(time.slice(0, 2)) % 12 || 12}:${time.slice(3, 5)}`;

/**
 * The one line the gig card, the band chat's gig card and the live screen show under the name, so they never drift:
 * "Rehearsal · Sat Nov 21 · 7:00 PM (call 6:15) · Elks Lodge". The day is read from the date itself, not the phone's clock.
 */
export function gigLine(plan: Pick<GigPlan, "date" | keyof GigDetails>): string {
  const day = new Date(`${plan.date}T00:00:00Z`);
  const parts = [KIND_WORDS[plan.kind ?? "gig"], `${DAYS[day.getUTCDay()]} ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`];
  const { startTime: start, callTime: call } = plan;
  if (start) parts.push(`${clock(start)} ${half(start)}${call ? ` (call ${clock(call)}${half(call) === half(start) ? "" : ` ${half(call)}`})` : ""}`);
  else if (call) parts.push(`Call ${clock(call)} ${half(call)}`);
  if (plan.venue) parts.push(plan.venue);
  return parts.join(" · ");
}

/** The fields the form types into, each "" while blank. */
export type DetailField = "startTime" | "callTime" | "venue" | "address" | "notes";

/** The Plan a gig form before Send to band. The leader is null only after the planner switched the leader off the lineup. */
export type GigDraft = Pick<GigPlan, "name" | "date" | "lineup" | "backup" | "route"> & { leader: string | null; kind: GigKind } & Record<DetailField, string>;

export type DraftAction =
  | { type: "name"; name: string }
  | { type: "date"; date: string }
  | { type: "kind"; kind: GigKind }
  | { type: "detail"; field: DetailField; value: string }
  | { type: "toggleLineup"; userId: string }
  | { type: "setLeader"; userId: string }
  | { type: "setBackup"; userId: string | null }
  | { type: "setRoute"; route: RouteChoice };

const BLANK_DETAILS: Record<DetailField, string> = { startTime: "", callTime: "", venue: "", address: "", notes: "" };

export const newDraft = (lineup: string[], leader: string): GigDraft => ({ name: "", date: "", lineup, leader, backup: null, route: "auto", kind: "gig", ...BLANK_DETAILS });

/** The form's local state. The server checks every rule again when the plan is sent. */
export function draftReducer(draft: GigDraft, action: DraftAction): GigDraft {
  switch (action.type) {
    case "name":
      return { ...draft, name: action.name };
    case "date":
      return { ...draft, date: action.date };
    case "kind":
      return { ...draft, kind: action.kind };
    case "detail":
      return { ...draft, [action.field]: action.value };
    case "toggleLineup": {
      if (!draft.lineup.includes(action.userId)) return { ...draft, lineup: [...draft.lineup, action.userId] };
      const off = (id: string | null) => (id === action.userId ? null : id);
      return { ...draft, lineup: draft.lineup.filter((id) => id !== action.userId), leader: off(draft.leader), backup: off(draft.backup) };
    }
    case "setLeader":
      if (!draft.lineup.includes(action.userId)) return draft;
      return { ...draft, leader: action.userId, backup: draft.backup === action.userId ? null : draft.backup };
    case "setBackup":
      if (action.userId !== null && (!draft.lineup.includes(action.userId) || action.userId === draft.leader)) return draft;
      return { ...draft, backup: action.userId };
    case "setRoute":
      return { ...draft, route: action.route };
  }
}

/** Why Send to band can't go yet, or null when it can. Everything but the name, date and lineup is optional. */
export function draftProblem(draft: GigDraft): string | null {
  if (!draft.name.trim()) return "Give the gig a name.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return "Pick the date.";
  if (draft.lineup.length === 0) return "Switch on who's playing.";
  if (draft.leader === null) return "Pick a leader from tonight's lineup.";
  return null;
}

/** Whether the form differs from where it started. The lineup is a set, so switching someone off and on again is no change. */
export function draftChanged(draft: GigDraft, from: GigDraft): boolean {
  const same = (a: GigDraft) => JSON.stringify({ ...a, lineup: [...a.lineup].sort() });
  return same(draft) !== same(from);
}

/** What Send to band posts: the draft with each blank detail as null and the rest trimmed. */
export function planBody(draft: GigDraft): Omit<GigDraft, DetailField> & Record<DetailField, string | null> {
  const details = Object.fromEntries((Object.keys(BLANK_DETAILS) as DetailField[]).map((field) => [field, draft[field].trim() || null])) as Record<DetailField, string | null>;
  return { ...draft, ...details };
}

/** Plan again: the past gig's plan as a new draft, everything kept but the date. */
export function againDraft(plan: GigPlan): GigDraft {
  const details = Object.fromEntries((Object.keys(BLANK_DETAILS) as DetailField[]).map((field) => [field, plan[field] ?? ""])) as Record<DetailField, string>;
  return { name: plan.name, date: "", lineup: [...plan.lineup], leader: plan.leader, backup: plan.backup, route: plan.route, kind: plan.kind ?? "gig", ...details };
}

/** A kept draft against the band as it is now: anyone who left comes off the lineup, and a leader or backup who left is cleared. */
export function fitDraft(draft: GigDraft, memberIds: string[]): GigDraft {
  const lineup = draft.lineup.filter((id) => memberIds.includes(id));
  const kept = (id: string | null) => (id !== null && lineup.includes(id) ? id : null);
  return { ...draft, lineup, leader: kept(draft.leader), backup: kept(draft.backup) };
}

/** This phone's unsent plans, in localStorage, one per account and gig, so another account on the phone never reads one. */
export const GIG_DRAFT_KEY = "leadSheetsGigDraft";
export const gigDraftKey = (owner: string, gigId: string) => `${GIG_DRAFT_KEY}.${owner}.${gigId}`;

/** A kept draft with what it is for: the band and setlist the plan route needs, and when it was last typed into. */
export type KeptDraft = { bandId: string; gigId: string; setlistId: string | null; savedAt: number; draft: GigDraft };

/** A kept draft read back from storage, or null when it is missing or not one. */
export function keptDraftOf(raw: string | null): KeptDraft | null {
  if (raw === null) return null;
  try {
    const kept = JSON.parse(raw) as KeptDraft;
    const draft = kept?.draft;
    const strings = draft && [draft.name, draft.date, draft.kind, ...(Object.keys(BLANK_DETAILS) as DetailField[]).map((field) => draft[field])].every((value) => typeof value === "string");
    return typeof kept.bandId === "string" && typeof kept.gigId === "string" && typeof kept.savedAt === "number" && strings && Array.isArray(draft.lineup) ? kept : null;
  } catch {
    return null;
  }
}
