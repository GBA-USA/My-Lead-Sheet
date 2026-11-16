import type { RouteChoice } from "./routes";

export type GigStatus = "planned" | "live" | "ended";

/**
 * A gig as the band Room keeps it (PLAN.md 5 `gigs`). `date` is the calendar day as `YYYY-MM-DD`. `lineup`, `leader` and
 * `backup` are user ids. `route` is the admin's choice for the night, `auto` unless they picked one.
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
};

/** A player's newest download of a gig's pack (PLAN.md 5 `pack_receipts`). */
export type PackReceipt = { userId: string; packRev: number; at: number };

/** What the gig routes answer: the plan, the pack rev a fresh download gets, and the lineup's receipts. */
export type GigView = { gig: GigPlan; packRev: number; receipts: PackReceipt[] };

/** Whether `userId` holds the pack as it is now, so the card can say Downloaded ✓ once per player, however many phones they have. */
export const downloaded = (view: GigView, userId: string) => view.receipts.some((receipt) => receipt.userId === userId && receipt.packRev === view.packRev);

/** The Plan a gig form before Send to band. The leader is null only after the planner switched the leader off the lineup. */
export type GigDraft = Pick<GigPlan, "name" | "date" | "lineup" | "backup" | "route"> & { leader: string | null };

export type DraftAction =
  | { type: "name"; name: string }
  | { type: "date"; date: string }
  | { type: "toggleLineup"; userId: string }
  | { type: "setLeader"; userId: string }
  | { type: "setBackup"; userId: string | null }
  | { type: "setRoute"; route: RouteChoice };

export const newDraft = (lineup: string[], leader: string): GigDraft => ({ name: "", date: "", lineup, leader, backup: null, route: "auto" });

/** The form's local state. The server checks every rule again when the plan is sent. */
export function draftReducer(draft: GigDraft, action: DraftAction): GigDraft {
  switch (action.type) {
    case "name":
      return { ...draft, name: action.name };
    case "date":
      return { ...draft, date: action.date };
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

/** Why Send to band can't go yet, or null when it can. */
export function draftProblem(draft: GigDraft): string | null {
  if (!draft.name.trim()) return "Give the gig a name.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return "Pick the date.";
  if (draft.lineup.length === 0) return "Switch on who's playing.";
  if (draft.leader === null) return "Pick a leader from tonight's lineup.";
  return null;
}
