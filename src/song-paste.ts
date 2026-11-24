import { displayChordLine, parseChord, pitchClass } from "./music";
import { headingLine, isChord, isSectionWord, KEY_ROOTS, ownSong, parseSheet, placeChords, untab, type PlacedChord, type SongFacts } from "./song-text";
import type { ChartSection, KeyMode, Song } from "./types";

/**
 * Smart paste: any chart copied from the web becomes the chart text `parseSheet` reads, plus the facts found on the
 * way. Pure text to text, so the editor's box stays the one editable copy of the chart. A chart that already reads
 * right, with nothing to clean, comes back as pasted.
 */

/** Every kind of line a paste leaves out and counts, in the order the status line names them. */
export const LEFT_OUT = ["tab lines", "lines above the first section", "directives", "site lines"] as const;
export type LeftOut = { count: number; what: (typeof LEFT_OUT)[number] };
export type Pasted = { facts: SongFacts; chart: string; leftOut: LeftOut[] };
/** A capo chart's chords as they sound, or as the guitar shapes the page wrote. */
export type CapoView = "sounding" | "shapes";

/** Decision D6: a bass has no capo, so a capo chart shows the chords as they sound. */
export const CAPO_VIEW: CapoView = "sounding";

/** How web pages spell chords the chart stores another way, one row per spelling, rooted on C. */
export const SPELLINGS: readonly (readonly [pasted: string, stored: string])[] = [
  ["CM7", "Cmaj7"],
  ["CM9", "Cmaj9"],
  ["CΔ", "Cmaj7"],
  ["CΔ7", "Cmaj7"],
  ["CΔ9", "Cmaj9"],
  ["C-", "Cm"],
  ["C-7", "Cm7"],
  ["Cmin", "Cm"],
  ["Cmin7", "Cm7"],
  ["Csus", "Csus4"],
  ["C7sus", "C7sus4"],
  ["C°", "Cdim"],
  ["C°7", "Cdim7"],
  ["Co", "Cdim"],
  ["Co7", "Cdim7"],
  ["Cø", "Cm7b5"],
  ["Cø7", "Cm7b5"],
  ["Cm7(b5)", "Cm7b5"],
  ["C+", "Caug"],
  ["C(add9)", "Cadd9"],
];

