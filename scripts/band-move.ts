import type { BandFile, Imported } from "../worker/room-export.ts";

/** One signed-in admin on one deployment: the API's base URL, the app origin it trusts, and the session cookie. */
export type Admin = { base: string; origin: string; cookie: string };

type Reply<T> = { status: number; body: T & { error?: string } };

async function call<T>(admin: Admin, path: string, body?: string): Promise<Reply<T>> {
  const response = await fetch(new URL(path, admin.base), {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: admin.cookie, ...(body === undefined ? {} : { "content-type": "application/json", origin: admin.origin }) },
    body,
  });
  return { status: response.status, body: (await response.json()) as T & { error?: string } };
}

/** What Band settings' Download button fetches: `GET /api/bands/export?bandId=`. */
export const downloadBandFile = (admin: Admin, bandId: string) => call<BandFile>(admin, `/api/bands/export?bandId=${encodeURIComponent(bandId)}`);

/** What Band settings' Import does with the picked file: `POST /api/rooms/<bandId>` with the file text as the body. */
export const importBandFile = (admin: Admin, bandId: string, fileText: string) => call<Imported>(admin, `/api/rooms/${bandId}`, fileText);

/** Moves one band's songs and setlists from a band on one deployment into a band on another, as the admin of each. */
export async function moveBand(from: Admin, fromBandId: string, to: Admin, toBandId: string): Promise<Reply<Imported>> {
  const file = await downloadBandFile(from, fromBandId);
  if (file.status !== 200) throw new Error(`the download was refused: ${file.status} ${file.body.error}`);
  return importBandFile(to, toBandId, JSON.stringify(file.body));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [fromBase, fromBandId, toBase, toBandId] = process.argv.slice(2);
  const { MLS_FROM_COOKIE, MLS_TO_COOKIE, MLS_TO_ORIGIN } = process.env;
  if (!fromBase || !fromBandId || !toBase || !toBandId || !MLS_FROM_COOKIE || !MLS_TO_COOKIE || !MLS_TO_ORIGIN) {
    console.error("usage: MLS_FROM_COOKIE=... MLS_TO_COOKIE=... MLS_TO_ORIGIN=https://app.example node --experimental-strip-types scripts/band-move.ts <from api base> <from band id> <to api base> <to band id>");
    process.exit(2);
  }
  const moved = await moveBand({ base: fromBase, origin: "", cookie: MLS_FROM_COOKIE }, fromBandId, { base: toBase, origin: MLS_TO_ORIGIN, cookie: MLS_TO_COOKIE }, toBandId);
  console.log(JSON.stringify(moved.body));
  process.exit(moved.status === 200 ? 0 : 1);
}
