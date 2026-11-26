import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { newSalt } from "../src/password.ts";
import { appPage } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Import files: a pile of text files and documents becomes a review list, one row a file, and one tap saves every
 * good row to My Songs. Cases are U1 to U13 of section 1, X1 to X13 of section 2 and B1 to B14 of section 4 of
 * docs/PLAN-bulk-import.md, each one named line.
 *
 * The pure half (`src/song-import.ts`, `src/import-read.ts`, `addOwnSongs` in `src/storage.ts`) runs in node. Cases
 * that need `DOMParser` or the canvas run the readers in headless Chrome (`CHROME`). Screen cases build the app and
 * hand files to the picker with the browser's own file-input command, signed in against a stub `/api/me`, with no
 * Worker. The check builds its own `.docx` and `.zip` with `node:zlib`. Every chart here is written for this check,
 * with made-up words.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const bytesOf = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The made-up charts, and the files the check builds from them.

/** A chord page as a site prints it: a title line, a by line, Key and BPM, then the chart in columns. */
const HARBOR = `Harbor Bells Chords
by The Made Up Band
Key: D
BPM 104

[Verse 1]
D            G
Bells are ringing on the water
A               D
Gulls are circling round the pier

[Chorus]
G        A
Ring out over
D          G
Ring along home
`;
/** The column rows of HARBOR, as typed. */
const HARBOR_ROWS: Row[] = [
  { chords: "D            G", lyrics: "Bells are ringing on the water" },
  { chords: "A               D", lyrics: "Gulls are circling round the pier" },
  { chords: "G        A", lyrics: "Ring out over" },
  { chords: "D          G", lyrics: "Ring along home" },
];

const LANTERNS = `{title: Paper Lanterns}
{artist: The Made Up Band}
{key: G}
{tempo: 96}

{start_of_verse: Verse 1}
[G]Lanterns drift a[C]bove the harbor
[D]Folding paper [G]into light
{end_of_verse}

{start_of_chorus}
[Em]Hold the [C]string
[D]Let it [G]climb
{end_of_chorus}
`;

const chartOf = (title: string, artist = "The Made Up Band", key = "A") => `${title} Chords
by ${artist}
Key: ${key}

[Verse 1]
${key}           E
Pebbles tumble down the ${title.split(" ")[0].toLowerCase()}
D            ${key}
Over moss and over stone

[Chorus]
E        D
Tumble along
`;

const MOSS = `<!doctype html><html><head><title>Moss Garden</title><style>pre { color: red }</style><script>window.zorbleScript = 1</script></head>
<body><nav><a href="#">Home</a> <a href="#">Top charts</a> <a href="#">Zorble menu</a></nav>
<pre>Moss Garden Chords
by The Made Up Band
Key: E

[Verse 1]
E          A
Moss along the garden wall
B            E
Softly growing green and small
</pre>
<footer>Zorble footer line</footer></body></html>`;

/** An RTF set in Courier New (`\fmodern`), so its columns are its places. */
const rtfOf = (lines: string[], font = "\\fmodern Courier New") => `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0${font};}}{\\colortbl;\\red0\\green0\\blue0;}\\f0\\fs24 ${lines.map((line) => line.replace(/\\/g, "\\\\")).join("\\par\n")}\\par}`;
const QUARRY = ["Quarry Song Chords", "by The Made Up Band", "Key: C", "", "[Verse 1]", "C          F", "Chisel ringing in the quarry", "G             C", "Dust is rising on the hill"];

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A Word paragraph: its runs, each a text with tabs and breaks, in `font`. */
const paragraph = (text: string, font: string) => {
  const run = (part: string) =>
    part
      .split("\t")
      .map((piece) => `<w:t xml:space="preserve">${xmlEscape(piece)}</w:t>`)
      .join("<w:tab/>");
  return `<w:p><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>${text.split("\n").map(run).join("<w:br/>")}</w:r></w:p>`;
};
const documentXml = (lines: string[], font: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document><w:body>${lines.map((line) => paragraph(line, font)).join("")}<w:sectPr/></w:body></w:document>`;

// A zip writer: stored or deflated entries, with the CRC-32 and the directory at the end.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
type ZipFile = { name: string; data: Uint8Array | string; deflate?: boolean; claim?: number };
function zip(files: ZipFile[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = typeof file.data === "string" ? Buffer.from(file.data) : Buffer.from(file.data);
    const body = file.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name);
    const crc = crc32(raw);
    const size = file.claim ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
/** A Word file, with its document deflated as Word does. */
const docx = (xml: string | null, extra: ZipFile[] = []) =>
  zip([{ name: "[Content_Types].xml", data: CONTENT_TYPES }, ...(xml === null ? [] : [{ name: "word/document.xml", data: xml, deflate: true }]), ...extra]);
const WILLOW = ["Willow Creek Chords", "by The Made Up Band", "Key: G", "", "[Verse 1]", "G           C", "Willow branches on the creek", "D            G", "Bending low and running deep"];
const OLD_WORD = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(500).fill(0)]);
/** Bytes no reader knows, with zero bytes in them, from a fixed seed. */
const noise = (length: number, seed = 7) => {
  const out = new Uint8Array(length);
  for (let i = 0, x = seed; i < length; i += 1) out[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24;
  out[3] = 0;
  return out;
};
const PDF = bytesOf("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

// ---------------------------------------------------------------------------------------------------------------
// The pure modules, bundled for node. A module that is missing fails every case that needs it, not the run.

type Draft = { title: string; artist: string; keyRoot: string; keyMode: string; bpm: string; timeSignature: string; chart: string; keyNote: string };
type RowState =
  | { is: "waiting" }
  | { is: "reading" }
  | { is: "ready"; draft: Draft; other?: Draft; verdict: "good" | "check"; reasons: string[]; duplicate?: { by: string; keep?: true; canReplace?: boolean }; skipped: boolean }
  | { is: "unread"; why: string }
  | { is: "saved"; songId: number };
type ImportRow = { id: string; name: string; state: RowState };
type Pile = { rows: ImportRow[]; past: number };
type Picked = { name: string; size: number; bytes: () => Promise<Uint8Array> };
type Extracted = { text: string; other?: string; doubts: string[]; title?: string };
type Reader = (bytes: Uint8Array, name: string) => Promise<Extracted[]>;
type Song = { id: number; ref: string; title: string; artist: string; body: { heading: string; lines: { chords?: string; lyrics?: string }[] }[]; keyNote?: string };
type ImportModule = {
  kindOf: (bytes: Uint8Array, name: string) => string;
  decodeText: (bytes: Uint8Array) => string;
  titleFromName: (name: string) => string;
  draftOf: (extracted: { text: string; title?: string }, name: string) => Draft;
  judge: (draft: Draft, extracted: { doubts: string[] }, songs: Song[], rows: ImportRow[]) => { verdict: string; reasons: string[]; duplicate?: unknown };
  pileReducer: (pile: Pile, action: object) => Pile;
  saveable: (row: ImportRow) => boolean;
  songOf: (draft: Draft) => object;
  EMPTY_PILE: Pile;
  MAX_FILES: number;
  MAX_BYTES: number;
  Unread: new (reason: string) => Error;
  unzip: (bytes: Uint8Array, limit?: number) => Promise<({ name: string; bytes: Uint8Array } | { name: string; why: string })[]>;
  readText: Reader;
  readRtf: Reader;
  readDocx: Reader;
  READERS: Record<string, Reader | null>;
  readFiles: (files: Picked[], emit: (event: { do: string; [key: string]: unknown }) => void, options?: object) => Promise<void>;
  MESSAGES: Record<string, string>;
  CHECK_MESSAGES: Record<string, (draft: Draft) => string>;
  PileRow: unknown;
  createElement: (type: unknown, props: object) => unknown;
  renderToStaticMarkup: (element: unknown) => string;
  storage: {
    addOwnSong: (song: object) => number | null;
    addOwnSongs?: (songs: object[]) => (number | null)[] | null;
    loadLibrary: () => { songs: Song[]; setlists: unknown[] };
    onStorageChange: (listener: () => void) => () => void;
  };
};
type PasteModule = { readPaste: (text: string) => { facts: Record<string, unknown>; chart: string } };
type TextModule = { parseSheet: (text: string) => { sections: Song["body"]; warnings: unknown[] } };

class FakeStorage {
  map = new Map<string, string>();
  refuse: ((key: string, value: string) => boolean) | null = null;
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
    if (this.refuse?.(key, value)) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}
let storage = new FakeStorage();
const freshStorage = () => {
  storage = new FakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
};
freshStorage();

const NEW_MODULES = `
export * from "./src/song-import.ts";
export * from "./src/import-read.ts";
export { MESSAGES, CHECK_MESSAGES, PileRow } from "./src/song-import.tsx";
export * as storage from "./src/storage.ts";
export { createElement } from "react";
export { renderToStaticMarkup } from "react-dom/server.browser";
`;

async function load<T>(contents: string, what: string): Promise<T | null> {
  try {
    const bundle = await build({
      stdin: { contents, resolveDir: root, loader: "ts" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  } catch (error) {
    console.log(`FAIL ${what} loads: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    failed += 1;
    return null;
  }
}

const importMod = await load<ImportModule>(NEW_MODULES, "src/song-import.ts, src/import-read.ts and src/song-import.tsx");
const pasteMod = await load<PasteModule>(`export { readPaste } from "./src/song-paste.ts";`, "src/song-paste.ts");
const textMod = await load<TextModule>(`export { parseSheet } from "./src/song-text.ts";`, "src/song-text.ts");
const M = (): ImportModule => {
  assert.ok(importMod, "the import modules load");
  return importMod;
};
const readPaste = (text: string) => {
  assert.ok(pasteMod, "src/song-paste.ts loads");
  return pasteMod.readPaste(text);
};
const parseSheet = (text: string) => {
  assert.ok(textMod, "src/song-text.ts loads");
  return textMod.parseSheet(text);
};

const picked = (name: string, data: Uint8Array | string): Picked => {
  const bytes = typeof data === "string" ? bytesOf(data) : data;
  return { name, size: bytes.length, bytes: async () => bytes };
};
/** Reads `files` into a pile the way the sheet does, with `songs` as My Songs. */
async function pileOf(files: Picked[], options: object = {}, songs: Song[] = []): Promise<Pile> {
  let pile = M().EMPTY_PILE;
  await M().readFiles(files, (event) => (pile = M().pileReducer(pile, event.do === "read" ? { ...event, songs } : event)), options);
  return pile;
}
type Ready = ImportRow & { state: Extract<RowState, { is: "ready" }> };
const ready = (row: ImportRow | undefined): Ready => {
  assert.ok(row, "a row");
  assert.equal(row.state.is, "ready", `${row.name} is ready (${js(row.state)})`);
  return row as Ready;
};
/** An own song as the app makes one, from a draft with `title` and a one-line chart. */
const songNamed = (title: string, artist = "The Made Up Band", chart = `[Verse 1]\nC         G\nOld words on the page\n`) =>
  M().songOf({ title, artist, keyRoot: "C", keyMode: "major", bpm: "", timeSignature: "4/4", chart, keyNote: "" });
