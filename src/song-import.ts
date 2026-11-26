import { fold, songYouHave } from "./search";
import { parseBpm } from "./song-data-editor";
import { capoNote, readPaste } from "./song-paste";
import { isChord, ownSong, parseSheet } from "./song-text";
import { madeHere } from "./storage";
import type { KeyMode, Song } from "./types";

/**
 * Bulk import, the half with no screen: what a file is, the song a file would make, and what the review list says
 * about it. No DOM and no network. Every file's text goes through `readPaste`, the paste's own reader, so the chart
 * rules live there alone. The readers that turn bytes into that text are in `src/import-read.ts`.
 */

/** What a file is, from its first bytes, then its name. */
export type ImportKind = "text" | "html" | "rtf" | "docx" | "zip" | "pdf" | "image" | "musicxml" | "unknown";

/** What a reader got out of one file. `other` is a second reading of the same file, when the reader has one. */
export type Extracted = { text: string; other?: string; doubts: Doubt[]; title?: string };
export type Doubt = "fonts" | "two-readings" | "photo" | "many-pages";

/** Why no sheet came out of a file. Each has its words in `MESSAGES` in `src/song-import.tsx`. */
export type UnreadReason = "unsupported" | "old-word" | "empty" | "no-text" | "damaged" | "locked" | "scan" | "no-reader" | "too-big" | "too-many" | "slow";
/** Why a row that can be saved wants a look first. */
export type CheckReason = "no-title" | "no-chords" | "warnings" | "fonts" | "two-readings" | "many-pages" | "photo" | "duplicate";

/** One reader for each kind. A reader throws `Unread` with a reason. A kind with no reader yet is `null`. */
export type Reader = (bytes: Uint8Array, name: string) => Promise<Extracted[]>;
export class Unread extends Error {
  constructor(readonly reason: UnreadReason) {
    super(reason);
  }
}

/** The song a row would save. The same fields as the editor's form. */
export type Draft = { title: string; artist: string; keyRoot: string; keyMode: KeyMode; bpm: string; timeSignature: string; chart: string; keyNote: string };

/**
 * A row that matches a song the player has, a song earlier in the pile, or the bytes of an earlier file. A hint about
 * the player's own library, never a judge of sharing: that goes by ids and lineage. `keep` is the player's Keep both.
 */
export type Duplicate =
  | { by: "library"; songId: number; title: string; canReplace: boolean; keep?: true }
  | { by: "pile"; name: string; keep?: true }
  | { by: "file"; name: string; keep?: true };

export type ImportRow = {
  id: string;
  name: string;
  state:
    | { is: "waiting" }
    | { is: "reading" }
    | { is: "ready"; draft: Draft; other?: Draft; verdict: "good" | "check"; reasons: CheckReason[]; duplicate?: Duplicate; skipped: boolean }
    | { is: "unread"; why: UnreadReason }
    | { is: "saved"; songId: number };
};

export type ReadyState = Extract<ImportRow["state"], { is: "ready" }>;

/** Files in one pile, after zips are opened. */
export const MAX_FILES = 200;
/** Bytes of one file, and of one file inside a zip after it is inflated. */
export const MAX_BYTES = 20 * 1024 * 1024;
/** Pages read from one PDF. */
export const MAX_PAGES = 60;
/** Characters of text from one file. A chart is a few thousand. */
export const MAX_CHARS = 200_000;
/** Time for one file. */
export const READ_MS = 20_000;

/** Fonts whose letters all take the same width, so a chord's column is its place over the words. */
export const MONOSPACE_FONTS = [
  "courier",
  "courier new",
  "consolas",
  "lucida console",
  "lucida sans typewriter",
  "monaco",
  "menlo",
  "andale mono",
  "ibm plex mono",
  "dejavu sans mono",
  "liberation mono",
  "noto sans mono",
  "roboto mono",
  "source code pro",
  "ubuntu mono",
  "fira mono",
  "fira code",
  "jetbrains mono",
  "cascadia mono",
  "cascadia code",
  "sf mono",
  "pt mono",
  "inconsolata",
  "monospace",
] as const;

