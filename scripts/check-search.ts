import { readFileSync } from "node:fs";
import { matchingSetlists, matchingSongs } from "../src/search.ts";
import type { LibraryFile, Setlist, Song, SongRef } from "../src/types.ts";

const seed = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as LibraryFile;
const local = (id: number): SongRef => `local/${id}`;
const mine: Song[] = seed.songs.map((song) => ({ ...song, ref: local(song.id) }));
const extra: Song = { ...mine[0], ref: local(900), id: 900, title: "Café Del Mar", artist: "Beyoncé" };
const bandCopy: Song = { ...mine.find((song) => song.id === 10)!, ref: "01JBANDROOM0000000000000000/01JBANDSONG0000000000000000", title: "Zebra Crossing", artist: "The Band" };
const songs = [...mine, extra, bandCopy];
const setlists: Setlist[] = [
  ...seed.setlists.map(({ songIds, ...setlist }) => ({ ...setlist, songRefs: songIds.map(local) })),
  { id: 77, name: "Empty night", songRefs: [] },
];

let failures = 0;
function expect<T>(actual: T[], expected: T[], message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.error(`FAIL ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const titles = (query: string) => matchingSongs(songs, query).map((song) => song.title);
const names = (query: string) => matchingSetlists(setlists, songs, query).map((setlist) => setlist.name);

expect(titles(""), songs.map((song) => song.title), "an empty box shows every song in library order");
expect(titles("   "), songs.map((song) => song.title), "a box of spaces shows every song");
expect(titles("NEON moon"), ["Neon Moon"], "matching ignores case");
expect(titles("no half steppin"), ["No Half Steppin'"], "a missing trailing apostrophe still matches");
expect(titles("say it aint so"), ["Say It Ain't So"], "a missing inner apostrophe still matches");
expect(titles("say it ain’t so"), ["Say It Ain't So"], "a curly apostrophe matches a straight one");
expect(titles("cafe"), ["Café Del Mar"], "an unaccented query finds an accented title");
expect(titles("beyonce"), ["Café Del Mar"], "an unaccented query finds an accented artist");
expect(titles("zach williams"), ["To The Table", "Chain Breaker"], "artist matches find every song by that artist");
expect(titles("brooks dunn"), ["Neon Moon"], "punctuation between words is ignored");
expect(titles("chain"), ["Chain Breaker"], "a partial title matches as you type");
expect(titles("xyzzy"), [], "a query that matches nothing returns no songs");

expect(names(""), setlists.map((setlist) => setlist.name), "an empty box shows every setlist, empty ones too");
expect(names("biker"), ["Biker church"], "a setlist matches by its name");
expect(names("WORSHIP"), ["Worship Set"], "setlist name matching ignores case");
expect(names("chain breaker"), ["Worship Set", "Biker church"], "a setlist matches when it holds a matching song");
expect(names("casting crowns"), ["Worship Set", "Biker church"], "a setlist matches when it holds a song by a matching artist");
expect(names("say it aint so"), [], "a song in no setlist matches no setlist");
expect(names("xyzzy"), [], "a query that matches nothing returns no setlists");
expect(names("zebra"), [], "a band's copy with the same id as a song in a setlist does not match that setlist");

const shown = matchingSetlists(setlists, songs, "chain breaker")[0];
expect(shown?.songRefs ?? [], seed.setlists[0].songIds.map(local), "a shown setlist keeps all of its songs in order");

if (failures) {
  console.error(`${failures} search check(s) failed`);
  process.exit(1);
}
console.log("search ok: case, accents, apostrophes, punctuation, artist, setlist by name and by song, empty box shows all");