const why = (row: ImportRow | undefined) => (row?.state.is === "unread" ? row.state.why : `not unread: ${js(row?.state)}`);
const chordsOf = (chart: string) => parseSheet(chart).sections.flatMap((section) => section.lines.flatMap((line) => line.chords?.match(/\S+/g) ?? []));
const headingsOf = (chart: string) => parseSheet(chart).sections.map((section) => section.heading);

// ---------------------------------------------------------------------------------------------------------------
// Section 2: the readers.

await check("X1. kindOf names each kind from its first bytes when the extension is missing or wrong, and from the extension for plain text", () => {
  const { kindOf } = M();
  const cases: [Uint8Array, string, string][] = [
    [PDF, "chart.txt", "pdf"],
    [bytesOf("{\\rtf1\\ansi hello}"), "chart", "rtf"],
    [docx(documentXml(["Hello"], "Courier New")), "chart.zip", "docx"],
    [docx(documentXml(["Hello"], "Courier New")), "", "docx"],
    [zip([{ name: "a.txt", data: "hello" }]), "pile", "zip"],
    [PNG, "chart.pdf", "image"],
    [bytesOf("<!doctype html><html><body>Hi</body></html>"), "chart.txt", "html"],
    [bytesOf('<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>'), "chart.xml", "musicxml"],
    [bytesOf(HARBOR), "harbor.cho", "text"],
    [bytesOf(HARBOR), "harbor", "text"],
    [new Uint8Array(0), "empty.txt", "text"],
    [noise(64), "blob", "unknown"],
    [OLD_WORD, "old.docx", "unknown"],
  ];
  for (const [bytes, name, kind] of cases) assert.equal(kindOf(bytes, name), kind, `${name || "(no name)"} is ${kind}`);
});

await check("X2. decodeText reads UTF-8, UTF-8 with a byte order mark, UTF-16 in both byte orders, and Windows-1252 with curly quotes", () => {
  const { decodeText } = M();
  const words = "Caf\u00e9 \u201cbells\u201d it\u2019s late";
  const utf16 = (big: boolean) => {
    const out = [big ? 0xfe : 0xff, big ? 0xff : 0xfe];
    for (const char of words) {
      const code = char.charCodeAt(0);
      out.push(...(big ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8]));
    }
    return new Uint8Array(out);
  };
  assert.equal(decodeText(bytesOf(words)), words, "UTF-8");
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(words)])), words, "UTF-8 with a byte order mark");
  assert.equal(decodeText(utf16(false)), words, "UTF-16 little end first");
  assert.equal(decodeText(utf16(true)), words, "UTF-16 big end first");
  const cp1252 = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x62, 0x65, 0x6c, 0x6c, 0x73, 0x94, 0x20, 0x69, 0x74, 0x92, 0x73, 0x20, 0x6c, 0x61, 0x74, 0x65]);
  assert.equal(decodeText(cp1252), words, "Windows-1252");
});

await check("X3. a text chart and a ChordPro chart each give the title, key, tempo, headings and chords that readPaste gives for the same text pasted", async () => {
  const pile = await pileOf([picked("harbor.txt", HARBOR), picked("lanterns.cho", LANTERNS)]);
  assert.equal(pile.rows.length, 2, "two rows");
  for (const [row, text] of [
    [pile.rows[0], HARBOR],
    [pile.rows[1], LANTERNS],
  ] as const) {
    const { draft } = ready(row).state;
    const pasted = readPaste(text);
    assert.ok(pasted.facts.title, `${row.name}: the paste finds a title`);
    assert.equal(draft.title, pasted.facts.title, `${row.name}: the title`);
    assert.equal(draft.artist, pasted.facts.artist ?? "", `${row.name}: the artist`);
    assert.deepEqual([draft.keyRoot, draft.keyMode], [pasted.facts.keyRoot, pasted.facts.keyMode], `${row.name}: the key`);
    assert.equal(draft.bpm, String(pasted.facts.tempo), `${row.name}: the tempo`);
    assert.equal(draft.chart, pasted.chart, `${row.name}: the chart the paste gives`);
    assert.deepEqual(headingsOf(draft.chart), headingsOf(pasted.chart), `${row.name}: the headings`);
    assert.ok(headingsOf(draft.chart).length >= 2, `${row.name}: two sections`);
    assert.deepEqual(chordsOf(draft.chart), chordsOf(pasted.chart), `${row.name}: the chords`);
    assert.ok(chordsOf(draft.chart).length >= 6, `${row.name}: its chords`);
  }
});

await check("X4. a ChordPro file with two {new_song} parts gives two rows", async () => {
  const two = `${LANTERNS}\n{new_song}\n${LANTERNS.replace("Paper Lanterns", "Paper Kites")}`;
  const pile = await pileOf([picked("two.cho", two)]);
  assert.equal(pile.rows.length, 2, `two rows (${js(pile.rows.map((row) => row.state.is))})`);
  assert.deepEqual(
    pile.rows.map((row) => ready(row).state.draft.title),
    ["Paper Lanterns", "Paper Kites"],
    "each part its own song",
  );
  assert.notEqual(pile.rows[0].id, pile.rows[1].id, "each row its own id");
});

await check("X6. an RTF file with a font table, a picture group, \\'e9 and \\u8217? gives the typed text", async () => {
  // Typed in parts, so the escape stays six letters of RTF and is never read as the character itself.
  const quote = "\\" + "u8217?";
  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Zorblesans;}{\\f1\\fmodern Courier New;}}{\\*\\generator Zorble Writer;}{\\pict\\pngblip 89504e470d0a1a0a0000000d}\\f0 Verse 1\\par Caf\\'e9 lights${quote}s late\\par\\tab and{\\i  still} on\\par}`;
  const [read] = await M().readRtf(bytesOf(rtf), "cafe.rtf");
  assert.deepEqual(read.text.split("\n").filter((line) => line.trim()), ["Verse 1", "Caf\u00e9 lights\u2019s late", "\tand still on"], `the typed text (${js(read.text)})`);
  for (const hidden of ["Zorblesans", "Courier", "Zorble Writer", "89504e"]) assert.ok(!read.text.includes(hidden), `no ${hidden}`);
});

await check("X7. a .docx built by the check, with one deflated entry, gives the typed lines, with tabs and line breaks kept", async () => {
  const file = docx(documentXml(["First line", "Tab\there", "Broken\nin two"], "Courier New"));
  const [read] = await M().readDocx(file, "lines.docx");
  assert.deepEqual(read.text.split("\n").filter((line) => line !== ""), ["First line", "Tab\there", "Broken", "in two"], `the lines (${js(read.text)})`);
  assert.deepEqual(read.doubts, [], "no doubt");
  const entries = await M().unzip(file);
  assert.ok(entries.some((entry) => entry.name === "word/document.xml" && "bytes" in entry), "the deflated document inflates");
});

await check("X9. a .zip of three files gives three rows named by path, and a damaged file inside gives one Couldn't read row and two good rows", async () => {
  const good = zip([
    { name: "set/harbor.txt", data: HARBOR, deflate: true },
    { name: "set/lanterns.cho", data: LANTERNS },
    { name: "quarry.rtf", data: rtfOf(QUARRY), deflate: true },
  ]);
  const pile = await pileOf([picked("gig.zip", good)]);
  assert.deepEqual(
    pile.rows.map((row) => row.name),
    ["gig.zip/set/harbor.txt", "gig.zip/set/lanterns.cho", "gig.zip/quarry.rtf"],
    "three rows named by path",
  );
  for (const row of pile.rows) assert.equal(ready(row).state.verdict, "good", `${row.name} looks good (${js(row.state)})`);
  const damaged = zip([
    { name: "harbor.txt", data: HARBOR },
    { name: "broken.docx", data: noise(300) },
    { name: "lanterns.cho", data: LANTERNS, deflate: true },
  ]);
  const second = await pileOf([picked("mixed.zip", damaged)]);
  assert.deepEqual(
    second.rows.map((row) => row.state.is),
    ["ready", "unread", "ready"],
    "two good rows and one Couldn't read",
  );
  assert.equal(why(second.rows[1]), "damaged", "the damaged file says damaged");
});

await check("X10. a file of zero bytes, a file of random bytes, an old .doc and a .docx with no word/document.xml are each refused with their own reason", async () => {
  const pile = await pileOf([picked("empty.txt", new Uint8Array(0)), picked("blob", noise(200)), picked("old.doc", OLD_WORD), picked("no-document.docx", docx(null, [{ name: "word/styles.xml", data: "<w:styles/>" }]))]);
  assert.deepEqual(
    pile.rows.map(why),
    ["empty", "unsupported", "old-word", "damaged"],
    "each its own reason",
  );
});

await check("X11. titleFromName gives Wagon Wheel for Wagon_Wheel-chords (1).txt, and an empty title for IMG_2041.jpg, Scan0003.pdf and 12.txt", () => {
  const { titleFromName } = M();
  assert.equal(titleFromName("Wagon_Wheel-chords (1).txt"), "Wagon Wheel");
  for (const name of ["IMG_2041.jpg", "Scan0003.pdf", "12.txt", "Screenshot 2026-11-02.png", "Document.docx"]) assert.equal(titleFromName(name), "", `${name} carries no title`);
  assert.equal(titleFromName("gig.zip/set/paper-boats lyrics.txt"), "paper boats", "a path inside a zip gives its file's name");
});

await check("X12. src/song-import.ts and src/import-read.ts contain no fetch, XMLHttpRequest or WebSocket", () => {
  const files = ["song-import.ts", "import-read.ts"].map((name) => join(root, "src", name));
  for (const file of files) {
    assert.ok(existsSync(file), `${file} exists`);
    const source = readFileSync(file, "utf8");
    for (const banned of ["fetch", "XMLHttpRequest", "WebSocket", "import("]) assert.ok(!source.includes(banned), `no ${banned} in ${file}`);
  }
});

await check("X13. an RTF cut off inside a group, a hex escape and a Unicode escape, and a .docx cut off inside a tag, each end as a row, and no reader loops on them", async () => {
  const rtf = rtfOf(QUARRY);
  const quote = "\\" + "u8217?";
  const cuts = [
    ["group.rtf", rtf.slice(0, rtf.indexOf("{\\colortbl") + 6)],
    ["hex.rtf", `${rtf.slice(0, rtf.lastIndexOf("\\par}"))}Caf\\'e`],
    ["unicode.rtf", `${rtf.slice(0, rtf.lastIndexOf("\\par}"))}it${quote.slice(0, 4)}`],
    ["bare.rtf", "{\\rtf1\\"],
  ] as const;
  const xml = documentXml(WILLOW, "Courier New");
  const cut = xml.slice(0, xml.indexOf("Bending") + 4) + "</w:t></w:r><w:r><w:t";
  const files = [...cuts.map(([name, text]) => picked(name, text)), picked("cut.docx", docx(cut)), picked("cut-name.docx", docx(xml.slice(0, xml.indexOf("<w:rFonts") + 5)))];
  const started = Date.now();
  const pile = await pileOf(files, { timeLimit: 3000 });
  assert.ok(Date.now() - started < 3000, `the cut files end at once (${Date.now() - started} ms)`);
  assert.equal(pile.rows.length, files.length, "a row each");
  for (const row of pile.rows) assert.ok(row.state.is === "ready" || (row.state.is === "unread" && row.state.why !== "slow"), `${row.name} ends as a row (${js(row.state)})`);
  assert.ok(ready(pile.rows[4]).state.draft.chart.includes("Willow branches"), "the cut .docx keeps what came before the cut");
});

