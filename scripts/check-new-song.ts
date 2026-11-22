import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ChartLine, ChartSection, LibraryFile, Song } from "../src/types.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * P6, Write your own song. One case per pass condition, named by it. The cases fix this contract, which the build
 * meets:
 *
 * `src/song-text.ts` (pure): `parseSheet(text)` gives `{ sections, warnings }`, each warning `{ line, message }` with
 * `line` the 1-based input line; `sectionsToText(sections)` is the text the editor opens an own song with;
 * `ownSong(meta, sections)` is the stored song, every field the editor does not ask for empty. `src/storage.ts`:
 * `madeHere(song)` and `removeOwnSong(id)`, which is false for a song the player did not make.
 *
 * On the phone, signed in, My Songs has "+ Add a song". It opens a dialog with Title, Artist, Key, BPM, Time
 * signature and Chart fields, "Paste a sheet" (reads the clipboard; when it can't, it says "Paste your sheet into the
 * box." and focuses it), a preview drawn by the normal chart, and each warning as "Line N: <message>" under the box.
 * The song page's More menu has Edit and Delete enabled on a song the player made; on any other song both are off,
 * with "Only songs you made can be edited." Delete asks first in an alert dialog with Cancel and Delete.
 *
 * The pure cases run anywhere. The rest start the Worker and headless Chrome (`CHROME`).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as LibraryFile;
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Warning = { line: number; message: string };
type Meta = { title: string; artist: string; keyRoot: string; keyMode: "major" | "minor"; tempo: number | null; timeSignature: string };
type App = typeof import("../src/storage.ts") &
  typeof import("../src/backup.ts") & {
    SONG_SETTING_KEYS: string[];
    parseSheet: (text: string) => { sections: ChartSection[]; warnings: Warning[] };
    sectionsToText: (sections: ChartSection[]) => string;
    ownSong: (meta: Meta, sections: ChartSection[]) => Omit<Song, "ref" | "id">;
    madeHere: (song: Pick<Song, "id" | "copy">) => boolean;
    removeOwnSong: (id: number) => boolean;
  };

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
const useStorage = (store: FakeStorage) => Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });

