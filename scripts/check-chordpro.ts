import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { LibraryFile } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
const BASE = "61f18be";

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

type Codec = {
  songToChordPro(song: SongContent): string;
  chordProToSong(text: string): SongContent;
};

let codec: Codec | null = null;
let codecError = "";
if (existsSync(join(root, "src/chordpro.ts"))) {
  try {
    const codecBundle = await build({
      entryPoints: [join(root, "src/chordpro.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      logLevel: "silent",
    });
    codec = (await import(`data:text/javascript;base64,${Buffer.from(codecBundle.outputFiles[0].text).toString("base64")}`)) as Codec;
  } catch (error) {
    codecError = error instanceof Error ? error.message : String(error);
  }
} else {
  codecError = "src/chordpro.ts does not exist";
}

const needCodec = (id: string, fn: (c: Codec) => void) => {
  if (!codec) {
    check(false, `${id}: src/chordpro.ts unavailable (${codecError || "missing"})`);
    return;
  }
  try {
    fn(codec);
  } catch (error) {
    check(false, `${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const library = JSON.parse(read("data/library.json")) as LibraryFile;
const exportFile = JSON.parse(read("docs/handoff/lead-sheets-data-export.json")) as LibraryFile;
const allSongs = [...library.songs, ...exportFile.songs];
const plan = read("docs/PLAN-chordpro-backbone.md");

const FACTS = [
  "title",
  "artist",
  "keyLabel",
  "keyRoot",
  "keyMode",
  "keyNote",
  "tempo",
  "tempoNote",
  "timeSignature",
  "officialRuntimeSec",
  "feel",
  "sourceNote",
  "atAGlance",
  "howToPlay",
  "practiceTip",
] as const;

type LineShape = { chords?: string; lyrics?: string; bars?: string; note?: string };
type SectionShape = { heading: string; lines: LineShape[] };
const FIELDS = ["chords", "lyrics", "bars", "note"] as const;
const chartShape = (body: SectionShape[]) =>
  JSON.stringify(
    body.map((sec) => [
      sec.heading,
      sec.lines.map((line) => FIELDS.map((f) => (f === "bars" || f === "note" ? (line[f] ?? "") : (line[f]?.trimEnd() ?? "")))),
    ]),
  );

const factsEqual = (a: SongContent, b: SongContent) => {
  for (const field of FACTS) {
    if ((a[field] ?? null) !== (b[field] ?? null)) return `${field}: ${JSON.stringify(a[field])} !== ${JSON.stringify(b[field])}`;
  }
  return null;
};

const blank: SongContent = {
  title: "T",
  artist: "",
  keyLabel: "C major",
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

function sectionBlock(heading: string): string {
  const lines = plan.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  const level = heading.indexOf(" ");
  let fence = false;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    if (lines[end].startsWith("```")) fence = !fence;
    else if (!fence && /^#+ /.test(lines[end]) && lines[end].indexOf(" ") <= level) break;
  }
  return /```text\n([\s\S]*?)\n```/.exec(lines.slice(start + 1, end).join("\n"))?.[1] ?? "";
}

// C1: 31 real songs keep promises 1, 2, and 4
needCodec("C1", (c) => {
  const bad: string[] = [];
  for (const song of allSongs) {
    const text1 = c.songToChordPro(song);
    const back = c.chordProToSong(text1);
    const factDiff = factsEqual(song, back);
    if (factDiff) bad.push(`${song.title} facts (${factDiff})`);
    if (chartShape(song.body) !== chartShape(back.body)) bad.push(`${song.title} chart differs`);
    const text2 = c.songToChordPro(back);
    if (text2 !== text1) bad.push(`${song.title} second write differs`);
  }
  check(bad.length === 0, `C1: all ${allSongs.length} songs of library and export keep promises 1, 2 and 4${bad.length ? ` (${bad.slice(0, 3).join("; ")})` : ""}`);
});

// C2: Worker's real printOf gives same print before and after
await (async () => {
  if (!codec) {
    check(false, `C2: src/chordpro.ts unavailable (${codecError || "missing"})`);
    return;
  }
  try {
    const bundled = await build({
      entryPoints: [join(root, "worker/room-library.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:*"],
      loader: { ".json": "json" },
      logLevel: "silent",
    });
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)) as {
      printOf(song: SongContent): Promise<string>;
    };
    const bad: string[] = [];
    for (const song of allSongs) {
      const before = await mod.printOf(song);
      const after = await mod.printOf(codec.chordProToSong(codec.songToChordPro(song)));
      if (before !== after) bad.push(song.title);
    }
    check(bad.length === 0, `C2: Worker printOf matches before and after across all ${allSongs.length} songs${bad.length ? ` (${bad.join(", ")})` : ""}`);
  } catch (error) {
    check(false, `C2: ${error instanceof Error ? error.message : String(error)}`);
  }
})();

// C3: Chord inside a word, past end of words, and leading spaces keep column
needCodec("C3", (c) => {
  const lines: LineShape[] = [
    { chords: "D      A", lyrics: "Fold another one" },
    { chords: "D      A                  E", lyrics: "Fold another one for me" },
    { chords: "            C                                  F         C", lyrics: "Walking down the same old road for miles and miles" },
  ];
  const song: SongContent = { ...blank, body: [{ heading: "VERSE 1", lines }] };
  const back = c.chordProToSong(c.songToChordPro(song));
  const got = back.body[0]?.lines ?? [];
  const ok =
    got.length === lines.length &&
    lines.every((line, i) => got[i].chords === line.chords && got[i].lyrics === line.lyrics);
  check(ok, `C3: chord inside word, past end of words, and leading-space chord row keep exact columns`);
});

// C4: Worked example written as shown and reads back as described
needCodec("C4", (c) => {
  const worked = sectionBlock("### A worked example");
  const song = c.chordProToSong(worked);
  const rewritten = c.songToChordPro(song);
  const ok =
    worked !== "" &&
    rewritten === worked &&
    song.title === "Paper Boats" &&
    song.body.length === 3 &&
    song.body[0].heading === "INTRO (band in)" &&
    song.body[0].lines.length === 1 &&
    song.body[0].lines[0].bars === "| A | D | A | E |" &&
    song.body[0].lines[0].note === "Let the last bar ring." &&
    song.body[1].heading === "VERSE 1" &&
    song.body[1].lines.length === 3 &&
    song.body[1].lines[2].chords === undefined &&
    song.body[1].lines[2].lyrics === "(spoken) [wait] one more" &&
    song.body[2].heading === "CHORUS — sing it twice" &&
    song.body[2].lines.length === 3 &&
    song.body[2].lines[0].chords?.includes("x2") === true &&
    song.body[2].lines[1].note === "Stop on the last word." &&
    song.body[2].lines[2].bars === "| D | A |";
  check(ok, "C4: worked example is written byte-for-byte and reads back as described");
});

const examples = sectionBlock("### Every mix of the four fields, written").split("\n----\n").filter(Boolean);
const FACTS_PREFIX = "{title: T}\n{key: C}\n";

// C5: Every mix of the four line fields, 16 in all
needCodec("C5", (c) => {
  const lineExamples = examples.filter((ex) => ex.startsWith("line "));
  const seen = new Set<string>();
  const wrong: string[] = [];
  for (const example of lineExamples) {
    const [first, ...rest] = example.split("\n");
    const line = JSON.parse(first.slice(first.indexOf(" ") + 1)) as LineShape;
    seen.add(FIELDS.filter((f) => line[f] !== undefined).join("+") || "no field");
    const made: SectionShape = { heading: "VERSE 1", lines: [line] };
    const want = rest.join("\n");
    const got = c.songToChordPro({ ...blank, body: [made] }).slice(FACTS_PREFIX.length);
    if (got !== want) wrong.push(`${first} wrote:\n${got}\nwant:\n${want}`);
    else if (chartShape(c.chordProToSong(FACTS_PREFIX + want).body) !== chartShape([made])) wrong.push(`${first} read back wrong`);
  }
  check(seen.size === 16 && wrong.length === 0, `C5: all 16 mixes of the four line fields match plan bytes and read back${wrong.length ? ` (${wrong[0]})` : ""}`);
});

// C6: Section examples: mixed bars+sung, empty lines, empty heading
needCodec("C6", (c) => {
  const secExamples = examples.filter((ex) => ex.startsWith("section "));
  const wrong: string[] = [];
  const parsed: SectionShape[] = [];
  for (const example of secExamples) {
    const [first, ...rest] = example.split("\n");
    const sec = JSON.parse(first.slice(first.indexOf(" ") + 1)) as SectionShape;
    const want = rest.join("\n");
    const got = c.songToChordPro({ ...blank, body: [sec] }).slice(FACTS_PREFIX.length);
    if (got !== want) wrong.push(`${first} wrote:\n${got}\nwant:\n${want}`);
    const back = c.chordProToSong(FACTS_PREFIX + want).body;
    if (chartShape(back) !== chartShape([sec])) wrong.push(`${first} read back wrong`);
    parsed.push(...back);
  }
  const hasMixed = parsed.some((s) => s.lines.length === 3 && s.lines[0].bars !== undefined && s.lines[1].chords !== undefined && s.lines[2].bars !== undefined);
  const hasEmptyLines = parsed.some((s) => s.lines.length === 0);
  const hasEmptyHeading = parsed.some((s) => s.heading === "" && s.lines.length > 0);
  check(secExamples.length > 0 && wrong.length === 0 && hasMixed && hasEmptyLines && hasEmptyHeading, `C6: section examples match plan bytes and preserve mixed, empty-lines, and empty-heading sections${wrong.length ? ` (${wrong[0]})` : ""}`);
});

// C7: Non-chord tokens written with * only when isChord refuses them, read back in place
needCodec("C7", (c) => {
  const line: LineShape = { chords: "A     x2    N.C.   (hold)", lyrics: "one   two   three  four" };
  const text = c.songToChordPro({ ...blank, body: [{ heading: "VERSE 1", lines: [line] }] });
  const back = c.chordProToSong(text).body[0]?.lines[0];
  const ok =
    text.includes("[A]") &&
    !text.includes("[*A]") &&
    text.includes("[*x2]") &&
    text.includes("[N.C.]") &&
    !text.includes("[*N.C.]") &&
    text.includes("[*(hold)]") &&
    back?.chords === line.chords &&
    back?.lyrics === line.lyrics;
  check(ok, "C7: non-chord tokens are starred only when isChord refuses them and read back in place");
});

// C8: Every character in the escaping table comes back in every field that can hold it
needCodec("C8", (c) => {
  const prose = "a\\b\nc\rd } [#]{";
  const song: SongContent = {
    title: prose,
    artist: prose,
    keyLabel: `A ${prose}`,
    keyRoot: "A",
    keyMode: "major",
    keyNote: prose,
    tempo: 100,
    tempoNote: prose,
    timeSignature: prose,
    officialRuntimeSec: 90,
    feel: prose,
    sourceNote: prose,
    atAGlance: prose,
    howToPlay: prose,
    practiceTip: prose,
    body: [
      {
        heading: `VERSE "1" ${prose}`,
        lines: [
          { chords: "A  [x]  a\\b\nc\rd", lyrics: "{hello [world] a\\b\nc\rd" },
          { chords: "{x", lyrics: "#hash [a]" },
          { bars: "{| A | \\ \n \r |}" },
          { bars: "#| B |", note: prose },
        ],
      },
    ],
  };
  const back = c.chordProToSong(c.songToChordPro(song));
  const diff = factsEqual(song, back);
  const ok = diff === null && chartShape(song.body) === chartShape(back.body);
  check(ok, `C8: every character in escaping table round-trips in every field${diff ? ` (${diff})` : ""}`);
});

// C9: Each fact alone
needCodec("C9", (c) => {
  const cases: [string, Partial<SongContent>, string][] = [
    ["minor key", { keyRoot: "F#", keyMode: "minor", keyLabel: "F# minor" }, "{key: F#m}"],
    ["custom keyLabel", { keyRoot: "A", keyMode: "major", keyLabel: "A (capo 2)" }, "{x_key_label: A (capo 2)}"],
    ["fractional tempo", { tempo: 98.5 }, "{tempo: 98.5}"],
    ["time signature with words", { timeSignature: "3/4 — waltz, count 1-2-3" }, "{x_time: 3/4 — waltz, count 1-2-3}"],
    ["duration 59s", { officialRuntimeSec: 59 }, "{duration: 0:59}"],
    ["duration 60s", { officialRuntimeSec: 60 }, "{duration: 1:00}"],
    ["duration 3601s", { officialRuntimeSec: 3601 }, "{duration: 60:01}"],
    ["fractional duration", { officialRuntimeSec: 123.5 }, "{duration: 123.5}"],
  ];
  const bad: string[] = [];
  for (const [label, patch, directive] of cases) {
    const input: SongContent = { ...blank, ...patch };
    const text = c.songToChordPro(input);
    const back = c.chordProToSong(text);
    const diff = factsEqual(input, back);
    if (!text.includes(directive) || diff) bad.push(`${label}${diff ? `: ${diff}` : " missing directive"}`);
  }
  check(bad.length === 0, `C9: each fact alone round-trips with expected directive${bad.length ? ` (${bad.join("; ")})` : ""}`);
});

// C10: Kept lines survive edits; invalid kept entries are not written
needCodec("C10", (c) => {
  const song: SongContent & { kept?: string[] } = {
    ...blank,
    kept: ["{x_capo_view: shapes}", "{x_extra: a } b}", "{x_bad: a\nb}", "{title: x}", '{start_of_verse: label="V"}', "{end_of_verse}", "not a directive"],
  };
  const text1 = c.songToChordPro(song);
  const back1 = c.chordProToSong(text1) as SongContent & { kept?: string[] };
  const edited: SongContent & { kept?: string[] } = { ...back1, title: "Edited", tempo: 112 };
  const back2 = c.chordProToSong(c.songToChordPro(edited)) as SongContent & { kept?: string[] };
  const ok =
    text1.includes("{x_capo_view: shapes}") &&
    text1.includes("{x_extra: a } b}") &&
    !text1.includes("{x_bad") &&
    !text1.includes("{title: x}") &&
    !text1.includes("start_of_verse") &&
    !text1.includes("end_of_verse") &&
    !text1.includes("not a directive") &&
    JSON.stringify(back2.kept) === JSON.stringify(["{x_capo_view: shapes}", "{x_extra: a } b}"]);
  check(ok, "C10: kept lines ride along through edits and invalid kept entries are omitted");
});

// C11: 2,000 seeded made-up songs built with Math.imul keep promises 1, 2 and 4
needCodec("C11", (c) => {
  let state = 0x51a7b3c9;
  const nextInt = (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * max);
  };
  const pick = <T,>(items: readonly T[]) => items[nextInt(items.length)];
  const ROOTS = ["C", "C#", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
  const MODES = ["major", "minor"] as const;
  const CHARS = ["a", "b", " ", "\\", "\n", "\r", "[", "]", "{", "}", "#", '"', "\t", "1", "C"];
  const TOKEN_CHARS = ["A", "m", "7", "x", "\\", "\n", "\r", "[", "]", "{", "}", "#", "*", "\t"];
  const makeStr = (len: number, pool: readonly string[], trimTail = false) => {
    let out = "";
    for (let i = 0; i < len; i += 1) out += pick(pool);
    return trimTail ? out.trimEnd() : out;
  };
  const makeChords = () => {
    const count = nextInt(4);
    let out = " ".repeat(nextInt(4));
    for (let i = 0; i < count; i += 1) {
      if (i > 0) out += " ".repeat(1 + nextInt(4));
      out += makeStr(1 + nextInt(5), TOKEN_CHARS);
    }
    return out;
  };
  const bad: string[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const keyRoot = pick(ROOTS);
    const keyMode = pick(MODES);
    const timePick = nextInt(3);
    const timeSignature = timePick === 0 ? "" : timePick === 1 ? `${1 + nextInt(12)}/${1 + nextInt(8)}` : makeStr(nextInt(14), CHARS);
    const body: SectionShape[] = Array.from({ length: nextInt(4) }, () => ({
      heading: makeStr(nextInt(12), CHARS),
      lines: Array.from({ length: nextInt(4) }, () => {
        const line: LineShape = {};
        if (nextInt(2)) line.chords = makeChords();
        if (nextInt(2)) line.lyrics = makeStr(nextInt(16), CHARS, true);
        if (nextInt(3) === 0) line.bars = makeStr(nextInt(14), CHARS);
        if (nextInt(3) === 0) line.note = makeStr(nextInt(14), CHARS);
        return line;
      }),
    }));
    const song: SongContent = {
      title: makeStr(nextInt(14), CHARS),
      artist: makeStr(nextInt(14), CHARS),
      keyRoot,
      keyMode,
      keyLabel: nextInt(2) ? `${keyRoot} ${keyMode}` : makeStr(nextInt(14), CHARS),
      keyNote: makeStr(nextInt(14), CHARS),
      tempo: nextInt(3) === 0 ? null : nextInt(240) + (nextInt(2) ? 0.5 : 0),
      tempoNote: makeStr(nextInt(14), CHARS),
      timeSignature,
      officialRuntimeSec: nextInt(3) === 0 ? null : nextInt(4000) + (nextInt(2) ? 0.25 : 0),
      feel: makeStr(nextInt(14), CHARS),
      sourceNote: makeStr(nextInt(14), CHARS),
      atAGlance: makeStr(nextInt(14), CHARS),
      howToPlay: makeStr(nextInt(14), CHARS),
      practiceTip: makeStr(nextInt(14), CHARS),
      body,
    };
    const t1 = c.songToChordPro(song);
    const back = c.chordProToSong(t1);
    const diff = factsEqual(song, back);
    if (diff || chartShape(song.body) !== chartShape(back.body) || c.songToChordPro(back) !== t1) {
      bad.push(`seed #${i}${diff ? ` (${diff})` : ""}`);
      if (bad.length >= 3) break;
    }
  }
  check(bad.length === 0, `C11: 2,000 seeded made-up songs keep promises 1, 2 and 4${bad.length ? ` (${bad.join("; ")})` : ""}`);
});

// C12: Reader never throws on empty, single bracket, or every prefix of worked example
needCodec("C12", (c) => {
  const worked = sectionBlock("### A worked example");
  const inputs = ["", "[", "]", "{", "\\"];
  for (let i = 0; i <= worked.length; i += 1) inputs.push(worked.slice(0, i));
  let ok = true;
  for (const input of inputs) {
    const out = c.chordProToSong(input);
    if (!out || typeof out !== "object" || !Array.isArray(out.body)) {
      ok = false;
      break;
    }
  }
  check(ok, `C12: reader never throws across ${inputs.length} broken/truncated inputs`);
});

// C13: src/chordpro.ts imports only src/types.ts and src/song-text.ts and names no DOM/storage globals
(() => {
  const path = join(root, "src/chordpro.ts");
  if (!existsSync(path)) {
    check(false, "C13: src/chordpro.ts does not exist");
    return;
  }
  const source = read("src/chordpro.ts");
  const imports = [...source.matchAll(/^\s*import\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const allowed = new Set(["./types", "./types.ts", "./song-text", "./song-text.ts"]);
  const badImports = imports.filter((spec) => !allowed.has(spec));
  const globals = source.match(/\b(?:document|window|localStorage)\b/);
  check(badImports.length === 0 && !globals, `C13: src/chordpro.ts imports only types/song-text and names no DOM/storage globals${badImports.length ? ` (imports: ${badImports.join(", ")})` : ""}${globals ? ` (names ${globals[0]})` : ""}`);
})();

// C14: Size totals for built-in library and export, and text is smaller than JSON
needCodec("C14", (c) => {
  const totals = (songs: LibraryFile["songs"]) => {
    let jsonChars = 0;
    let jsonBytes = 0;
    let wrappedChars = 0;
    let wrappedBytes = 0;
    let textChars = 0;
    for (const song of songs) {
      const js = JSON.stringify(song);
      const cp = c.songToChordPro(song);
      const wrapped = JSON.stringify({ id: song.id, chordpro: cp });
      jsonChars += js.length;
      jsonBytes += Buffer.byteLength(js);
      wrappedChars += wrapped.length;
      wrappedBytes += Buffer.byteLength(wrapped);
      textChars += cp.length;
    }
    return { jsonChars, jsonBytes, wrappedChars, wrappedBytes, textChars };
  };
  const lib = totals(library.songs);
  const exp = totals(exportFile.songs);
  console.log(
    `C14 sizes — library (${library.songs.length}): JSON ${lib.jsonChars} chars (${lib.jsonBytes} B), {id,chordpro} ${lib.wrappedChars} chars (${lib.wrappedBytes} B), text ${lib.textChars} chars | export (${exportFile.songs.length}): JSON ${exp.jsonChars} chars (${exp.jsonBytes} B), {id,chordpro} ${exp.wrappedChars} chars (${exp.wrappedBytes} B), text ${exp.textChars} chars`,
  );
  check(
    lib.wrappedChars < lib.jsonChars && exp.wrappedChars < exp.jsonChars && lib.textChars < lib.jsonChars && exp.textChars < exp.jsonChars,
    "C14: ChordPro text and {id, chordpro} totals are smaller than JSON for both library and export",
  );
});

// N11 & N12: Old build (61f18be) compatibility guards
{
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  });

  const tree = mkdtempSync(join(tmpdir(), "check-chordpro-old-"));
  try {
    const tar = execFileSync("git", ["archive", "--format=tar", BASE, "src", "data"], { cwd: root, maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", tree], { input: tar });
    appendFileSync(join(tree, "src/storage.ts"), "\nexport { isSong };\n");

    const oldBundle = await build({
      entryPoints: [join(tree, "src/storage.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      loader: { ".json": "json" },
      logLevel: "silent",
    });
    const oldBuild = (await import(`data:text/javascript;base64,${Buffer.from(oldBundle.outputFiles[0].text).toString("base64")}`)) as typeof import("../src/storage.ts") & {
      isSong(v: unknown): boolean;
    };

    const curBundle = await build({
      stdin: {
        contents: `export * from "./src/storage.ts"; export { ownSong } from "./src/song-text.ts"; export { content } from "./src/band-library.tsx";`,
        resolveDir: root,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      loader: { ".css": "empty", ".json": "json" },
      logLevel: "silent",
    });
    const curBuild = (await import(`data:text/javascript;base64,${Buffer.from(curBundle.outputFiles[0].text).toString("base64")}`)) as typeof import("../src/storage.ts") & {
      ownSong: typeof import("../src/song-text.ts").ownSong;
      content: typeof import("../src/band-library.tsx").content;
    };

    // N11
    store.clear();
    const fresh = curBuild.loadLibrary();
    const addedId = curBuild.addOwnSong(
      curBuild.ownSong(
        { title: "Paper Boats", artist: "The Made Up Band", keyRoot: "A", keyMode: "major", tempo: 112, timeSignature: "4/4" },
        [{ heading: "VERSE 1", lines: [{ chords: "A", lyrics: "la la" }] }],
      ),
    );
    const first = fresh.songs[0];
    const { ref: _r1, id: editId, ...editRest } = first;
    curBuild.replaceOwnSong(editId, { ...editRest, title: `${editRest.title} (edited)` });
    const bandAddedId = curBuild.addOwnSong({ ...curBuild.content(first), title: "Band Copy", copy: { id: "copy_1", canSendOn: true } });
    const storedAfter = JSON.parse(store.get("leadSheetsLibrary") ?? "null") as { songs: Array<{ id: number }> } | null;
    const savedNew = storedAfter?.songs.find((s) => s.id === addedId);
    const savedEdited = storedAfter?.songs.find((s) => s.id === editId);
    const savedBand = storedAfter?.songs.find((s) => s.id === bandAddedId);
    const sentSeed = { ...curBuild.content(first), id: first.id };
    const n11Results = [
      ["new song", oldBuild.isSong(savedNew)],
      ["edited built-in", oldBuild.isSong(savedEdited)],
      ["band-added song", oldBuild.isSong(savedBand)],
      ["sent built-in", oldBuild.isSong(sentSeed)],
    ] as const;
    const n11Bad = n11Results.filter(([, ok]) => !ok).map(([label]) => label);
    check(n11Bad.length === 0, `N11 (guard): saved new, edited built-in, band-added, and sent built-in songs pass isSong of ${BASE}${n11Bad.length ? ` (failed: ${n11Bad.join(", ")})` : ""}`);

    // N12
    store.clear();
    oldBuild.loadLibrary();
    curBuild.loadLibrary();
    const uneditedOwn = curBuild.ownLibraryItems(store.get("leadSheetsLibrary"));

    store.clear();
    const oldLib = oldBuild.loadLibrary();
    const target = oldLib.songs[0];
    const { ref: _r2, id: tid, ...trest } = target;
    oldBuild.replaceOwnSong(tid, { ...trest, title: "Old Build Edit" });
    const beforeSongBytes = JSON.stringify((JSON.parse(store.get("leadSheetsLibrary")!) as { songs: Array<{ id: number }> }).songs.find((s) => s.id === tid));
    const beforeEntry = oldBuild.ownLibraryItems(store.get("leadSheetsLibrary")).get(`leadSheetsSong.${tid}`);
    curBuild.loadLibrary();
    const afterSongBytes = JSON.stringify((JSON.parse(store.get("leadSheetsLibrary")!) as { songs: Array<{ id: number }> }).songs.find((s) => s.id === tid));
    const afterOwn = curBuild.ownLibraryItems(store.get("leadSheetsLibrary"));
    const n12Ok = uneditedOwn.size === 0 && afterOwn.size === 1 && afterSongBytes === beforeSongBytes && afterOwn.get(`leadSheetsSong.${tid}`) === beforeEntry;
    check(n12Ok, `N12 (guard): unedited ${BASE} library has 0 own songs in this build, and an edited built-in song keeps its exact bytes`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