// ---------------------------------------------------------------------------------------------------------------
// Section 4: the batch.

const counting = (reader: Reader | null | undefined, calls: string[], fail?: (name: string) => Promise<Extracted[]> | null) => async (bytes: Uint8Array, name: string) => {
  calls.push(name);
  const instead = fail?.(name);
  if (instead) return instead;
  return reader!(bytes, name);
};
const textPile = (count: number, from = 0) => Array.from({ length: count }, (_, at) => picked(`song-${from + at + 1}.txt`, chartOf(`Pebble ${from + at + 1}`)));

await check("B1. a pile of five files with one reader that throws gives four rows with sheets and one Couldn't read row, in the picked order", async () => {
  const calls: string[] = [];
  const readers = { ...M().READERS, text: counting(M().READERS.text, calls, (name) => (name === "c.txt" ? Promise.reject(new TypeError("zorble")) : null)) };
  const pile = await pileOf(["a", "b", "c", "d", "e"].map((letter) => picked(`${letter}.txt`, chartOf(`${letter} song`))), { readers });
  assert.deepEqual(
    pile.rows.map((row) => row.name),
    ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"],
    "the picked order",
  );
  assert.deepEqual(
    pile.rows.map((row) => row.state.is),
    ["ready", "ready", "unread", "ready", "ready"],
    "four sheets and one Couldn't read",
  );
  assert.deepEqual(calls, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"], "every file was read");
});

await check("B2. a reader that never returns is stopped at the time limit, and the files after it are read", async () => {
  const calls: string[] = [];
  const readers = { ...M().READERS, text: counting(M().READERS.text, calls, (name) => (name === "stuck.txt" ? new Promise<never>(() => {}) : null)) };
  const started = Date.now();
  const pile = await pileOf([picked("first.txt", chartOf("First")), picked("stuck.txt", chartOf("Stuck")), picked("after.txt", chartOf("After"))], { readers, timeLimit: 300 });
  const took = Date.now() - started;
  assert.ok(took >= 280 && took < 3000, `stopped at the limit (${took} ms)`);
  assert.equal(why(pile.rows[1]), "slow", "the stuck file reads too long");
  assert.equal(ready(pile.rows[2]).state.draft.title, "After", "the file after it is read");
});

/** Files that give every Couldn't read reason, with the options and readers that reach the ones a later cook's reader gives. */
const SECRET = "Zorblewick";
async function everyUnread() {
  const calls: string[] = [];
  const pdfReasons: Record<string, string> = { "locked.pdf": "locked", "scan.pdf": "scan", "reader.pdf": "no-reader" };
  const readers = {
    ...M().READERS,
    text: counting(M().READERS.text, calls, (name) => (name === "stuck.txt" ? new Promise<never>(() => {}) : null)),
    pdf: async (_bytes: Uint8Array, name: string) => {
      calls.push(name);
      throw new (M().Unread)(pdfReasons[name] ?? "damaged");
    },
  };
  const files = [
    picked("photo.png", PNG),
    picked("old.doc", OLD_WORD),
    picked("empty.txt", new Uint8Array(0)),
    picked("blank.txt", `   \n\n  ${"\n"}`),
    picked("broken.docx", noise(400)),
    picked("locked.pdf", PDF),
    picked("scan.pdf", PDF),
    picked("reader.pdf", PDF),
    picked("huge.txt", `${SECRET} `.repeat(400)),
    picked("stuck.txt", `${SECRET}\nG C\nwords`),
    picked("extra.txt", chartOf(SECRET)),
  ];
  // The size limit is 2000 bytes here, so huge.txt passes it; the pile is full at ten, so extra.txt is one too many.
  const pile = await pileOf(files, { readers, sizeLimit: 2000, maxFiles: 10, timeLimit: 200 });
  return { pile, calls };
}
/** The words of section 4's Couldn't read table, as the plan gives them. */
const UNREAD_WORDS: Record<string, string> = {
  unsupported: "This kind of file can't be read yet.",
  "old-word": "This is an old Word file. Save it as .docx or PDF and try again.",
  empty: "This file is empty.",
  "no-text": "No words or chords were found in this file.",
  damaged: "This file is damaged, or it is not the kind its name says.",
  locked: "This PDF needs a password. Save a copy without one and try again.",
  scan: "This PDF is a scan with no text inside. Scans can't be read yet.",
  "no-reader": "The PDF reader could not be loaded. Check your connection and try again.",
  "too-big": "This file is larger than 20 MB.",
  "too-many": "Only the first 200 files were read. Import the rest in a second pile.",
  slow: "Reading this file took too long.",
};
const UNREAD_WANTED = ["unsupported", "old-word", "empty", "no-text", "damaged", "locked", "scan", "no-reader", "too-big", "slow", "too-many"];
const markup = (row: ImportRow) => M().renderToStaticMarkup(M().createElement(M().PileRow, { row, actions: { onOpen() {}, onTitle() {}, onSkip() {}, onKeep() {}, onReplace() {}, onOther() {} } }));

await check("B3. each reason in the Couldn't read table has a file that produces it and shows its words, and no unread row shows any text from its file", async () => {
  const { pile } = await everyUnread();
  assert.deepEqual(pile.rows.map(why), UNREAD_WANTED, "each reason from its file");
  assert.deepEqual(M().MESSAGES, UNREAD_WORDS, "MESSAGES holds the plan's words for every reason and no other");
  for (const row of pile.rows) {
    const html = markup(row);
    const words = M().MESSAGES[(row.state as { why: string }).why];
    assert.ok(html.includes(words.replace(/'/g, "&#x27;")), `${row.name} shows ${words}`);
    assert.ok(html.includes("Couldn"), `${row.name} is marked Couldn't read`);
    assert.ok(!html.includes(SECRET) && !html.includes(">G C<"), `${row.name} shows nothing from its file`);
    assert.ok(!/>(unsupported|old-word|no-text|no-reader|too-big|too-many)</.test(html), `${row.name} shows no reason word`);
  }
});

await check("B4. each cook 1 reason in the Check this table has a file that produces it", async () => {
  const have: Song[] = [{ id: 900, ref: "own/900", title: "Quarry Song", artist: "The Made Up Band", body: [] }];
  const files = [
    picked("IMG_0001.txt", "[Verse 1]\nG          C\nNo name upon the paper\n"),
    picked("words.txt", "Kettle Song\nby The Made Up Band\n\n[Verse 1]\nKettle singing on the stove\nSteam is rising up above\n"),
    picked("close.txt", "Crowded Chords\nby The Made Up Band\n\n[Verse 1]\n[Am][F]Sunny morning on the hill\n"),
    picked("proportional.rtf", rtfOf(["Ferry Line Chords", "by The Made Up Band", "", "[Verse 1]", "G          C", "Ferry leaving from the landing"], "\\fswiss Arial")),
    picked("quarry.rtf", rtfOf(QUARRY)),
  ];
  const pile = await pileOf(files, {}, have);
  const reasons = pile.rows.map((row) => ready(row).state.reasons);
  assert.ok(reasons[0].includes("no-title"), `IMG_0001.txt: no-title (${js(reasons[0])})`);
  assert.ok(reasons[1].includes("no-chords"), `words.txt: no-chords (${js(reasons[1])})`);
  assert.ok(reasons[2].includes("warnings"), `close.txt: warnings (${js(reasons[2])})`);
  assert.ok(reasons[3].includes("fonts"), `proportional.rtf: fonts (${js(reasons[3])})`);
  assert.ok(reasons[4].includes("duplicate"), `quarry.rtf: duplicate (${js(reasons[4])})`);
  for (const row of pile.rows) assert.equal(ready(row).state.verdict, "check", `${row.name} says Check this`);
  const words = pile.rows.map(markup);
  assert.ok(words[0].includes("Add a title"), "the no-title row says Add a title");
  assert.ok(words[1].includes("No chords were found. It will be saved as words."), "the no-chords row says so");
  assert.ok(words[2].includes("1 line may have a chord in the wrong place."), "the warnings row counts its lines");
  assert.ok(words[3].includes("Chords may sit over the wrong word. A PDF of this document keeps them in place."), "the fonts row says so");
  assert.ok(words[4].includes("You already have Quarry Song."), "the duplicate row says so");
});

await check("B5. a row whose title and artist match a song in My Songs is flagged and not saved by Save; Keep both adds a second song, and the first is byte-for-byte unchanged", async () => {
  freshStorage();
  const { storage: st, saveable, pileReducer } = M();
  assert.ok(st.addOwnSongs, "addOwnSongs exists");
  const firstId = st.addOwnSong(songNamed("Quarry Song"));
  assert.ok(firstId !== null, "the first song is saved");
  const before = JSON.stringify(st.loadLibrary().songs.find((song) => song.id === firstId));
  const rawBefore = storage.getItem("leadSheetsLibrary")!;
  let pile = await pileOf([picked("quarry.rtf", rtfOf(QUARRY))], {}, st.loadLibrary().songs);
  const row = ready(pile.rows[0]);
  assert.equal(row.state.duplicate?.by, "library", "flagged as a song you have");
  assert.equal(saveable(row), false, "Save leaves it");
  pile = pileReducer(pile, { do: "keep", id: row.id, songs: st.loadLibrary().songs });
  const kept = ready(pile.rows[0]);
  assert.ok(kept.state.duplicate?.keep, "Keep both is taken");
  assert.equal(saveable(kept), true, "Save takes it now");
  const ids = st.addOwnSongs!([M().songOf(kept.state.draft)]);
  assert.ok(ids && ids[0] !== null && ids[0] !== firstId, "a second song with its own id");
  const songs = st.loadLibrary().songs.filter((song) => song.title === "Quarry Song");
  assert.equal(songs.length, 2, "two songs of that title");
  assert.equal(JSON.stringify(st.loadLibrary().songs.find((song) => song.id === firstId)), before, "the first song is unchanged");
  const rowOf = (raw: string, id: number) => JSON.stringify((JSON.parse(raw).songs as { id: number }[]).find((song) => song.id === id));
  assert.equal(rowOf(storage.getItem("leadSheetsLibrary")!, firstId!), rowOf(rawBefore, firstId!), "its stored bytes are unchanged");
});

await check("B7. two files with the same bytes give one ready row and one skipped row; two with the same title and different bytes give one ready row and one flagged row", async () => {
  const same = await pileOf([picked("harbor.txt", HARBOR), picked("harbor copy.txt", HARBOR)]);
  const [first, second] = same.rows.map(ready);
  assert.equal(first.state.skipped, false, "the first is ready");
  assert.equal(first.state.duplicate, undefined, "the first is not flagged");
  assert.equal(second.state.skipped, true, "the same bytes start skipped");
  assert.equal(second.state.duplicate?.by, "file", "flagged as the same file");
  const titled = await pileOf([picked("harbor.txt", HARBOR), picked("harbor-live.txt", HARBOR.replace("Gulls are circling", "Gulls go circling"))]);
  const [one, two] = titled.rows.map(ready);
  assert.equal(one.state.duplicate, undefined, "the first is not flagged");
  assert.equal(two.state.skipped, false, "the second is not skipped");
  assert.equal(two.state.duplicate?.by, "pile", "the second is flagged as the same song in this pile");
  assert.equal(M().saveable(two), false, "and waits for a choice");
});

await check("B9. Stop during a pile of 20 keeps the rows that are done and reads no more", async () => {
  const calls: string[] = [];
  const readers = { ...M().READERS, text: counting(M().READERS.text, calls) };
  let done = 0;
  let pile = M().EMPTY_PILE;
  await M().readFiles(
    textPile(20),
    (event) => {
      if (event.do === "read") done += 1;
      pile = M().pileReducer(pile, event.do === "read" ? { ...event, songs: [] } : event);
    },
    { readers, stopped: () => done >= 6 },
  );
  assert.equal(calls.length, 6, `six files read (${calls.length})`);
  assert.equal(pile.rows.length, 6, "the six rows that are done stay");
  for (const row of pile.rows) ready(row);
});

await check("B10. file 201 of a pile gets the too-many reason, and a zip of 250 files gives 200 rows and one line that says the rest were not read", async () => {
  const many = await pileOf(textPile(201));
  assert.equal(many.rows.length, 201, "a row each");
  assert.equal(why(many.rows[200]), "too-many", "file 201 is one too many");
  assert.equal(many.rows.filter((row) => row.state.is === "ready").length, 200, "200 are read");
  const big = zip(Array.from({ length: 250 }, (_, at) => ({ name: `songs/${at + 1}.txt`, data: chartOf(`Pebble ${at + 1}`), deflate: at % 2 === 0 })));
  const zipped = await pileOf([picked("songbook.zip", big)]);
  assert.equal(zipped.rows.length, 200, `200 rows (${zipped.rows.length})`);
  assert.equal(zipped.past, 50, "50 not read");
  assert.equal(M().MESSAGES["too-many"], "Only the first 200 files were read. Import the rest in a second pile.", "the line's words");
});

await check("B12. addOwnSongs with one song that has no title saves the others, returns null for that one, and fires one change", () => {
  freshStorage();
  const st = M().storage;
  assert.ok(st.addOwnSongs, "addOwnSongs exists");
  let changes = 0;
  const stop = st.onStorageChange(() => (changes += 1));
  const ids = st.addOwnSongs([songNamed("One Pebble"), songNamed(""), songNamed("Two Pebbles")]);
  stop();
  assert.ok(ids, "the write is taken");
  assert.equal(ids.length, 3, "an id or null for each");
  assert.equal(ids[1], null, "null for the untitled song");
  assert.ok(typeof ids[0] === "number" && typeof ids[2] === "number" && ids[0] !== ids[2], "an id each for the others");
  const titles = st.loadLibrary().songs.filter((each) => ids.includes(each.id)).map((each) => each.title);
  assert.deepEqual(titles.sort(), ["One Pebble", "Two Pebbles"], "both saved");
  assert.equal(changes, 1, "one change for one write");
});

await check("B13. a file over the size limit gets the too-big reason, and no reader is called for it", async () => {
  const calls: string[] = [];
  let opened = 0;
  const readers = Object.fromEntries(Object.entries(M().READERS).map(([kind, reader]) => [kind, reader && counting(reader, calls)]));
  const huge: Picked = {
    name: "huge.txt",
    size: M().MAX_BYTES + 1,
    bytes: async () => {
      opened += 1;
      return bytesOf(chartOf("Huge"));
    },
  };
  const pile = await pileOf([huge, picked("small.txt", chartOf("Small"))], { readers });
  assert.equal(why(pile.rows[0]), "too-big", "the big file is too big");
  assert.equal(M().MESSAGES["too-big"], "This file is larger than 20 MB.", "its words");
  assert.deepEqual(calls, ["small.txt"], "no reader is called for it");
  assert.equal(opened, 0, "its bytes are never read");
});

await check("B14. a zip entry that would inflate past the size limit gets too-big, unzip stops at the limit, the other entries are read, and a .docx whose document passes the limit is damaged", async () => {
  // 64 MB of zeros deflates to 64 KB, and the directory claims 16 bytes, so only the stream can tell.
  const bomb = zip([
    { name: "harbor.txt", data: HARBOR, deflate: true },
    { name: "bomb.txt", data: new Uint8Array(64 * 1024 * 1024), deflate: true, claim: 16 },
    { name: "lanterns.cho", data: LANTERNS, deflate: true },
  ]);
  // The bytes unzip pulls out of the browser's inflater are counted at the stream, which no garbage collector moves.
  const Inflater = globalThis.DecompressionStream;
  let inflated = 0;
  globalThis.DecompressionStream = class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<BufferSource>;
    constructor(format: CompressionFormat) {
      const real = new Inflater(format);
      this.writable = real.writable;
      this.readable = real.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, out) => ((inflated += chunk.length), out.enqueue(chunk)) }));
    }
  } as unknown as typeof DecompressionStream;
  const started = Date.now();
  let entries;
  try {
    entries = await M().unzip(bomb);
  } finally {
    globalThis.DecompressionStream = Inflater;
  }
  assert.deepEqual(
    entries.map((entry) => ("why" in entry ? entry.why : "read")),
    ["read", "too-big", "read"],
    "too big, and the others read",
  );
  assert.ok(inflated < 24 * 1024 * 1024, `inflating stopped near the 20 MB limit (${Math.round(inflated / 1024 / 1024)} MB inflated of 64)`);
  assert.ok(Date.now() - started < 5000, `at once (${Date.now() - started} ms)`);
  const pile = await pileOf([picked("bomb.zip", bomb)]);
  assert.deepEqual(pile.rows.map((row) => (row.state.is === "unread" ? row.state.why : row.state.is)), ["ready", "too-big", "ready"], "the pile reads the others");
  const bigDocument = docx(`<w:document><w:body><w:p><w:r><w:t>${"zorble ".repeat(3_100_000)}</w:t></w:r></w:p></w:body></w:document>`);
  const word = await pileOf([picked("big.docx", bigDocument)]);
  assert.equal(why(word.rows[0]), "damaged", "the .docx is damaged");
});