let app: App | null = null;
try {
  const bundle = await build({
    stdin: {
      contents: `export * from "./src/song-text.ts"; export * from "./src/storage.ts"; export * from "./src/backup.ts"; export { SONG_SETTING_KEYS } from "./src/backup-keys.ts";`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  app = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.log(`FAIL the song text and storage modules load: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  failed += 1;
}
const need = (): App => {
  assert.ok(app, "the song text and storage modules loaded");
  return app;
};

const META: Meta = { title: "Kitchen Floor", artist: "Pat Bass", keyRoot: "A", keyMode: "major", tempo: 96, timeSignature: "4/4" };
const TWO_SECTIONS = ["VERSE 1", "A               E", "Honey, load up your questions", "", "Chorus:", "[D]Fire a[A]way, [E]fire away"].join("\n");
/** Hand-read from the text above: the word each chord is typed over, counted across the song, and how far into it. */
const TWO_SECTION_ANCHORS = ['A on word 1 "Honey," at 0', 'E on word 4 "your" at 1', 'D on word 6 "Fire" at 0', 'A on word 7 "away," at 1', 'E on word 8 "fire" at 0'];
const pairs = (sections: ChartSection[]) => sections.flatMap((section) => section.lines).filter((line): line is Row & ChartLine => line.chords !== undefined);

/** A bracket line read the way a player means it: the lyric without brackets, and each chord at the letter after its bracket. */
function bracketMeaning(line: string): Row {
  const names: string[] = [];
  const at: number[] = [];
  let lyrics = "";
  for (const part of line.split(/(\[[^\]]*\])/)) {
    if (/^\[.+\]$/.test(part)) {
      names.push(part.slice(1, -1));
      at.push(lyrics.length);
    } else lyrics += part;
  }
  return { chords: names.join(" "), lyrics, at };
}

/** A two-line pair written the inline way, each chord in brackets before the letter it sits over. */
function inBrackets(pair: { chords: string; lyrics: string }): string {
  let out = pair.lyrics;
  for (const chord of [...pair.chords.matchAll(/\S+/g)].reverse()) out = `${out.slice(0, chord.index)}[${chord[0]}]${out.slice(chord.index)}`;
  return out;
}

/** One line holding bars and a note draws as the bars row, then the note: the same page as the two lines apart. */
const drawnLines = (sections: ChartSection[]) =>
  sections.map((section) => ({ heading: section.heading, lines: section.lines.flatMap((line) => (line.bars !== undefined && line.note !== undefined ? [{ bars: line.bars }, { note: line.note }] : [line])) }));

// 1a
await check("1a. a parsed two-section song has each chord on the syllable it was typed over, and the phone keeps it as a song", () => {
  const app = need();
  const { sections, warnings } = app.parseSheet(TWO_SECTIONS);
  assert.deepEqual(sections.map((section) => section.heading), ["VERSE 1", "Chorus"], "two sections, named by their heading lines");
  assert.deepEqual(warnings, [], "no warnings");
  assert.deepEqual(chordAnchors(pairs(sections)), TWO_SECTION_ANCHORS, "every chord on its syllable");
  const store = new FakeStorage();
  useStorage(store);
  const song = app.ownSong(META, sections);
  const id = app.addOwnSong(song);
  assert.ok(id !== null, "the stored song is one the phone can show (it passes the stored-song check)");
  const kept = app.loadLibrary().songs.find((each) => each.id === id);
  assert.ok(kept, "the song is in My Songs after the library is read again");
  assert.deepEqual([kept.title, kept.artist, kept.keyRoot, kept.keyMode, kept.tempo, kept.timeSignature], ["Kitchen Floor", "Pat Bass", "A", "major", 96, "4/4"], "with the fields the player gave");
  assert.deepEqual(kept.body, sections, "and the chart as parsed");
  assert.equal(kept.copy, undefined, "with no copy mark");
});

// 2a
await check("2a. pasted two-line text and pasted bracket text parse to the same sections and anchors", () => {
  const app = need();
  const twoLine = app.parseSheet(["VERSE 1", "A               E", "Honey, load up your questions"].join("\n"));
  const bracket = app.parseSheet(["VERSE 1", "[A]Honey, load up y[E]our questions"].join("\n"));
  assert.deepEqual(bracket.sections, twoLine.sections, "the same section and pair");
  assert.deepEqual(chordAnchors(pairs(bracket.sections)), chordAnchors(pairs(twoLine.sections)), "the same anchors");
  let compared = 0;
  for (const song of seed.songs) {
    for (const line of song.body.flatMap((section) => section.lines)) {
      if (line.chords === undefined || line.lyrics === undefined) continue;
      if ([...line.chords.matchAll(/\S+/g)].some((chord) => chord.index >= line.lyrics!.length)) continue;
      const parsed = app.parseSheet(inBrackets({ chords: line.chords, lyrics: line.lyrics }));
      assert.deepEqual(parsed.sections[0]?.lines, [{ chords: line.chords, lyrics: line.lyrics }], `${song.title}: "${inBrackets({ chords: line.chords, lyrics: line.lyrics })}" parses to the library's own pair`);
      compared += 1;
    }
  }
  assert.ok(compared > 300, `every library pair written in brackets parses back to that pair (${compared} compared)`);
});

await check("2a. bracket chords land on the syllable after each bracket, and a chord name too long for the gap moves the later words right at a word boundary", () => {
  const app = need();
  for (const line of ["[A]Honey, load [E]up your questions", "[Am7]Hi [E]there", "[Cmaj7]Oh [G/B]my [Am]dar[F]ling", "Sing [N.C.]it [E7sus4]out [B]now"]) {
    const { sections, warnings } = app.parseSheet(line);
    assert.deepEqual(warnings, [], `${line}: no warnings`);
    assert.deepEqual(chordAnchors(pairs(sections)), chordAnchors([bracketMeaning(line)]), `${line}: each chord where its bracket was`);
  }
  assert.deepEqual(app.parseSheet("[Am7]Hi [E]there").sections[0].lines, [{ chords: "Am7 E", lyrics: "Hi  there" }], "a space goes in between the words, not inside one");
});

await check("2a. a collision inside a word yields the warning and keeps the lyric", () => {
  const app = need();
  const { sections, warnings } = app.parseSheet(["Chorus:", "[A]Honey, load up your ques[Am7]ti[E]ons"].join("\n"));
  assert.deepEqual(warnings, [{ line: 2, message: "Chords too close inside 'questions'" }], "one warning, on line 2");
  assert.equal(sections[0].lines[0].lyrics, "Honey, load up your questions", "the lyric stays as typed");
  assert.deepEqual(
    [...(sections[0].lines[0].chords ?? "").matchAll(/\S+/g)].map((chord) => chord[0]),
    ["A", "Am7", "E"],
    "every chord is still there, in order",
  );
});

await check("2a. blank lines split sections and headings are kept", () => {
  const app = need();
  const text = ["INTRO", "| A | E |", "", "", "Verse 1:", "A        E", "Honey, load up", "", "D        A", "Fire away, fire away", "Note: hold the last A", "", "[Chorus]", "[D]Fire away", "", "BRIDGE (x2)", "Bars: Am - D - G", "Bm   Em"].join("\n");
  const { sections, warnings } = app.parseSheet(text);
  assert.deepEqual(warnings, [], "no warnings");
  assert.deepEqual(sections, [
    { heading: "INTRO", lines: [{ bars: "| A | E |" }] },
    { heading: "Verse 1", lines: [{ chords: "A        E", lyrics: "Honey, load up" }] },
    { heading: "Verse 2", lines: [{ chords: "D        A", lyrics: "Fire away, fire away" }, { note: "hold the last A" }] },
    { heading: "Chorus", lines: [{ chords: "D", lyrics: "Fire away" }] },
    { heading: "BRIDGE (x2)", lines: [{ bars: "Am - D - G" }, { bars: "Bm   Em" }] },
  ]);
});

await check("2a. every library song written as editor text parses back to the same chart", () => {
  const app = need();
  for (const song of seed.songs) {
    const text = app.sectionsToText(song.body);
    const parsed = app.parseSheet(text);
    assert.deepEqual(parsed.warnings, [], `${song.title}: no warnings`);
    assert.deepEqual(parsed.sections, drawnLines(song.body), `${song.title}: the same sections and lines`);
    assert.equal(app.sectionsToText(parsed.sections), app.sectionsToText(drawnLines(song.body)), `${song.title}: and the same text again`);
  }
  const pasted = app.parseSheet(TWO_SECTIONS).sections;
  assert.deepEqual(app.parseSheet(app.sectionsToText(pasted)).sections, pasted, "an own song opens in the editor as text that saves back unchanged");
});

await check("3. only a song the player made counts as made here", () => {
  const app = need();
  useStorage(new FakeStorage());
  const library = app.loadLibrary();
  const builtIn = library.songs[0];
  assert.equal(app.madeHere(builtIn), false, "a built-in song is not");
  const id = app.addOwnSong(app.ownSong(META, app.parseSheet(TWO_SECTIONS).sections))!;
  assert.equal(app.madeHere(app.loadLibrary().songs.find((song) => song.id === id)!), true, "a song added here is");
  const copyId = app.addOwnSong({ ...app.ownSong(META, app.parseSheet(TWO_SECTIONS).sections), title: "Gift", copy: { id: "c1", canSendOn: true, from: { name: "Sam" } } })!;
  assert.equal(app.madeHere(app.loadLibrary().songs.find((song) => song.id === copyId)!), false, "a friend's copy is not");
  const stored = JSON.parse(localStorage.getItem(app.LIBRARY_KEY)!);
  stored.songs[0] = { ...stored.songs[0], title: "Renamed built-in" };
  localStorage.setItem(app.LIBRARY_KEY, JSON.stringify(stored));
  const edited = app.loadLibrary().songs.find((song) => song.id === builtIn.id)!;
  assert.equal(edited.title, "Renamed built-in", "a built-in song edited on this phone keeps the edit");
  assert.equal(app.madeHere(edited), false, "and is still a built-in song");
});

await check("6. removeOwnSong removes the song from My Songs, from the player's own setlists and from its per-song settings", () => {
  const app = need();
  const store = new FakeStorage();
  useStorage(store);
  const builtIn = app.loadLibrary().songs[0];
  const id = app.addOwnSong(app.ownSong(META, app.parseSheet(TWO_SECTIONS).sections))!;
  const ref = app.localRef(id);
  const friday = app.addOwnSetlist({ name: "Friday", songIds: [builtIn.id, id, builtIn.id] })!;
  app.saveNotation(ref, "nashville");
  app.saveScrollPercent(ref, 80);
  app.saveSongData(ref, { officialRuntimeSec: 200 });
  app.saveScrollVersions(ref, { versions: [{ name: "Taught", bpm: 96, marks: [{ at: 0, progress: 0 }, { at: 180, progress: 1 }] }], selected: 0 });
  app.saveSongDraft(null, ref, { semitones: 2 });
  app.saveSongDraft("user_1", ref, { semitones: 3 });
  app.saveNotation(builtIn.ref, "nashville");
  assert.ok(app.SONG_SETTING_KEYS.every((key) => store.getItem(`${key}.${id}`) !== null), "every per-song setting was stored first");

  assert.equal(app.removeOwnSong(builtIn.id), false, "a built-in song can't be removed");
  assert.ok(app.loadLibrary().songs.some((song) => song.id === builtIn.id), "and stays");
  assert.equal(app.removeOwnSong(id), true, "the own song is removed");
  const after = app.loadLibrary();
  assert.ok(!after.songs.some((song) => song.id === id), "it is gone from My Songs");
  assert.deepEqual(after.setlists.find((setlist) => setlist.id === friday)?.songRefs, [builtIn.ref, builtIn.ref], "and from the setlist, which keeps its other songs");
  for (const key of app.SONG_SETTING_KEYS) assert.equal(store.getItem(`${key}.${id}`), null, `${key}.${id} is gone`);
  assert.equal(app.loadSongDraft(null, ref), undefined, "the signed-out draft is gone");
  assert.equal(app.loadSongDraft("user_1", ref), undefined, "an account's draft is gone");
  assert.equal(app.loadNotation(builtIn.ref), "nashville", "another song's settings stay");
  const next = app.addOwnSong(app.ownSong({ ...META, title: "Next one" }, app.parseSheet(TWO_SECTIONS).sections))!;
  assert.equal(app.loadNotation(app.localRef(next)), "notes", "a song added after it starts with no settings, whatever id it gets");
  const copyId = app.addOwnSong({ ...app.ownSong(META, app.parseSheet(TWO_SECTIONS).sections), copy: { id: "c1", canSendOn: true } })!;
  assert.equal(app.removeOwnSong(copyId), false, "a friend's copy can't be removed this way");
});

await check("6. a song written after the newest own song is deleted gets a new id, so nothing kept under the old id passes to it", () => {
  const app = need();
  useStorage(new FakeStorage());
  const song = app.ownSong(META, app.parseSheet(TWO_SECTIONS).sections);
  const gone = app.addOwnSong(song)!;
  assert.equal(app.removeOwnSong(gone), true, "the newest own song is deleted");
  app.loadLibrary();
  const next = app.addOwnSong({ ...song, title: "A Different Song" })!;
  assert.notEqual(next, gone, `the new song gets its own id (deleted ${gone}, new ${next})`);
});

// The Worker: backup and restore, one phone.
const realFetch = globalThis.fetch;
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

class Device {
  readonly store = new FakeStorage();
  readonly phone: Phone;
  constructor(phone: Phone) {
    this.phone = phone;
  }
  use() {
    useStorage(this.store);
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: iphone }, configurable: true });
    globalThis.fetch = (path, init) =>
      realFetch(new URL(String(path), this.phone.base), { ...init, headers: { ...(init?.headers as Record<string, string>), origin: "https://app.test", ...(this.phone.cookie ? { cookie: this.phone.cookie } : {}) } });
  }
  async sync() {
    this.use();
    return need().syncBackup();
  }
  boot() {
    this.use();
    return need().loadLibrary();
  }
}

