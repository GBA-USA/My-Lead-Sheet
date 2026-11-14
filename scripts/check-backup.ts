import { build } from "esbuild";
import type { ScrollVersion } from "../src/scroll-timing.ts";
import { Phone, TEST_ORIGIN, startApi } from "./api-session.ts";
import { openSite } from "./chrome.ts";

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
  /** Runs once, after the next reply arrives and before the app reads it: an edit made while a sync is on its way. */
  duringFetch: (() => void) | null = null;
  /** How many more requests reach the server before the network drops. */
  requestsLeft = Infinity;
  readonly phone: Phone;
  readonly agent: string;
  readonly origin: string;
  constructor(phone: Phone, agent: string, origin = TEST_ORIGIN) {
    this.phone = phone;
    this.agent = agent;
    this.origin = origin;
  }

  use() {
    Object.defineProperty(globalThis, "localStorage", { value: this.store, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: this.agent }, configurable: true });
    globalThis.fetch = async (path, init) => {
      this.calls += 1;
      if (this.requestsLeft-- <= 0) throw new TypeError("Failed to fetch");
      const headers = { ...(init?.headers as Record<string, string>), origin: this.origin, ...(this.phone.cookie ? { cookie: this.phone.cookie } : {}) };
      const response = await realFetch(new URL(String(path), this.phone.base), { ...init, headers });
      const edit = this.duringFetch;
      this.duringFetch = null;
      edit?.();
      return response;
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
  const idleCalls = b.calls;
  check((await app.syncBackup({ onlyIfChanged: true })).ok && b.calls === idleCalls, "an open phone with nothing new makes no request on the timer");
  app.saveScrollPercent(ref(first.songs[7].id), 100);
  await app.syncBackup({ onlyIfChanged: true });
  check(b.calls > idleCalls, "a change on the phone goes out on the timer");
  await a.sync();

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
  const saturdays = (library: typeof libA) => library.setlists.filter((set) => set.name.startsWith("Saturday")).map((set) => set.name);
  check(
    JSON.stringify(saturdays(libA)) === JSON.stringify(["Saturday"]) && JSON.stringify(saturdays(libB)) === JSON.stringify(["Saturday"]),
    `phone B's setlist moves with its song and stays one setlist on both phones (A ${JSON.stringify(saturdays(libA))}, B ${JSON.stringify(saturdays(libB))})`,
  );
  check(JSON.stringify(libA) === JSON.stringify(libB) && libA.songs.length === aLibrary.songs.length + 2, "both phones end with the same library and nothing dropped");

  a.use();
  app.saveScrollPercent(ref(first.songs[7].id), 130);
  await a.sync();
  b.duringFetch = () => app.saveScrollPercent(ref(first.songs[7].id), 115);
  await b.sync();
  b.use();
  app.saveScrollPercent(ref(first.songs[7].id), 100);
  await b.sync();
  await a.sync();
  const raced = `${app.SCROLL_PERCENT_KEY}.${first.songs[7].id}`;
  check(a.store.getItem(raced) === b.store.getItem(raced), `an edit made and undone while a sync was on its way still ends the same on both phones (${a.store.getItem(raced)}, ${b.store.getItem(raced)})`);

  b.use();
  const flight = app.syncBackup();
  app.backupOff();
  await flight;
  check(b.store.getItem(app.BACKUP_KEY) === null, "signing out while a sync is on its way leaves backup off");
  app.backupOn(userId);
  await b.sync();

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

  const c = new Device(new Phone(base), iphone);
  c.boot();
  addOwnSong(c, 980, "Chain Breaker");
  c.use();
  app.saveSongData(ref(980), { tempo: 100, timeSignature: "4/4" });
  app.saveScrollVersions(ref(980), { versions: [version("Chain timing", 200)], selected: 0 });
  const samId: string = (await c.phone.createAccount("Sam Drums")).body.account.userId;
  c.use();
  app.backupOn(samId);
  await c.sync();
  const d = new Device(new Phone(base, c.phone.authenticator), android);
  d.boot();
  addOwnSong(d, 980, "Wagon Wheel");
  d.use();
  app.saveSongData(ref(980), { tempo: 140, timeSignature: "3/4" });
  app.saveScrollVersions(ref(980), { versions: [version("Wagon timing", 180)], selected: 0 });
  await d.phone.signIn();
  d.use();
  app.backupOn(samId);
  await d.sync();
  await c.sync();
  await d.sync();
  for (const [name, device] of [["iPhone", c], ["Android", d]] as const) {
    const songs = device.boot().songs;
    const own = (song: (typeof songs)[number] | undefined) => song && { title: song.title, data: app.loadSongData(song.ref), timing: app.loadScrollVersions(song.ref).versions.map((item) => item.name) };
    const chain = own(songs.find((song) => song.id === 980));
    const wagon = own(songs.find((song) => song.title.startsWith("Wagon Wheel")));
    check(
      JSON.stringify(chain) === JSON.stringify({ title: "Chain Breaker", data: { tempo: 100, timeSignature: "4/4" }, timing: ["Chain timing"] }),
      `two phones' own songs with one id: the first keeps its tempo, time signature and timing on the ${name} (${JSON.stringify(chain)})`,
    );
    check(
      JSON.stringify(wagon) === JSON.stringify({ title: "Wagon Wheel · from Android", data: { tempo: 140, timeSignature: "3/4" }, timing: ["Wagon timing"] }),
      `the second phone's song moves to a new id with its own tempo, time signature and timing on the ${name} (${JSON.stringify(wagon)})`,
    );
  }

  const inSync = d.boot().songs.length;
  addOwnSong(c, 980, "Chain Breaker (fixed bridge)");
  addOwnSong(d, 990, "New on B");
  await c.sync();
  await d.sync();
  await c.sync();
  const titlesC = c.boot().songs.map((song) => `${song.id} ${song.title}`).sort();
  const titlesD = d.boot().songs.map((song) => `${song.id} ${song.title}`).sort();
  check(
    titlesD.length === inSync + 1 && JSON.stringify(titlesC) === JSON.stringify(titlesD) && titlesD.includes("980 Chain Breaker (fixed bridge)") && !titlesD.some((title) => title.includes("Chain Breaker ·")),
    `an edit on one phone makes no duplicate when the other adds a song (${inSync} songs, then ${titlesD.length}: ${titlesD.filter((title) => /^9\d\d /.test(title)).join(", ")})`,
  );

  const ipad = new Device(new Phone(base, c.phone.authenticator), "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)");
  ipad.boot();
  addOwnSong(ipad, 980, "Chain Breaker live");
  ipad.use();
  app.saveSongData(ref(980), { tempo: 77, timeSignature: "2/4" });
  for (let i = 0; i < 600; i += 1) ipad.store.setItem(`${app.SCROLL_PERCENT_KEY}.r${i}`, "90");
  await ipad.phone.signIn();
  ipad.use();
  app.backupOn(samId);
  await ipad.sync();
  await c.sync();
  c.use();
  const chainData = app.loadSongData(ref(980));
  const live = ipad.boot().songs.find((song) => song.title === "Chain Breaker live · from iPad");
  ipad.use();
  check(
    JSON.stringify(chainData) === JSON.stringify({ tempo: 100, timeSignature: "4/4" }) && JSON.stringify(live && app.loadSongData(live.ref)) === JSON.stringify({ tempo: 77, timeSignature: "2/4" }),
    `a first sync too big for one request still keeps each song's settings with its song (Chain Breaker ${JSON.stringify(chainData)}, the iPad's copy ${JSON.stringify(live && app.loadSongData(live.ref))})`,
  );

  const e = new Device(new Phone(base), iphone);
  e.boot();
  addOwnSong(e, 960, "Chain Breaker");
  const patId: string = (await e.phone.createAccount("Pat Keys")).body.account.userId;
  e.use();
  app.backupOn(patId);
  await e.sync();
  const f = new Device(new Phone(base, e.phone.authenticator), android);
  f.boot();
  addOwnSong(f, 960, "Wagon Wheel");
  f.use();
  app.saveScrollVersions(ref(960), { versions: [version("Wagon timing", 180)], selected: 0 });
  await f.phone.signIn();
  f.use();
  app.backupOn(patId);
  f.requestsLeft = 1;
  const dropped = await f.sync();
  f.requestsLeft = Infinity;
  await e.sync();
  e.use();
  const pulledOnChain = app.loadScrollVersions(ref(960)).versions.map((item) => item.name);
  check(!dropped.ok && dropped.problem === "offline" && pulledOnChain.length === 0, `a phone that loses the network after its first request leaves no timing on the other phone's song with the same id (${dropped.problem}, ${JSON.stringify(pulledOnChain)})`);
  app.updateScrollVersions(ref(960), (current) => ({ versions: [...current.versions, version("Chain new", 220)], selected: current.versions.length }));
  await e.sync();
  for (let i = 0; i < 2; i += 1) {
    await f.sync();
    await e.sync();
  }
  for (const [name, device] of [["iPhone", e], ["Android", f]] as const) {
    const songs = device.boot().songs;
    const timed = (song: (typeof songs)[number] | undefined) => song && [song.title, app.loadScrollVersions(song.ref).versions.map((item) => item.name)];
    const pair = [timed(songs.find((song) => song.id === 960)), timed(songs.find((song) => song.title.startsWith("Wagon Wheel")))];
    check(
      JSON.stringify(pair) === JSON.stringify([["Chain Breaker", ["Chain new"]], ["Wagon Wheel · from Android", ["Wagon timing"]]]),
      `after a dropped first sync each song keeps only its own timing on the ${name} (${JSON.stringify(pair)})`,
    );
  }
  for (const [device, title] of [[e, "Night Drive"], [f, "Day Drive"]] as const) {
    addOwnSong(device, 975, title);
    device.use();
    app.saveScrollVersions(ref(975), { versions: [version("Shared", 150)], selected: 0 });
  }
  await e.sync();
  await f.sync();
  await e.sync();
  for (const [name, device] of [["iPhone", e], ["Android", f]] as const) {
    const songs = device.boot().songs;
    const timed = (song: (typeof songs)[number] | undefined) => song && [song.title, app.loadScrollVersions(song.ref).versions.map((item) => item.name)];
    const pair = [timed(songs.find((song) => song.id === 975)), timed(songs.find((song) => song.title.startsWith("Day Drive")))];
    check(
      JSON.stringify(pair) === JSON.stringify([["Night Drive", ["Shared"]], ["Day Drive · from Android", ["Shared"]]]),
      `two songs with one id and the same timing both keep it on the ${name} (${JSON.stringify(pair)})`,
    );
  }

  const rowsOf = async (cookie: string) => (await post(cookie, { since: 0, changes: [] })).body.rows?.length ?? -1;
  const samRows = await rowsOf(c.phone.cookie);
  const unknownKey = await post(c.phone.cookie, { since: 0, changes: [{ key: "leadSheetsJunk.1", kind: "timing", value: "x", base: 0 }] });
  const wrongKind = await post(c.phone.cookie, { since: 0, changes: [{ key: `${app.SCROLL_PERCENT_KEY}.1`, kind: "timing", value: "1", base: 0 }] });
  const metronome = await post(c.phone.cookie, { since: 0, changes: [{ key: app.METRONOME_PREFS_KEY, kind: "settings", value: "{}", base: 0 }] });
  check(
    unknownKey.status === 400 && wrongKind.status === 400 && metronome.status === 400 && (await rowsOf(c.phone.cookie)) === samRows,
    `the room refuses a key no phone backs up, and a kind that is not the key's (${unknownKey.status}, ${wrongKind.status}, ${metronome.status})`,
  );

  d.use();
  d.store.setItem(`${app.SCROLL_VERSIONS_KEY}.3`, JSON.stringify({ versions: [version("x".repeat(1_000_001), 100)], selected: null }));
  d.store.setItem(`${app.NOTATION_KEY}.not a ref`, JSON.stringify("nashville"));
  app.saveScrollPercent(ref(4), 70);
  const heldBack = await d.sync();
  await c.sync();
  c.use();
  check(
    heldBack.ok && heldBack.at !== null && heldBack.heldBack === 2 && app.loadScrollPercent(ref(4)) === 70,
    `a value too long and a key the room can't store are held back, the rest backs up, and the phone says how many (ok ${heldBack.ok}, held ${heldBack.heldBack})`,
  );
  d.use();
  d.store.removeItem(`${app.SCROLL_VERSIONS_KEY}.3`);
  d.store.removeItem(`${app.NOTATION_KEY}.not a ref`);

  const full = new Device(new Phone(base), iphone);
  full.boot();
  await full.phone.createAccount("Alex Full");
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ key: `${app.SCROLL_PERCENT_KEY}.r${from + i}`, kind: "scroll", value: "90", base: 0 }));
  const fills = [];
  for (let i = 0; i < 10; i += 1) fills.push((await post(full.phone.cookie, { since: 0, changes: many(i * 500, 500) })).status);
  const overRows = await post(full.phone.cookie, { since: 0, changes: many(5000, 1) });
  check(
    fills.every((status) => status === 200) && overRows.status === 413 && overRows.body.error === "backup-full" && (await rowsOf(full.phone.cookie)) === 5000,
    `a backup at 5,000 rows refuses one more with 413 and keeps none of it (${fills.join(",")} then ${overRows.status})`,
  );
  check((await post(full.phone.cookie, { since: 0, changes: [] })).status === 200, "a full backup still answers a sync that sends nothing, so its phones can still pull");

  const big = new Device(new Phone(base), android);
  big.boot();
  const bigId: string = (await big.phone.createAccount("Jo Big")).body.account.userId;
  const huge = (n: number) => ({ key: `${app.SCROLL_VERSIONS_KEY}.${n}`, kind: "timing", value: "x".repeat(999_000), base: 0 });
  const underBytes = [(await post(big.phone.cookie, { since: 0, changes: [huge(1), huge(2), huge(3)] })).status, (await post(big.phone.cookie, { since: 0, changes: [huge(4), huge(5)] })).status];
  const overBytes = await post(big.phone.cookie, { since: 0, changes: [{ key: `${app.SCROLL_PERCENT_KEY}.1`, kind: "scroll", value: "9".repeat(10_000), base: 0 }] });
  check(underBytes.every((status) => status === 200) && overBytes.status === 413 && (await rowsOf(big.phone.cookie)) === 5, `a backup near 5 MB refuses a write that passes it with 413 (${underBytes.join(",")} then ${overBytes.status})`);
  big.use();
  app.backupOn(bigId);
  await big.sync();
  big.store.setItem(`${app.SCROLL_PERCENT_KEY}.2`, "9".repeat(10_000));
  const refused = await big.sync();
  check(!refused.ok && refused.problem === "full", `a phone whose backup is full says so instead of "can't reach the server" (ok ${refused.ok}, problem ${refused.problem})`);
} finally {
  globalThis.fetch = realFetch;
  await worker.dispose();
}

