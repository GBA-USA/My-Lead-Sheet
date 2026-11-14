import { build } from "esbuild";
import type { ScrollVersion } from "../src/scroll-timing.ts";
import { Phone, TEST_ORIGIN, startApi } from "./api-session.ts";

type App = typeof import("../src/backup.ts") & typeof import("../src/storage.ts");

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

const root = new URL("..", import.meta.url).pathname;
const bundle = await build({
  stdin: { contents: `export * from "./src/backup.ts"; export * from "./src/storage.ts";`, resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
});
const app: App = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const realFetch = globalThis.fetch;
const { worker, base } = await startApi();

/** One phone: its own localStorage, its own cookie jar, and a count of every request the app made. */
class Device {
  readonly store = new FakeStorage();
  calls = 0;
  readonly phone: Phone;
  readonly agent: string;
  constructor(phone: Phone, agent: string) {
    this.phone = phone;
    this.agent = agent;
  }

  use() {
    Object.defineProperty(globalThis, "localStorage", { value: this.store, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: this.agent }, configurable: true });
    globalThis.fetch = async (path, init) => {
      this.calls += 1;
      const headers = { ...(init?.headers as Record<string, string>), origin: TEST_ORIGIN, ...(this.phone.cookie ? { cookie: this.phone.cookie } : {}) };
      return realFetch(new URL(String(path), base), { ...init, headers });
    };
  }

  async sync() {
    this.use();
    return app.syncBackup();
  }

  /** What the app does on start and after a sync that changed keys: read the library, which merges in the seed. */
  boot() {
    this.use();
    return app.loadLibrary();
  }

  /** Every backed-up localStorage entry, as raw text. */
  backedUp() {
    return Object.fromEntries([...this.store.map].filter(([key]) => key !== app.BACKUP_KEY && BACKED_UP.test(key)).sort());
  }
}

const BACKED_UP = /^leadSheets(Library|ScrollVersions|SongData|ScrollPercent|Notation|TextScale|KeepAwake)(\.|$)/;
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9)";

const taught: ScrollVersion = { name: "Taught", bpm: 120, marks: [{ at: 0, progress: 0 }, { at: 4.5, progress: 0.4 }, { at: 180, progress: 1 }] };
const learned: ScrollVersion = {
  name: "Learned",
  bpm: 96,
  marks: [{ at: 0.5, progress: 0 }, { at: 200, progress: 1 }],
  learned: { beatsPerBar: 4, downbeat: 0.5, beats: [0.5, 1.125, 1.75], sections: [{ heading: "Verse 1", at: 0.5, heard: ["G", null] }], vocals: [{ start: 1, end: 2.25 }] },
  tempo: [{ at: 0, bpm: 96 }, { at: 30, bpm: 100 }],
};
const version = (name: string, end: number): ScrollVersion => ({ name, bpm: 100, marks: [{ at: 0, progress: 0 }, { at: end, progress: 1 }] });

/** Adds or replaces an own song (and optionally a setlist) in the stored library, the way an older app build left it. */
function addOwnSong(device: Device, id: number, title: string, setlist?: { id: number; name: string }) {
  device.use();
  const stored = JSON.parse(device.store.getItem(app.LIBRARY_KEY)!);
  const song = { ...stored.songs[1], id, title };
  stored.songs = [...stored.songs.filter((item: { id: number }) => item.id !== id), song];
  if (setlist) stored.setlists.push({ ...setlist, songIds: [id, stored.songs[0].id] });
  device.store.setItem(app.LIBRARY_KEY, JSON.stringify(stored));
  return device.boot();
}