await check("4. an own song survives reload and backs up and restores with the account", async () => {
  const app = need();
  const { worker, base } = await startApi();
  try {
    const phone = new Device(new Phone(base));
    phone.boot();
    const sections = app.parseSheet(TWO_SECTIONS).sections;
    const id = app.addOwnSong(app.ownSong(META, sections))!;
    app.saveNotation(app.localRef(id), "nashville");
    assert.ok(phone.boot().songs.some((song) => song.id === id && song.title === META.title), "the song is there when the app starts again");
    const made = await phone.phone.createAccount("Pat Bass");
    const userId = made.body.account.userId as string;
    phone.use();
    app.backupOn(userId);
    const up = await phone.sync();
    assert.ok(up.ok && up.at !== null, "the phone backs up");

    const wiped = new Device(new Phone(base, phone.phone.authenticator));
    wiped.boot();
    assert.equal((await wiped.phone.signIn()).status, 200, "the same phone, wiped, signs in to the account again");
    wiped.use();
    app.backupOn(userId);
    const down = await wiped.sync();
    assert.ok(down.ok, "and pulls the backup");
    const restored = wiped.boot().songs.find((song) => song.id === id);
    assert.ok(restored, "the own song is back, under its id");
    assert.deepEqual([restored.title, restored.artist, restored.body], [META.title, META.artist, sections], "with its title, artist and chart");
    assert.equal(restored.copy, undefined, "still the player's own, with no copy mark");
    assert.equal(app.madeHere(restored), true, "so Edit and Delete still apply to it");
    assert.equal(app.loadNotation(app.localRef(id)), "nashville", "its per-song setting came back too");
    assert.ok(!wiped.boot().songs.some((song) => song.title.includes(" · from ")), "no second copy was made");

    wiped.use();
    assert.equal(app.removeOwnSong(id), true, "the player deletes it");
    await wiped.sync();
    await phone.sync();
    assert.ok(!phone.boot().songs.some((song) => song.id === id), "the delete goes out with the next backup, so the copy the phone backed up first goes too");
    assert.equal(phone.store.getItem(`leadSheetsNotation.${id}`), null, "and its setting");
  } finally {
    globalThis.fetch = realFetch;
    await worker.dispose();
  }
});

