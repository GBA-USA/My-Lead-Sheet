import { receive, type GigState, type UserId } from "../src/gig-state";
import type { GigCopy, GigSend, RoomRefusal } from "../src/leader-fanout";
import { inRoom } from "./room-members";

/** The op ids the room remembers per gig (PLAN.md 5, `gig_ops`). A repeat of any of them changes nothing. */
const OPS_KEPT = 500;

type GigRow = { leader: string; lineup: string; status: string; state: string | null };

/** What the room knows of the gig from its own tables, never from the phone. */
export type Planned = { leader: UserId; lineup: UserId[]; ended: boolean; isAdmin: (userId: UserId) => boolean };

/** Whoever leads a new epoch must have the claim they say: the admin, the backup, or the player the lead was offered to. */
const MAY_LEAD: Record<GigState["claim"], (held: GigState, by: UserId) => boolean> = {
  admin: (held, by) => by === held.admin,
  backup: (held, by) => by === held.backup,
  other: (held, by) => by === held.handoff?.to,
};

function sameSet(a: string[], b: string[]) {
  const ids = new Set(a);
  return ids.size === a.length && a.length === b.length && b.every((id) => ids.has(id));
}

/**
 * Whether the room takes a send from `by`, the socket's signed-in player. Only a leader writes, and only the state it
 * leads. A new leader must hold the claim it names. Between two leaders of one epoch, `receive` decides, so two
 * take-overs made offline settle the same way whichever reaches the room first: the admin, then the backup.
 */
export function judge(held: GigState | null, sent: GigSend, by: UserId, plan: Planned): RoomRefusal | null {
  const { state } = sent;
  if (plan.ended || held?.status === "ended") return "ended";
  if (state.leader !== by) return "not-allowed";
  if (!held) {
    const opens = by === plan.leader && state.epoch === 0 && sameSet(state.lineup, plan.lineup) && plan.isAdmin(state.admin);
    return opens ? null : "not-allowed";
  }
  if (sent.kind === "gig-start") return "repeat";
  if (state.epoch < held.epoch) return "stale-epoch";
  if (state.admin !== held.admin) return "not-allowed";
  if ((state.leader !== held.leader || state.epoch !== held.epoch) && !MAY_LEAD[state.claim](held, by)) return "not-allowed";
  const order = receive(held, state).result;
  if (order === "applied") return null;
  return order === "duplicate" || order === "old" ? "repeat" : "stale-epoch";
}

export type Taken = { stored: true; copy: Extract<GigCopy, { state: GigState }> } | { stored: false; refused: RoomRefusal };

const rowOf = (sql: SqlStorage, gigId: string) => sql.exec<GigRow>(`SELECT leader, lineup, status, state FROM gigs WHERE gig_id = ?`, gigId).toArray()[0];
const heldOf = (row: GigRow | undefined): GigState | null => (row?.state ? (JSON.parse(row.state) as GigState) : null);

function isAdmin(sql: SqlStorage, userId: UserId) {
  try {
    return inRoom(sql, userId).me.role === "admin";
  } catch {
    return false;
  }
}

/** The live gig state in the band room. Each caller is the Room, with the socket's player and the gig it joined. */
export const gigRelay = {
  /** The room's copy for a phone that asks, or a null copy before the leader has sent anything. */
  copy(sql: SqlStorage, gigId: string): GigCopy {
    const held = heldOf(rowOf(sql, gigId));
    return held ? { kind: "gig-state", state: held, at: held.changedAt } : { kind: "gig-state", state: null, at: null };
  },

  /**
   * Stores the op id before the state, like `chatRoom.post` stores a message id. Only a send this call stored is kept as
   * the gig's state and comes back as the copy to forward, so the same op on two routes, or a retry after a drop, goes
   * out once. `at` in `gig_ops` is the room's own clock, for the record; the band time is in the state.
   */
  take(sql: SqlStorage, gigId: string | null, by: UserId, sent: GigSend, now: number): Taken {
    const row = gigId === sent.state.gigId ? rowOf(sql, gigId) : undefined;
    if (!row) return { stored: false, refused: "not-on-lineup" };
    const plan: Planned = { leader: row.leader, lineup: JSON.parse(row.lineup), ended: row.status === "ended", isAdmin: (userId) => isAdmin(sql, userId) };
    const refused = judge(heldOf(row), sent, by, plan);
    if (refused) return { stored: false, refused };
    if (sent.kind === "gig-op") {
      if (sql.exec(`SELECT 1 FROM gig_ops WHERE gig_id = ? AND op_id = ?`, gigId, sent.op.opId).toArray().length) return { stored: false, refused: "repeat" };
      sql.exec(`INSERT INTO gig_ops (gig_id, op_id, rev, at) VALUES (?, ?, ?, ?)`, gigId, sent.op.opId, sent.state.rev, now);
      sql.exec(`DELETE FROM gig_ops WHERE gig_id = ? AND rowid NOT IN (SELECT rowid FROM gig_ops WHERE gig_id = ? ORDER BY rowid DESC LIMIT ?)`, gigId, gigId, OPS_KEPT);
    }
    sql.exec(`UPDATE gigs SET state = ?, epoch = ? WHERE gig_id = ?`, JSON.stringify(sent.state), sent.state.epoch, gigId);
    return { stored: true, copy: { kind: "gig-state", state: sent.state, at: sent.at } };
  },
};
