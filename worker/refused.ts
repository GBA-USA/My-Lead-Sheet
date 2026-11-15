/** A request the API turns down. `reason` is the machine word the phone branches on, and `detail` joins it in the reply. */
export class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly status = 400,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}

/** Room refusals arrive over RPC as plain errors carrying the reason, so the Directory gives each its status back here. */
const ROOM_REFUSALS = {
  "no-band": 404,
  "not-a-member": 403,
  "not-admin": 403,
  "not-found": 404,
  "last-admin": 409,
  "band-exists": 409,
  "code-stopped": 410,
  yourself: 400,
  "not-yours": 403,
  "not-a-band-song": 400,
  lineage_broken: 403,
} as const;

export const roomRefused = (reason: keyof typeof ROOM_REFUSALS) => new Refused(reason, ROOM_REFUSALS[reason]);

/** A Room RPC call, with the room's refusal turned back into the reply the phone expects. */
export async function fromRoom<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason in ROOM_REFUSALS) throw roomRefused(reason as keyof typeof ROOM_REFUSALS);
    throw error;
  }
}

/** A request's JSON object body. Over `maxChars` is `too-large` (413). Not JSON, or not an object, is `bad-request`. An empty body is `{}`. */
export async function readJsonObject(request: Request, maxChars: number): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxChars) throw new Refused("too-large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new Refused("bad-request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Refused("bad-request");
  return body as Record<string, unknown>;
}