await check("PROBE second phone: a deleted own song's id is not handed out again on a phone that restores the backup", async () => {
  const app = need();
  const { worker, base } = await startApi();
  try {
    const a = new Device(new Phone(base));
    a.boot();
    const sections = app.parseSheet(TWO_SECTIONS).sections;
    const made = await a.phone.createAccount("Pat Bass");
    const userId = made.body.account.userId as string;
    a.use();
    app.backupOn(userId);
    app.addOwnSong(app.ownSong({ ...META, title: "Keeper" }, sections));
    const gone = app.addOwnSong(app.ownSong({ ...META, title: "Short Lived" }, sections))!;
    a.store.setItem("leadSheetsSentSongs", js({ [userId]: { [app.localRef(gone)]: { user_mike: "share_old" } } }));
    await a.sync();
    a.use();
    assert.equal(app.removeOwnSong(gone), true, "phone A deletes Short Lived");
    await a.sync();

    const b = new Device(new Phone(base, a.phone.authenticator));
    b.boot();
    assert.equal((await b.phone.signIn()).status, 200, "phone B signs in to Pat");
    b.use();
    app.backupOn(userId);
    assert.ok((await b.sync()).ok, "phone B restores");
    assert.ok(!b.boot().songs.some((song) => song.id === gone), "phone B does not bring Short Lived back");
    b.use();
    const next = app.addOwnSong(app.ownSong({ ...META, title: "A Different Song" }, sections))!;
    assert.notEqual(next, gone, `phone B's new song gets its own id (deleted ${gone}, new ${next})`);
    await b.sync();
    await a.sync();
    assert.equal(a.boot().songs.find((song) => song.id === next)?.title, "A Different Song", "phone A gets the new song under its new id");
    assert.ok(!a.boot().songs.some((song) => song.id === gone), "and nothing under the deleted id, which phone A's sent map still points at an old send");
  } finally {
    globalThis.fetch = realFetch;
    await worker.dispose();
  }
});

// The phone, in headless Chrome against the Worker.
const WIDTHS = [344, 390, 820, 884, 1280];
const measure = `(() => {
  const chart = document.querySelector(".sheet .chart");
  const box = chart.getBoundingClientRect();
  const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
  const rows = [...chart.querySelectorAll(".pair")].map((row) => {
    const chords = row.querySelector(".chords");
    const lyrics = row.querySelector(".lyrics");
    const text = chords.textContent;
    const lyric = lyrics?.textContent ?? "";
    const left = (lyrics ?? chords).getBoundingClientRect().left;
    const sample = lyric ? { node: lyrics.firstChild, length: lyric.length } : { node: chords.firstChild, length: text.length };
    const advance = range(sample.node, 0, sample.length).width / sample.length;
    const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance));
    const right = Math.max(range(chords.firstChild, 0, text.length).right, lyric ? range(lyrics.firstChild, 0, lyric.length).right : 0);
    return { chords: text, lyrics: lyrics ? lyric : undefined, at, right };
  });
  return { right: box.right, rows };
})()`;