// ---------------------------------------------------------------------------------------------------------------
// Headless Chrome: the readers that need the page, then the sheet.

const ACCOUNT = { userId: "u_song_import", handle: "pat", displayName: "Pat Bass", ways: [] };
const SECOND = { userId: "u_song_import_two", handle: "sam", displayName: "Sam Keys", ways: [{ kind: "password", id: "pw1" }] };
const SALT = newSalt();
const server = { me: ACCOUNT as typeof ACCOUNT | null, backup: 404 };
const api = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  for await (const _ of request);
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(js(body));
  };
  if (path === "/api/me") return server.me ? reply(200, { account: server.me }) : reply(401, { error: "signed-out" });
  if (path === "/api/backup") return reply(server.backup, { error: server.backup === 401 ? "signed-out" : "not-found" });
  if (path === "/api/auth/config") return reply(200, { google: false, password: true });
  if (path === "/api/auth/password/salt") return reply(200, { salt: SALT });
  if (path === "/api/auth/password/sign-in") {
    server.me = SECOND;
    return reply(200, { account: SECOND });
  }
  reply(404, { error: "not-found" });
});
await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
const apiAddress = api.address();
const apiBase = `http://127.0.0.1:${typeof apiAddress === "object" && apiAddress ? apiAddress.port : 0}`;

/** In the page before any app script: the song catalog answers no songs, so no case reaches it. */
const CATALOG_STUB = `(() => {
  window.__catalogCalls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) return realFetch(input, init);
    window.__catalogCalls.push(url.href);
    return Promise.resolve(new Response(JSON.stringify({ created: "2026-11-26T00:00:00.000Z", count: 0, offset: 0, recordings: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  };
})();`;

const SCREEN_CASES = {
  X5: "X5. an HTML page with a chart in a pre, a menu and a script gives the chart alone; a page with no pre gives one line for each block",
  X8: "X8. a .docx in a monospace font has no doubt; the same chart in a proportional font has the doubt fonts and two readings",
  X13h: "X13b. an HTML page cut off inside a tag ends as a row",
  U1: "U1. Import files shows under + Add a song for a signed-in player and is absent for a signed-out one, whose drag does nothing",
  U13: "U13. a pick of no files, and a picker that is closed, each leave the sheet on Choose files with no row",
  U2: "U2. five files of five kinds, picked at once, give five rows in the picked order, each with its mark",
  U8: "U8. chords sit over their syllables in the preview and on the saved sheet",
  U3: "U3. a row's Title field edits the title; clearing it shows Add a title and the count on the save button drops by one",
  U4: "U4. tapping a row shows the real sheet with its headings; Edit opens the song editor with the row's title, key and chart, and Save there marks the row saved and returns to the list",
  U5: "U5. Skip removes a row from the count, and Undo brings it back",
  U10: "U10. every control is at least 44 px tall and not clipped at 360 px and 390 px, and no row scrolls sideways",
  U6: "U6. Save 3 songs adds three songs to My Songs, and after a reload with the network off each opens with its chart",
  U7: "U7. a second tap on the save button, and a second Save after it finished, add no song",
  B11: "B11. after a save and a reload, picking the same pile again flags every saved song and adds none without a tap",
  B5s: "B5b. on the sheet, Keep both on a flagged row saves a second song and leaves the first unchanged",
  B6: "B6. Replace on a song the player made keeps its id and its place in a setlist and changes its chart; Replace is not offered for a built-in song",
  B3s: "B3b. with every file failed, the list shows each reason and the bottom button is disabled and says Nothing to save",
  B8: "B8. with the write refused by a full store, the saved rows are marked, the rest stay, the message shows, and a second Save after space is freed adds each remaining song once",
  U9: "U9. closing with unsaved rows asks once, and Escape closes through the same question",
  U11: "U11. a drag of two files onto My Songs opens the sheet with two rows",
  B9s: "B9b. on the sheet, Reading N of 40 shows while a pile reads, Stop keeps the rows that are done and reads no more, and a pick after it reads again",
  U12: "U12. with two ready rows showing, a 401 ends the session and the sheet closes with no question; a second account then sees it closed, opens Import files on Choose files with no row, and holds no song from the pile",
  P1: "perf 1. the main script stays within 15 KB gzipped of the branch point",
  P2: "perf 2. 100 picked text files reach their last row within 5 s at 4 times CPU slowdown",
  P3: "perf 3. addOwnSongs saves 100 songs at least 5 times faster than 100 addOwnSong calls and within 2 s, at 4 times CPU slowdown",
  P4: "perf 4. 200 imported songs on top of 100 are stored, and the stored size is reported",
} as const;

