export type Role = "admin" | "member";
export type Member = { handle: string; name: string; role: Role };
export type Band = { id: string; name: string; code: string; members: Member[] };
export type BandsState = { me: string; bands: Band[]; notice: string };

export const fixtureBands: BandsState = {
  me: "@alex",
  bands: [
    {
      id: "b1",
      name: "Back Porch",
      code: "GB-1234",
      members: [
        { handle: "@alex", name: "Alex", role: "admin" },
        { handle: "@mike", name: "Mike", role: "member" },
      ],
    },
  ],
  notice: "",
};

export const joinableBands: Band[] = [
  {
    id: "b2",
    name: "Iverson Acres",
    code: "IA-5678",
    members: [{ handle: "@dana", name: "Dana", role: "admin" }],
  },
];

export type BandsAction =
  | { type: "create"; name: string }
  | { type: "join"; code: string }
  | { type: "remove"; bandId: string; handle: string }
  | { type: "promote"; bandId: string; handle: string }
  | { type: "leave"; bandId: string };

export function bandsReducer(
  state: BandsState,
  action: BandsAction
): BandsState {
  const newState: BandsState = structuredClone(state);

  switch (action.type) {
    case "create": {
      const name = action.name.trim();
      if (!name) {
        newState.notice = "Enter a band name";
        return newState;
      }
      const count = newState.bands.length;
      const newBand: Band = {
        id: `b${count + 1}`,
        name,
        code: `NEW-${count + 1}`,
        members: [{ handle: newState.me, name: "You", role: "admin" }],
      };
      newState.bands.push(newBand);
      newState.notice = `Created ${name}`;
      return newState;
    }

    case "join": {
      let code = action.code.trim().toUpperCase();
      const linkMatch = code.match(/\/join\/([A-Z0-9\-]+)$/i);
      if (linkMatch) {
        code = linkMatch[1];
      }

      const existingBand = newState.bands.find((b) =>
        b.members.some((m) => m.handle === newState.me && b.code === code)
      );
      if (existingBand) {
        newState.notice = `Already in ${existingBand.name}`;
        return newState;
      }

      const joinable = joinableBands.find((b) => b.code === code);
      if (joinable) {
        const bandCopy: Band = {
          id: joinable.id,
          name: joinable.name,
          code: joinable.code,
          members: [
            ...joinable.members,
            { handle: newState.me, name: "You", role: "member" },
          ],
        };
        newState.bands.push(bandCopy);
        newState.notice = `Joined ${joinable.name}`;
        return newState;
      }

      newState.notice = "Code not found";
      return newState;
    }

    case "remove": {
      const band = newState.bands.find((b) => b.id === action.bandId);
      if (!band || !isAdmin(band, newState.me)) {
        newState.notice = "Only an admin can remove members";
        return newState;
      }
      if (action.handle === newState.me) {
        newState.notice = "Only an admin can remove members";
        return newState;
      }
      band.members = band.members.filter((m) => m.handle !== action.handle);
      newState.notice = `Removed ${action.handle}`;
      return newState;
    }

    case "promote": {
      const band = newState.bands.find((b) => b.id === action.bandId);
      if (!band || !isAdmin(band, newState.me)) {
        newState.notice = "Only an admin can promote members";
        return newState;
      }
      const member = band.members.find((m) => m.handle === action.handle);
      if (member) {
        member.role = "admin";
        newState.notice = `${action.handle} is now an admin`;
      }
      return newState;
    }

    case "leave": {
      const band = newState.bands.find((b) => b.id === action.bandId);
      if (!band) {
        return newState;
      }
      const adminCount = band.members.filter((m) => m.role === "admin").length;
      const isCurrentUserAdmin = isAdmin(band, newState.me);
      if (isCurrentUserAdmin && adminCount === 1 && band.members.length > 1) {
        newState.notice = "Make someone else admin first";
        return newState;
      }
      newState.bands = newState.bands.filter((b) => b.id !== action.bandId);
      newState.notice = `Left ${band.name}`;
      return newState;
    }

    default:
      return newState;
  }
}

export function isAdmin(band: Band, handle: string): boolean {
  return band.members.some((m) => m.handle === handle && m.role === "admin");
}