async function phoneChecks(site: Site, base: string, origin: string) {
  const page = await appPage(site);
  type Reply = { status: number; body: Record<string, any> };
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const stored = () => site.evaluate<Song[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? "{}").songs ?? []`);
  const hashId = () => site.evaluate<number | null>(`(() => { const m = location.hash.match(/^#\\/song\\/(\\d+)/); return m ? Number(m[1]) : null; })()`);
  const buttons = (scope: string) => site.evaluate<{ text: string; disabled: boolean }[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
  const hasButton = (text: string) => site.evaluate<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${js(text)})`);
  const editor = `document.querySelector(".song-editor[role=dialog]")`;
  const field = (label: string) => `[...${editor}.querySelectorAll("label")].find((l) => l.textContent.trim() === ${js(label)})?.control`;
  /** Sets a field the way typing or picking does, so React sees the change. */
  const fill = async (label: string, value: string) => {
    const set = await site.evaluate<boolean>(`(() => {
      const el = ${field(label)};
      if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${js(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      return true;
    })()`);
    assert.ok(set, `a ${label} field in the editor`);
    await settle(150);
  };
  const value = (label: string) => site.evaluate<string>(`${field(label)}?.value ?? ""`);
  const openSong = async (id: number) => {
    await site.evaluate(`location.hash = ${js(`#/song/${id}`)}`);
    await page.until(`!!document.querySelector(".sheet .sheet-name") && location.hash === ${js(`#/song/${id}`)}`, `song ${id} on screen`);
  };
  const openMore = async () => {
    await site.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
    await page.until(`!!document.querySelector("[role=menu]")`, "the More menu");
    return buttons(`document.querySelector("[role=menu]")`);
  };
  const closeMore = async () => {
    await site.evaluate(`document.querySelector("[role=menu]") && document.querySelector('.shell-header [aria-label="More"]').click()`);
    await settle();
  };
  const tapIn = async (scope: string, text: string) => {
    const tapped = await site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`);
    assert.ok(tapped, `a ${text} button to tap`);
    await settle();
  };
  const reload = async (hash: string) => {
    await site.evaluate(`location.hash = ${js(hash)}`);
    await site.evaluate("location.reload()");
    await page.library();
  };
  const atWidth = (width: number) => site.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: width < 800 });
  const fitsAt = async (what: string, selector: string) => {
    for (const width of WIDTHS) {
      await atWidth(width);
      await settle(200);
      const box = await site.evaluate<{ page: number; left: number; right: number } | null>(
        `(() => { const el = document.querySelector(${js(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { page: document.documentElement.scrollWidth, left: r.left, right: r.right }; })()`,
      );
      assert.ok(box, `${what} is on screen at ${width} px`);
      assert.ok(box.page <= width && box.left >= -0.5 && box.right <= width + 0.5, `${what} fits at ${width} px (page ${box.page}, ${box.left.toFixed(1)} to ${box.right.toFixed(1)})`);
    }
    await atWidth(390);
    await settle(200);
  };

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await page.library();

  await check("signed out, My Songs offers no + Add a song, and nothing traps the visitor", async () => {
    assert.equal(await hasButton("+ Add a song"), false, "no + Add a song signed out");
  });

  await page.signUp("Pat Bass");
  const pat = (await site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`)).account;
  assert.ok(pat, "Pat is signed in on the phone");
  let id = 0;
  let mike: Awaited<ReturnType<typeof passwordPlayer>> | null = null;

  await check("1b. a song written in + Add a song opens at #/song/<id> as a chart, each chord on its syllable, no row past the chart", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await page.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ Add a song")`, "+ Add a song on My Songs");
    await page.click("+ Add a song");
    await page.until(`!!${editor}`, "the song editor");
    assert.ok(await site.evaluate<boolean>(`!!${editor}.querySelector(".song-editor-preview")`), "the editor has a preview");
    await fitsAt("the empty editor", ".song-editor");
    await tapIn(editor, "Save");
    assert.ok((await page.text(".song-editor [role=alert]")).includes("Add a title"), "Save with no title asks for one");
    await fill("Title", META.title);
    await fill("Artist", META.artist);
    await fill("Key", "A");
    await fill("BPM", "96");
    await tapIn(editor, "Save");
    assert.ok((await page.text(".song-editor [role=alert]")).includes("Add at least one section"), "Save with no chart asks for a section");
    await fill("Chart", TWO_SECTIONS);
    await page.until(`document.querySelectorAll(".song-editor-preview .chart .chords").length === 2`, "the preview's two chord rows");
    assert.deepEqual(await page.texts(".song-editor-preview .chart-heading"), ["VERSE 1", "Chorus"], "the preview names both sections");
    await fitsAt("the filled editor", ".song-editor");
    await tapIn(editor, "Save");
    await page.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the new song's page");
    id = (await hashId())!;
    assert.equal(await page.text(".sheet .sheet-name"), META.title, "the page shows its title");
    assert.ok(await site.evaluate<boolean>(`document.querySelectorAll(".sheet .chart .chords").length >= 2`), "as a chart with chord rows");
    await site.evaluate("document.fonts.ready.then(() => true)");
    const source = chordAnchors(pairs(need().parseSheet(TWO_SECTIONS).sections));
    for (const width of WIDTHS) {
      await atWidth(width);
      await settle(300);
      const drawn = await site.evaluate<{ right: number; rows: (Row & { right: number })[] }>(measure);
      assert.deepEqual(chordAnchors(drawn.rows), source, `at ${width} px every chord is drawn over the syllable it was typed over`);
      const past = drawn.rows.filter((row) => row.right > drawn.right + 0.5);
      assert.deepEqual(past.map((row) => row.lyrics), [], `at ${width} px no row paints past the chart`);
    }
    await atWidth(390);
    const kept = (await stored()).find((song) => song.id === id);
    assert.ok(kept && kept.copy === undefined && kept.tempo === 96 && kept.keyRoot === "A", "it is stored as the player's own song");
  });

  await check("3. Edit and Delete work on a song the player made", async () => {
    await openSong(id);
    const items = await openMore();
    assert.deepEqual(items.filter((item) => ["Edit", "Delete"].includes(item.text)), [{ text: "Edit", disabled: false }, { text: "Delete", disabled: false }], "Edit and Delete are on");
    assert.ok(!(await page.text("[role=menu]")).includes("Only songs you made"), "with no locked note");
    await tapIn(`document.querySelector("[role=menu]")`, "Edit");
    await page.until(`!!${editor}`, "the editor, opened on the song");
    assert.equal(await value("Title"), META.title, "the editor holds the title");
    const chart = await value("Chart");
    assert.ok(chart.includes("Honey, load up your questions") && chart.includes("VERSE 1"), "and the chart as text");
    await fill("Title", "Kitchen Floor (live)");
    await tapIn(editor, "Save");
    await page.until(`!document.querySelector(".song-editor")`, "the editor to close");
    assert.equal(await hashId(), id, "the song keeps its page");
    assert.equal(await page.text(".sheet .sheet-name"), "Kitchen Floor (live)", "with the new title");
    const kept = (await stored()).find((song) => song.id === id)!;
    assert.deepEqual(kept.body, need().parseSheet(TWO_SECTIONS).sections, "and its chart unchanged");
    assert.equal((await stored()).filter((song) => song.title.startsWith("Kitchen Floor")).length, 1, "an edit adds no second song");
  });

  await check("4. an own song survives reload", async () => {
    await reload("#/songs");
    await page.until(`[...document.querySelectorAll(".song-list .song-title")].some((el) => el.textContent === "Kitchen Floor (live)")`, "the song in My Songs after a reload");
    await openSong(id);
    assert.equal(await page.text(".sheet .sheet-name"), "Kitchen Floor (live)", "and its page opens");
  });

  await check("3. a BPM saved in Edit moves the metronome, also after the player transposed the song", async () => {
    const speed = `document.querySelector('input[aria-label="Metronome speed in bpm"]')`;
    /** The BPM the metronome sheet opens at. */
    const metronomeBpm = async () => {
      await site.evaluate(`document.querySelector(".controls .metronome-pill").click()`);
      await page.until(`!!${speed}`, "the metronome sheet");
      const bpm = await site.evaluate<string>(`${speed}.value`);
      await site.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await page.until(`!${speed}`, "the metronome sheet to close");
      return bpm;
    };
    const editBpm = async (bpm: string) => {
      await openMore();
      await tapIn(`document.querySelector("[role=menu]")`, "Edit");
      await page.until(`!!${editor}`, "the editor");
      await fill("BPM", bpm);
      await tapIn(editor, "Save");
      await page.until(`!document.querySelector(".song-editor")`, "the editor to close");
    };
    await openSong(id);
    await editBpm("140");
    assert.equal(await metronomeBpm(), "140", "the metronome opens at the BPM saved in Edit");
    await site.evaluate(`document.querySelector('[aria-label="Transpose up"]').click()`);
    await settle();
    await editBpm("160");
    assert.equal((await stored()).find((song) => song.id === id)?.tempo, 160, "the song is stored at 160");
    assert.equal(await metronomeBpm(), "160", "the metronome follows the new BPM over the transposed draft");
    await reload("#/songs");
    await openSong(id);
    assert.equal(await metronomeBpm(), "160", "and keeps it after a reload");
  });

  await check("5. an own song can be shared to a band and sent to a friend with the existing flows", async () => {
    mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
    assert.equal((await appCalls("/api/friends/request", { handle: mike.handle })).status, 200, "Pat asks Mike");
    assert.equal((await mike.call("/api/friends/accept", { userId: pat.userId })).status, 200, "Mike accepts");
    await reload("#/songs");
    await openSong(id);
    assert.ok(await site.evaluate<boolean>(`!!document.querySelector(".controls .send-btn")`), "the song page has Send");
    const items = await openMore();
    assert.ok(items.some((item) => item.text === "Send to a friend…" && !item.disabled), "and Send to a friend… in More");
    await tapIn(`document.querySelector("[role=menu]")`, "Send to a friend…");
    await page.until(`[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim().startsWith("Mike Keys"))`, "Mike in the friend list");
    await site.evaluate(`document.querySelector("[role=dialog] [aria-label='Mike Keys']").click()`); await settle();
    await tapIn(`document.querySelector("[role=dialog]")`, "Public");
    const send = await site.evaluate<boolean>(`(() => { const b = [...document.querySelector("[role=dialog]").querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Send to ") && !b.disabled); b?.click(); return !!b; })()`);
    assert.ok(send, "a Send button once Public is picked");
    const roomId = (await mike.call("/api/chat/dm", { userId: pat.userId })).body.roomId as string;
    let message: { kind: string; text: string } | undefined;
    for (const end = Date.now() + 15000; !message && Date.now() < end; await sleep(200)) {
      message = ((await mike!.call("/api/chat/open", { roomId })).body.messages ?? []).find((m: { kind: string }) => m.kind === "song");
    }
    assert.ok(message, "Mike's DM gets the song card");
    const card = JSON.parse(message.text) as { song: Song; sharedAs: string };
    const own = (await stored()).find((song) => song.id === id)!;
    assert.deepEqual([card.song.title, card.song.body, card.sharedAs], [own.title, own.body, "public"], "holding Pat's own chart, sent Public");

    const bandId = (await appCalls("/api/bands/create", { name: "Kitchen Band" })).body.bandId as string;
    assert.ok(bandId, "Pat starts a band");
    const { id: localId, copy, ...song } = own;
    const shared = await appCalls("/api/bands/library/share-song", { bandId, song, choice: "public", localId, copyId: copy?.id });
    assert.equal(shared.status, 200, `the band library takes the own song as Pat's original (${js(shared.body)})`);
    const library = (await appCalls("/api/bands/library", { bandId })).body as { songs: { song: Song }[] };
    assert.deepEqual(library.songs.map((item) => [item.song.title, item.song.body]), [[own.title, own.body]], "the band now has it");
  });

  await check("2b. the paste form shows the preview and the warning line", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await page.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ Add a song")`, "+ Add a song");
    await page.click("+ Add a song");
    await page.until(`!!${editor}`, "the song editor");
    await site.evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => Promise.reject(new DOMException("No", "NotAllowedError")) } })`);
    await tapIn(editor, "Paste a sheet");
    await page.until(`${editor}.textContent.includes("Paste your sheet into the box.")`, "the fallback when the clipboard can't be read");
    assert.ok(await site.evaluate<boolean>(`document.activeElement === ${field("Chart")}`), "with the chart box focused for a paste");
    const sheet = ["[Intro]", "| A | E |", "", "[A]Honey, load up your ques[Am7]ti[E]ons", "", "CHORUS", "D        A", "Fire away, fire away"].join("\n");
    await site.evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => Promise.resolve(${js(sheet)}) } })`);
    await tapIn(editor, "Paste a sheet");
    await page.until(`${field("Chart")}.value === ${js(sheet)}`, "the pasted sheet in the chart box");
    await page.until(`document.querySelectorAll(".song-editor-preview .chart-heading").length === 3`, "the preview's sections");
    assert.deepEqual(await page.texts(".song-editor-preview .chart-heading"), ["Intro", "Verse 1", "CHORUS"], "split at blank lines and labelled best-effort");
    assert.deepEqual(await page.texts(".song-editor-warnings li"), ["Line 4: Chords too close inside 'questions'"], "the warning line shows under the box");
    await fitsAt("the editor with a warning", ".song-editor");
    await fill("Title", "Pasted One");
    await tapIn(editor, "Save");
    await page.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the pasted song's page, saved despite the warning");
    assert.equal(await page.text(".sheet .sheet-name"), "Pasted One");
  });

  await check("3. Edit and Delete stay disabled with 'Only songs you made can be edited.' on catalog and friend-copy songs", async () => {
    const builtIn = seed.songs[0];
    await site.evaluate(`(() => {
      const library = JSON.parse(localStorage.getItem("leadSheetsLibrary"));
      library.songs.push({ ...library.songs[1], id: 800, title: "Gift from Sam", copy: { id: "copy_1", canSendOn: true, from: { name: "Sam" } } });
      localStorage.setItem("leadSheetsLibrary", JSON.stringify(library));
    })()`);
    await reload("#/songs");
    for (const [what, songId] of [["a built-in song", builtIn.id], ["a friend's copy", 800]] as const) {
      await openSong(songId);
      const items = await openMore();
      assert.deepEqual(items.filter((item) => ["Edit", "Delete"].includes(item.text)), [{ text: "Edit", disabled: true }, { text: "Delete", disabled: true }], `${what}: Edit and Delete are off`);
      assert.ok((await page.text("[role=menu]")).includes("Only songs you made can be edited."), `${what}: the menu says why`);
      await closeMore();
    }
  });

  await check("6. Delete asks first and removes the song from My Songs, from the player's own setlists and from its per-song settings", async () => {
    const builtIn = seed.songs[0];
    await site.evaluate(`(() => {
      const library = JSON.parse(localStorage.getItem("leadSheetsLibrary"));
      library.setlists.push({ id: 900, name: "Friday", songIds: [${id}, ${builtIn.id}] });
      localStorage.setItem("leadSheetsLibrary", JSON.stringify(library));
      localStorage.setItem("leadSheetsNotation.${id}", JSON.stringify("nashville"));
    })()`);
    await reload("#/setlists");
    await page.until(`[...document.querySelectorAll(".setlist")].some((el) => el.getAttribute("aria-label") === "Friday" && el.textContent.includes("Kitchen Floor (live)"))`, "the song in the Friday setlist");
    await openSong(id);
    await openMore();
    await tapIn(`document.querySelector("[role=menu]")`, "Delete");
    await page.until(`!!document.querySelector("[role=alertdialog]")`, "the Delete question");
    assert.ok((await page.text("[role=alertdialog]")).includes("Delete Kitchen Floor (live)?"), "it names the song");
    await fitsAt("the Delete question", "[role=alertdialog]");
    await tapIn(`document.querySelector("[role=alertdialog]")`, "Cancel");
    assert.ok(!(await site.evaluate<boolean>(`!!document.querySelector("[role=alertdialog]")`)) && (await hashId()) === id, "Cancel keeps the song");
    assert.ok((await stored()).some((song) => song.id === id), "still stored");
    await openMore();
    await tapIn(`document.querySelector("[role=menu]")`, "Delete");
    await page.until(`!!document.querySelector("[role=alertdialog]")`, "the Delete question again");
    await tapIn(`document.querySelector("[role=alertdialog]")`, "Delete");
    await page.until(`location.hash === "#/songs" && !!document.querySelector(".song-list")`, "My Songs after the delete");
    assert.ok(!(await page.texts(".song-list .song-title")).includes("Kitchen Floor (live)"), "the song is gone from My Songs");
    assert.ok(!(await stored()).some((song) => song.id === id), "and from storage");
    assert.equal(await site.evaluate<string | null>(`localStorage.getItem("leadSheetsNotation.${id}")`), null, "its per-song setting is gone");
    await site.evaluate(`location.hash = "#/setlists"`);
    await page.until(`[...document.querySelectorAll(".setlist")].some((el) => el.getAttribute("aria-label") === "Friday")`, "the Friday setlist");
    const friday = await site.evaluate<string>(`[...document.querySelectorAll(".setlist")].find((el) => el.getAttribute("aria-label") === "Friday").textContent`);
    assert.ok(!friday.includes("Kitchen Floor") && friday.includes(builtIn.title) && !friday.includes("Missing from this library"), "the setlist drops it and keeps its other song");
  });

  await check("6. a song written after the newest own song is deleted gets a new id, and its first send to a friend is not an update", async () => {
    assert.ok(mike, "Mike is Pat's friend from case 5");
    const friend = mike;
    const write = async (title: string) => {
      await site.evaluate(`location.hash = "#/songs"`);
      await page.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ Add a song")`, "+ Add a song");
      await page.click("+ Add a song");
      await page.until(`!!${editor}`, "the song editor");
      await fill("Title", title);
      await fill("Chart", TWO_SECTIONS);
      await tapIn(editor, "Save");
      await page.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, `${title}'s page`);
      const written = (await hashId())!;
      await openSong(written);
      return written;
    };
    const roomId = (await friend.call("/api/chat/dm", { userId: pat.userId })).body.roomId as string;
    const sendToMike = async (title: string, songId: number) => {
      await reload("#/songs");
      await openSong(songId);
      await openMore();
      await tapIn(`document.querySelector("[role=menu]")`, "Send to a friend…");
      await page.until(`!!document.querySelector("[role=dialog] [aria-label='Mike Keys']")`, "Mike in the friend list");
      await site.evaluate(`document.querySelector("[role=dialog] [aria-label='Mike Keys']").click()`);
      await settle();
      await tapIn(`document.querySelector("[role=dialog]")`, "Public");
      const sent = await site.evaluate<boolean>(`(() => { const b = [...document.querySelector("[role=dialog]").querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Send to ") && !b.disabled); b?.click(); return !!b; })()`);
      assert.ok(sent, `a Send button for ${title}`);
      let card: { song: Song; updateOf: string | null } | undefined;
      for (const end = Date.now() + 15000; !card && Date.now() < end; await sleep(200)) {
        const messages: { kind: string; text: string }[] = (await friend.call("/api/chat/open", { roomId })).body.messages ?? [];
        card = messages.filter((m) => m.kind === "song").map((m) => JSON.parse(m.text)).find((each) => each.song?.title === title);
      }
      assert.ok(card, `Mike's DM gets ${title}`);
      await reload("#/songs");
      await openSong(songId);
      return card;
    };

    const gone = await write("Short Lived");
    assert.equal((await sendToMike("Short Lived", gone)).updateOf, null, "the first song's first send is not an update");
    await openMore();
    await tapIn(`document.querySelector("[role=menu]")`, "Delete");
    await page.until(`!!document.querySelector("[role=alertdialog]")`, "the Delete question");
    await tapIn(`document.querySelector("[role=alertdialog]")`, "Delete");
    await page.until(`location.hash === "#/songs" && !document.querySelector("[role=alertdialog]")`, "My Songs after the delete");
    assert.ok(!(await stored()).some((song) => song.id === gone), "Short Lived is deleted");

    const next = await write("A Different Song");
    assert.equal((await sendToMike("A Different Song", next)).updateOf, null, "its first send to Mike is a new song, not an update of the deleted one");
    assert.notEqual(next, gone, `the new song gets its own id (deleted ${gone}, new ${next})`);
  });

  assert.deepEqual(await page.errors(), [], "no page errors");
}

if (app) {
  try {
    let apiBase = "";
    const site = await openSite(root, "check-new-song", () => apiBase);
    const origin = site.origin.replace("127.0.0.1", "localhost");
    const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
    apiBase = base;
    try {
      await phoneChecks(site, base, origin);
    } finally {
      await site.close();
      await worker.dispose();
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL the phone checks ran in headless Chrome: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.log(`check:new-song: ${failed} failed`);
  process.exit(1);
}
console.log("check:new-song passed");
