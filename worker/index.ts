import type { Directory } from "./directory";
import { Refused } from "./refused";
import { BACKUP_PATH, SESSION_HEADER, USER_HEADER, type Room } from "./room";
import { selfRoomId } from "./room-backup";
import { readSession } from "./session";

export { Directory } from "./directory";
export { Room } from "./room";

export interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>;
  ROOM: DurableObjectNamespace<Room>;
  APP_ORIGIN?: string;
  RP_ID?: string;
  RP_NAME?: string;
  SESSION_SECRET?: string;
  CHALLENGE_TTL_SECONDS?: string;
}

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/;
const ACCOUNT_PATH = /^\/api\/(auth|me)(\/|$)/;

const refuse = (error: string, status: number) => Response.json({ error }, { status });

/** A browser always sends Origin on a POST and a socket upgrade, so anything else is another site or not a browser. */
const fromApp = (request: Request, env: Env) => !!env.APP_ORIGIN && request.headers.get("Origin") === env.APP_ORIGIN;

async function enterRoom(request: Request, env: Env, roomOf: (userId: string) => string): Promise<Response> {
  const writes = request.headers.get("Upgrade") === "websocket" || request.method !== "GET";
  if (writes && !fromApp(request, env)) return refuse("wrong-origin", 403);
  const session = await readSession(env.SESSION_SECRET, request.headers.get("Cookie"), Date.now());
  const roomId = session ? roomOf(session.userId) : "";
  if (!session || !(await env.DIRECTORY.getByName("directory").authorizeRoom(session.userId, session.version, roomId))) return refuse("signed-out", 401);
  const forwarded = new Request(request);
  forwarded.headers.set(USER_HEADER, session.userId);
  forwarded.headers.set(SESSION_HEADER, String(session.version));
  return env.ROOM.getByName(roomId).fetch(forwarded);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true });
    try {
      const room = ROOM_PATH.exec(pathname)?.[1];
      if (room) return await enterRoom(request, env, () => room);
      if (pathname === BACKUP_PATH) return await enterRoom(request, env, selfRoomId);
    } catch (error) {
      if (error instanceof Refused) return refuse(error.reason, error.status);
      throw error;
    }
    if (ACCOUNT_PATH.test(pathname)) {
      if (request.method !== "GET" && !fromApp(request, env)) return refuse("wrong-origin", 403);
      return env.DIRECTORY.getByName("directory").fetch(request);
    }
    return refuse("not-found", 404);
  },
} satisfies ExportedHandler<Env>;