const SUFFIXES = SPELLINGS.map(([pasted, stored]) => [pasted.slice(1), stored.slice(1)] as const).sort((a, b) => b[0].length - a[0].length);
const EXTENSIONS = /^(?:(?:sus|add|b|#)\d+)*$/;

/** The chart's spelling of a pasted chord token, or null when the token is no chord. */
function storedChord(token: string): string | null {
  if (/^(?:N\.?C\.?|N\/C)$/i.test(token)) return "N.C.";
  const parts = token
    .replace(/\*+$/, "")
    .replace(/^\((.+)\)$/, "$1")
    .match(/^([A-G][#b]?)(.*?)(\/[A-G][#b]?)?$/);
  if (!parts) return null;
  const [, root, rest, bass = ""] = parts;
  const known = (name: string) => (isChord(name) ? name : null);
  for (const [pasted, stored] of SUFFIXES) {
    const tail = rest.startsWith(pasted) ? rest.slice(pasted.length).replace(/[()]/g, "") : null;
    if (tail !== null && EXTENSIONS.test(tail)) return known(root + stored + tail + bass);
  }
  return known(root + rest.replace(/[()]/g, "") + bass);
}

const BRACKET = /\[([^\]\s]+)\]/g;
const TOKEN = /\([^)]*\)|\S+/g;
const SEPARATOR = /^[-–—~>.,/|:]+$/;
const REPEAT = /^\(?(?:x\s*(\d+)|(\d+)\s*x)\)?$/i;

type ChordRow = { chords: PlacedChord[]; notes: string[] };

/** A line where every token is a chord or a row mark, with at least one chord. A mark such as (x2) becomes a note. */
function chordRowOf(line: string): ChordRow | null {
  const chords: PlacedChord[] = [];
  const notes: string[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    const name = storedChord(token);
    const repeat = token.match(REPEAT);
    if (name) chords.push({ name, at: match.index });
    else if (repeat) notes.push(`x${repeat[1] ?? repeat[2]}`);
    else if (SEPARATOR.test(token)) continue;
    else if (/^\(.+\)$/.test(token)) notes.push(token.slice(1, -1).trim());
    else return null;
  }
  return chords.length > 0 ? { chords, notes } : null;
}

/** A chord row over its words. Two chords with no room between them inside a word go into the words, so the editor warns about that line. */
function pairLines(chords: PlacedChord[], lyric: string): string[] {
  const { line, warning } = placeChords(chords, lyric);
  return warning ? [chords.reduceRight((text, { name, at }) => `${text.padEnd(at).slice(0, at)}[${name}]${text.slice(at)}`, lyric)] : [line.chords, line.lyrics];
}

type Heading = { name: string; note?: string; rest: string };

/** A section name with its repeat count apart: Chorus x2 is Chorus, played twice. */
function sectionName(text: string): { name: string; note?: string } | null {
  const repeat = text.trim().match(/^(.*?)\s*\(?(?:x\s*(\d+)|(\d+)\s*x)\)?$/i);
  const name = (repeat?.[1] ?? text).trim();
  if (!isSectionWord(name)) return null;
  return { name: name.replace(/:$/, ""), note: repeat ? `x${repeat[2] ?? repeat[3]}` : undefined };
}

/** [Verse 1], Verse 1:, (Bridge), chorus, Chorus x2, and a heading with its chords after it: Intro: G D Em C. */
function headingOf(text: string): Heading | null {
  const line = text.trim();
  const boxed = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (boxed && !storedChord(boxed[1].trim())) {
    const named = sectionName(boxed[1]);
    return { name: named?.name ?? boxed[1].trim(), note: named?.note, rest: boxed[2] };
  }
  const round = line.match(/^\(([^)]+)\)$/);
  const named = sectionName(round ? round[1] : line);
  if (named) return { ...named, rest: "" };
  const colon = line.match(/^([^:]{1,30}):\s*(.+)$/);
  const before = colon && sectionName(colon[1]);
  if (before && (chordRowOf(colon[2]) || colon[2].startsWith("|"))) return { ...before, rest: colon[2] };
  return null;
}

/** The section word in capitals, the library's style: Chorus (soft) becomes CHORUS (soft). */
function styled(name: string): string {
  const cut = name.search(/\s*\(|\s[—–-]\s/);
  const head = cut < 0 ? name : name.slice(0, cut);
  return head.toUpperCase() + name.slice(head.length);
}

/** The heading `parseSheet` already reads in a line, or null when it reads the line as something else. */
const headingRead = (line: string) => {
  const [only, ...more] = parseSheet(line).sections;
  return more.length === 0 && only?.lines.length === 0 ? only.heading : null;
};

type Key = { keyRoot: string; keyMode: KeyMode };

/** A key named in a header, or null when the root is no note. */
function keyOf(root: string, mode: string | undefined): Key | null {
  const note = root[0].toUpperCase() + root.slice(1).toLowerCase();
  if (!/^[A-G][#b]?$/.test(note)) return null;
  return { keyRoot: KEY_ROOTS[pitchClass(note)], keyMode: /^m(?!aj)/i.test(mode ?? "") ? "minor" : "major" };
}

const HEADER = {
  key: /^key\s*(?:[:=-]|\s+of)?\s*([A-Ga-g][#b]?)\s*(m|min|minor|maj|major)?\.?$/i,
  tempo: /^(?:(?:tempo|bpm)\s*[:=-]?\s*(\d{2,3})\s*(?:bpm)?|(\d{2,3})\s*bpm)$/i,
  capo: /^capo\s*(?:[:=-]|\s+on)?\s*(?:fret\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*fret)?$/i,
  noCapo: /^(?:no capo|capo\s*[:=-]?\s*(?:none|no|off|0))$/i,
  time: /^(?:time(?:\s*signature)?|meter)\s*[:=-]?\s*(\d{1,2}\/\d{1,2})$/i,
};
/** What a chord page prints around a chart: a rating, a sign-in prompt, a credit, a button. Matched by shape, never by a site's name. */
const SITE_LINES = [
  /^\d(?:[.,]\d+)?\s*\/\s*5\b/,
  /^[\d,.]+\s*(?:votes?|ratings?|views|reviews|favou?rites|comments)\b/i,
  /^(?:log\s?in|sign\s?in|sign\s?up|register)\b.*\b(?:to|for)\b/i,
  /\bsongbook\b/i,
  /^(?:tabbed|transcribed|submitted|arranged|uploaded|corrected)\s+by\b/i,
  /^(?:last\s+(?:edit(?:ed)?|updated?)|author|contributors?)\b/i,
  /^(?:advertisement|sponsored|print|share|embed|transpose|autoscroll|report (?:bad )?(?:tab|chords|this)|rate this(?: tab| song)?|download (?:pdf|tab))$/i,
];
/** The title line a chord page prints: "Paper Boats chords", "Paper Boats Chords by The Made Up Band". */
const TITLE_LINE = /^(.+?)\s+(?:(?:guitar|ukulele|uke|bass|piano)\s+)?(?:chords?|tabs?|chord chart|lyrics)(?:\s+\(.*\))?(?:\s+(?:by|[-–—])\s+(.+))?$/i;
/** The artist line under it: "The Made Up Band", "by The Made Up Band" or "Artist: The Made Up Band". */
const ARTIST_LINE = /^(?:by\s+|artist\s*:\s*)?([^:]+?)$/i;
/** The parts a band plays and nobody sings, where a line of words is an instruction to the player. */
const PLAYED = /^(?:intro|solo|interlude|instrumental|riff|break)\b/i;
/** A rule a page draws under a heading or between parts. */
const DIVIDER = /^[-–—_=*~]{3,}$/;
/** A fretboard shape such as 032010 or xx2010. */
const FRETS = /(?<![\w-])[xX\d]{6}(?![\w-])/;
/** Words to the player, not sung: they name a fretboard shape, or a chord by more than its letter, such as C/E or G#dim. */
const toPlayer = (text: string) =>
  FRETS.test(text) ||
  text.split(/\s+/).some((token) => {
    const name = token.replace(/[.,;:!?]+$/, "");
    return (name.length >= 3 || /[\d#/]/.test(name)) && storedChord(name) !== null;
  });
const TAB_LINE = /^\s*[A-Ga-g][#b]?\s*[|:][-0-9|hpbrsvx/\\~^.()<>=*\s]*$/;
const DIRECTIVE = /^\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}$/i;
const STARTS: Record<string, string> = { soc: "Chorus", start_of_chorus: "Chorus", sov: "Verse", start_of_verse: "Verse", sob: "Bridge", start_of_bridge: "Bridge" };
const ENDS = new Set(["eoc", "end_of_chorus", "eov", "end_of_verse", "eob", "end_of_bridge"]);
const COMMENTS = new Set(["c", "comment", "ci", "comment_italic", "cb", "comment_box"]);

type Read =
  | { kind: "blank" }
  | { kind: "gone" }
  | { kind: "counted"; what: LeftOut["what"] }
  | { kind: "heading"; heading: Heading; made: boolean }
  | { kind: "chords"; row: ChordRow }
  | { kind: "bars" }
  | { kind: "bracket" }
  | { kind: "note"; text: string }
  | { kind: "end" }
  | { kind: "site" }
  | { kind: "text" };

type Found = { facts: SongFacts; headerKey?: Key };

/** What one cleaned line is, with any fact it holds put in `found`. Tab mode runs from {start_of_tab} to {end_of_tab}. */
function readLine(line: string, found: Found, state: { tab: boolean }): Read {
  const text = line.trim();
  const directive = text.match(DIRECTIVE);
  if (directive) {
    const name = directive[1].toLowerCase();
    const value = directive[2]?.trim() ?? "";
    if (name === "sot" || name === "start_of_tab") state.tab = true;
    else if (name === "eot" || name === "end_of_tab") state.tab = false;
    else if ((name === "title" || name === "t") && value) found.facts.title = value;
    else if ((name === "artist" || name === "subtitle" || name === "st") && value) found.facts.artist ??= value;
    else if (name === "key" && /^[A-G][#b]?\s*(?:m|min|minor|maj|major)?$/i.test(value)) {
      const [, root, mode] = value.match(/^([A-G][#b]?)\s*(.*)$/i)!;
      found.headerKey = keyOf(root, mode) ?? found.headerKey;
    } else if (name === "tempo" && /^\d{2,3}$/.test(value)) found.facts.tempo = Number(value);
    else if (name === "time" && /^\d{1,2}\/\d{1,2}$/.test(value)) found.facts.timeSignature = value;
    else if (name === "capo" && /^\d{1,2}$/.test(value)) {
      if (Number(value) > 0) found.facts.capo = Number(value);
    }
    else if (STARTS[name]) return { kind: "heading", heading: { name: value || STARTS[name], rest: "" }, made: true };
    else if (ENDS.has(name)) return { kind: "end" };
    else if (COMMENTS.has(name) && value) {
      const named = sectionName(value);
      return named ? { kind: "heading", heading: { ...named, rest: "" }, made: true } : { kind: "note", text: value };
    } else return { kind: "counted", what: "directives" };
    return { kind: "gone" };
  }
  if (state.tab) return text ? { kind: "counted", what: "tab lines" } : { kind: "blank" };
  if (text === "") return { kind: "blank" };
  const named = text.match(HEADER.key);
  const key = named && keyOf(named[1], named[2]);
  const tempo = text.match(HEADER.tempo);
  const capo = text.match(HEADER.capo);
  const time = text.match(HEADER.time);
  if (key) found.headerKey = key;
  else if (tempo) found.facts.tempo = Number(tempo[1] ?? tempo[2]);
  else if (capo && Number(capo[1]) >= 1 && Number(capo[1]) <= 11) found.facts.capo = Number(capo[1]);
  else if (time) found.facts.timeSignature = time[1];
  if (key || tempo || capo || time || HEADER.noCapo.test(text)) return { kind: "gone" };
  if (TAB_LINE.test(text) && text.includes("--")) return { kind: "counted", what: "tab lines" };
  if (DIVIDER.test(text)) return { kind: "gone" };
  if (text.startsWith("|")) return { kind: "bars" };
  if ([...text.matchAll(BRACKET)].some((match) => storedChord(match[1]))) return { kind: "bracket" };
  if (SITE_LINES.some((pattern) => pattern.test(text))) return { kind: "site" };
  const heading = headingOf(text);
  // A heading the chart already reads keeps its whole name, BRIDGE (x2) included, and only takes the library's style.
  const already = heading && !heading.rest ? headingRead(line) : null;
  if (already) return { kind: "heading", heading: { name: already, rest: "" }, made: false };
  if (heading) return { kind: "heading", heading, made: true };
  const row = chordRowOf(line);
  return row ? { kind: "chords", row } : { kind: "text" };
}

/** A song that holds only a key, so the chart's own transpose spells the raised chords for that key. */
const inKey = (key: Key): Song => ({ ...ownSong({ title: "", artist: "", ...key, tempo: null, timeSignature: "" }, []), ref: "paste/key", id: 0 });

/** The chart text for `lines`, each chord raised by `raise` semitones in `key`, and whether anything changed. */
function write(lines: string[], reads: Read[], raise: number, key: Key): { out: string[]; changed: boolean; leftOut: Map<LeftOut["what"], number> } {
  const song = inKey(key);
  const sound = (name: string) => (raise ? displayChordLine(name, song, raise, "notes") : name);
  const chord = (token: string) => {
    const name = storedChord(token);
    return name ? sound(name) : null;
  };
  const bars = (text: string) => text.replace(/[^\s|]+/g, (token) => chord(token) ?? token);
  const brackets = (text: string) => text.replace(BRACKET, (whole, token: string) => (chord(token) ? `[${chord(token)}]` : whole));
  const leftOut = new Map<LeftOut["what"], number>();
  const count = (what: LeftOut["what"]) => leftOut.set(what, (leftOut.get(what) ?? 0) + 1);
  const first = firstSection(reads);
  const out: string[] = [];
  let changed = false;
  let verses = 0;
  let part = "";
  let instructed = false;
  const row = ({ chords, notes }: ChordRow, lyric = "") => {
    const named = chords.map((chord) => ({ ...chord, name: sound(chord.name) }));
    out.push(...(lyric ? pairLines(named, lyric) : [placeChords(named, lyric).line.chords]));
    out.push(...notes.map((note) => `Note: ${note}`));
  };
  for (let i = 0; i < lines.length; i += 1) {
    const read = reads[i];
    const line = lines[i];
    const start = out.length;
    if (first >= 0 && i < first && (read.kind === "text" || read.kind === "note" || read.kind === "site")) {
      count("lines above the first section");
      changed = true;
      continue;
    }
    if (read.kind === "blank") {
      // A blank in a played part before more playing, or before more words once the part holds words to the
      // player, would start a section the page never named, so the part keeps it. Any other blank ends the part.
      const next = reads.findIndex((each, k) => k > i && !["blank", "gone", "counted", "site"].includes(each.kind));
      const playing = next >= 0 && (reads[next].kind === "bars" || (reads[next].kind === "chords" && reads[next + 1]?.kind !== "text"));
      const told = instructed && next >= 0 && reads[next].kind === "text" && !headingRead(lines[next]);
      if (PLAYED.test(part) && (playing || told)) changed = true;
      else {
        out.push("");
        part = "";
      }
    } else if (read.kind === "end") out.push("");
    else if (read.kind === "counted") count(read.what);
    else if (read.kind === "site") {
      count("site lines");
      changed = true;
    } else if (read.kind === "note") out.push(`Note: ${read.text}`);
    else if (read.kind === "text") {
      // A line the chart reads as a heading starts its own part; in a played part, words are an instruction.
      const own = headingRead(line);
      if (own) {
        part = own;
        instructed = false;
      } else if (PLAYED.test(part)) instructed = true;
      out.push(!own && PLAYED.test(part) && !/^\s*(?:note|bars):/i.test(line) ? `Note: ${line.trim()}` : line);
    }
    else if (read.kind === "bars") out.push(bars(line));
    else if (read.kind === "bracket") out.push(brackets(line));
    else if (read.kind === "heading") {
      const { heading } = read;
      part = heading.name;
      instructed = false;
      if (/^verse\b/i.test(heading.name)) verses += 1;
      // A bare Verse is numbered, so two pasted [Verse] markers are two verses the player can tell apart.
      const name = /^verse$/i.test(heading.name) ? `Verse ${verses}` : heading.name;
      // Under a chord row with no words, the chart would read the heading as that row's words.
      if (out.length > 0 && chordRowOf(out[out.length - 1])) {
        out.push("");
        changed = true;
      }
      // A name that is no section word stays boxed, so a second read still takes it for a heading.
      out.push(sectionName(name) ? headingLine(styled(name)) : `[${styled(name)}]`);
      if (heading.note) out.push(`Note: ${heading.note}`);
      const rest = heading.rest.trim();
      const chords = chordRowOf(rest);
      if (rest.startsWith("|")) out.push(bars(rest));
      else if (chords) row(chords);
      else if (rest) out.push(rest);
      if (read.made || name !== heading.name) changed = true;
      continue;
    } else if (read.kind === "chords") {
      const below = reads[i + 1]?.kind === "text" ? lines[i + 1] : undefined;
      row(read.row, below);
      if (below !== undefined) i += 1;
      const written = out.slice(start).map((each) => each.trimEnd());
      const source = [line, ...(below === undefined ? [] : [below])].map((each) => each.trimEnd());
      if (written.join("\n") !== source.join("\n")) changed = true;
      continue;
    }
    if (out.slice(start).join("\n").trimEnd() !== line.trimEnd()) changed = true;
  }
  return { out, changed, leftOut };
}

/** The first line that starts the chart: a heading, a chord row, a bar line or a line with chords in brackets. */
const firstSection = (reads: Read[]) => reads.findIndex((read) => ["heading", "chords", "bars", "bracket"].includes(read.kind));

/** The title and artist a chord page prints above its chart. A ChordPro title or artist wins. */
function headerFacts(lines: string[], reads: Read[], found: Found) {
  const texts = lines.flatMap((line, i) => (reads[i].kind === "text" ? [line.trim()] : []));
  const at = texts.findIndex((text) => TITLE_LINE.test(text));
  if (at < 0) return;
  const [, title, by] = texts[at].match(TITLE_LINE)!;
  const next = texts[at + 1]?.match(ARTIST_LINE)?.[1].trim();
  const artist = by ?? (next && next.split(/\s+/).length <= 6 && !/[.!?,;]$/.test(next) ? next : undefined);
  found.facts.title ??= title.trim();
  if (artist) found.facts.artist ??= artist.trim();
}

/** What a line is to `rejoin`. A lone chord is a chord row of one chord at the line's start. */
type Cell = "blank" | "heading" | "chord" | "words" | "site" | "other";
/**
 * A run of lines with no blank or heading inside, and the blank lines before it. A phone that copies a chord page
 * gives each chord, and the words under it, a line of its own (`copy`), and a blank line where the page broke a lyric
 * line, so one lyric line can come as a `pair` (a lone chord over a word), a lone `chord`, or a whole `copy` block.
 */
type Block = { from: number; to: number; gap: number; kind: "copy" | "pair" | "chord" | "line" | "site" | "other" };
type Piece = { chord: string } | { words: string };

/** Words that start a lyric line: a capital or a digit first. */
const opensLine = (text: string) => /^[\p{Lu}\d]/u.test(text.trim());
/** Words a page copy breaks a lyric line into: a few words, or a run that goes on from the words before it. */
const fragment = (text: string) => text.trim().split(/\s+/).length <= 4 || !opensLine(text);

function blockKind(cells: Cell[], texts: string[]): Block["kind"] {
  if (cells.every((cell) => cell === "site")) return "site";
  if (cells.length === 1 && (cells[0] === "chord" || cells[0] === "words")) return cells[0] === "chord" ? "chord" : "line";
  const pieces = cells.every((cell, k) => cell === "chord" || (cell === "words" && fragment(texts[k])));
  if (!pieces || !cells.some((cell, k) => cell === "chord" && cells[k + 1] === "words")) return "other";
  if (cells.length === 2) return "pair";
  // Lines typed one chord each, or one chord over a line and the next line, stay lines. A copy shows words that run
  // on in lower case, under two chords or more, or under one chord when its words already start mid-line.
  const first = cells.indexOf("words");
  const runsOn = texts.some((text, k) => k > first && cells[k] === "words" && !opensLine(text));
  const chords = cells.filter((cell) => cell === "chord").length;
  return runsOn && (chords >= 2 || !opensLine(texts[first])) ? "copy" : "other";
}

/** One lyric line from its pieces: the words joined by spaces, each chord over the first letter of the words after it. */
function pieceRow(pieces: Piece[]): string[] {
  let lyric = "";
  let waiting: string[] = [];
  const placed: PlacedChord[] = [];
  for (const piece of pieces) {
    if ("chord" in piece) {
      waiting.push(piece.chord);
      continue;
    }
    const at = lyric ? lyric.length + 1 : 0;
    lyric = lyric ? `${lyric} ${piece.words}` : piece.words;
    placed.push(...waiting.map((name) => ({ name, at })));
    waiting = [];
  }
  placed.push(...waiting.map((name) => ({ name, at: lyric ? lyric.length + 1 : 0 })));
  const { line } = placeChords(placed, lyric);
  return lyric ? [line.chords, line.lyrics] : [line.chords];
}

/**
 * The lines of a page copy put back together as the page showed them: each run of pieces becomes a chord row over its
 * lyric line, and the blank lines inside a run go. A run takes a block that goes on in lower case into the line
 * before it. In a part of single lines of words with a blank after each, one blank is a line break and two end a
 * stanza. Anything else stays as pasted.
 */
function rejoin(lines: string[]): string[] {
  const scratch: Found = { facts: {} };
  const state = { tab: false };
  const reads = lines.map((line) => readLine(line, scratch, state));
  const cells: Cell[] = reads.map((read) => {
    if (read.kind === "blank") return "blank";
    if (read.kind === "heading" || read.kind === "end") return "heading";
    if (read.kind === "chords" && read.row.chords.length === 1 && read.row.notes.length === 0 && read.row.chords[0].at === 0) return "chord";
    return read.kind === "text" ? "words" : read.kind === "site" ? "site" : "other";
  });
  const skip = new Set<number>();
  const put = new Map<number, string[]>();
  const runOf = (run: Block[]) => {
    const rows: Piece[][] = [];
    for (const block of run) {
      const pieces: Piece[] = [];
      for (let i = block.from; i <= block.to; i += 1) {
        const read = reads[i];
        pieces.push(read.kind === "chords" ? { chord: read.row.chords[0].name } : { words: lines[i].trim() });
      }
      const last = rows[rows.length - 1];
      const words = (each: Piece[]) => each.find((piece): piece is { words: string } => "words" in piece);
      const said = words(pieces)?.words;
      const goesOn = last && (words(last) ? said !== undefined && !opensLine(said) : said === undefined);
      if (goesOn) last.push(...pieces);
      else rows.push(pieces);
    }
    for (let i = run[0].from; i <= run[run.length - 1].to; i += 1) skip.add(i);
    put.set(run[0].from, rows.flatMap(pieceRow));
  };
  const mend = (blocks: Block[]) => {
    const solid = blocks.filter((block) => block.kind !== "site");
    if (solid.length >= 3 && solid.every((block) => block.kind === "line")) {
      for (const [k, block] of blocks.entries()) if (k > 0 && block.gap === 1 && block.kind === "line" && blocks[k - 1].kind === "line") skip.add(block.from - 1);
    }
    const pieces = (block: Block) => block.kind === "copy" || block.kind === "pair" || block.kind === "chord";
    for (let k = 0; k < blocks.length; ) {
      let end = k;
      while (pieces(blocks[k]) && end + 1 < blocks.length && pieces(blocks[end + 1]) && blocks[end + 1].gap === 1) end += 1;
      const run = blocks.slice(k, end + 1);
      if (run.some((block) => block.kind === "copy") || (run.length >= 2 && run.every((block) => block.kind === "chord"))) runOf(run);
      k = end + 1;
    }
  };
  let blocks: Block[] = [];
  let gap = 0;
  for (let i = 0; i <= lines.length; i += 1) {
    const cell = cells[i];
    if (cell === undefined || cell === "heading") {
      mend(blocks);
      blocks = [];
      gap = 0;
    } else if (cell === "blank") gap += 1;
    else {
      let to = i;
      while (cells[to + 1] !== undefined && !["blank", "heading"].includes(cells[to + 1])) to += 1;
      blocks.push({ from: i, to, gap, kind: blockKind(cells.slice(i, to + 1), lines.slice(i, to + 1)) });
      gap = 0;
      i = to;
    }
  }
  return lines.flatMap((line, i) => [...(put.get(i) ?? []), ...(skip.has(i) ? [] : [line])]);
}

/** A chord on a line of its own with no space around it, the way a phone copies one from a chord page. */
const loneChord = (line: string | undefined) => (line !== undefined && /^\S+$/.test(line) ? storedChord(line) : null);
const blank = (line: string | undefined) => line !== undefined && line.trim() === "";

/** One line of the page while its pieces come in: the words so far, the spaces since, and the chords that wait for their word. */
type PageRow = { lyric: string; gap: number; placed: PlacedChord[]; waiting: string[] };

/** Puts words on the row. The last chord that waits sits over their first letter, and each chord before it gets room to its left. */
function say(row: PageRow, text: string) {
  const joint = row.lyric && (row.gap > 0 || /^\s/.test(text)) ? " " : "";
  const roomy = joint !== "" || row.lyric === "";
  let at = row.lyric.length + joint.length;
  for (const [k, name] of row.waiting.entries()) {
    row.placed.push({ name, at });
    if (roomy && k < row.waiting.length - 1) at += name.length + 1;
  }
  row.lyric = (row.lyric + joint).padEnd(at) + text.trim().replace(/\s+/g, " ");
  row.waiting = [];
  row.gap = text.length - text.trimEnd().length;
}

/** The chart lines of one page line: a chord row over its words, or chords alone, with any row mark after them. */
function rowLines(row: PageRow): string[] {
  let at = row.lyric ? row.lyric.length + 1 : 0;
  for (const name of row.waiting) {
    row.placed.push({ name, at });
    at += name.length + 1;
  }
  const chords = row.placed.map((chord) => chord.name).join(" ");
  if (!row.lyric) return [chords];
  if (chordRowOf(`${chords} ${row.lyric}`)) return [`${chords} ${row.lyric}`];
  return pairLines(row.placed, row.lyric);
}

/**
 * A phone's copy of a chord page, put back together as the page showed it, or null when the paste is no such copy.
 * The page holds each chord, and the word under it, in a box of its own, and the phone gives every box a line. So a
 * line that is one chord, or the one word after it, goes on with the line before it. The text between two boxes comes
 * as one line for each line of the page it covers: its first line goes on, and each line after it, or an empty line,
 * starts a new line of the page. A gap of two spaces or more before a chord starts a new row. A line with no box that
 * speaks to the player is a note, and a chord row set apart from its words by such lines takes the words, with the
 * notes under the pair. On a page that names its sections a blank line starts none. A copy that kept none of the
 * page's spaces is no such copy, and `rejoin` reads it.
 */
function pageCopy(lines: string[]): string[] | null {
  const spaced = (line: string | undefined) => line !== undefined && line.trim() !== "" && /^\s/.test(line) && /\s$/.test(line);
  const signs = lines.filter((line, i) => loneChord(line) && (spaced(lines[i - 1]) || (lines[i + 1] !== "" && blank(lines[i + 1]))));
  if (signs.length < 2) return null;
  const out: { text: string; loose?: true }[] = [];
  const indents: number[] = [];
  let row: PageRow | null = null;
  /** A line of the page with no box on it yet. A chord may still follow on the same line. */
  let held: string | null = null;
  /** What the line before was: a chord, the spaces after a chord, the one word after a chord, or text between boxes. */
  let after: "chord" | "lead" | "word" | "text" = "text";
  const open = (): PageRow => (row ??= { lyric: "", gap: 0, placed: [], waiting: [] });
  const close = () => {
    if (row) out.push(...rowLines(row).map((text) => ({ text })));
    if (held !== null) out.push(blank(held) ? { text: "" } : { text: held, loose: true });
    row = null;
    held = null;
  };
  for (const [i, line] of lines.entries()) {
    const next = lines[i + 1];
    const name = loneChord(line);
    // A word that reads as a chord, such as A: it comes after a chord and the rest of its line follows.
    const word = name !== null && (after === "chord" || after === "lead") && next !== undefined && /^\s+[\p{L}']/u.test(next);
    if (name !== null && !word) {
      if (after === "text") {
        const before: string = held ?? "";
        const last = row ? lines[i - 1] : before;
        // Text that ends in a space, or inside a word the chord splits, is on the chord's line of the page.
        const goesOn = /\s$/.test(last) || (/[\p{L}']$/u.test(last) && next !== undefined && /^\p{Ll}\S*$/u.test(next));
        if (!row && blank(before)) {
          if (held !== null) indents.push(before.length);
          held = null;
        } else if (!goesOn) close();
        else if (!row) {
          held = null;
          say(open(), before);
        }
      }
      if (open().lyric && open().gap >= 2) close();
      open().waiting.push(name);
      after = "chord";
    } else if (line === "") {
      const fresh = after === "text";
      close();
      if (fresh) out.push({ text: "" });
      after = "text";
    } else if (after !== "text") {
      const one = /^\S+$/.test(line);
      if (after === "lead" && !one) {
        close();
        held = line;
        after = "text";
      } else if (blank(line)) {
        open().gap += line.length;
        after = after === "chord" ? "lead" : "text";
      } else {
        say(open(), line);
        after = one && after !== "word" ? "word" : "text";
      }
    } else {
      close();
      held = line;
      after = "text";
    }
  }
  close();
  // A line with no box keeps its columns, less the indent the page gives every line.
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  const shown = out.map(({ text, loose }) => ({ loose, text: loose ? text.slice(Math.min(cut, text.length - text.trimStart().length)) : text }));
  // Above the chart a line is the page's own, and its title may hold a word that reads as a chord.
  const first = shown.findIndex(({ text, loose }) => (loose ? chordRowOf(text) !== null || headingOf(text) !== null : text !== ""));
  const aside = (at: number) => at > first && shown[at]?.loose === true && !chordRowOf(shown[at].text) && toPlayer(shown[at].text);
  const note = (text: string) => `Note: ${text.trim().replace(/\s+/g, " ")}`;
  const page: string[] = [];
  for (let i = 0; i < shown.length; i += 1) {
    const { text, loose } = shown[i];
    page.push(aside(i) ? note(text) : text);
    if (!loose || !chordRowOf(text)) continue;
    let under = i + 1;
    while (shown[under]?.text === "" || aside(under)) under += 1;
    const words = shown[under];
    const asides = shown.slice(i + 1, under).filter((each) => each.text !== "");
    if (asides.length === 0 || !words?.loose || chordRowOf(words.text) || headingOf(words.text)) continue;
    page.push(words.text, ...asides.map((each) => note(each.text)));
    i = under;
  }
  const named = page.some((text) => headingOf(text) !== null);
  return named ? page.filter((text) => text !== "") : page;
}

/** Blank runs fold to one blank line, and the chart starts and ends on a line with something on it. */
const tidy = (out: string[]) => out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");

/** A pasted text as chart text, with the facts it held and a count of what it left out. Run on a paste, not on each key. */
export function readPaste(text: string, view: CapoView = CAPO_VIEW): Pasted {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .split("\n")
    .map(untab);
  const lines = pageCopy(cleaned) ?? rejoin(cleaned);
  const found: Found = { facts: {} };
  const state = { tab: false };
  const reads = lines.map((line) => readLine(line, found, state));
  const first = firstSection(reads);
  if (first > 0) headerFacts(lines.slice(0, first), reads, found);
  const shapes = write(lines, reads, 0, { keyRoot: "C", keyMode: "major" });
  const capo = found.facts.capo ?? 0;
  const fromChords = keyFromChords(parseSheet(tidy(shapes.out)).sections);
  const header = found.headerKey;
  const headerSounds = Boolean(capo && header && fromChords && header.keyMode === fromChords.keyMode && pitchClass(header.keyRoot) === (pitchClass(fromChords.keyRoot) + capo) % 12);
  const shapesKey = headerSounds ? fromChords : (header ?? fromChords);
  const sounding = capo > 0 && view === "sounding" && shapesKey !== null;
  const written = sounding ? write(lines, reads, capo, shapesKey) : shapes;
  const key = shapesKey && sounding ? { keyRoot: KEY_ROOTS[(pitchClass(shapesKey.keyRoot) + capo) % 12], keyMode: shapesKey.keyMode } : shapesKey;
  const facts: SongFacts = { ...found.facts, ...(key ?? {}) };
  const leftOut = LEFT_OUT.flatMap((what) => (written.leftOut.has(what) ? [{ count: written.leftOut.get(what)!, what }] : []));
  const rejoined = lines.length !== cleaned.length || lines.some((line, i) => line !== cleaned[i]);
  return { facts, chart: written.changed || rejoined ? tidy(written.out) : cleaned.join("\n"), leftOut };
}

/** The words `Song.keyNote` takes for a capo chart. */
export function capoNote(capo: number, view: CapoView = CAPO_VIEW): string {
  return view === "sounding" ? `Capo ${capo} for guitar` : `Capo ${capo}. The chords are guitar shapes.`;
}

const TRIADS: Record<KeyMode, [number, "major" | "minor" | "dim"][]> = {
  major: [[0, "major"], [2, "minor"], [4, "minor"], [5, "major"], [7, "major"], [9, "minor"], [11, "dim"]],
  minor: [[0, "minor"], [2, "dim"], [3, "major"], [5, "minor"], [7, "minor"], [7, "major"], [8, "major"], [10, "major"], [11, "dim"]],
};

/**
 * The key whose chords the chart uses most, of the 24. A chord in the key scores one. The first and the last chord
 * score two more when they are the key's own tonic chord. Null for a chart with no chords.
 */
export function keyFromChords(sections: ChartSection[]): Key | null {
  const chords = sections
    .flatMap((section) => section.lines.flatMap((line) => `${line.chords ?? ""} ${line.bars ?? ""}`.split(/[\s|]+/)))
    .flatMap((token) => {
      const chord = isChord(token) ? parseChord(token) : null;
      if (!chord) return [];
      const kind = /^(?:dim|m7b5)/.test(chord.quality) ? "dim" : chord.minor ? "minor" : "major";
      return [{ pc: pitchClass(chord.root), kind }];
    });
  if (chords.length === 0) return null;
  let best: { key: Key; score: number } | null = null;
  for (const keyMode of ["major", "minor"] as const) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const fits = (chord: (typeof chords)[number]) => TRIADS[keyMode].some(([step, kind]) => (tonic + step) % 12 === chord.pc && kind === chord.kind);
      const home = (chord: (typeof chords)[number]) => chord.pc === tonic && chord.kind === keyMode;
      const score = chords.filter(fits).length + (home(chords[0]) ? 2 : 0) + (home(chords[chords.length - 1]) ? 2 : 0);
      if (!best || score > best.score) best = { key: { keyRoot: KEY_ROOTS[tonic], keyMode }, score };
    }
  }
  return best!.key;
}
