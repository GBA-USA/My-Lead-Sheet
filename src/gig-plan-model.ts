export type Player = { handle: string; name: string };
export type Connection = "wifi" | "hotspot" | "internet";
export type GigPlan = {
  gigId: string;
  title: string;
  lineup: string[];
  leader: string | null;
  backupLeader: string | null;
  connection: Connection;
  packSongIds: string[];
  downloaded: string[];
  admin: string;
};

export const fixtureMembers: Player[] = [
  { handle: "@alex", name: "Alex" },
  { handle: "@mike", name: "Mike" },
  { handle: "@dana", name: "Dana" },
  { handle: "@sam", name: "Sam" },
];

export const fixtureGigPlan: GigPlan = {
  gigId: "g1",
  title: "Friday at the Barn",
  lineup: ["@alex", "@mike", "@dana"],
  leader: "@alex",
  backupLeader: "@mike",
  connection: "wifi",
  packSongIds: ["s1", "s2", "s3"],
  downloaded: [],
  admin: "@alex",
};

export type GigPlanAction =
  | { type: "toggleLineup"; handle: string }
  | { type: "setLeader"; handle: string }
  | { type: "setBackup"; handle: string | null }
  | { type: "setConnection"; by: string; connection: Connection }
  | { type: "togglePack"; songId: string }
  | { type: "markDownloaded"; songId: string };

export function gigPlanReducer(
  state: { plan: GigPlan; notice: string },
  action: GigPlanAction
): { plan: GigPlan; notice: string } {
  const plan = structuredClone(state.plan);

  switch (action.type) {
    case "toggleLineup": {
      const index = plan.lineup.indexOf(action.handle);
      if (index === -1) {
        plan.lineup.push(action.handle);
      } else {
        plan.lineup.splice(index, 1);
        if (plan.leader === action.handle) plan.leader = null;
        if (plan.backupLeader === action.handle) plan.backupLeader = null;
      }
      return { plan, notice: "" };
    }

    case "setLeader": {
      if (!plan.lineup.includes(action.handle)) {
        return { plan, notice: "Pick someone in the lineup" };
      }
      plan.leader = action.handle;
      if (plan.backupLeader === action.handle) plan.backupLeader = null;
      return { plan, notice: "" };
    }

    case "setBackup": {
      if (action.handle !== null) {
        if (!plan.lineup.includes(action.handle)) {
          return { plan, notice: "Pick someone in the lineup" };
        }
        if (action.handle === plan.leader) {
          return { plan, notice: "Backup must be someone other than the leader" };
        }
      }
      plan.backupLeader = action.handle;
      return { plan, notice: "" };
    }

    case "setConnection": {
      if (action.by !== plan.admin) {
        return { plan, notice: "Only the admin picks the connection" };
      }
      plan.connection = action.connection;
      return { plan, notice: "" };
    }

    case "togglePack": {
      const index = plan.packSongIds.indexOf(action.songId);
      if (index === -1) {
        plan.packSongIds.push(action.songId);
      } else {
        plan.packSongIds.splice(index, 1);
        const dIndex = plan.downloaded.indexOf(action.songId);
        if (dIndex !== -1) plan.downloaded.splice(dIndex, 1);
      }
      return { plan, notice: "" };
    }

    case "markDownloaded": {
      if (!plan.packSongIds.includes(action.songId)) {
        return { plan, notice: "Song is not in the pack" };
      }
      if (!plan.downloaded.includes(action.songId)) {
        plan.downloaded.push(action.songId);
      }
      return { plan, notice: "" };
    }

    default:
      return state;
  }
}

export function isPackReady(plan: GigPlan): boolean {
  if (plan.packSongIds.length === 0) return false;
  return plan.packSongIds.every((songId) => plan.downloaded.includes(songId));
}
