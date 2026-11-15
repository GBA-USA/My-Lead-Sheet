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
