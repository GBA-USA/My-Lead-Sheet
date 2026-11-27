import { isChord } from "./song-text";
import type { ChartLine, ChartSection, Song } from "./types";

/** A song as it travels and rests: the chart and its facts, without this phone's `ref`, `id` and `copy`. */
export type SongContent = Omit<Song, "ref" | "id" | "copy">;
/** A song on its way to or from the Worker. Cook 1 exports the type and uses it nowhere. */
export type SentSong = { chordpro: string };

/** Strips a leading UTF-8 BOM and turns CRLF or lone CR line breaks into plain `\n`. */
export function normalizeChordPro(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

type TextFact = "keyNote" | "tempoNote" | "feel" | "sourceNote" | "atAGlance" | "howToPlay" | "practiceTip";
const NOTE_FACTS: [string, TextFact][] = [
  ["x_feel", "feel"],
  ["x_source_note", "sourceNote"],
  ["x_at_a_glance", "atAGlance"],
  ["x_how_to_play", "howToPlay"],
  ["x_practice_tip", "practiceTip"],
];
const TEXT_FACTS = new Map<string, TextFact>([
  ["x_key_note", "keyNote"],
  ["x_tempo_note", "tempoNote"],
  ...NOTE_FACTS,
]);
const KNOWN = new Set(["title", "artist", "key", "x_key_label", "tempo", "time", "x_time", "duration", "x_join", ...TEXT_FACTS.keys()]);
const DIRECTIVE = /^\{([a-z_0-9]+)(?:: (.*))?\}$/s;

const escaped = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const unescapedChar = (char: string) => (char === "n" ? "\n" : char === "r" ? "\r" : char);
const unescaped = (text: string) => text.replace(/\\(.)/gs, (_, char: string) => unescapedChar(char));
const lineStart = (text: string) => text.replace(/^[{#]/, "\\$&");
const brackets = (text: string) => escaped(text).replace(/[[\]]/g, "\\$&");

const kindOf = (heading: string) => /^\s*(verse|chorus|bridge)\b/i.exec(heading)?.[1].toLowerCase() ?? "part";
const duration = (seconds: number) =>
  Number.isInteger(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : String(seconds);
const isSung = (line: ChartLine) => line.chords !== undefined || line.lyrics !== undefined;
const isBarsAlone = (line: ChartLine) => line.bars !== undefined && !isSung(line);
const isNoteAlone = (line: ChartLine) => line.note !== undefined && line.bars === undefined && !isSung(line);

/** A chord row over its words as one text line: each token of the row in brackets at its own column. */
function sungLine(chords = "", lyrics = ""): string {
  const words = lyrics.trimEnd();
  let out = "";
  let cursor = 0;
  for (const token of chords.matchAll(/[^ ]+/g)) {
    out += brackets(words.slice(cursor, token.index).padEnd(token.index - cursor));
    out += `[${isChord(token[0]) ? "" : "*"}${brackets(token[0])}]`;
    cursor = token.index;
  }
  return lineStart(out + brackets(words.slice(Math.min(cursor, words.length))));
}

/** Whether the reader would keep this entry again: one line, a whole directive, a name it does not know. */
function keepable(entry: string): boolean {
  const name = /[\r\n]/.test(entry) ? undefined : DIRECTIVE.exec(entry)?.[1];
  return name !== undefined && !KNOWN.has(name) && !/^(start|end)_of_/.test(name);
}

/** Writes any song as deterministic ChordPro text. */
export function songToChordPro(song: SongContent): string {
  const out: string[] = [];
  const put = (name: string, value: string) => out.push(`{${name}: ${escaped(value)}}`);
  put("title", song.title);
  if (song.artist) put("artist", song.artist);
  put("key", `${song.keyRoot}${song.keyMode === "minor" ? "m" : ""}`);
  if (song.keyLabel !== `${song.keyRoot} ${song.keyMode}`) put("x_key_label", song.keyLabel);
  if (song.keyNote) put("x_key_note", song.keyNote);
  if (song.tempo != null) put("tempo", String(song.tempo));
  if (song.tempoNote) put("x_tempo_note", song.tempoNote);
  const bare = /^\d{1,2}\/\d{1,2}/.exec(song.timeSignature)?.[0];
  if (bare) put("time", bare);
  if (song.timeSignature !== (bare ?? "")) put("x_time", song.timeSignature);
  if (song.officialRuntimeSec != null) put("duration", duration(song.officialRuntimeSec));
  for (const [name, field] of NOTE_FACTS) if (song[field]) put(name, song[field]);
  out.push(...(song.kept ?? []).filter(keepable));

  for (const section of song.body) {
    const sung = kindOf(section.heading);
    let open: string | null = null;
    let labelled = false;
    const start = (kind: string) => {
      if (open === kind) return;
      if (open) out.push(`{end_of_${open}}`);
      out.push(labelled ? `{start_of_${kind}}` : `{start_of_${kind}: label="${escaped(section.heading).replace(/"/g, '\\"')}"}`);
      labelled = true;
      open = kind;
    };
    section.lines.forEach((line, index) => {
      let parts = 0;
      const part = (text: string) => {
        if (parts > 0) out.push("{x_join}");
        parts += 1;
        out.push(text);
      };
      if (isSung(line) || (line.bars === undefined && line.note === undefined)) {
        start(sung);
        part(sungLine(line.chords, line.lyrics));
      }
      if (line.bars !== undefined) {
        start("grid");
        part(lineStart(escaped(line.bars)));
      }
      if (line.note !== undefined) {
        if (!open) {
          const next = section.lines.slice(index).find((each) => !isNoteAlone(each));
          start(next && isBarsAlone(next) ? "grid" : sung);
        }
        part(`{comment: ${escaped(line.note)}}`);
      }
    });
    if (!open) start(sung);
    out.push(`{end_of_${open}}`);
  }
  return out.join("\n");
}

function readSungLine(text: string): ChartLine {
  let lyrics = "";
  let chords = "";
  let anyChord = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\" && i + 1 < text.length) {
      lyrics += unescapedChar(text[i + 1]);
      i += 2;
    } else if (text[i] === "[") {
      let token = "";
      let j = i + 1;
      while (j < text.length && text[j] !== "]") {
        const pair = text[j] === "\\" && j + 1 < text.length;
        token += pair ? unescapedChar(text[j + 1]) : text[j];
        j += pair ? 2 : 1;
      }
      chords = chords.padEnd(lyrics.length) + (token.startsWith("*") ? token.slice(1) : token);
      anyChord = true;
      i = j + 1;
    } else {
      lyrics += text[i];
      i += 1;
    }
  }
  lyrics = lyrics.trimEnd();
  return { ...(anyChord ? { chords } : {}), ...(lyrics !== "" || !anyChord ? { lyrics } : {}) };
}

/** Reads ChordPro text written by `songToChordPro` back into a `SongContent`. Never throws. */
export function chordProToSong(text: string): SongContent {
  const song: SongContent = {
    title: "",
    artist: "",
    keyLabel: "",
    keyRoot: "C",
    keyMode: "major",
    keyNote: "",
    tempo: null,
    tempoNote: "",
    timeSignature: "",
    officialRuntimeSec: null,
    feel: "",
    sourceNote: "",
    atAGlance: "",
    howToPlay: "",
    practiceTip: "",
    body: [],
  };
  const kept: string[] = [];
  let section: ChartSection | null = null;
  let inSection = false;
  let grid = false;
  let join = false;
  let time: string | undefined;
  let xTime: string | undefined;
  let keyLabel: string | undefined;
  const add = (fields: ChartLine) => {
    const last = section!.lines[section!.lines.length - 1];
    if (join && last) Object.assign(last, fields);
    else section!.lines.push(fields);
    join = false;
  };
  const number = (value: string) => (value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

  for (const raw of text.split("\n")) {
    const directive = DIRECTIVE.exec(raw);
    if (!directive) {
      if (inSection && !raw.startsWith("#")) add(grid ? { bars: unescaped(raw) } : readSungLine(raw));
      continue;
    }
    const [, name, rest = ""] = directive;
    const value = unescaped(rest);
    const fact = TEXT_FACTS.get(name);
    if (name.startsWith("start_of_")) {
      const label = /^label="((?:[^"\\]|\\.)*)"$/s.exec(rest);
      if (label || !section) {
        section = { heading: label ? unescaped(label[1]) : "", lines: [] };
        song.body.push(section);
      }
      grid = name === "start_of_grid";
      inSection = true;
    } else if (name.startsWith("end_of_")) inSection = false;
    else if (name === "x_join") join = true;
    else if (name === "comment" && inSection) add({ note: value });
    else if (name === "title") song.title = value;
    else if (name === "artist") song.artist = value;
    else if (name === "key") {
      const key = /^([A-G][#b]?)(m?)$/.exec(value);
      if (key) [song.keyRoot, song.keyMode] = [key[1], key[2] ? "minor" : "major"];
    } else if (name === "tempo") song.tempo = number(value);
    else if (name === "time") time = value;
    else if (name === "x_time") xTime = value;
    else if (name === "duration") {
      const clock = /^(\d+):(\d\d)$/.exec(value);
      song.officialRuntimeSec = clock ? Number(clock[1]) * 60 + Number(clock[2]) : number(value);
    } else if (name === "x_key_label") keyLabel = value;
    else if (fact) song[fact] = value;
    else if (!section) kept.push(raw);
  }
  song.keyLabel = keyLabel ?? `${song.keyRoot} ${song.keyMode}`;
  song.timeSignature = xTime ?? time ?? "";
  if (kept.length > 0) song.kept = kept;
  return song;
}
