import type { Directory } from "./directory";
import type { Room } from "./room";

export { Directory } from "./directory";
export { Room } from "./room";

interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>;
  ROOM: DurableObjectNamespace<Room>;
}

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/;

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true });
    const room = ROOM_PATH.exec(pathname)?.[1];
    if (room) return env.ROOM.getByName(room).fetch(request);
    return Response.json({ error: "not-found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