let sheetBase = "";
const site = await openSite(root, "backup-sheet", () => sheetBase);
const sheetOrigin = site.origin.replace("127.0.0.1", "localhost");
const sheetApi = await startApi({ APP_ORIGIN: sheetOrigin, RP_ID: "localhost" });
sheetBase = sheetApi.base;
try {
  const SONG_ONE = `${app.SCROLL_VERSIONS_KEY}.1`;
  const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (expression: string, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression)) return true;
    return false;
  };
  const TIMING = `[...document.querySelectorAll("button.teach-btn")].find((b) => b.textContent.includes("Timing:"))`;
  const timingMenu = async () => {
    await until(`!!${TIMING}`);
    await site.evaluate(`${TIMING}.click()`);
    await until(`!!document.querySelector("[role=menuitemradio]")`);
    return site.evaluate<string[]>(`[...document.querySelectorAll("[role=menuitemradio]")].map((b) => b.textContent.replace("✓", "").trim())`);
  };
  const backedUpOnB = () => until(`(() => { const state = JSON.parse(localStorage.getItem("leadSheetsBackup") ?? "{}"); return state.at != null && !Object.values(state.synced).some(([, print]) => print === "?"); })()`);
  const versionsOnB = async () => (JSON.parse((await site.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(SONG_ONE)})`)) ?? "{}").versions ?? []).map((item: ScrollVersion) => item.name);

  const phoneA = new Device(new Phone(sheetBase), iphone, sheetOrigin);
  phoneA.boot();
  const created = await phoneA.phone.createAccount("Terry Bass", { origin: sheetOrigin, rpId: "localhost" });
  const sheetUser: string = created.body.account.userId;
  const [cookieName, cookieValue] = phoneA.phone.cookie.split(/=(.*)/s);
  await site.send("Network.enable");
  await site.send("Network.setCookie", { name: cookieName, value: cookieValue, url: sheetOrigin, httpOnly: true, secure: true, sameSite: "Lax" });
  await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.navigate", { url: `${sheetOrigin}/#/songs` });
  await until(`!!document.querySelector(".shell-header")`);
  await site.evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(SONG_ONE)}, ${JSON.stringify(JSON.stringify({ versions: [version("Mine", 150)], selected: null }))});
    localStorage.setItem("leadSheetsBackup", JSON.stringify({ account: ${JSON.stringify(sheetUser)}, pulled: 0, synced: {}, at: null }));
  })()`);
  await site.send("Page.reload");
  await until(`!!document.querySelector(".shell-header")`);
  await backedUpOnB();
  await site.evaluate(`location.hash = "#/song/1"`);
  const before = await timingMenu();
  await site.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);

  phoneA.use();
  app.backupOn(sheetUser);
  await phoneA.sync();
  phoneA.use();
  const onlyA = app.loadScrollVersions(app.localRef(1)).versions;
  app.saveScrollVersions(app.localRef(1), { versions: [...onlyA, version("Learned on iPad", 210)], selected: onlyA.length });
  await phoneA.sync();

  await site.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
  const pulled = await until(`(localStorage.getItem(${JSON.stringify(SONG_ONE)}) ?? "").includes("Learned on iPad")`);
  await settle(300);
  const shown = await timingMenu();
  check(pulled && before.includes("Mine") && shown.includes("Learned on iPad"), `an open sheet's Timing menu shows a version pulled from the other phone (${JSON.stringify(before)} then ${JSON.stringify(shown)})`);
  const tapped = await site.evaluate<boolean>(`(() => {
    const mine = [...document.querySelectorAll("[role=menuitemradio]")].find((b) => b.textContent.includes("Mine"));
    mine?.click();
    return !!mine;
  })()`);
  await settle(300);
  await site.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
  await settle(500);
  await backedUpOnB();
  await phoneA.sync();
  phoneA.use();
  const onA = app.loadScrollVersions(app.localRef(1)).versions.map((item) => item.name);
  const onB = await versionsOnB();
  check(
    tapped && onA.includes("Learned on iPad") && onB.includes("Learned on iPad") && onA.includes("Mine") && onB.includes("Mine"),
    `tapping a Timing choice on the open sheet keeps the pulled version on both phones (A ${JSON.stringify(onA)}, B ${JSON.stringify(onB)})`,
  );
} finally {
  globalThis.fetch = realFetch;
  await site.close();
  await sheetApi.worker.dispose();
}

if (failures > 0) {
  console.error(`check:backup failed (${failures})`);
  process.exit(1);
}
console.log("check:backup passed: first upload, byte-equal restore, two-way edits, conflict rule, per-song data across a moved song, held-back keys, the key allowlist and caps, an open sheet after a pull, signed-out and other-account cases");
