import type { Env } from "./index";
import { readJsonObject, Refused } from "./refused";
import { CLEARED_COOKIE, needsRenewal, readSession, sessionCookie, signSession, type Session } from "./session";

const MAX_BODY_BYTES = 16 * 1024;

export type User = { user_id: string; handle: string; display_name: string; session_version: number };

export const userById = (sql: SqlStorage, userId: string) => sql.exec<User>(`SELECT * FROM users WHERE user_id = ?`, userId).toArray()[0];

/** A user as a Room stores them: the id and the name bandmates see. */
export type Person = { userId: string; name: string };
export const who = (user: User): Person => ({ userId: user.user_id, name: user.display_name });

export interface Context {
  storage: DurableObjectStorage;
  sql: SqlStorage;
  env: Env;
  now: number;
  request: Request;
  body: Record<string, unknown>;
  session: Session | null;
}

/** A JSON `body`, or for a browser coming back from Google, `googleReturn`: the word the app shows once it is sent back there. */
export type Reply = ({ body: unknown; googleReturn?: undefined } | { googleReturn: string; body?: undefined }) & { signIn?: User; signOut?: true; cookies?: string[] };

/** The caller's users row as it is now, or null once another request has moved its `session_version` on. */
function currentUser(sql: SqlStorage, session: Session | null): User | null {
  const user = session ? userById(sql, session.userId) : undefined;
  return user && user.session_version === session?.version ? user : null;
}

/**
 * The signed-in caller, read fresh on every call. Other requests run while this one awaits,
 * so a route calls this again in the same synchronous segment as its write.
 */
export function signedIn(c: Context): User {
  const user = currentUser(c.sql, c.session);
  if (!user) throw new Refused("signed-out", 401);
  return user;
}

export type Route = (c: Context) => Promise<Reply>;

/** The cookie a reply sets: a new session on sign-in, a cleared one on sign-out, or a renewed one for a session older than a day. */
async function replyCookie(env: Env, sql: SqlStorage, reply: Reply, session: Session | null, now: number): Promise<string | null> {
  if (reply.signOut) return CLEARED_COOKIE;
  if (reply.signIn) return sessionCookie(await signSession(env.SESSION_SECRET, { userId: reply.signIn.user_id, version: reply.signIn.session_version, issuedAt: now }));
  if (session && needsRenewal(session, now) && currentUser(sql, session)) return sessionCookie(await signSession(env.SESSION_SECRET, { ...session, issuedAt: now }));
  return null;
}

/** Serves the Directory's API routes. Unknown paths are 404, refusals are `{error}` with their status. */
export async function handleDirectoryRequest(request: Request, storage: DurableObjectStorage, env: Env, routes: Record<string, Route>): Promise<Response> {
  const route = routes[`${request.method} ${new URL(request.url).pathname}`];
  if (!route) return Response.json({ error: "not-found" }, { status: 404 });
  const headers = new Headers({ "Cache-Control": "no-store" });
  try {
    const now = Date.now();
    const session = await readSession(env.SESSION_SECRET, request.headers.get("Cookie"), now);
    const reply = await route({ storage, sql: storage.sql, env, now, request, body: request.method === "POST" ? await readJsonObject(request, MAX_BODY_BYTES) : {}, session });
    const cookie = await replyCookie(env, storage.sql, reply, session, now);
    for (const value of [...(cookie ? [cookie] : []), ...(reply.cookies ?? [])]) headers.append("Set-Cookie", value);
    if (reply.googleReturn === undefined) return Response.json(reply.body, { headers });
    headers.set("Location", `${env.APP_ORIGIN ?? ""}/?google=${encodeURIComponent(reply.googleReturn)}`);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.reason, ...error.detail }, { status: error.status, headers });
    throw error;
  }
}