/** The main script at the branch point fcffb43, gzipped, measured on the laptop before this cook's first edit. */
const MAIN_BASELINE_KB = 227.3;

await check(SCREEN_CASES.P1, async () => {
  const out = mkdtempSync(join(tmpdir(), "check-song-import-size-"));
  try {
    await viteBuild({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const assets = join(out, "assets");
    const main = readdirSync(assets).filter((name) => /^index-.*\.js$/.test(name));
    assert.equal(main.length, 1, "one main script");
    const kb = gzipSync(readFileSync(join(assets, main[0]))).length / 1000;
    console.log(`     main script ${kb.toFixed(2)} KB gzipped, ${(kb - MAIN_BASELINE_KB).toFixed(2)} KB over the branch point (${statSync(join(assets, main[0])).size} bytes raw)`);
    assert.ok(kb <= MAIN_BASELINE_KB + 15, `${kb.toFixed(2)} KB is within ${MAIN_BASELINE_KB + 15} KB`);
    assert.ok(existsSync(join(root, "src", "song-import.tsx")), "the import sheet is built in");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const files = mkdtempSync(join(tmpdir(), "check-song-import-files-"));
const write = (name: string, data: Uint8Array | string) => {
  const path = join(files, name);
  writeFileSync(path, typeof data === "string" ? data : Buffer.from(data));
  return path;
};

/** The readers, bundled for the page, as `window.__read`. */
async function readerScript(): Promise<string | null> {
  try {
    const bundle = await build({
      stdin: {
        contents: [
          `export * from "./src/import-read.ts"; export * as storage from "./src/storage.ts"; export { ownSong } from "./src/song-text.ts";`,
          // U12 mounts the editors on their own, to switch the account with no change of page.
          `export { SongEditors } from "./src/song-editor.tsx"; export { createElement } from "react"; export { createRoot } from "react-dom/client"; export { flushSync } from "react-dom";`,
        ].join("\n"),
        resolveDir: root,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__read",
      platform: "browser",
      jsx: "automatic",
      loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    return bundle.outputFiles[0].text;
  } catch {
    return null;
  }
}

let site: Site | null = null;
try {
  site = await openSite(root, "check-song-import", () => apiBase);
} catch (error) {
  for (const name of Object.entries(SCREEN_CASES).flatMap(([key, name]) => (key === "P1" ? [] : [name]))) {
    failed += 1;
    console.log(`FAIL ${name}: the app or Chrome did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

if (site) {
  const s = site;
  try {
    const app = await appPage(s);
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: CATALOG_STUB });
    await s.send("DOM.enable");
    const HEIGHT = 780;
    const phone = async (width: number) => {
      await s.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    };
    await phone(390);
    await s.send("Page.navigate", { url: `${s.origin}/#/songs` });
    await app.library();

    // The readers that need DOMParser and the canvas, in the page.
    const reader = await readerScript();
    const inPage = async <T>(expression: string): Promise<T> => {
      assert.ok(reader, "src/import-read.ts bundles for the page");
      if (!(await s.evaluate<boolean>(`!!window.__read`))) await s.evaluate(`${reader};true`);
      return s.evaluate<T>(expression);
    };
    const bytesIn = (bytes: Uint8Array) => `Uint8Array.from(atob(${js(b64(bytes))}), (c) => c.charCodeAt(0))`;

    await check(SCREEN_CASES.X5, async () => {
      const [read] = await inPage<Extracted[]>(`__read.readHtml(${bytesIn(bytesOf(MOSS))}, "moss.html")`);
      assert.equal(read.text.trim(), MOSS.slice(MOSS.indexOf("<pre>") + 5, MOSS.indexOf("</pre>")).trim(), `the chart alone (${js(read.text)})`);
      assert.equal(read.title, "Moss Garden", "the page's title");
      for (const gone of ["Zorble menu", "zorbleScript", "Zorble footer", "color: red"]) assert.ok(!read.text.includes(gone), `no ${gone}`);
      const blocks = `<html><body><nav>Zorble menu</nav><h1>Fern Hollow</h1><p>[Verse 1]</p><div>G  C</div><p>Ferns along <b>the</b> hollow<br>Second line</p><ul><li>One</li><li>Two</li></ul></body></html>`;
      const [plain] = await inPage<Extracted[]>(`__read.readHtml(${bytesIn(bytesOf(blocks))}, "fern.html")`);
      assert.deepEqual(plain.text.split("\n").filter((line) => line.trim()), ["Fern Hollow", "[Verse 1]", "G C", "Ferns along the hollow", "Second line", "One", "Two"], `one line a block (${js(plain.text)})`);
    });

    await check(SCREEN_CASES.X8, async () => {
      const mono = await inPage<Extracted[]>(`__read.readDocx(${bytesIn(docx(documentXml(WILLOW, "Courier New")))}, "willow.docx")`);
      assert.deepEqual(mono[0].doubts, [], "monospace has no doubt");
      assert.equal(mono[0].other, undefined, "and one reading");
      assert.ok(mono[0].text.includes("G           C\nWillow branches on the creek"), "the columns as typed");
      const sans = await inPage<Extracted[]>(`__read.readDocx(${bytesIn(docx(documentXml(WILLOW, "Arial")))}, "willow.docx")`);
      assert.deepEqual(sans[0].doubts, ["fonts"], "a proportional font has the doubt fonts");
      assert.ok(sans[0].other?.includes("G           C\nWillow branches on the creek"), "the other reading is the columns");
      assert.ok(/\[G\]Willow/.test(sans[0].text) && /\[C\]/.test(sans[0].text), `the first reading places the chords inline (${js(sans[0].text)})`);
    });

    await check(SCREEN_CASES.X13h, async () => {
      const cut = MOSS.slice(0, MOSS.indexOf("<footer") + 4);
      const result = await inPage<string>(`(async () => {
        const rows = [];
        await __read.readFiles([{ name: "cut.html", size: ${cut.length}, bytes: async () => ${bytesIn(bytesOf(cut))} }, { name: "cut2.html", size: 20, bytes: async () => ${bytesIn(bytesOf("<!doctype html><html><bo"))} }], (e) => e.do === "read" && rows.push(...e.results.map((r) => r.why ?? "read")), { timeLimit: 3000 });
        return rows.join(",");
      })()`);
      assert.ok(/^(read|no-text|damaged),(read|no-text|damaged)$/.test(result), `each cut page ends as a row (${result})`);
      assert.ok(result.startsWith("read"), "the page cut at its footer keeps its chart");
    });

    // The sheet.
    const sheet = `document.querySelector(".song-import[role=dialog]")`;
    const button = (label: string, scope = "document") => `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(label)})`;
    const rowsOf = () =>
      s.evaluate<{ name: string; mark: string; text: string }[]>(
        `[...document.querySelectorAll(".song-import-row")].map((row) => ({ name: row.querySelector(".song-import-open, .song-import-name")?.textContent.trim() ?? "", mark: row.querySelector(".song-import-mark")?.textContent.trim() ?? "", text: row.textContent }))`,
      );
    const saveLabel = () => s.evaluate<string>(`(${sheet}?.querySelector(".song-import-bottom .is-primary")?.textContent ?? "").trim()`);
    const library = () => s.evaluate<{ id: number; title: string; artist: string; body: Song["body"] }[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? "{}").songs ?? []`);
    const songsTitled = async (title: string) => (await library()).filter((song) => song.title === title);
    const importButton = button("Import files");
    const onSongs = async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${button("+ Add a song")}`, "My Songs, signed in", 10000);
    };
    let opened = 0;
    const openImport = async () => {
      opened += 1;
      await closeImport();
      await onSongs();
      await app.until(`!!${importButton}`, "the Import files button", 5000);
      await s.evaluate(`${importButton}.click()`);
      await app.until(`!!${sheet} && !!${button("Choose files", sheet)}`, "the sheet on Choose files", 5000);
    };
    const closeImport = async () => {
      if (!(await s.evaluate<boolean>(`!!${sheet}`))) return;
      await s.evaluate(`${button("Close", sheet)}?.click()`);
      await sleep(150);
      await s.evaluate(`${button("Leave", sheet)}?.click()`);
      await app.until(`!${sheet}`, "the sheet to close");
    };
    const input = async () => {
      const { result } = await s.send("Runtime.evaluate", { expression: `document.querySelector(".song-import input[type=file]")` });
      assert.ok(result.objectId, "the sheet's file input");
      return result.objectId as string;
    };
    /** The browser's own file-input command, as the picker hands over files. */
    const pick = async (paths: string[]) => {
      await s.send("DOM.setFileInputFiles", { files: paths, objectId: await input() });
    };
    const allRead = (count: number, ms = 10000) => app.until(`document.querySelectorAll(".song-import-row").length === ${count} && ![...document.querySelectorAll(".song-import-row")].some((r) => ["waiting", "reading"].includes(r.dataset.mark))`, `${count} rows read`, ms);
    const rowButton = (name: string, label: string) => `${button(label, `[...document.querySelectorAll(".song-import-row")].find((r) => r.querySelector(".song-import-open, .song-import-name")?.textContent.trim() === ${js(name)})`)}`;
    const titleField = (name: string) => `[...document.querySelectorAll(".song-import-row")].find((r) => r.querySelector(".song-import-open, .song-import-name")?.textContent.trim() === ${js(name)})?.querySelector(".song-import-title input")`;
    const setTitle = async (name: string, value: string) => {
      const set = await s.evaluate<boolean>(`(() => {
        const el = ${titleField(name)};
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${js(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      assert.ok(set, `a Title field on ${name}`);
      await sleep(150);
    };
    const tapIn = async (expression: string, what: string) => {
      assert.ok(await s.evaluate<boolean>(`(() => { const el = ${expression}; if (!el || el.disabled) return false; el.click(); return true; })()`), `a ${what} to tap`);
      await sleep(200);
    };
    /** Each drawn chord row in `scope`, with the lyric column every chord glyph starts over (the measure check:chords uses). */
    const drawn = (scope: string) =>
      s.evaluate<Row[]>(`(() => {
        const chart = document.querySelector(${js(`${scope} .chart`)});
        if (!chart) return [];
        const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
        return [...chart.querySelectorAll(".pair")].map((row) => {
          const chords = row.querySelector(".chords");
          const lyrics = row.querySelector(".lyrics");
          const text = chords.textContent;
          const lyric = lyrics?.textContent ?? "";
          const left = (lyrics ?? chords).getBoundingClientRect().left;
          const sample = lyric ? { node: lyrics.firstChild, length: lyric.length } : { node: chords.firstChild, length: text.length };
          const advance = range(sample.node, 0, sample.length).width / sample.length;
          const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance));
          return { chords: text, lyrics: lyrics ? lyric : undefined, at };
        });
      })()`);
    const places = (rows: Row[]) => chordAnchors(rows).map((anchor) => anchor.replace(/^\S+ /, ""));

    // The five kinds of U2, as files on disk.
    const FIVE = {
      "harbor.txt": write("harbor.txt", HARBOR),
      "lanterns.cho": write("lanterns.cho", LANTERNS),
      "moss.html": write("moss.html", MOSS),
      "quarry.rtf": write("quarry.rtf", rtfOf(QUARRY)),
      "willow.docx": write("willow.docx", docx(documentXml(WILLOW, "Courier New"))),
    };

    await check(SCREEN_CASES.U1, async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Search songs") || !!document.querySelector(".song-list")`, "My Songs, signed out");
      assert.equal(await s.evaluate<boolean>(`!!${importButton}`), false, "no Import files signed out");
      const dropped = await s.evaluate<boolean>(`(() => {
        const data = new DataTransfer();
        data.items.add(new File(["G C\\nwords"], "dropped.txt", { type: "text/plain" }));
        document.body.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
        return !document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      })()`);
      await sleep(400);
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".song-import")`), false, "a drag opens nothing");
      assert.equal(dropped, false, "the page takes no drop");
      await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(ACCOUNT.userId)})`);
      await s.send("Page.reload");
      await app.library();
      await onSongs();
      await app.until(`!!${importButton}`, "Import files, signed in", 8000);
      assert.equal(await s.evaluate<string>(`${button("+ Add a song")}.nextElementSibling?.textContent.trim()`), "Import files", "right under + Add a song");
    });
    if (!(await s.evaluate<string | null>(`localStorage.getItem("leadSheetsSignedIn")`))) {
      await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(ACCOUNT.userId)})`);
      await s.send("Page.reload");
      await app.library();
    }

    await check(SCREEN_CASES.U13, async () => {
      await openImport();
      await pick([]);
      await s.evaluate(`document.querySelector(".song-import input[type=file]").dispatchEvent(new Event("change", { bubbles: true }))`);
      await s.evaluate(`document.querySelector(".song-import input[type=file]").dispatchEvent(new Event("cancel", { bubbles: true }))`);
      await sleep(500);
      assert.equal(await s.evaluate<boolean>(`!!${button("Choose files", sheet)}`), true, "still on Choose files");
      assert.equal((await rowsOf()).length, 0, "no row");
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".song-import-reading")`), false, "nothing reading");
      assert.deepEqual(
        await s.evaluate<[boolean, boolean]>(`(() => { const el = document.querySelector(".song-import input[type=file]"); return [el.multiple, el.hasAttribute("accept")]; })()`),
        [true, false],
        "the picker takes many files, with no type filter",
      );
      await closeImport();
      assert.equal(await s.evaluate<boolean>(`!!${sheet}`), false, "Close with no rows asks nothing");
    });

    await check(SCREEN_CASES.U2, async () => {
      await openImport();
      await pick(Object.values(FIVE));
      await allRead(5);
      const rows = await rowsOf();
      assert.deepEqual(
        rows.map((row) => row.name),
        Object.keys(FIVE),
        "the picked order",
      );
      assert.deepEqual(
        rows.map((row) => row.mark),
        ["Looks good", "Looks good", "Looks good", "Looks good", "Looks good"],
        `each with its mark (${js(rows.map((row) => row.text))})`,
      );
      assert.equal(await saveLabel(), "Save 5 songs", "five to save");
    });

    await check(SCREEN_CASES.U8, async () => {
      await tapIn(`[...document.querySelectorAll(".song-import-open")].find((b) => b.textContent.trim() === "harbor.txt")`, "harbor.txt row");
      await app.until(`!!document.querySelector(".song-import-preview .chart .pair")`, "the row's sheet");
      const preview = await drawn(".song-import-preview");
      assert.equal(preview.length, HARBOR_ROWS.length, `four chord rows drawn (${js(preview)})`);
      assert.deepEqual(places(preview), places(HARBOR_ROWS), `the preview draws each chord over its letter in the file (${js(preview)})`);
      await tapIn(button("Back to the list", sheet), "Back to the list");
    });

    await check(SCREEN_CASES.U3, async () => {
      await setTitle("moss.html", "Moss Garden Wall");
      assert.equal(await s.evaluate<string>(`${titleField("moss.html")}.value`), "Moss Garden Wall", "the title edits");
      assert.equal(await saveLabel(), "Save 5 songs", "still five");
      await setTitle("willow.docx", "");
      const row = (await rowsOf()).find((each) => each.name === "willow.docx");
      assert.ok(row?.text.includes("Add a title"), "the row says Add a title");
      assert.equal(await s.evaluate<string | null>(`${titleField("willow.docx")}.getAttribute("aria-invalid")`), "true", "the field is outlined");
      assert.equal(await saveLabel(), "Save 4 songs", "the count drops by one");
    });

    await check(SCREEN_CASES.U4, async () => {
      await tapIn(`[...document.querySelectorAll(".song-import-open")].find((b) => b.textContent.trim() === "harbor.txt")`, "harbor.txt row");
      await app.until(`document.querySelectorAll(".song-import-preview .chart-heading").length >= 2`, "the row's headings");
      assert.deepEqual(await app.texts(".song-import-preview .chart-heading"), ["VERSE 1", "CHORUS"], "the real sheet's headings");
      await tapIn(button("Edit", `document.querySelector(".song-import-preview")`), "Edit");
      const editor = `document.querySelector(".song-editor[role=dialog]")`;
      await app.until(`!!${editor}`, "the song editor");
      const field = (label: string) => `[...${editor}.querySelectorAll("label")].find((l) => l.textContent.trim() === ${js(label)})?.control`;
      assert.equal(await s.evaluate<string>(`${field("Title")}?.value`), "Harbor Bells", "the row's title");
      assert.equal(await s.evaluate<string>(`${field("Key")}?.value`), "D", "the row's key");
      assert.ok((await s.evaluate<string>(`${field("Chart")}?.value`)).includes("Bells are ringing on the water"), "the row's chart");
      const before = (await library()).length;
      await tapIn(button("Save", editor), "Save in the editor");
      await app.until(`!${editor} && !!${sheet} && !document.querySelector(".song-import-preview")`, "back to the list");
      const row = (await rowsOf()).find((each) => each.name === "harbor.txt");
      assert.equal(row?.mark, "Saved", "the row is saved");
      assert.equal((await library()).length, before + 1, "one song saved");
      assert.equal((await songsTitled("Harbor Bells")).length, 1, "Harbor Bells is in My Songs");
      assert.equal(await s.evaluate<string>(`location.hash`), "#/songs", "the list stays, with no jump to the song");
      assert.equal(await saveLabel(), "Save 3 songs", "three left to save");
      // A row with no title opens in the editor with nothing looked up: import makes no network call.
      await tapIn(`[...document.querySelectorAll(".song-import-open")].find((b) => b.textContent.trim() === "willow.docx")`, "willow.docx row");
      await tapIn(button("Edit", `document.querySelector(".song-import-preview")`), "Edit on willow.docx");
      await app.until(`!!${editor}`, "the song editor on a row with no title");
      await sleep(800);
      assert.deepEqual(await s.evaluate<string[]>(`window.__catalogCalls`), [], "the editor asks the catalog nothing");
      await tapIn(button("Cancel", editor), "Cancel in the editor");
      await app.until(`!${editor} && !!document.querySelector(".song-import-preview")`, "back to the row's sheet");
      await tapIn(button("Back to the list", sheet), "Back to the list");
      assert.equal((await rowsOf()).find((each) => each.name === "willow.docx")?.mark, "Check this", "the row is as it was");
    });

    await check(SCREEN_CASES.U5, async () => {
      await tapIn(rowButton("quarry.rtf", "Skip"), "Skip on quarry.rtf");
      assert.equal(await saveLabel(), "Save 2 songs", "Skip takes it from the count");
      assert.equal((await rowsOf()).find((row) => row.name === "quarry.rtf")?.mark, "Set aside", "set aside");
      await tapIn(rowButton("quarry.rtf", "Undo"), "Undo on quarry.rtf");
      assert.equal(await saveLabel(), "Save 3 songs", "Undo brings it back");
    });

    await check(SCREEN_CASES.U10, async () => {
      for (const width of [360, 390]) {
        await phone(width);
        const report = await s.evaluate<{ what: string; h: number; left: number; right: number; clipped: boolean }[]>(`(() => {
          const out = [];
          for (const el of document.querySelectorAll(".song-import button, .song-import input:not([type=file])")) {
            if (!el.getClientRects().length) continue;
            const r = el.getBoundingClientRect();
            out.push({ what: el.textContent.trim() || el.getAttribute("aria-label") || el.tagName, h: r.height, left: r.left, right: r.right, clipped: el.scrollWidth > el.clientWidth + 1 });
          }
          return out;
        })()`);
        assert.ok(report.length >= 10, `${width} px: the controls (${report.length})`);
        for (const box of report) {
          assert.ok(box.h >= 44, `${width} px: ${box.what} is ${box.h} px tall`);
          assert.ok(box.left >= 0 && box.right <= width + 0.5, `${width} px: ${box.what} runs ${box.left}..${box.right}`);
          assert.ok(!box.clipped, `${width} px: ${box.what} is clipped`);
        }
        const wide = await s.evaluate<number>(`[...document.querySelectorAll(".song-import-row")].filter((r) => r.scrollWidth > r.clientWidth + 1).length`);
        assert.equal(wide, 0, `${width} px: no row scrolls sideways`);
        assert.ok((await s.evaluate<number>(`document.documentElement.scrollWidth`)) <= width + 0.5, `${width} px: the page does not scroll sideways`);
      }
      await phone(390);
    });

    const SAVED_THREE = ["Paper Lanterns", "Moss Garden Wall", "Quarry Song"];
    await check(SCREEN_CASES.U6, async () => {
      const before = (await library()).length;
      assert.equal(await saveLabel(), "Save 3 songs", "the button says Save 3 songs");
      await tapIn(button("Save 3 songs", sheet), "Save 3 songs");
      await app.until(`(${sheet}?.querySelector(".song-import-done")?.textContent ?? "").includes("3 songs saved")`, "3 songs saved");
      const done = await s.evaluate<string>(`${sheet}.querySelector(".song-import-done").textContent`);
      assert.ok(done.includes("1 needs a title"), `the leftovers (${done})`);
      assert.equal((await library()).length, before + 3, "three songs added");
      for (const title of SAVED_THREE) assert.equal((await songsTitled(title)).length, 1, `${title} saved once`);
      assert.deepEqual(
        (await rowsOf()).map((row) => row.mark),
        ["Saved", "Saved", "Saved", "Saved", "Check this"],
        "the rows say saved",
      );
      await closeImport();
      await app.until(`[...document.querySelectorAll(".song-row")].some((r) => r.textContent.includes("Paper Lanterns"))`, "the songs in My Songs");
      await app.until(`!!navigator.serviceWorker?.controller`, "the service worker", 15000);
      await s.send("Network.enable");
      await s.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        assert.equal(await s.evaluate<string>(`fetch("/api/me?probe=" + Date.now(), { cache: "no-store" }).then(() => "online", () => "offline")`), "offline", "the network is off");
        await s.send("Page.reload");
        await sleep(500);
        for (const title of [...SAVED_THREE, "Harbor Bells"]) {
          const [song] = await songsTitled(title);
          await s.evaluate(`location.hash = "#/song/${song.id}"`);
          await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(title)} && document.querySelectorAll(".sheet .chart .chart-heading").length >= 1`, `${title} with its chart, offline`, 15000);
        }
      } finally {
        await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await s.evaluate(`location.hash = "#/songs"`);
        await s.send("Page.reload");
        await app.library();
      }
    });

    await check(SCREEN_CASES.U8.replace("U8.", "U8b.") + ", after Save", async () => {
      const [song] = await songsTitled("Harbor Bells");
      assert.ok(song, "Harbor Bells is saved");
      await s.evaluate(`location.hash = "#/song/${song.id}"`);
      await app.until(`!!document.querySelector(".sheet .chart .pair")`, "the saved sheet");
      assert.deepEqual(places(await drawn(".sheet")), places(HARBOR_ROWS), "the saved sheet draws each chord over its letter in the file");
    });

    await check(SCREEN_CASES.U7, async () => {
      await openImport();
      await pick([write("pebble-one.txt", chartOf("Pebble Creek One")), write("pebble-two.txt", chartOf("Pebble Creek Two"))]);
      await allRead(2);
      const before = (await library()).length;
      await s.evaluate(`(() => { const b = ${button("Save 2 songs", sheet)}; b.click(); b.click(); })()`);
      await app.until(`(${sheet}?.querySelector(".song-import-done")?.textContent ?? "").includes("2 songs saved")`, "2 songs saved");
      await s.evaluate(`${sheet}.querySelector(".song-import-bottom .is-primary").click()`);
      await sleep(300);
      assert.equal((await library()).length, before + 2, "two songs, once each");
      assert.equal(await saveLabel(), "Nothing to save", "the button says Nothing to save");
      assert.equal(await s.evaluate<boolean>(`${sheet}.querySelector(".song-import-bottom .is-primary").disabled`), true, "and is disabled");
      await closeImport();
    });

    await check(SCREEN_CASES.B11, async () => {
      await s.send("Page.reload");
      await app.library();
      const before = (await library()).length;
      await openImport();
      await pick([FIVE["harbor.txt"], FIVE["lanterns.cho"], FIVE["quarry.rtf"]]);
      await allRead(3);
      const rows = await rowsOf();
      for (const [row, title] of rows.map((each, at) => [each, ["Harbor Bells", "Paper Lanterns", "Quarry Song"][at]] as const)) {
        assert.equal(row.mark, "Check this", `${row.name} wants a look`);
        assert.ok(row.text.includes(`You already have ${title}.`), `${row.name} says You already have ${title}`);
        assert.ok(row.text.includes("Keep both") && row.text.includes("Replace") && row.text.includes("Skip"), `${row.name} offers three choices`);
      }
      assert.equal(await saveLabel(), "Nothing to save", "Save takes none of them");
      assert.equal((await library()).length, before, "nothing added");
    });

    await check(SCREEN_CASES.B5s, async () => {
      const [first] = await songsTitled("Quarry Song");
      assert.ok(first, "Quarry Song is saved");
      const before = JSON.stringify(first);
      await tapIn(rowButton("quarry.rtf", "Keep both"), "Keep both on quarry.rtf");
      assert.equal(await saveLabel(), "Save 1 song", "Keep both makes it one to save");
      await tapIn(button("Save 1 song", sheet), "Save 1 song");
      await app.until(`(${sheet}?.querySelector(".song-import-done")?.textContent ?? "").includes("1 song saved")`, "1 song saved");
      const both = await songsTitled("Quarry Song");
      assert.equal(both.length, 2, "two songs of that title");
      assert.equal(JSON.stringify(both.find((song) => song.id === first.id)), before, "the first is byte-for-byte unchanged");
      await closeImport();
    });

    await check(SCREEN_CASES.B6, async () => {
      const [lanterns] = await songsTitled("Paper Lanterns");
      assert.ok(lanterns, "Paper Lanterns is saved");
      // A setlist that holds it, written by the app's own storage code, then read by the app on reload.
      await inPage(`__read.storage.addOwnSetlist({ name: "Friday Set", songIds: [${lanterns.id}] })`);
      await s.send("Page.reload");
      await app.library();
      const builtIn = await s.evaluate<{ title: string; artist: string }>(`fetch("/data/library.json").then((r) => r.json()).then((l) => ({ title: l.songs[0].title, artist: l.songs[0].artist }))`);
      const newer = LANTERNS.replace("[Em]Hold the [C]string", "[Am]Hold the [D]string tight");
      await openImport();
      await pick([write("lanterns-new.cho", newer), write("built-in.txt", `{title: ${builtIn.title}}\n{artist: ${builtIn.artist}}\n\n[Verse 1]\n[G]Zorble words [C]here\n`)]);
      await allRead(2);
      const builtInRow = (await rowsOf())[1];
      assert.ok(builtInRow.text.includes(`You already have ${builtIn.title}.`), `the built-in song is flagged (${builtInRow.text})`);
      assert.ok(builtInRow.text.includes("Keep both") && builtInRow.text.includes("Skip"), "Keep both and Skip for a built-in song");
      assert.equal(await s.evaluate<boolean>(`!!${rowButton("built-in.txt", "Replace")}`), false, "no Replace for a built-in song");
      await tapIn(rowButton("lanterns-new.cho", "Replace"), "Replace on lanterns-new.cho");
      await app.until(`(${sheet}?.textContent ?? "").includes("Replace the chart of Paper Lanterns? This can't be undone.")`, "the Replace question");
      await tapIn(`${sheet}.querySelector(".song-import-ask .is-danger")`, "Replace in the question");
      await app.until(`[...document.querySelectorAll(".song-import-row")].find((r) => r.textContent.includes("lanterns-new.cho"))?.dataset.mark === "saved"`, "the row saved");
      const after = await songsTitled("Paper Lanterns");
      assert.equal(after.length, 1, "still one Paper Lanterns");
      assert.equal(after[0].id, lanterns.id, "the same id");
      assert.ok(JSON.stringify(after[0].body).includes("tight"), "the new chart");
      assert.ok(!JSON.stringify(after[0].body).includes("Em"), "the old chart is gone");
      const setlists = await s.evaluate<{ name: string; songIds: number[] }[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary")).setlists`);
      assert.deepEqual(setlists.find((each) => each.name === "Friday Set")?.songIds, [lanterns.id], "its place in the setlist");
      await closeImport();
    });

    await check(SCREEN_CASES.B3s, async () => {
      await openImport();
      const failing: [string, Uint8Array | string, string][] = [
        ["photo.png", PNG, "unsupported"],
        ["old.doc", OLD_WORD, "old-word"],
        ["empty.txt", new Uint8Array(0), "empty"],
        ["blank.txt", "   \n\n   \n", "no-text"],
        ["broken.docx", noise(400), "damaged"],
      ];
      await pick(failing.map(([name, data]) => write(name, data)));
      await allRead(failing.length);
      const rows = await rowsOf();
      for (const [at, [name, , reason]] of failing.entries()) {
        assert.equal(rows[at].name, name, `row ${at + 1} is ${name}`);
        assert.equal(rows[at].mark, "Couldn't read", `${name} couldn't be read`);
        const words = await s.evaluate<string>(`[...document.querySelectorAll(".song-import-row")][${at}].querySelector(".song-import-why")?.textContent ?? ""`);
        assert.equal(words, UNREAD_WORDS[reason], `${name} gives its reason in words`);
      }
      assert.equal(await saveLabel(), "Nothing to save", "Nothing to save");
      assert.equal(await s.evaluate<boolean>(`${sheet}.querySelector(".song-import-bottom .is-primary").disabled`), true, "disabled");
      await closeImport();
    });

    await check(SCREEN_CASES.B8, async () => {
      await openImport();
      const names = ["Ferrous One", "Ferrous Two", "Ferrous Three"];
      await pick(names.map((title, at) => write(`ferrous-${at + 1}.txt`, chartOf(title))));
      await allRead(3);
      // A full store: the library write is refused once it would hold more than one of these songs.
      await s.evaluate(`(() => {
        const real = Storage.prototype.setItem;
        window.__realSetItem = real;
        Storage.prototype.setItem = function (key, value) {
          if (key === "leadSheetsLibrary" && (String(value).match(/Ferrous/g) ?? []).length > 1) throw new DOMException("full", "QuotaExceededError");
          return real.call(this, key, value);
        };
      })()`);
      try {
        await tapIn(button("Save 3 songs", sheet), "Save 3 songs");
        await app.until(`(${sheet}?.textContent ?? "").includes("This phone couldn't save the song. Free some space and try again.")`, "the landed message");
        assert.deepEqual(
          (await rowsOf()).map((row) => row.mark),
          ["Saved", "Looks good", "Looks good"],
          "the saved row is marked and the rest stay",
        );
        assert.equal(await saveLabel(), "Save 2 songs", "two left");
      } finally {
        await s.evaluate(`Storage.prototype.setItem = window.__realSetItem`);
      }
      await tapIn(button("Save 2 songs", sheet), "Save 2 songs");
      await app.until(`(${sheet}?.querySelector(".song-import-done")?.textContent ?? "").includes("2 songs saved")`, "2 songs saved");
      for (const title of names) assert.equal((await songsTitled(title)).length, 1, `${title} saved once`);
      assert.equal(await s.evaluate<boolean>(`(${sheet}?.textContent ?? "").includes("couldn't save")`), false, "the message goes");
      await closeImport();
    });

    await check(SCREEN_CASES.U9, async () => {
      await openImport();
      await pick([write("left-one.txt", chartOf("Leftover One")), write("left-two.txt", chartOf("Leftover Two"))]);
      await allRead(2);
      await tapIn(button("Close", sheet), "Close");
      assert.equal(await s.evaluate<number>(`document.querySelectorAll(".song-import-ask").length`), 1, "one question");
      assert.ok((await s.evaluate<string>(`${sheet}.querySelector(".song-import-ask").textContent`)).includes("Leave without saving 2 songs?"), "it asks");
      await tapIn(button("Stay", sheet), "Stay");
      assert.equal((await rowsOf()).length, 2, "Stay keeps the rows");
      await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await sleep(200);
      assert.ok((await s.evaluate<string>(`${sheet}?.querySelector(".song-import-ask")?.textContent ?? ""`)).includes("Leave without saving 2 songs?"), "Escape asks the same question");
      assert.equal(await s.evaluate<boolean>(`!!${sheet}`), true, "and does not close yet");
      await tapIn(button("Leave", sheet), "Leave");
      await app.until(`!${sheet}`, "the sheet closed");
      assert.equal(await songsTitled("Leftover One").then((songs) => songs.length), 0, "nothing saved");
    });

    await check(SCREEN_CASES.U11, async () => {
      await onSongs();
      await s.evaluate(`(() => {
        const data = new DataTransfer();
        data.items.add(new File([${js(chartOf("Dropped One"))}], "dropped-one.txt", { type: "text/plain" }));
        data.items.add(new File([${js(chartOf("Dropped Two"))}], "dropped-two.txt", { type: "text/plain" }));
        document.body.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      })()`);
      await app.until(`!!${sheet}`, "the sheet from a drop");
      await allRead(2);
      assert.deepEqual(
        (await rowsOf()).map((row) => [row.name, row.mark]),
        [
          ["dropped-one.txt", "Looks good"],
          ["dropped-two.txt", "Looks good"],
        ],
        "two rows",
      );
      await closeImport();
    });

    await check(SCREEN_CASES.B9s, async () => {
      await openImport();
      const paths = Array.from({ length: 40 }, (_, at) => write(`stop-${at + 1}.txt`, chartOf(`Stop Pebble ${at + 1}`)));
      await s.send("Emulation.setCPUThrottlingRate", { rate: 8 });
      let seen = "";
      try {
        await pick(paths);
        // In the page, so the tap lands while the pile is still reading.
        seen = await s.evaluate<string>(`new Promise((done) => {
          const end = Date.now() + 15000;
          const look = () => {
            const status = document.querySelector(".song-import-reading [role=status]")?.textContent.trim() ?? "";
            const at = Number(/^Reading (\\d+) of 40$/.exec(status)?.[1] ?? 0);
            if (at >= 3) {
              [...document.querySelectorAll(".song-import-reading button")].find((b) => b.textContent.trim() === "Stop").click();
              return done(status);
            }
            if (Date.now() > end) return done("none: " + status);
            setTimeout(look, 5);
          };
          look();
        })`);
        await app.until(`!document.querySelector(".song-import-reading")`, "the reading to stop", 15000);
      } finally {
        await s.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      assert.match(seen, /^Reading \d+ of 40$/, "Reading N of 40 showed");
      const rows = await rowsOf();
      assert.ok(rows.length >= 3 && rows.length < 40, `the rows that are done stay, and no more (${rows.length})`);
      assert.ok(rows.every((row) => row.mark === "Looks good"), "none waiting or reading");
      await sleep(500);
      assert.equal((await rowsOf()).length, rows.length, "nothing more is read after Stop");
      await pick([write("after-stop.txt", chartOf("After Stop Pebble"))]);
      await allRead(rows.length + 1);
      assert.equal((await rowsOf()).at(-1)?.name, "after-stop.txt", "a pick after Stop reads again");
      await closeImport();
    });

    await check(SCREEN_CASES.U12, async () => {
      await openImport();
      await pick([write("account-one.txt", chartOf("Account Pebble One")), write("account-two.txt", chartOf("Account Pebble Two"))]);
      await allRead(2);
      assert.deepEqual(
        (await rowsOf()).map((row) => row.mark),
        ["Looks good", "Looks good"],
        "two ready rows",
      );
      // The session ends: backup is on for this account, and the server now answers 401.
      await s.evaluate(`localStorage.setItem("leadSheetsBackup", ${js(js({ account: ACCOUNT.userId, pulled: 0, synced: {}, at: null }))})`);
      server.backup = 401;
      server.me = null;
      await s.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      await app.until(`!${sheet}`, "the sheet to close when the session ends");
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".song-import-ask")`), false, "with no question");
      assert.equal(await s.evaluate<boolean>(`!!${importButton}`), false, "no Import files while signed out");
      server.backup = 404;
      // A second account signs in on this phone, with a password.
      await app.openMenu();
      await app.pick("Sign in");
      await app.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign in with a password")`, "the password way in");
      await app.click("Sign in with a password");
      await app.type("Your @name", SECOND.handle);
      await app.type("Password", "violet tram 42 lantern");
      await app.click("Sign in", `document.querySelector(".account-sheet")`);
      await app.until(`["account", "nudge"].includes(document.querySelector(".account-sheet")?.dataset.step)`, "signed in as the second account", 20000);
      await s.evaluate(`[...document.querySelectorAll(".account-sheet button")].find((b) => b.textContent.trim() === "✕")?.click()`);
      await app.closeMenu();
      await onSongs();
      await app.until(`!!${importButton}`, "Import files for the second account", 8000);
      assert.equal(await s.evaluate<boolean>(`!!${sheet}`), false, "the sheet stays closed");
      await openImport();
      assert.equal((await rowsOf()).length, 0, "no row from the first account's pile");
      assert.equal(await s.evaluate<boolean>(`!!${button("Choose files", sheet)}`), true, "on Choose files");
      for (const title of ["Account Pebble One", "Account Pebble Two"]) assert.equal((await songsTitled(title)).length, 0, `no ${title} stored`);
      await closeImport();
      // In the app a sign-in passes through Settings, and a change of page closes every editor. The editors close
      // the sheet themselves too, so an account switch that comes with no change of page drops the rows as well.
      const alone = await inPage<{ first: boolean; closed: number; second: boolean; out: boolean }>(`(async () => {
        const { SongEditors, createElement, createRoot, flushSync } = __read;
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        let closed = 0;
        let editing = "import";
        // As App does, onClose sets editing to null.
        const draw = (userId) => flushSync(() => root.render(createElement(SongEditors, { editing, song: undefined, songs: [], userId, files: [], onSongData() {}, onTempo() {}, onClose: () => ((closed += 1), (editing = null)) })));
        const showing = () => !!host.querySelector(".song-import");
        const wait = () => new Promise((done) => setTimeout(done, 100));
        draw(${js(ACCOUNT.userId)});
        await wait();
        const first = showing();
        draw(${js(SECOND.userId)});
        await wait();
        draw(${js(SECOND.userId)});
        await wait();
        const result = { first, closed, second: showing() };
        draw(null);
        await wait();
        result.out = showing();
        root.unmount();
        host.remove();
        return result;
      })()`);
      assert.equal(alone.first, true, "the editors show the sheet for the first account");
      assert.equal(alone.closed, 1, "a second account closes the sheet once, with no change of page");
      assert.equal(alone.second, false, "the sheet is not drawn for the second account");
      assert.equal(alone.out, false, "or for no account");
    });

    await check(SCREEN_CASES.P2, async () => {
      const paths = Array.from({ length: 100 }, (_, at) => write(`speed-${at + 1}.txt`, chartOf(`Speed Pebble ${at + 1}`)));
      await openImport();
      await s.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        const started = process.hrtime.bigint();
        await pick(paths);
        await allRead(100, 30000);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        console.log(`     100 text files read in ${Math.round(ms)} ms at 4x CPU slowdown`);
        assert.ok(ms <= 5000, `${Math.round(ms)} ms is within 5 s`);
        const saveStarted = process.hrtime.bigint();
        await s.evaluate(`${button("Save 100 songs", sheet)}.click()`);
        await app.until(`(${sheet}?.querySelector(".song-import-done")?.textContent ?? "").includes("100 songs saved")`, "100 songs saved", 30000);
        console.log(`     Save for 100 ready rows took ${Math.round(Number(process.hrtime.bigint() - saveStarted) / 1e6)} ms on the sheet at 4x CPU slowdown`);
      } finally {
        await s.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      await closeImport();
    });

    await check(SCREEN_CASES.P3, async () => {
      await s.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        const times = await inPage<{ one: number; many: number; ones: number; manys: number }>(`(() => {
          const { addOwnSong, addOwnSongs } = __read.storage;
          const song = (n) => __read.ownSong({ title: "Timing Pebble " + n, artist: "The Made Up Band", keyRoot: "A", keyMode: "major", tempo: null, timeSignature: "4/4" }, [{ heading: "Verse 1", lines: [{ chords: "A       E", lyrics: "Pebbles tumble down the creek " + n }] }]);
          const saved = localStorage.getItem("leadSheetsLibrary");
          let at = performance.now();
          let ones = 0;
          for (let n = 0; n < 100; n += 1) if (addOwnSong(song(n)) !== null) ones += 1;
          const one = performance.now() - at;
          localStorage.setItem("leadSheetsLibrary", saved);
          at = performance.now();
          const manys = (addOwnSongs(Array.from({ length: 100 }, (_, n) => song(n))) ?? []).filter((id) => id !== null).length;
          const many = performance.now() - at;
          localStorage.setItem("leadSheetsLibrary", saved);
          return { one, many, ones, manys };
        })()`);
        console.log(`     100 addOwnSong calls ${Math.round(times.one)} ms, one addOwnSongs ${Math.round(times.many)} ms, ${(times.one / times.many).toFixed(1)} times faster, at 4x CPU slowdown`);
        assert.equal(times.ones, 100, "the baseline saved 100");
        assert.equal(times.manys, 100, "addOwnSongs saved 100");
        assert.ok(times.one / times.many >= 5, `${(times.one / times.many).toFixed(1)} times faster`);
        assert.ok(times.many <= 2000, `${Math.round(times.many)} ms is within 2 s`);
      } finally {
        await s.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    });

    await check(SCREEN_CASES.P4, async () => {
      const result = await inPage<{ first: number; second: number; refused: boolean; size: number }>(`(() => {
        const { addOwnSongs } = __read.storage;
        const saved = localStorage.getItem("leadSheetsLibrary");
        const song = (n) => __read.ownSong({ title: "Store Pebble " + n, artist: "The Made Up Band", keyRoot: "A", keyMode: "major", tempo: 96, timeSignature: "4/4" }, [{ heading: "Verse 1", lines: [{ chords: "A       E", lyrics: "Pebbles tumble down the creek " + n }, { chords: "D       A", lyrics: "Over moss and over stone " + n }] }, { heading: "Chorus", lines: [{ chords: "E   D", lyrics: "Tumble along " + n }] }]);
        const first = (addOwnSongs(Array.from({ length: 100 }, (_, n) => song(n))) ?? []).filter((id) => id !== null).length;
        const ids = addOwnSongs(Array.from({ length: 200 }, (_, n) => song(100 + n)));
        const size = (localStorage.getItem("leadSheetsLibrary") ?? "").length;
        const second = (ids ?? []).filter((id) => id !== null).length;
        localStorage.setItem("leadSheetsLibrary", saved);
        return { first, second, refused: ids === null, size };
      })()`);
      console.log(`     200 songs on top of 100: ${result.refused ? "refused" : "stored"}, library ${(result.size / 1024).toFixed(1)} KB`);
      assert.equal(result.first, 100, "100 first");
      assert.equal(result.refused, false, "the write is taken");
      assert.equal(result.second, 200, "200 more");
    });

    const errors = (await app.errors()) ?? [];
    await check("screen. the page threw no error while the sheet ran", () => {
      assert.ok(opened >= 10, "the sheet opened");
      assert.deepEqual(errors, []);
    });
  } finally {
    await s.close();
  }
}
api.closeAllConnections();
api.close();
rmSync(files, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
// The Vite build of the size case can leave a handle open, so the check ends itself.
process.exit(0);
