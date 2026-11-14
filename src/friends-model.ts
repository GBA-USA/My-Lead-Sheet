export type Friend = { handle: string; name: string };
export type FriendRequest = { id: string; from: Friend; via: "name" | "code" | "link" };
export type FriendsState = {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: string[];
  notice: string;
};

export const fixtureFriends: FriendsState = {
  friends: [
    { handle: "@mike", name: "Mike" },
    { handle: "@dana", name: "Dana" },
  ],
  incoming: [
    { id: "req1", from: { handle: "@sam", name: "Sam" }, via: "name" },
  ],
  outgoing: [],
  notice: "",
};

export type FriendsAction =
  | { type: "accept"; id: string }
  | { type: "ignore"; id: string }
  | { type: "add"; handle: string }
  | { type: "scanned"; handle: string };

export function friendsReducer(
  state: FriendsState,
  action: FriendsAction
): FriendsState {
  switch (action.type) {
    case "accept": {
      const request = state.incoming.find((r) => r.id === action.id);
      if (!request) return state;
      return {
        ...state,
        friends: [...state.friends, request.from],
        incoming: state.incoming.filter((r) => r.id !== action.id),
        notice: "",
      };
    }

    case "ignore": {
      return {
        ...state,
        incoming: state.incoming.filter((r) => r.id !== action.id),
        notice: "",
      };
    }

    case "add":
    case "scanned": {
      const trimmed = action.handle.trim();
      if (!trimmed) {
        return { ...state, notice: "Enter a handle" };
      }
      const handle = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      if (state.friends.some((f) => f.handle === handle)) {
        return { ...state, notice: "Already friends" };
      }
      if (state.outgoing.includes(handle)) {
        return { ...state, notice: "Request already sent" };
      }
      return {
        ...state,
        outgoing: [...state.outgoing, handle],
        notice: `Request sent to ${handle}${action.type === "scanned" ? " — they need to accept" : ""}`,
      };
    }

    default:
      return state;
  }
}