export const isMonospace = (font: string) => (MONOSPACE_FONTS as readonly string[]).includes(font.trim().replace(/^["']|["']$/g, "").toLowerCase());

const TEXT_EXTENSIONS = ["txt", "text", "cho", "crd", "chopro", "chordpro", "pro", "onsong"];
const KIND_OF_EXTENSION: Record<string, ImportKind> = {
  ...Object.fromEntries(TEXT_EXTENSIONS.map((ext) => [ext, "text"])),
  html: "html",
  htm: "html",
  rtf: "rtf",
  docx: "docx",
  zip: "zip",
  pdf: "pdf",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  musicxml: "musicxml",
  mxl: "musicxml",
};

/** The kind a file's name claims, or undefined for a name with no extension the app knows. */
export const kindOfName = (name: string): ImportKind | undefined => KIND_OF_EXTENSION[/\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? ""];

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((byte, at) => bytes[at] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** An old Word file, `.doc`, which is a compound file and not a zip. */
export const isOldWord = (bytes: Uint8Array) => startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

/** Where `needle` sits in `bytes`, or -1. */
export function findBytes(bytes: Uint8Array, needle: string, from = 0): number {
  const codes = ascii(needle);
  for (let at = bytes.indexOf(codes[0], from); at >= 0 && at <= bytes.length - codes.length; at = bytes.indexOf(codes[0], at + 1)) {
    if (codes.every((code, i) => bytes[at + i] === code)) return at;
  }
  return -1;
}

/** Text has no zero byte, unless it is UTF-16, which starts with its byte order mark. */
const looksLikeText = (bytes: Uint8Array) => startsWith(bytes, 0xff, 0xfe) || startsWith(bytes, 0xfe, 0xff) || !bytes.subarray(0, 8192).includes(0);

/**
 * The kind, from the first bytes, then from the extension. A phone can hand over a file with no extension, and a name
 * can be wrong, so the bytes win: a PDF, a zip, an RTF and the photo types start with fixed bytes. Text with no known
 * start is text, or HTML when it opens like a page.
 */
export function kindOf(bytes: Uint8Array, name: string): ImportKind {
  const named = kindOfName(name);
  if (startsWith(bytes, ...ascii("%PDF-"))) return "pdf";
  if (startsWith(bytes, ...ascii("{\\rtf"))) return "rtf";
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) || startsWith(bytes, 0x50, 0x4b, 0x05, 0x06)) {
    if (named === "docx" || findBytes(bytes, "word/document.xml") >= 0) return "docx";
    return named === "musicxml" ? "musicxml" : "zip";
  }
  if (startsWith(bytes, 0xff, 0xd8, 0xff) || startsWith(bytes, 0x89, 0x50, 0x4e, 0x47) || startsWith(bytes, ...ascii("GIF8"))) return "image";
  if (startsWith(bytes, ...ascii("RIFF")) && findBytes(bytes.subarray(8, 12), "WEBP") === 0) return "image";
  if (findBytes(bytes.subarray(4, 8), "ftyp") === 0) return "image";
  if (bytes.length === 0) return named ?? "unknown";
  if (isOldWord(bytes) || !looksLikeText(bytes)) return "unknown";
  const head = decodeText(bytes.subarray(0, 2048)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("<?xml") && head.includes("<score-")) return "musicxml";
  return named === "html" || named === "musicxml" ? named : "text";
}

/**
 * Bytes as text. A byte order mark picks UTF-8 or UTF-16. With none, UTF-8 is tried, and a file that is not valid
 * UTF-8 is read as Windows-1252, which is what an old Windows editor writes.
 */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** A name a camera, a scanner or an editor gives, which says nothing about the song. */
const NO_TITLE = /^(?:img|image|dsc[fn]?|pxl|photo|pic|scan|scanned|screenshot|screen shot|document|doc|untitled|new document|file|page)?[\s\d.]*$/i;

/**
 * The title a file name carries: `Wagon_Wheel-chords (1).txt` is Wagon Wheel. The folder, the extension and a copy mark
 * go, so do the words chords and lyrics, and `_` and `-` are spaces. Empty for a name with no title in it, such as
 * IMG_2041, Scan0003, Screenshot 2026-11-02, Document or digits alone.
 */
export function titleFromName(name: string): string {
  const stem = (name.split(/[\\/]/).pop() ?? "").replace(/\.[^.]{1,10}$/, "");
  const title = stem
    .replace(/[_-]+/g, " ")
    .replace(/(?:\s*(?:\(\d+\)|\bcopy\b))+\s*$/i, "")
    .replace(/\b(?:chords?|lyrics)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return NO_TITLE.test(title) ? "" : title;
}

const bpmText = (tempo: number | undefined) => (tempo != null && parseBpm(String(tempo)) != null ? String(tempo) : "");

/**
 * The song one reading of a file would save. `readPaste` reads the text as it reads a paste. The title comes from the
 * paste, then from the reader (an HTML page's title), then from the file name.
 */
export function draftOf(extracted: Pick<Extracted, "text" | "title">, name: string): Draft {
  const { facts, chart } = readPaste(extracted.text);
  return {
    title: (facts.title?.trim() || extracted.title?.trim() || titleFromName(name)).slice(0, 200),
    artist: facts.artist?.trim() ?? "",
    keyRoot: facts.keyRoot ?? "C",
    keyMode: facts.keyMode ?? "major",
    bpm: bpmText(facts.tempo),
    timeSignature: facts.timeSignature ?? "4/4",
    chart,
    keyNote: facts.capo ? capoNote(facts.capo) : "",
  };
}

/** True when the draft has a sheet: at least one section with a line in it. */
export const hasSheet = (draft: Draft) => parseSheet(draft.chart).sections.some((section) => section.lines.length > 0);

/** The chords a chart holds, over words and in bar rows. */
export function chordCount(chart: string): number {
  return parseSheet(chart)
    .sections.flatMap((section) => section.lines.flatMap((line) => `${line.chords ?? ""} ${line.bars ?? ""}`.split(/[\s|]+/)))
    .filter(isChord).length;
}

/** The lines `parseSheet` warns about, which the editor marks. */
export const warningCount = (draft: Draft) => parseSheet(draft.chart).warnings.length;

/**
 * The song a draft saves, as the editor stores a new song. With `before`, the song it replaces: the chart, key and
 * time come from the file, and the title, artist, length and notes stay, the tempo too when the file gives none.
 */
export function songOf(draft: Draft, before?: Omit<Song, "ref" | "id">): Omit<Song, "ref" | "id"> {
  const meta = {
    title: before?.title ?? draft.title,
    artist: before?.artist ?? draft.artist,
    keyRoot: draft.keyRoot,
    keyMode: draft.keyMode,
    tempo: parseBpm(draft.bpm) ?? before?.tempo ?? null,
    timeSignature: draft.timeSignature,
  };
  return { ...ownSong(meta, parseSheet(draft.chart).sections, before), keyNote: draft.keyNote || (before?.keyNote ?? "") };
}

/**
 * The verdict on one ready row, its reasons, and the duplicate flag. `rows` are the rows before it in the pile. A
 * duplicate is found by title and artist, the rule the editor uses: against My Songs by `songYouHave`, then against an
 * earlier row. The same bytes as an earlier file is the reducer's to find, since only it holds each file's print.
 */
export function judge(draft: Draft, extracted: Pick<Extracted, "doubts">, songs: Song[], rows: ImportRow[]): { verdict: "good" | "check"; reasons: CheckReason[]; duplicate?: Duplicate } {
  const reasons: CheckReason[] = [];
  const titled = draft.title.trim() !== "";
  if (!titled) reasons.push("no-title");
  if (chordCount(draft.chart) === 0) reasons.push("no-chords");
  if (warningCount(draft) > 0) reasons.push("warnings");
  for (const doubt of extracted.doubts) if (!reasons.includes(doubt)) reasons.push(doubt);
  const have = titled ? songYouHave(songs, draft) : undefined;
  const earlier = titled
    ? rows.find(({ state }) => state.is === "ready" && !state.skipped && fold(state.draft.title) === fold(draft.title) && fold(state.draft.artist) === fold(draft.artist))
    : undefined;
  const duplicate: Duplicate | undefined = have
    ? { by: "library", songId: have.id, title: have.title, canReplace: madeHere(have) }
    : earlier
      ? { by: "pile", name: earlier.name }
      : undefined;
  if (duplicate) reasons.push("duplicate");
  return { verdict: reasons.length === 0 ? "good" : "check", reasons, ...(duplicate ? { duplicate } : {}) };
}

/** What reading one file gave: a reading of each song in it, or a reason, each with the name its row shows. */
export type ReadResult = { name: string; extracted: Extracted; print: string } | { name: string; why: UnreadReason };

/** What the pile keeps about each row besides the row itself: what its reader doubted, its bytes' print, the player's Keep both. */
type Source = { doubts: Doubt[]; print: string; sameAs?: string; kept: boolean };

/** The review list. `past` counts the files inside zips that were not read because the pile was full. */
export type Pile = { rows: ImportRow[]; sources: Record<string, Source>; past: number };

export const EMPTY_PILE: Pile = { rows: [], sources: {}, past: 0 };

export type PileAction =
  | { do: "pick"; rows: { id: string; name: string }[] }
  | { do: "reading"; id: string }
  | { do: "read"; id: string; results: ReadResult[]; songs: Song[] }
  | { do: "past"; count: number }
  | { do: "drop" }
  | { do: "title"; id: string; title: string; songs: Song[] }
  | { do: "skip"; id: string; skipped: boolean; songs: Song[] }
  | { do: "keep"; id: string; songs: Song[] }
  | { do: "other"; id: string; songs: Song[] }
  | { do: "saved"; saved: { id: string; songId: number }[]; songs: Song[] }
  | { do: "songs"; songs: Song[] };

/** Every ready row judged again in pile order, after anything that can change a verdict or a duplicate. */
function judged(pile: Pile, songs: Song[]): Pile {
  const rows: ImportRow[] = [];
  for (const row of pile.rows) {
    const source = pile.sources[row.id];
    if (row.state.is !== "ready" || !source) {
      rows.push(row);
      continue;
    }
    const verdict = judge(row.state.draft, source, songs, rows);
    const found: Duplicate | undefined = source.sameAs ? { by: "file", name: source.sameAs } : verdict.duplicate;
    const reasons = source.sameAs && !verdict.reasons.includes("duplicate") ? [...verdict.reasons, "duplicate" as const] : verdict.reasons;
    const duplicate = found && source.kept ? { ...found, keep: true as const } : found;
    const { duplicate: _old, ...rest } = row.state;
    rows.push({ ...row, state: { ...rest, verdict: reasons.length === 0 ? "good" : "check", reasons, ...(duplicate ? { duplicate } : {}) } });
  }
  return { ...pile, rows };
}

const placed = (draft: Draft, other: Draft | undefined): Pick<ReadyState, "draft" | "other"> => (other ? { draft, other } : { draft });

/** The rows one file gave, in place of its waiting row. */
function readRows(pile: Pile, id: string, results: ReadResult[]): Pile {
  const sources = { ...pile.sources };
  const earlier = pile.rows.slice(0, Math.max(0, pile.rows.findIndex((row) => row.id === id)));
  const prints = new Map<string, string>();
  for (const row of earlier) if (sources[row.id]) prints.set(sources[row.id].print, row.name);
  const made = results.map((result, at): ImportRow => {
    const rowId = results.length === 1 ? id : `${id}.${at + 1}`;
    if ("why" in result) return { id: rowId, name: result.name, state: { is: "unread", why: result.why } };
    const draft = draftOf(result.extracted, result.name);
    if (!hasSheet(draft)) return { id: rowId, name: result.name, state: { is: "unread", why: "no-text" } };
    const other = result.extracted.other === undefined ? undefined : draftOf({ text: result.extracted.other, title: result.extracted.title }, result.name);
    const sameAs = prints.get(result.print);
    if (!sameAs) prints.set(result.print, result.name);
    sources[rowId] = { doubts: result.extracted.doubts, print: result.print, kept: false, ...(sameAs ? { sameAs } : {}) };
    return { id: rowId, name: result.name, state: { is: "ready", ...placed(draft, other), verdict: "good", reasons: [], skipped: sameAs !== undefined } };
  });
  return { ...pile, sources, rows: pile.rows.flatMap((row) => (row.id === id ? made : [row])) };
}

/** Changes the ready row `id` and judges the pile again. */
function onReady(pile: Pile, id: string, songs: Song[], change: (state: ReadyState) => ReadyState): Pile {
  return judged({ ...pile, rows: pile.rows.map((row) => (row.id === id && row.state.is === "ready" ? { ...row, state: change(row.state) } : row)) }, songs);
}

/**
 * The one place a row moves. A row is waiting, reading, ready, unread or saved, and nothing else moves it, so a row
 * cannot be both saved and waiting. A saved row keeps its song id, and nothing moves it again.
 */
export function pileReducer(pile: Pile, action: PileAction): Pile {
  switch (action.do) {
    case "pick":
      return { ...pile, rows: [...pile.rows, ...action.rows.map(({ id, name }): ImportRow => ({ id, name, state: { is: "waiting" } }))] };
    case "reading":
      return { ...pile, rows: pile.rows.map((row) => (row.id === action.id && row.state.is === "waiting" ? { ...row, state: { is: "reading" } } : row)) };
    case "read": {
      const row = pile.rows.find((each) => each.id === action.id);
      if (!row || (row.state.is !== "waiting" && row.state.is !== "reading")) return pile;
      return judged(readRows(pile, action.id, action.results), action.songs);
    }
    case "past":
      return { ...pile, past: pile.past + action.count };
    case "drop":
      return { ...pile, rows: pile.rows.filter((row) => row.state.is !== "waiting" && row.state.is !== "reading") };
    case "title":
      return onReady(pile, action.id, action.songs, (state) => ({ ...state, draft: { ...state.draft, title: action.title } }));
    case "skip":
      return onReady(pile, action.id, action.songs, (state) => ({ ...state, skipped: action.skipped }));
    case "keep": {
      const source = pile.sources[action.id];
      if (!source) return pile;
      return judged({ ...pile, sources: { ...pile.sources, [action.id]: { ...source, kept: true } } }, action.songs);
    }
    case "other":
      return onReady(pile, action.id, action.songs, (state) => (state.other ? { ...state, draft: { ...state.other, title: state.draft.title }, other: state.draft } : state));
    case "saved": {
      const ids = new Map(action.saved.map(({ id, songId }) => [id, songId]));
      const rows = pile.rows.map((row): ImportRow => (ids.has(row.id) && row.state.is === "ready" ? { ...row, state: { is: "saved", songId: ids.get(row.id)! } } : row));
      return judged({ ...pile, rows }, action.songs);
    }
    case "songs":
      return judged(pile, action.songs);
  }
}

/** A row Save writes: ready, not set aside, with a title, and not a duplicate unless the player chose Keep both. */
export const saveable = (row: ImportRow): row is ImportRow & { state: ReadyState } =>
  row.state.is === "ready" && !row.state.skipped && row.state.draft.title.trim() !== "" && (!row.state.duplicate || row.state.duplicate.keep === true);

/** Rows that hold a song not yet saved, which closing the sheet would lose. */
export const unsaved = (rows: ImportRow[]) => rows.filter((row) => row.state.is === "ready" && !row.state.skipped);

/** What is left after a Save, by kind, for the Done screen. */
export function leftOver(rows: ImportRow[]): { saved: number; untitled: number; unread: number; choosing: number; skipped: number } {
  const ready = rows.flatMap((row) => (row.state.is === "ready" ? [row.state] : []));
  return {
    saved: rows.filter((row) => row.state.is === "saved").length,
    untitled: ready.filter((state) => !state.skipped && !state.draft.title.trim()).length,
    unread: rows.filter((row) => row.state.is === "unread").length,
    choosing: ready.filter((state) => !state.skipped && state.draft.title.trim() && state.duplicate && !state.duplicate.keep).length,
    skipped: ready.filter((state) => state.skipped).length,
  };
}