async function post(cookie: string, body: object, headers: Record<string, string> = { origin: TEST_ORIGIN }) {
  const response = await realFetch(new URL("/api/backup", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { rows?: { key: string }[]; error?: string } };
}

try {
  const a = new Device(new Phone(base), iphone);
  const first = a.boot();
  const edited = first.songs[0];
  const ref = (id: number) => app.localRef(id);
  const stored = JSON.parse(a.store.getItem(app.LIBRARY_KEY)!);
  stored.songs[0] = { ...stored.songs[0], practiceTip: "Watch the push into the chorus." };
  a.store.setItem(app.LIBRARY_KEY, JSON.stringify(stored));
  addOwnSong(a, 900, "Chain Breaker", { id: 900, name: "Friday" });
  a.store.setItem(app.SCROLL_PERCENT_KEY, JSON.stringify({ [first.songs[2].id]: 80 }));
  a.store.setItem(app.NOTATION_KEY, JSON.stringify({ [first.songs[2].id]: "nashville" }));
  a.store.setItem(app.SCROLL_VERSIONS_KEY, JSON.stringify({ [first.songs[4].id]: { versions: [taught], selected: 0 } }));
  app.saveScrollPercent(ref(first.songs[3].id), 120);
  app.saveNotation(ref(900), "nashville");
  app.saveSongData(ref(900), { officialRuntimeSec: 212, tempo: 104, timeSignature: "6/8" });
  app.saveScrollVersions(ref(edited.id), { versions: [taught, learned], selected: 1 });
  app.saveTextScaleIndex(3);
  app.saveAwake(false);
  a.store.setItem(app.METRONOME_PREFS_KEY, JSON.stringify({ sound: "wood", nudgeMs: 140 }));
  a.store.setItem("someOtherSite", "not ours");
  const aLibrary = a.boot();

  const signedOut = new Device(new Phone(base), iphone);
  for (const [key, value] of a.store.map) signedOut.store.setItem(key, value);
  const offResult = await signedOut.sync();
  check(signedOut.calls === 0 && offResult.changed.length === 0, `a signed-out phone makes no request (made ${signedOut.calls})`);

  const created = await a.phone.createAccount("Terry Bass");
  const userId: string = created.body.account.userId;
  a.use();
  app.backupOn(userId);
  const before = new Map(a.store.map);
  const up = await a.sync();
  check(a.calls > 0 && up.ok && up.at !== null, `the first sync uploads and marks Backed up (calls ${a.calls}, at ${up.at})`);
  check([...before].every(([key, value]) => key === app.BACKUP_KEY || a.store.getItem(key) === value) && up.changed.length === 0, "the first upload changes nothing on the phone that sent it");

  const b = new Device(new Phone(base, a.phone.authenticator), android);
  b.boot();
  check((await b.phone.signIn()).status === 200, "phone B signs in to the same account");
  b.use();
  app.backupOn(userId);
  const down = await b.sync();
  const bLibrary = b.boot();
  check(down.ok && down.at !== null && down.changed.length > 0, "phone B pulls the backup and marks Backed up");
  check(JSON.stringify(b.backedUp()) === JSON.stringify(a.backedUp()), "every backed-up key on phone B is byte-equal to phone A, old map keys and per-song keys alike");
  for (const key of Object.keys(a.backedUp())) check(b.store.getItem(key) === a.store.getItem(key), `restored ${key} byte-equal`);
  check(JSON.stringify(bLibrary) === JSON.stringify(aLibrary), "phone B loads the same library as phone A, own songs and setlists included");
  b.use();
  check(JSON.stringify(app.loadScrollVersions(ref(edited.id))) === JSON.stringify({ versions: [taught, learned], selected: 1 }), "a learned version with its tempo map loads on phone B");
  check(app.loadScrollPercent(ref(first.songs[2].id)) === 80 && app.loadNotation(ref(first.songs[2].id)) === "nashville", "settings from the old one-map keys load on phone B");
  check(b.store.getItem(app.METRONOME_PREFS_KEY) === null && b.store.getItem("someOtherSite") === null, "metronome prefs and other sites' keys stay on phone A");

  const rowsNow = (await post(a.phone.cookie, { since: 0, changes: [] })).body.rows?.length;
  const againA = await a.sync();
  const againB = await b.sync();
  const rowsAfter = (await post(a.phone.cookie, { since: 0, changes: [] })).body.rows?.length;
  check(againA.changed.length === 0 && againB.changed.length === 0 && rowsNow === rowsAfter && !!rowsNow, `a second run adds no rows and changes nothing (${rowsNow} then ${rowsAfter})`);
  check(b.boot().songs.length === aLibrary.songs.length, "a second run adds no duplicate songs");

  a.use();
  app.saveScrollPercent(ref(first.songs[3].id), 140);
  app.saveScrollVersions(ref(first.songs[5].id), { versions: [version("Fast", 150)], selected: 0 });
  app.saveSongData(ref(900), {});
  await a.sync();
  const pulled = await b.sync();
  b.use();
  check(app.loadScrollPercent(ref(first.songs[3].id)) === 140, "an edit on phone A appears on phone B");
  check(app.loadScrollVersions(ref(first.songs[5].id)).versions[0]?.name === "Fast", "a new timing version on phone A appears on phone B");
  check(b.store.getItem(`${app.SONG_DATA_KEY}.900`) === null && pulled.changed.includes(`${app.SONG_DATA_KEY}.900`), "clearing song data on phone A clears it on phone B");

  a.use();
  app.saveNotation(ref(first.songs[6].id), "nashville");
  app.saveScrollVersions(ref(first.songs[5].id), { versions: [version("Fast", 150), version("V2", 160)], selected: 1 });
  addOwnSong(a, 950, "Song from A");
  b.use();
  app.saveNotation(ref(first.songs[6].id), "notes");
  app.saveScrollPercent(ref(first.songs[6].id), 90);
  app.saveScrollVersions(ref(first.songs[5].id), { versions: [version("Fast", 150), version("V2", 170)], selected: 1 });
  addOwnSong(b, 950, "Song from B", { id: 951, name: "Saturday" });
  await a.sync();
  const merged = await b.sync();
  await a.sync();
  const libA = a.boot();
  const libB = b.boot();
  check(merged.ok && merged.at !== null, "phone B is Backed up after resolving conflicts");
  check(JSON.stringify(a.backedUp()) === JSON.stringify(b.backedUp()), "after conflicting edits both phones hold the same data");
  b.use();
  check(app.loadNotation(ref(first.songs[6].id)) === "notes", "a single value both phones changed takes the last phone to sync");
  const versions = app.loadScrollVersions(ref(first.songs[5].id));
  check(
    JSON.stringify(versions.versions.map((item) => [item.name, item.marks[1].at])) === JSON.stringify([["Fast", 150], ["V2", 160], ["V2 · Android", 170]]),
    `timing versions are combined and a name clash is renamed (${versions.versions.map((item) => item.name).join(", ")})`,
  );
  check(versions.versions[versions.selected ?? -1]?.marks[1].at === 170, "the last phone's selected version stays selected");
  const copy = libB.songs.find((song) => song.title === "Song from B · from Android");
  check(!!libB.songs.find((song) => song.id === 950 && song.title === "Song from A") && !!copy, "a song both phones changed is kept twice, the second named · from Android");
  check(JSON.stringify(libB.setlists.find((set) => set.name === "Saturday")?.songRefs[0]) === JSON.stringify(copy?.ref), "phone B's setlist follows its song to the new id");
  check(JSON.stringify(libA) === JSON.stringify(libB) && libA.songs.length === aLibrary.songs.length + 2, "both phones end with the same library and nothing dropped");

  check((await post("", { since: 0, changes: [] })).status === 401, "no session cookie gets 401");
  const tampered = a.phone.cookie.slice(0, -2) + (a.phone.cookie.endsWith("AA") ? "BB" : "AA");
  check((await post(tampered, { since: 0, changes: [] })).status === 401, "a tampered session cookie gets 401");
  check((await post(a.phone.cookie, { since: 0, changes: [] }, {})).status === 403, "a request without the app's Origin gets 403");
  const selfPath = await realFetch(new URL(`/api/rooms/${encodeURIComponent(`self:${userId}`)}`, base), { headers: { cookie: a.phone.cookie } });
  check(selfPath.status === 404, `the self room can't be opened by name through /api/rooms (${selfPath.status})`);

  const other = new Device(new Phone(base), iphone);
  other.boot();
  await other.phone.createAccount("Mike Keys");
  const otherRows = (await post(other.phone.cookie, { since: 0, changes: [] })).body.rows ?? [];
  check(otherRows.length === 0, `another account's backup holds none of Terry's rows (${otherRows.length})`);
  other.use();
  app.backupOn((await other.phone.call("/api/me")).body.account.userId);
  await other.sync();
  check(Object.keys(other.backedUp()).every((key) => key === app.LIBRARY_KEY) && other.boot().songs.length === first.songs.length, "another account's phone receives nothing from Terry's backup");
  const forged = await post(other.phone.cookie, { since: 0, changes: [{ key: `${app.SCROLL_PERCENT_KEY}.${first.songs[3].id}`, kind: "scroll", value: "1", base: 0 }] });
  b.use();
  await b.sync();
  check(forged.status === 200 && app.loadScrollPercent(ref(first.songs[3].id)) === 140, "another account's write lands in its own backup, not Terry's");

  await a.phone.call("/api/auth/sign-out-everywhere", {});
  const kept = JSON.stringify(b.backedUp());
  const after = await b.sync();
  check(after.signedOut === true && !after.ok, "after Sign out everywhere the other phone's sync is refused");
  b.use();
  check(b.store.getItem(app.BACKUP_KEY) === null && JSON.stringify(b.backedUp()) === kept, "being signed out stops backup and keeps every song and setting on the phone");
  const callsBefore = b.calls;
  await b.sync();
  check(b.calls === callsBefore, "once signed out the phone stops calling the server");
} finally {
  globalThis.fetch = realFetch;
  await worker.dispose();
}

if (failures > 0) {
  console.error(`check:backup failed (${failures})`);
  process.exit(1);
}
console.log("check:backup passed: first upload, byte-equal restore, two-way edits, conflict rule, signed-out and other-account cases");
