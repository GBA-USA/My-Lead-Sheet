import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import { Phone, startApi } from "./api-session.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const BASE = "61f18be";
const NEW_SHAPE = { "x-song-shape": "chordpro" } as const;
const js = (value: unknown) => JSON.stringify(value);
const newId = () => crypto.randomUUID().replace(/-/g, "");
const refusal = (reply: { status: number; body: Record<string, unknown> }) => [reply.status, reply.body.error];

let failures = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Codec = {
  songToChordPro(song: SongContent): string;
  chordProToSong(text: string): SongContent;
};

const codecBundle = await build({
  entryPoints: [join(root, "src/chordpro.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { songToChordPro } = (await import(
  `data:text/javascript;base64,${Buffer.from(codecBundle.outputFiles[0].text).toString("base64")}`
)) as Codec;

const oldTree = mkdtempSync(join(tmpdir(), "check-chordpro-worker-old-"));
const state = mkdtempSync(join(tmpdir(), "check-chordpro-worker-state-"));

const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const seedContent = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;

const blank: SongContent = {
  title: "Untitled",
  artist: "The Made Up Band",
  keyLabel: "A major",
  keyRoot: "A",
  keyMode: "major",
  keyNote: "",
  tempo: 96,
  tempoNote: "",
  timeSignature: "4/4",
  officialRuntimeSec: 192,
  feel: "Easy sway",
  sourceNote: "",
  atAGlance: "",
  howToPlay: "",
  practiceTip: "",
  body: [],
};

const madeSong = (title: string, lyric: string, extra: Partial<SongContent> = {}): SongContent => ({
  ...blank,
  title,
  body: [
    { heading: "INTRO", lines: [{ bars: "| A | D | A | E |" }] },
    { heading: "VERSE 1", lines: [{ chords: "A               E", lyrics: lyric }] },
  ],
  ...extra,
});

const asOld = (song: SongContent) => ({ ...song, bassNotes: [] as unknown[] });

let api: Awaited<ReturnType<typeof startApi>> | null = null;
const phones: Phone[] = [];

try {
  const tar = execFileSync("git", ["archive", "--format=tar", BASE, "src", "data"], { cwd: root, maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", oldTree], { input: tar });
  appendFileSync(join(oldTree, "src/storage.ts"), "\nexport { isSong };\n");
  const oldBundle = await build({
    stdin: {
      contents: `export { isSong } from "./src/storage.ts"; export { songMessageIn } from "./src/send-song-model.ts";`,
      resolveDir: oldTree,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    loader: { ".json": "json" },
    logLevel: "silent",
  });
  const oldBuild = (await import(`data:text/javascript;base64,${Buffer.from(oldBundle.outputFiles[0].text).toString("base64")}`)) as {
    isSong(value: unknown): boolean;
    songMessageIn(text: string): { song: SongContent; shareId: string; versions: unknown[] } | null;
  };

  api = await startApi({}, state);

  const callNew = (phone: Phone, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) =>
    phone.call(path, body, { ...NEW_SHAPE, ...headers });

  const player = async (name: string) => {
    const phone = new Phone(api!.base);
    phones.push(phone);
    const created = await phone.createAccount(name);
    assert.equal(created.status, 200, `${name} creates an account (${js(created.body)})`);
    return Object.assign(phone, { name, userId: created.body.account.userId as string });
  };

  const makeBand = async (admin: Phone, name: string, members: Phone[] = []) => {
    const made = await admin.call("/api/bands/create", { name });
    assert.equal(made.status, 200, `create band ${name} (${js(made.body)})`);
    const bandId = made.body.bandId as string;
    if (members.length > 0) {
      const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
      for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `join ${name}`);
    }
    return bandId;
  };

  const makeFriends = async (a: Phone, b: Phone) => {
    const code = (await a.call("/api/codes", { kind: "friend-link" })).body.code as string;
    assert.equal((await b.call("/api/friends/add-by-code", { code })).status, 200, "friends connect");
  };

  async function withSqlite<T>(work: (files: string[]) => T): Promise<T> {
    await api!.worker.dispose();
    api = null;
    try {
      const files = (readdirSync(state, { recursive: true }) as string[])
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => join(state, name));
      return work(files);
    } finally {
      api = await startApi({}, state);
      for (const phone of phones) Object.assign(phone, { base: api.base });
    }
  }

  function hasTable(db: DatabaseSync, table: string): boolean {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  }

  function readBandSongRow(files: string[], songId: string): { song: string; print: string } | null {
    for (const file of files) {
      const db = new DatabaseSync(file);
      try {
        if (!hasTable(db, "band_songs")) continue;
        const row = db.prepare(`SELECT song, print FROM band_songs WHERE song_id = ?`).get(songId) as { song: string; print: string } | undefined;
        if (row) return row;
      } finally {
        db.close();
      }
    }
    return null;
  }

  function updateBandSongRow(files: string[], songId: string, songText: string): number {
    let changed = 0;
    for (const file of files) {
      const db = new DatabaseSync(file);
      try {
        if (!hasTable(db, "band_songs")) continue;
        changed += Number(db.prepare(`UPDATE band_songs SET song = ? WHERE song_id = ?`).run(songText, songId).changes);
      } finally {
        db.close();
      }
    }
    return changed;
  }

  const alice = await player("Alice Keys");
  const bob = await player("Bob Guitar");
  await makeFriends(alice, bob);

  const paperBoats = madeSong("Paper Boats", "Paper boats are sailing to the sea");
  const paperBoatsText = songToChordPro(paperBoats);

  // W1: New phone shares a song -> band_songs.song holds the writer's text
  await check("W1: new phone shares a song and band_songs.song stores the writer's ChordPro text", async () => {
    const bandId = await makeBand(alice, "W1 Band");
    const shared = await callNew(alice, "/api/bands/library/share-song", {
      bandId,
      song: { chordpro: paperBoatsText },
      choice: "public",
      localId: null,
    });
    assert.equal(shared.status, 200, `new phone share failed (${js(shared.body)})`);
    const row = await withSqlite((files) => readBandSongRow(files, shared.body.songId as string));
    assert.ok(row, "band_songs row exists");
    assert.equal(row.song, paperBoatsText, "stored column holds the writer's exact ChordPro text");
  });

  // W2: Old phone shares the same chart to a second band -> holds the same text, byte for byte
  await check("W2: old phone shares the same chart to a second band and stores the exact same ChordPro text", async () => {
    const bandId = await makeBand(bob, "W2 Band");
    const shared = await bob.call("/api/bands/library/share-song", {
      bandId,
      song: asOld(paperBoats),
      choice: "public",
      localId: null,
    });
    assert.equal(shared.status, 200, `old phone share failed (${js(shared.body)})`);
    const row = await withSqlite((files) => readBandSongRow(files, shared.body.songId as string));
    assert.ok(row, "band_songs row exists");
    assert.equal(row.song, paperBoatsText, "old-phone share stores the exact same ChordPro bytes as W1");
  });

  // W3: Old JSON row stays old JSON across reads by both phones, then becomes text after an edit
  await check("W3: row set back to old JSON is read by both phones without rewriting, and becomes text on edit", async () => {
    const bandId = await makeBand(alice, "W3 Band", [bob]);
    const harborBells = madeSong("Harbor Bells", "Harbor bells ring across the bay");
    const harborBellsV2 = madeSong("Harbor Bells", "Harbor bells ring louder tonight");
    const shared = await alice.call("/api/bands/library/share-song", {
      bandId,
      song: asOld(harborBells),
      choice: "public",
      localId: null,
    });
    assert.equal(shared.status, 200, `setup share failed (${js(shared.body)})`);
    const songId = shared.body.songId as string;
    const oldJson = JSON.stringify(asOld(harborBells));
    const reset = await withSqlite((files) => updateBandSongRow(files, songId, oldJson));
    assert.equal(reset, 1, "row reset to old JSON");

    const oldLib = await bob.call("/api/bands/library", { bandId });
    assert.equal(oldLib.status, 200, "old phone reads library");
    const oldSeen = (oldLib.body.songs as { songId: string; song: Record<string, unknown> }[]).find((s) => s.songId === songId);
    assert.equal(oldSeen?.song.title, harborBells.title, "old phone reads old JSON row");

    const newLib = await callNew(bob, "/api/bands/library", { bandId });
    assert.equal(newLib.status, 200, "new phone reads library");
    const newSeen = (newLib.body.songs as { songId: string; song: Record<string, unknown> }[]).find((s) => s.songId === songId);
    assert.deepEqual(newSeen?.song, { chordpro: songToChordPro(harborBells) }, "new phone gets { chordpro } from old JSON row");

    const afterReads = await withSqlite((files) => readBandSongRow(files, songId));
    assert.equal(afterReads?.song, oldJson, "reads never rewrite the stored old JSON row");

    const edited = await alice.call("/api/bands/library/edit-song", {
      bandId,
      songId,
      base: 1,
      song: asOld(harborBellsV2),
    });
    assert.equal(edited.status, 200, `edit failed (${js(edited.body)})`);
    const afterEdit = await withSqlite((files) => readBandSongRow(files, songId));
    assert.equal(afterEdit?.song, songToChordPro(harborBellsV2), "after edit the row is stored as ChordPro text");
  });

  // W4: Note posted and listed on both a ChordPro row and an old JSON row
  await check("W4: notes post and list on a song stored as text and on a song stored as old JSON", async () => {
    const bandId = await makeBand(alice, "W4 Band", [bob]);
    const textSong = madeSong("Lantern Glow", "Carry the lantern into the dusk");
    const jsonSong = madeSong("Cedar Ridge", "Over the ridge before dawn");
    const sText = await alice.call("/api/bands/library/share-song", { bandId, song: asOld(textSong), choice: "public", localId: null });
    const sJson = await alice.call("/api/bands/library/share-song", { bandId, song: asOld(jsonSong), choice: "public", localId: null });
    assert.equal(sText.status, 200);
    assert.equal(sJson.status, 200);
    const idText = sText.body.songId as string;
    const idJson = sJson.body.songId as string;

    await withSqlite((files) => {
      assert.equal(updateBandSongRow(files, idText, songToChordPro(textSong)), 1, "set text song to ChordPro");
      assert.equal(updateBandSongRow(files, idJson, JSON.stringify(asOld(jsonSong))), 1, "set json song to old JSON");
    });

    const addText = await alice.call("/api/bands/notes/add", { bandId, songId: idText, body: "Hold the intro two bars" });
    assert.equal(addText.status, 200, `add note on text song (${js(addText.body)})`);
    const listText = await bob.call("/api/bands/notes/list", { bandId, songId: idText });
    assert.equal(listText.status, 200);
    assert.equal(listText.body.notes[0]?.body, "Hold the intro two bars");

    const addJson = await alice.call("/api/bands/notes/add", { bandId, songId: idJson, body: "Quiet on verse two" });
    assert.equal(addJson.status, 200, `add note on json song (${js(addJson.body)})`);
    const listJson = await bob.call("/api/bands/notes/list", { bandId, songId: idJson });
    assert.equal(listJson.status, 200);
    assert.equal(listJson.body.notes[0]?.body, "Quiet on verse two");

    const chat = await bob.call("/api/chat/open", { roomId: bandId });
    const texts = (chat.body.messages as ChatMessage[]).map((m) => m.text);
    assert.ok(texts.some((t) => t.includes(`added a note to ${textSong.title}`)), "chat line names text song title");
    assert.ok(texts.some((t) => t.includes(`added a note to ${jsonSong.title}`)), "chat line names json song title");
  });

  // W5: Band library, band pack and gig pack give new phone { chordpro } and old phone old object passing 61f18be isSong
  await check("W5: band library, band pack and gig pack answer in caller's shape and old object passes 61f18be isSong", async () => {
    const bandId = await makeBand(alice, "W5 Band", [bob]);
    const copperSky = madeSong("Copper Sky", "Under the copper sky we ride");
    const copperText = songToChordPro(copperSky);
    const sharedOld = await alice.call("/api/bands/library/share-song", { bandId, song: asOld(copperSky), choice: "public", localId: null });
    assert.equal(sharedOld.status, 200);
    const songId = sharedOld.body.songId as string;

    const setlist = await alice.call("/api/bands/library/share-setlist", {
      bandId,
      name: "W5 Set",
      songIds: [songId],
      tags: [],
      choice: "public",
      localId: null,
    });
    assert.equal(setlist.status, 200);
    const gig = await alice.call("/api/bands/gig/plan", {
      bandId,
      setlistId: setlist.body.setlistId,
      name: "W5 Gig",
      date: "2026-12-10",
    });
    assert.equal(gig.status, 200);
    const gigId = gig.body.gig.gigId as string;

    // Band library
    const libNew = await callNew(bob, "/api/bands/library", { bandId });
    assert.equal(libNew.status, 200);
    assert.deepEqual(libNew.body.songs[0].song, { chordpro: copperText }, "library gives new phone { chordpro }");
    const libOld = await bob.call("/api/bands/library", { bandId });
    assert.equal(libOld.status, 200);
    assert.equal(libOld.body.songs[0].song.chordpro, undefined, "library gives old phone no chordpro key");
    assert.equal(libOld.body.songs[0].song.title, copperSky.title);
    assert.deepEqual(libOld.body.songs[0].song.bassNotes, []);
    assert.equal(oldBuild.isSong({ ...libOld.body.songs[0].song, id: 1 }), true, "library old-shape song passes 61f18be isSong");

    // Band pack (carries band metadata only; both shapes succeed)
    const bandPackNew = await callNew(bob, "/api/bands/pack", { bandId });
    const bandPackOld = await bob.call("/api/bands/pack", { bandId });
    assert.deepEqual([bandPackNew.status, bandPackOld.status], [200, 200], "band pack answers both callers");
    assert.equal(bandPackNew.body.bandId, bandId);
    assert.equal(bandPackOld.body.bandId, bandId);

    // Gig pack
    const gigPackNew = await callNew(bob, "/api/bands/gig/pack", { bandId, gigId });
    assert.equal(gigPackNew.status, 200);
    assert.deepEqual(gigPackNew.body.songs[0].song, { chordpro: copperText }, "gig pack gives new phone { chordpro }");
    const gigPackOld = await bob.call("/api/bands/gig/pack", { bandId, gigId });
    assert.equal(gigPackOld.status, 200);
    assert.equal(gigPackOld.body.songs[0].song.chordpro, undefined, "gig pack gives old phone no chordpro key");
    assert.equal(gigPackOld.body.songs[0].song.title, copperSky.title);
    assert.deepEqual(gigPackOld.body.songs[0].song.bassNotes, []);
    assert.equal(oldBuild.isSong({ ...gigPackOld.body.songs[0].song, id: 1 }), true, "gig pack old-shape song passes 61f18be isSong");
  });

  // W6: edit-song with a stale base answers 409 with current in caller's shape
  await check("W6: stale edit-song answers 409 with current in the caller's shape", async () => {
    const bandId = await makeBand(alice, "W6 Band");
    const v1 = madeSong("Silver Pine", "Wind through the silver pine");
    const v2 = madeSong("Silver Pine", "Rain through the silver pine");
    const v3 = madeSong("Silver Pine", "Snow through the silver pine");
    const shared = await alice.call("/api/bands/library/share-song", { bandId, song: asOld(v1), choice: "public", localId: null });
    assert.equal(shared.status, 200);
    const songId = shared.body.songId as string;
    const saved = await alice.call("/api/bands/library/edit-song", { bandId, songId, base: 1, song: asOld(v2) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.rev, 2);

    const staleNew = await callNew(alice, "/api/bands/library/edit-song", { bandId, songId, base: 1, song: { chordpro: songToChordPro(v3) } });
    assert.deepEqual(refusal(staleNew), [409, "changed"], `new phone stale edit gets 409 changed (${js(staleNew.body)})`);
    assert.equal(staleNew.body.current.rev, 2);
    assert.deepEqual(staleNew.body.current.song, { chordpro: songToChordPro(v2) }, "new phone 409 current holds { chordpro }");

    const staleOld = await alice.call("/api/bands/library/edit-song", { bandId, songId, base: 1, song: asOld(v3) });
    assert.deepEqual(refusal(staleOld), [409, "changed"], `old phone stale edit gets 409 changed (${js(staleOld.body)})`);
    assert.equal(staleOld.body.current.rev, 2);
    assert.equal(staleOld.body.current.song.chordpro, undefined);
    assert.deepEqual(staleOld.body.current.song.bassNotes, []);
    assert.equal(oldBuild.isSong({ ...staleOld.body.current.song, id: 1 }), true, "old phone 409 current passes 61f18be isSong");
  });

  // W7: DM song card stored in sender's shape; old card passes 61f18be songMessageIn
  await check("W7: DM song card is stored in sender's shape and old-phone card is read by 61f18be songMessageIn", async () => {
    const cedarWind = madeSong("Cedar Wind", "Cedar wind across the valley");
    const cedarText = songToChordPro(cedarWind);
    const shareNew = newId();
    const sentNew = await callNew(alice, "/api/chat/send-song", {
      userId: bob.userId,
      msgId: newId(),
      shareId: shareNew,
      song: { chordpro: cedarText },
      versions: [],
      data: null,
      choice: "public",
    });
    assert.equal(sentNew.status, 200, `new phone send-song failed (${js(sentNew.body)})`);
    const newCard = JSON.parse(sentNew.body.message.text as string);
    assert.deepEqual(newCard.song, { chordpro: cedarText }, "new phone card holds { chordpro }");

    const shareOld = newId();
    const sentOld = await bob.call("/api/chat/send-song", {
      userId: alice.userId,
      msgId: newId(),
      shareId: shareOld,
      song: asOld(cedarWind),
      versions: [],
      data: null,
      choice: "public",
    });
    assert.equal(sentOld.status, 200, `old phone send-song failed (${js(sentOld.body)})`);
    const oldText = sentOld.body.message.text as string;
    const oldCard = JSON.parse(oldText);
    assert.equal(oldCard.song.chordpro, undefined, "old phone card has no chordpro field");
    assert.deepEqual(oldCard.song.bassNotes, [], "old phone card keeps empty bassNotes");
    const readByOld = oldBuild.songMessageIn(oldText);
    assert.ok(readByOld, "61f18be songMessageIn reads the old-phone card");
    assert.equal(readByOld.song.title, cedarWind.title);
    assert.equal(oldBuild.isSong({ ...readByOld.song, id: 1 }), true, "old-phone card song passes 61f18be isSong");

    const storedBodies = await withSqlite((files) => {
      const found: Record<string, string> = {};
      for (const file of files) {
        const db = new DatabaseSync(file);
        try {
          if (!hasTable(db, "messages")) continue;
          for (const ref of [shareNew, shareOld]) {
            const row = db.prepare(`SELECT body FROM messages WHERE kind = 'song' AND ref = ?`).get(ref) as { body: string } | undefined;
            if (row) found[ref] = row.body;
          }
        } finally {
          db.close();
        }
      }
      return found;
    });
    assert.deepEqual(JSON.parse(storedBodies[shareNew]).song, { chordpro: cedarText }, "SQLite message body for new phone holds { chordpro }");
    assert.equal(JSON.parse(storedBodies[shareOld]).song.title, cedarWind.title, "SQLite message body for old phone holds old object");
  });

  // W8: Copy code stores { chordpro, print, shareId }; old row still reads; scanner reply shaped; card titles right
  await check("W8: copy code stores { chordpro, print, shareId }, reads old-shape rows, and answers scanner in caller's shape", async () => {
    const meadow = madeSong("Meadow Lark", "Meadow lark sings at sunrise");
    const brook = madeSong("Cold Brook", "Cold brook runs down the hill");
    const meadowText = songToChordPro(meadow);
    const brookText = songToChordPro(brook);

    const codeNew = await callNew(alice, "/api/codes", {
      kind: "my-setlist",
      choice: "public",
      name: "W8 New Set",
      songs: [{ song: { chordpro: meadowText }, copyId: null }],
      setlistCopyId: null,
    });
    assert.equal(codeNew.status, 200, `new phone mint failed (${js(codeNew.body)})`);

    const codeOld = await alice.call("/api/codes", {
      kind: "my-setlist",
      choice: "public",
      name: "W8 Old Set",
      songs: [{ song: asOld(brook), copyId: null }],
      setlistCopyId: null,
    });
    assert.equal(codeOld.status, 200, `old phone mint failed (${js(codeOld.body)})`);

    // Inspect both rows in SQLite and rewrite the second back to the old shape
    const rows = await withSqlite((files) => {
      const got: Record<string, { share_id: string; songs: string }> = {};
      for (const file of files) {
        const db = new DatabaseSync(file);
        try {
          if (!hasTable(db, "setlist_sends")) continue;
          for (const name of ["W8 New Set", "W8 Old Set"]) {
            const row = db.prepare(`SELECT share_id, songs FROM setlist_sends WHERE name = ?`).get(name) as { share_id: string; songs: string } | undefined;
            if (row) got[name] = row;
          }
          if (got["W8 Old Set"]) {
            const parsed = JSON.parse(got["W8 Old Set"].songs) as { chordpro?: string; print: string; shareId: string }[];
            const oldShape = parsed.map((item) => ({ song: asOld(brook), print: item.print, shareId: item.shareId }));
            db.prepare(`UPDATE setlist_sends SET songs = ? WHERE share_id = ?`).run(JSON.stringify(oldShape), got["W8 Old Set"].share_id);
          }
        } finally {
          db.close();
        }
      }
      return got;
    });
    const storedNew = JSON.parse(rows["W8 New Set"].songs) as Record<string, unknown>[];
    const storedOld = JSON.parse(rows["W8 Old Set"].songs) as Record<string, unknown>[];
    assert.equal(storedNew[0].chordpro, meadowText, "new-phone copy code stores chordpro text");
    assert.equal(storedNew[0].song, undefined, "new-phone copy code has no old song object");
    assert.equal(typeof storedNew[0].print, "string");
    assert.equal(typeof storedNew[0].shareId, "string");
    assert.equal(storedOld[0].chordpro, brookText, "old-phone copy code also stores chordpro text");
    assert.equal(storedOld[0].song, undefined, "old-phone copy code has no old song object");

    // Scan both codes and verify card titles + scanner replies in both shapes
    for (const [code, setName, song, songText] of [
      [codeNew.body.code as string, "W8 New Set", meadow, meadowText],
      [codeOld.body.code as string, "W8 Old Set", brook, brookText],
    ] as const) {
      const scanned = await bob.call("/api/chat/setlist-code", { code });
      assert.equal(scanned.status, 200, `scan ${setName} failed (${js(scanned.body)})`);
      const messages = (await bob.call("/api/chat/open", { roomId: scanned.body.roomId })).body.messages as ChatMessage[];
      const cardMsg = messages.find((m) => m.kind === "setlist" && JSON.parse(m.text).name === setName);
      assert.ok(cardMsg, `setlist card for ${setName}`);
      const card = JSON.parse(cardMsg.text) as { titles: string[]; copyId: string };
      assert.deepEqual(card.titles, [song.title], `card titles right for ${setName}`);

      const copyNew = await callNew(bob, "/api/chat/setlist-copy", { copyId: card.copyId });
      assert.equal(copyNew.status, 200);
      assert.deepEqual(copyNew.body.songs[0].song, { chordpro: songText }, `new scanner gets { chordpro } for ${setName}`);

      const copyOld = await bob.call("/api/chat/setlist-copy", { copyId: card.copyId });
      assert.equal(copyOld.status, 200);
      assert.equal(copyOld.body.songs[0].song.chordpro, undefined);
      assert.equal(copyOld.body.songs[0].song.title, song.title);
      assert.deepEqual(copyOld.body.songs[0].song.bassNotes, []);
      assert.equal(oldBuild.isSong({ ...copyOld.body.songs[0].song, id: 1 }), true, `old scanner song passes 61f18be isSong for ${setName}`);
    }
  });

  // W9 (guard): Old phone backs up and pulls as today while no new phone has synced that account
  await check("W9 (guard): old phone backs up and pulls as today while no new phone has synced that account", async () => {
    const carol = await player("Carol Bass");
    const push = await carol.call("/api/backup", {
      since: 0,
      changes: [{ key: "leadSheetsScrollPercent.1", kind: "scroll", value: "110", base: 0 }],
    });
    assert.equal(push.status, 200, `old phone push failed (${js(push.body)})`);
    assert.equal(push.body.rev, 1);
    const pull = await carol.call("/api/backup", { since: 0, changes: [] });
    assert.equal(pull.status, 200, `old phone pull failed (${js(pull.body)})`);
    assert.equal(pull.body.rows.find((r: { key: string }) => r.key === "leadSheetsScrollPercent.1")?.value, "110");
  });

  // W10: After new phone's first backup request, old phone gets 409 update-app, no row changes, new phone still syncs, second account unmarked
  await check("W10: backup room marks on first ChordPro sync, refuses old phone 409 update-app with no row change, leaves other accounts unmarked", async () => {
    const dave = await player("Dave Drums");
    const eve = await player("Eve Violin");

    const before = await dave.call("/api/backup", {
      since: 0,
      changes: [{ key: "leadSheetsScrollPercent.1", kind: "scroll", value: "100", base: 0 }],
    });
    assert.equal(before.status, 200);

    const firstNew = await callNew(dave, "/api/backup", { since: 0, changes: [] });
    assert.equal(firstNew.status, 200, `new phone first sync failed (${js(firstNew.body)})`);

    const refusedOld = await dave.call("/api/backup", {
      since: 0,
      changes: [{ key: "leadSheetsScrollPercent.1", kind: "scroll", value: "200", base: 1 }],
    });
    assert.equal(refusedOld.status, 409, `old phone should get 409 (${js(refusedOld.body)})`);
    assert.deepEqual(refusedOld.body, { error: "update-app" }, "refusal carries only update-app and no rows or account info");

    const refusedWrong = await dave.call("/api/backup", { since: 0, changes: [] }, { "x-song-shape": "legacy" });
    assert.deepEqual([refusedWrong.status, refusedWrong.body], [409, { error: "update-app" }], "any other header value is also refused");

    const stillNew = await callNew(dave, "/api/backup", {
      since: 0,
      changes: [{ key: "leadSheetsScrollPercent.2", kind: "scroll", value: "95", base: 0 }],
    });
    assert.equal(stillNew.status, 200, `new phone continues syncing (${js(stillNew.body)})`);
    const rows = stillNew.body.rows as { key: string; value: string }[];
    assert.equal(rows.find((r) => r.key === "leadSheetsScrollPercent.1")?.value, "100", "refused old request changed no row");
    assert.equal(rows.find((r) => r.key === "leadSheetsScrollPercent.2")?.value, "95", "new phone write landed");

    const eveOld = await eve.call("/api/backup", {
      since: 0,
      changes: [{ key: "leadSheetsScrollPercent.1", kind: "scroll", value: "85", base: 0 }],
    });
    assert.equal(eveOld.status, 200, "second account on the same Worker is not marked");
  });

  // W11: Exported band file holds { chordpro }; importing it and importing an old-shape file give the same prints
  await check("W11: band export holds { chordpro } and importing either shape gives the same prints", async () => {
    const srcBand = await makeBand(alice, "W11 Source");
    const dstNew = await makeBand(bob, "W11 Target New");
    const dstOld = await makeBand(bob, "W11 Target Old");
    const oakRidge = madeSong("Oak Ridge", "Down by the oak ridge road");
    const oakText = songToChordPro(oakRidge);

    const shared = await alice.call("/api/bands/library/share-song", { bandId: srcBand, song: asOld(oakRidge), choice: "public", localId: null });
    assert.equal(shared.status, 200);
    const srcSongId = shared.body.songId as string;

    const exported = await alice.call(`/api/bands/export?bandId=${encodeURIComponent(srcBand)}`);
    assert.equal(exported.status, 200, `export failed (${js(exported.body)})`);
    assert.equal(exported.body.songs.length, 1);
    assert.deepEqual(exported.body.songs[0].song, { chordpro: oakText }, "exported band file holds { chordpro }");

    const impNew = await bob.call(`/api/rooms/${dstNew}`, exported.body);
    assert.equal(impNew.status, 200, `import chordpro file failed (${js(impNew.body)})`);
    assert.equal(impNew.body.songs.added, 1);

    const oldFile = {
      exportedFrom: "https://other.test/band_old_w11",
      exportedAt: new Date().toISOString(),
      band: { name: "W11 Old Source" },
      songs: [{ id: "song_old_w11", share: { choice: "public", parentId: null }, song: asOld(oakRidge), versions: [] }],
      setlists: [],
    };
    const impOld = await bob.call(`/api/rooms/${dstOld}`, oldFile);
    assert.equal(impOld.status, 200, `import old-shape file failed (${js(impOld.body)})`);
    assert.equal(impOld.body.songs.added, 1);

    const idNew = (await bob.call("/api/bands/library", { bandId: dstNew })).body.songs[0].songId as string;
    const idOld = (await bob.call("/api/bands/library", { bandId: dstOld })).body.songs[0].songId as string;
    const [rowSrc, rowNew, rowOld] = await withSqlite((files) => [
      readBandSongRow(files, srcSongId),
      readBandSongRow(files, idNew),
      readBandSongRow(files, idOld),
    ]);
    assert.ok(rowSrc && rowNew && rowOld, "all three rows exist");
    assert.equal(rowNew.print, rowOld.print, "ChordPro import and old-shape import record the same print");
    assert.equal(rowNew.print, rowSrc.print, "and both match the source band's print");
    assert.equal(rowNew.song, oakText);
    assert.equal(rowOld.song, oakText);
  });

  // W12: Share rule decides the same in both shapes; prints recorded are equal across shapes
  await check("W12: share rule decides the same in both shapes and records equal prints across shapes", async () => {
    const bandA = await makeBand(bob, "W12 Band A");
    const bandB = await makeBand(bob, "W12 Band B");
    const lockedTune = madeSong("Locked Gate", "Behind the locked gate in the rain");
    const lockedText = songToChordPro(lockedTune);

    const sentPrivate = await alice.call("/api/chat/send-song", {
      userId: bob.userId,
      msgId: newId(),
      shareId: newId(),
      song: asOld(lockedTune),
      versions: [],
      data: null,
      choice: "private",
    });
    assert.equal(sentPrivate.status, 200);

    assert.deepEqual(
      refusal(await callNew(bob, "/api/bands/library/share-song", { bandId: bandA, song: { chordpro: lockedText }, choice: "public", localId: null })),
      [403, "private_copy"],
      "Private copy refused when re-shared as ChordPro text",
    );
    assert.deepEqual(
      refusal(await bob.call("/api/bands/library/share-song", { bandId: bandA, song: asOld(lockedTune), choice: "public", localId: null })),
      [403, "private_copy"],
      "Private copy refused when re-shared as old object",
    );

    const builtIn = seedContent(seed.songs[1]);
    const builtInText = songToChordPro(builtIn);
    const sentBuiltIn = await alice.call("/api/chat/send-song", {
      userId: bob.userId,
      msgId: newId(),
      shareId: newId(),
      song: asOld(builtIn),
      versions: [],
      data: null,
      choice: "private",
    });
    assert.equal(sentBuiltIn.status, 200);
    assert.equal(
      (await callNew(bob, "/api/bands/library/share-song", { bandId: bandA, song: { chordpro: builtInText }, choice: "public", localId: null })).status,
      200,
      "built-in chart stays common when shared as ChordPro text",
    );
    assert.equal(
      (await bob.call("/api/bands/library/share-song", { bandId: bandB, song: asOld(builtIn), choice: "public", localId: null })).status,
      200,
      "built-in chart stays common when shared as old object",
    );

    const openSky = madeSong("Open Sky", "Wide open sky above the highway");
    const ownText = await callNew(bob, "/api/bands/library/share-song", {
      bandId: bandA,
      song: { chordpro: songToChordPro(openSky) },
      choice: "public",
      localId: null,
    });
    const ownObj = await bob.call("/api/bands/library/share-song", {
      bandId: bandB,
      song: asOld(openSky),
      choice: "public",
      localId: null,
    });
    assert.equal(ownText.status, 200, "own song passes as text");
    assert.equal(ownObj.status, 200, "own song passes as old object");

    const [rowText, rowObj] = await withSqlite((files) => [
      readBandSongRow(files, ownText.body.songId as string),
      readBandSongRow(files, ownObj.body.songId as string),
    ]);
    assert.ok(rowText && rowObj);
    assert.equal(rowText.print, rowObj.print, "Worker records equal prints across the two shapes");
  });

  // W13: MAX_SONG_CHARS boundary (12,000 passes, 12,001 refused), old object under JSON limit passes even if text > 12,000, invalid { chordpro } refused
  await check("W13: 12,000-char text passes, 12,001 refused, old object under JSON limit passes, and bad { chordpro } values are refused", async () => {
    const bandId = await makeBand(alice, "W13 Band");
    const baseExact: SongContent = { ...blank, title: "Limit Exact", body: [{ heading: "VERSE 1", lines: [{ lyrics: "" }] }] };
    const pad = 12_000 - songToChordPro(baseExact).length;
    assert.ok(pad > 0, "pad positive");
    const exactText = songToChordPro({ ...baseExact, body: [{ heading: "VERSE 1", lines: [{ lyrics: "a".repeat(pad) }] }] });
    const overText = songToChordPro({ ...baseExact, body: [{ heading: "VERSE 1", lines: [{ lyrics: "a".repeat(pad + 1) }] }] });
    assert.equal(exactText.length, 12_000, "exactText is 12,000 chars");
    assert.equal(overText.length, 12_001, "overText is 12,001 chars");

    const passExact = await callNew(alice, "/api/bands/library/share-song", { bandId, song: { chordpro: exactText }, choice: "public", localId: null });
    assert.equal(passExact.status, 200, `12,000-char text passes (${js(passExact.body)})`);

    const failOver = await callNew(alice, "/api/bands/library/share-song", { bandId, song: { chordpro: overText }, choice: "public", localId: null });
    assert.deepEqual(refusal(failOver), [400, "bad-request"], `12,001-char text refused (${js(failOver.body)})`);

    // Old object whose JSON <= 12,000 and ChordPro text > 12,000 (chords-only rows expand in brackets)
    const chordRow = "A G D E A G D E A G D E A G D E";
    const wideOld: SongContent = {
      ...blank,
      title: "Wide Chords",
      body: [{ heading: "VERSE 1", lines: Array.from({ length: 200 }, () => ({ chords: chordRow })) }],
    };
    const wideOldPayload = asOld(wideOld);
    assert.ok(JSON.stringify(wideOldPayload).length <= 12_000, `old JSON (${JSON.stringify(wideOldPayload).length}) is under 12,000`);
    assert.ok(songToChordPro(wideOld).length > 12_000, `ChordPro text (${songToChordPro(wideOld).length}) is over 12,000`);
    const passWide = await alice.call("/api/bands/library/share-song", { bandId, song: wideOldPayload, choice: "public", localId: null });
    assert.equal(passWide.status, 200, `old object under JSON limit passes (${js(passWide.body)})`);

    for (const [label, bad] of [
      ["no title", { chordpro: `{key: C}\n{start_of_verse: label="V"}\nla la\n{end_of_verse}` }],
      ["blank title", { chordpro: `{title:    }\n{key: C}` }],
      ["title over 200 chars", { chordpro: `{title: ${"T".repeat(201)}}\n{key: C}` }],
      ["number chordpro", { chordpro: 123 }],
      ["null chordpro", { chordpro: null }],
    ] as const) {
      const res = await callNew(alice, "/api/bands/library/share-song", { bandId, song: bad, choice: "public", localId: null });
      assert.deepEqual(refusal(res), [400, "bad-request"], `${label} is refused bad-request (${js(res.body)})`);
    }
  });

  // W15 (Added by CoS): CRLF, lone CR, and leading BOM are normalized to plain \n before reading/storing
  await check("W15: CRLF line ends, lone CR, and leading BOM in { chordpro } are stored and returned byte for byte as plain LF", async () => {
    const bandId = await makeBand(alice, "W15 Band");
    const riverBend = madeSong("River Bend", "Around the river bend we go");
    const plain = songToChordPro(riverBend);
    const variants: [string, string][] = [
      ["CRLF", plain.replaceAll("\n", "\r\n")],
      ["BOM", `\uFEFF${plain}`],
      ["lone CR", plain.replaceAll("\n", "\r")],
      ["BOM + CRLF", `\uFEFF${plain.replaceAll("\n", "\r\n")}`],
    ];
    for (const [label, input] of variants) {
      const res = await callNew(alice, "/api/bands/library/share-song", { bandId, song: { chordpro: input }, choice: "public", localId: null });
      assert.equal(res.status, 200, `${label} share failed (${js(res.body)})`);
      assert.deepEqual(res.body.song, { chordpro: plain }, `${label} returned byte-for-byte as plain LF`);
      const row = await withSqlite((files) => readBandSongRow(files, res.body.songId as string));
      assert.equal(row?.song, plain, `${label} stored byte-for-byte as plain LF`);
    }
    const noTitleBomCrlf = await callNew(alice, "/api/bands/library/share-song", {
      bandId,
      song: { chordpro: "\uFEFF{key: C}\r\n{start_of_verse: label=\"V\"}\r\nla la\r\n{end_of_verse}" },
      choice: "public",
      localId: null,
    });
    assert.deepEqual(refusal(noTitleBomCrlf), [400, "bad-request"], "BOM+CRLF with no title still takes the bad-song path");
  });
} finally {
  if (api) await api.worker.dispose();
  rmSync(oldTree, { recursive: true, force: true, maxRetries: 10 });
  rmSync(state, { recursive: true, force: true, maxRetries: 10 });
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
