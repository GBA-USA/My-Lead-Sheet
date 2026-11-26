import { chordRowOf } from "./song-paste";
import {
  decodeText,
  isMonospace,
  isOldWord,
  kindOf,
  kindOfName,
  MAX_BYTES,
  MAX_CHARS,
  MAX_FILES,
  READ_MS,
  Unread,
  type Extracted,
  type ImportKind,
  type ReadResult,
  type Reader,
  type UnreadReason,
} from "./song-import.js";
import { untab } from "./song-text";

/**
 * Bulk import's readers: each turns a file's bytes into the text `readPaste` takes, and nothing more. Sections, facts
 * and chord spellings are the paste's to find. A reader recovers the file's lines, and where the file names a font
 * that is not monospace, it measures where each chord sits and writes it inline, keeping the columns as the other
 * reading. Every reader runs on the phone and ends on a file cut off at any point.
 */

/** One file inside a zip: its bytes, or why it was not inflated. */
export type ZipEntry = { name: string; bytes: Uint8Array } | { name: string; why: "too-big" | "damaged" };

const u16 = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes: Uint8Array, at: number) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;

/** Inflates a deflated run, stopping as soon as it passes `limit` bytes. Null past the limit. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The files in a zip, read from the directory at its end and inflated by the browser's own `DecompressionStream`.
 * Folders, and the hidden files a Mac adds, are left out. An entry is not inflated past `limit` bytes, whatever its
 * header claims. A zip with no directory is damaged.
 */
export async function unzip(bytes: Uint8Array, limit = MAX_BYTES): Promise<ZipEntry[]> {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Unread("damaged");
  const count = u16(bytes, end + 10);
  const entries: ZipEntry[] = [];
  for (let at = u32(bytes, end + 16), n = 0; n < count && at + 46 <= bytes.length && u32(bytes, at) === 0x02014b50; n += 1) {
    const method = u16(bytes, at + 10);
    const packed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\._/.test(name)) continue;
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (u32(bytes, local) !== 0x04034b50 || start + packed > bytes.length) {
      entries.push({ name, why: "damaged" });
      continue;
    }
    const data = bytes.subarray(start, start + packed);
    if (size > limit || (method === 0 && packed > limit)) entries.push({ name, why: "too-big" });
    else if (method === 0) entries.push({ name, bytes: data });
    else if (method !== 8) entries.push({ name, why: "damaged" });
    else {
      const inflated = await inflate(data, limit).catch(() => undefined);
      entries.push(inflated ? { name, bytes: inflated } : { name, why: inflated === null ? "too-big" : "damaged" });
    }
  }
  return entries;
}

/** A ChordPro file holds a song for each `{new_song}` or `{ns}` part. */
const NEW_SONG = /^\s*\{\s*(?:new_song|ns)\s*\}\s*$/im;

export const readText: Reader = async (bytes) => {
  const parts = decodeText(bytes)
    .split(new RegExp(NEW_SONG.source, "gim"))
    .filter((part) => part.trim());
  if (parts.length === 0) throw new Unread("no-text");
  return parts.map((text) => ({ text, doubts: [] }));
};

const DROPPED = "script, style, noscript, template, nav, header, footer, form";
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CENTER", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "SECTION", "TABLE", "TR", "UL"]);

/** A page's chart: what its `pre` holds, or with no `pre`, one line for each block. Menus, scripts and forms are dropped. */
export const readHtml: Reader = async (bytes) => {
  const page = new DOMParser().parseFromString(decodeText(bytes), "text/html");
  for (const node of page.querySelectorAll(DROPPED)) node.remove();
  const title = page.title.trim();
  const pres = [...page.querySelectorAll("pre")].map((pre) => pre.textContent ?? "").filter((text) => text.trim());
  const lines: string[] = [""];
  const end = () => {
    if (lines[lines.length - 1] !== "") lines.push("");
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/[ \t\n\r\f]+/g, " ");
        lines[lines.length - 1] += lines[lines.length - 1] === "" ? text.trimStart() : text;
      } else if (child.nodeName === "BR") lines.push("");
      else if (child.nodeName === "TD" || child.nodeName === "TH") {
        walk(child);
        lines[lines.length - 1] += "  ";
      } else if (BLOCKS.has(child.nodeName)) {
        end();
        walk(child);
        end();
      } else walk(child);
    }
  };
  if (pres.length === 0 && page.body) walk(page.body);
  const text = pres.length > 0 ? pres.join("\n\n") : lines.map((line) => line.trimEnd()).join("\n");
  if (!text.trim()) throw new Unread("no-text");
  return [{ text, doubts: [], ...(title ? { title } : {}) }];
};

/** A line of a document with the font its first letters are set in, when the document says. */
export type FontLine = { text: string; font?: string };
/** A text's width in a font. */
export type Measure = (text: string, font: string) => number;

/** Widths as the browser draws them: the document's font when this phone has it, else a sans font. Null with no canvas. */
function canvasMeasure(): Measure | null {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
  const context = canvas?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  if (!context) return null;
  return (text, font) => {
    context.font = `16px "${font.replace(/["\\]/g, "")}", sans-serif`;
    return context.measureText(text).width;
  };
}

/** Each chord of a row over its words, inline, at the letter that starts where the chord starts when both are drawn in `font`. */
function measuredLine(chords: string, words: string, font: string, measure: Measure): string {
  const row = chordRowOf(chords)!;
  const edges = [...words].map((_, at) => measure(words.slice(0, at), font));
  const width = measure(words, font);
  const marks = row.chords.map(({ name, at }) => {
    const x = measure(chords.slice(0, at), font);
    if (x >= width) return { name, at: words.length };
    let best = 0;
    for (let i = 1; i < edges.length; i += 1) if (Math.abs(edges[i] - x) < Math.abs(edges[best] - x)) best = i;
    return { name, at: best };
  });
  let line = words;
  for (const { name, at } of [...marks].reverse()) line = `${line.slice(0, at)}${at === line.length && at > 0 ? " " : ""}[${name}]${line.slice(at)}`;
  return row.notes.length > 0 ? `${line} (${row.notes.join(", ")})` : line;
}

/**
 * The text of a document's lines. Where a chord row over a line of words is set in a font that is not monospace, its
 * columns are not its places, so the first reading measures each chord's place and the columns as typed are the
 * other, with the doubt `fonts`. A document set in monospace has one reading and no doubt.
 */
export function documentText(lines: FontLine[], measure: Measure | null = canvasMeasure()): Extracted {
  const columns = lines.map((line) => line.text).join("\n");
  const pairs = new Set<number>();
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const [chords, words] = [untab(lines[i].text), untab(lines[i + 1].text)];
    const font = lines[i].font ?? lines[i + 1].font;
    if (!words.trim() || !chordRowOf(chords) || chordRowOf(words) || (font !== undefined && isMonospace(font))) continue;
    pairs.add(i);
    i += 1;
  }
  if (pairs.size === 0) return { text: columns, doubts: [] };
  if (!measure) return { text: columns, doubts: ["fonts"] };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!pairs.has(i)) {
      out.push(lines[i].text);
      continue;
    }
    out.push(measuredLine(untab(lines[i].text), untab(lines[i + 1].text), lines[i].font ?? lines[i + 1].font ?? "sans-serif", measure));
    i += 1;
  }
  return { text: out.join("\n"), other: columns, doubts: ["fonts"] };
}

/** RTF groups whose text is not the document's: tables of fonts and colors, pictures, fields, headers and the like. */
const HIDDEN = new Set([
  "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "footnote",
  "fldinst", "listtable", "listoverridetable", "rsidtbl", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "generator",
  "filetbl", "revtbl", "pntext", "pntxta", "pntxtb", "shp", "shpinst", "nonshppict", "bkmkstart", "bkmkend", "xe", "tc", "mmathPr", "pgdsctbl",
]);
const SYMBOLS: Record<string, string> = { emdash: "—", endash: "–", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", bullet: "•", tab: "\t", cell: "  " };

type RtfGroup = { hidden: boolean; fonts: boolean; font: number; skip: number; uc: number };

/** The lines of an RTF file with their fonts. `\par` and `\line` end a line, and hidden groups are dropped. */
export function rtfLines(rtf: string): FontLine[] {
  const fonts = new Map<number, { name: string; fixed: boolean }>();
  let defaultFont = 0;
  let group: RtfGroup = { hidden: false, fonts: false, font: 0, skip: 0, uc: 1 };
  const stack: RtfGroup[] = [];
  const lines: FontLine[] = [{ text: "" }];
  let tableFont: number | null = null;
  let fontName = "";
  const put = (text: string) => {
    if (group.skip > 0) {
      group.skip -= 1;
      return;
    }
    if (group.hidden) return;
    if (group.fonts) {
      fontName += text;
      return;
    }
    const line = lines[lines.length - 1];
    if (line.font === undefined && text.trim()) {
      const font = fonts.get(group.font);
      if (font) line.font = font.fixed ? "monospace" : font.name;
    }
    line.text += text;
  };
  const endLine = () => {
    if (!group.hidden && !group.fonts) lines.push({ text: "" });
  };
  for (let i = 0; i < rtf.length; ) {
    const char = rtf[i];
    if (char === "{") {
      stack.push(group);
      group = { ...group, skip: 0 };
      i += 1;
    } else if (char === "}") {
      if (group.fonts && tableFont !== null && fontName) {
        const name = fontName.replace(/;\s*$/, "").trim();
        const known = fonts.get(tableFont);
        fonts.set(tableFont, { name, fixed: (known?.fixed ?? false) || isMonospace(name) });
        fontName = "";
      }
      group = stack.pop() ?? group;
      i += 1;
    } else if (char === "\r" || char === "\n") i += 1;
    else if (char !== "\\") {
      put(char);
      i += 1;
    } else {
      const next = rtf[i + 1];
      if (next === undefined) break;
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 4;
        if (/^[0-9a-f]{2}$/i.test(hex)) put(new TextDecoder("windows-1252").decode(new Uint8Array([parseInt(hex, 16)])));
      } else if (next === "*") {
        group.hidden = true;
        i += 2;
      } else if (/[a-z]/i.test(next)) {
        const word = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1, i + 40))!;
        i += 1 + word[0].length;
        const [name, number] = [word[1], word[2] === undefined ? undefined : Number(word[2])];
        if (HIDDEN.has(name)) group.hidden = true;
        else if (name === "fonttbl") group.fonts = true;
        else if (name === "par" || name === "line" || name === "row" || name === "sect" || name === "page") endLine();
        else if (name === "u" && number !== undefined) {
          put(String.fromCharCode(number < 0 ? number + 65536 : number));
          group.skip = group.uc;
        } else if (name === "uc" && number !== undefined) group.uc = number;
        else if (name === "bin" && number !== undefined) i += number;
        else if (name === "deff" && number !== undefined) defaultFont = number;
        else if (name === "plain") group.font = defaultFont;
        else if (name === "f" && number !== undefined) {
          if (group.fonts) {
            tableFont = number;
            fontName = "";
          } else group.font = number;
        } else if ((name === "fmodern" || (name === "fprq" && number === 1)) && group.fonts && tableFont !== null) {
          fonts.set(tableFont, { name: fonts.get(tableFont)?.name ?? "", fixed: true });
        } else if (SYMBOLS[name]) put(SYMBOLS[name]);
      } else {
        // \\, \{ and \} are their own letter, \~ a space that holds, and \- a place a word may break.
        if (next === "\\" || next === "{" || next === "}") put(next);
        else if (next === "~") put(" ");
        else if (next === "_") put("-");
        i += 2;
      }
    }
  }
  return lines;
}

export const readRtf: Reader = async (bytes) => {
  const { text, other, doubts } = documentText(rtfLines(decodeText(bytes)));
  if (!text.trim()) throw new Unread("no-text");
  return [{ text, doubts, ...(other === undefined ? {} : { other }) }];
};

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
    code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ENTITY[code.toLowerCase()],
  );

type Tag = { name: string; attributes: string; closing: boolean; empty: boolean };

/** Each tag of an XML text and the text between, in order, up to the last tag that is whole. */
function* xmlParts(xml: string): Generator<Tag | string> {
  for (let at = 0; at < xml.length; ) {
    const open = xml.indexOf("<", at);
    if (open < 0) {
      yield xml.slice(at);
      return;
    }
    if (open > at) yield xml.slice(at, open);
    const close = xml.indexOf(">", open);
    if (close < 0) return;
    const body = xml.slice(open + 1, close);
    at = close + 1;
    if (body[0] === "?" || body[0] === "!") continue;
    const tag = /^(\/?)([^\s/>]+)([\s\S]*?)(\/?)$/.exec(body);
    if (tag) yield { closing: tag[1] === "/", name: tag[2], attributes: tag[3], empty: tag[4] === "/" };
  }
}

const attribute = (tag: Tag, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag.attributes)?.[1];

/** The font a Word style sets, through the styles it is based on, by style id. */
function styleFonts(xml: string | undefined, theme: string | undefined): { fonts: Map<string, string>; base?: string } {
  const minor = theme ? /<a:minorFont>[\s\S]*?<a:latin typeface="([^"]*)"/.exec(theme)?.[1] : undefined;
  const major = theme ? /<a:majorFont>[\s\S]*?<a:latin typeface="([^"]*)"/.exec(theme)?.[1] : undefined;
  const fontOf = (tag: Tag) => attribute(tag, "w:ascii") ?? (attribute(tag, "w:asciiTheme")?.startsWith("major") ? major : attribute(tag, "w:asciiTheme") ? minor : undefined);
  const own = new Map<string, { font?: string; basedOn?: string }>();
  let base: string | undefined;
  let style: string | null = null;
  let defaults = false;
  for (const part of xml ? xmlParts(xml) : []) {
    if (typeof part === "string") continue;
    if (part.name === "w:docDefaults") defaults = !part.closing;
    else if (part.name === "w:style") style = part.closing ? null : (attribute(part, "w:styleId") ?? null);
    else if (part.name === "w:rFonts" && defaults) base ??= fontOf(part);
    else if (part.name === "w:rFonts" && style) own.set(style, { ...own.get(style), font: own.get(style)?.font ?? fontOf(part) });
    else if (part.name === "w:basedOn" && style) own.set(style, { ...own.get(style), basedOn: attribute(part, "w:val") });
  }
  const fonts = new Map<string, string>();
  for (const id of own.keys()) {
    let at: string | undefined = id;
    for (let depth = 0; at && depth < 10; depth += 1, at = own.get(at)?.basedOn) {
      const font = own.get(at)?.font;
      if (font) {
        fonts.set(id, font);
        break;
      }
    }
  }
  return { fonts, base: base ?? minor };
}

/**
 * The lines of a Word document with their fonts. Each paragraph is a line, a tab is a tab and a break ends a line.
 * A table row is one line. Tab stops, deleted text and the second copy Word keeps of a text box are not text.
 */
export function docxLines(xml: string, styles?: string, theme?: string): FontLine[] {
  const { fonts, base } = styleFonts(styles, theme);
  const lines: FontLine[] = [{ text: "" }];
  let paragraphFont: string | undefined;
  let runFont: string | undefined;
  let inText = false;
  let properties = 0;
  let fallback = 0;
  let table = 0;
  const put = (text: string) => {
    const line = lines[lines.length - 1];
    if (line.font === undefined && text.trim()) line.font = runFont ?? paragraphFont ?? base;
    line.text += text;
  };
  const endLine = () => lines.push({ text: "" });
  for (const part of xmlParts(xml)) {
    if (typeof part === "string") {
      if (inText && fallback === 0) put(xmlText(part));
      continue;
    }
    const { name, closing, empty } = part;
    if (name === "mc:Fallback") fallback += closing ? -1 : empty ? 0 : 1;
    if (fallback > 0) continue;
    if (name === "w:pPr") properties += closing ? -1 : empty ? 0 : 1;
    else if (name === "w:p" && !closing && !empty) paragraphFont = undefined;
    else if (name === "w:pStyle" && properties > 0) paragraphFont = fonts.get(attribute(part, "w:val") ?? "");
    else if (name === "w:r" && !closing) runFont = undefined;
    else if (name === "w:rStyle") runFont ??= fonts.get(attribute(part, "w:val") ?? "");
    else if (name === "w:rFonts" && properties === 0) runFont = attribute(part, "w:ascii") ?? attribute(part, "w:hAnsi") ?? runFont;
    else if (name === "w:t") inText = !closing && !empty;
    else if (name === "w:tab" && properties === 0) put("\t");
    else if (name === "w:br" || name === "w:cr") endLine();
    else if (name === "w:noBreakHyphen") put("-");
    else if (name === "w:tbl") table += closing ? -1 : empty ? 0 : 1;
    else if (name === "w:tc" && closing) put("  ");
    else if (name === "w:tr" && closing) endLine();
    else if (name === "w:p" && (closing || empty) && table === 0) endLine();
    else if (name === "w:p" && closing && table > 0) put(" ");
  }
  return lines.map((line) => ({ ...line, text: line.text.trimEnd() }));
}

export const readDocx: Reader = async (bytes) => {
  const entries = await unzip(bytes);
  const entry = (name: string) => entries.find((each) => each.name === name);
  const text = (found: ZipEntry | undefined) => (found && "bytes" in found ? new TextDecoder().decode(found.bytes) : undefined);
  const document = entry("word/document.xml");
  if (!document || !("bytes" in document)) throw new Unread("damaged");
  const read = documentText(docxLines(text(document)!, text(entry("word/styles.xml")), text(entry("word/theme/theme1.xml"))));
  if (!read.text.trim()) throw new Unread("no-text");
  return [read];
};

/**
 * One reader for each kind, or null for a kind no reader reads yet. A zip is opened by `readFiles` itself, so a zip
 * inside a zip is not opened. A later cook adds a reader by changing its line here.
 */
export const READERS: Record<ImportKind, Reader | null> = {
  text: readText,
  html: readHtml,
  rtf: readRtf,
  docx: readDocx,
  zip: null,
  pdf: null,
  image: null,
  musicxml: null,
  unknown: null,
};

/** A file the player picked or dropped, read only when its turn comes. */
export type Picked = { name: string; size: number; bytes: () => Promise<Uint8Array> };

export const pickedFile = (file: File): Picked => ({ name: file.name, size: file.size, bytes: () => file.arrayBuffer().then((buffer) => new Uint8Array(buffer)) });

/** What `readFiles` tells the pile, in the order it happens. */
export type ReadEvent =
  | { do: "pick"; rows: { id: string; name: string }[] }
  | { do: "reading"; id: string }
  | { do: "read"; id: string; results: ReadResult[] }
  | { do: "past"; count: number }
  | { do: "drop" };

export type ReadOptions = {
  readers?: Record<ImportKind, Reader | null>;
  timeLimit?: number;
  sizeLimit?: number;
  maxFiles?: number;
  /** Rows already in the pile, which count toward `maxFiles`. */
  counted?: number;
  /** Starts each row id, so a second pick in the same sheet gets ids of its own. */
  prefix?: string;
  /** Asked between two files. True ends the reading, and the rows not yet read are dropped. */
  stopped?: () => boolean;
};

/** A hex SHA-256 of the bytes, so the same file picked twice is known. */
async function printOf(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${bytes.length}.${(hash >>> 0).toString(36)}`;
}

/** The promise, or `Unread("slow")` once `ms` pass. A reader on the main thread can't be stopped, so each one also ends on any input. */
function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, refuse) => (timer = setTimeout(() => refuse(new Unread("slow")), ms)))]).finally(() => clearTimeout(timer));
}

const reasonOf = (error: unknown): UnreadReason => (error instanceof Unread ? error.reason : "damaged");

/**
 * Reads a pile one file at a time, in the order picked, and yields to the screen between two files. Each file is
 * read inside its own `try` and its own timer, so a reader that throws or never returns gives one Couldn't read row
 * and the next file starts. A file past the size limit never reaches a reader. A zip gives a row for each file in
 * it, named by its path, up to the pile's limit.
 */
export async function readFiles(files: Picked[], emit: (event: ReadEvent) => void, options: ReadOptions = {}): Promise<void> {
  const { readers = READERS, timeLimit = READ_MS, sizeLimit = MAX_BYTES, maxFiles = MAX_FILES, prefix = "", stopped = () => false } = options;
  const ids = files.map((_, at) => `${prefix}${at + 1}`);
  emit({ do: "pick", rows: files.map((file, at) => ({ id: ids[at], name: file.name })) });
  let counted = options.counted ?? 0;

  const readOne = async (bytes: Uint8Array, name: string): Promise<ReadResult[]> => {
    try {
      if (bytes.length === 0) return [{ name, why: "empty" }];
      if (bytes.length > sizeLimit) return [{ name, why: "too-big" }];
      if (isOldWord(bytes)) return [{ name, why: "old-word" }];
      const kind = kindOf(bytes, name);
      const reader = readers[kind];
      if (!reader) return [{ name, why: kind === "unknown" && kindOfName(name) !== undefined ? "damaged" : "unsupported" }];
      const read = await timed(reader(bytes, name), timeLimit);
      if (read.length === 0) return [{ name, why: "no-text" }];
      const print = await printOf(bytes);
      return read.map((extracted, part) => (extracted.text.length > MAX_CHARS ? { name, why: "damaged" } : { name, extracted, print: read.length === 1 ? print : `${print}.${part}` }));
    } catch (error) {
      return [{ name, why: reasonOf(error) }];
    }
  };

  for (let at = 0; at < files.length; at += 1) {
    if (stopped()) {
      emit({ do: "drop" });
      return;
    }
    const [file, id] = [files[at], ids[at]];
    if (counted >= maxFiles) {
      emit({ do: "read", id, results: [{ name: file.name, why: "too-many" }] });
      continue;
    }
    emit({ do: "reading", id });
    let results: ReadResult[];
    try {
      if (file.size > sizeLimit) results = [{ name: file.name, why: "too-big" }];
      else {
        const bytes = await timed(file.bytes(), timeLimit);
        if (bytes.length > 0 && bytes.length <= sizeLimit && kindOf(bytes, file.name) === "zip") {
          const entries = await timed(unzip(bytes, sizeLimit), timeLimit);
          const room = Math.max(0, maxFiles - counted);
          if (entries.length > room) emit({ do: "past", count: entries.length - room });
          results = [];
          for (const entry of entries.slice(0, room)) {
            const name = `${file.name}/${entry.name}`;
            results.push(...("why" in entry ? [{ name, why: entry.why }] : await readOne(entry.bytes, name)));
          }
          if (entries.length === 0) results = [{ name: file.name, why: "empty" }];
        } else results = await readOne(bytes, file.name);
      }
    } catch (error) {
      results = [{ name: file.name, why: reasonOf(error) }];
    }
    counted += Math.max(1, results.length);
    emit({ do: "read", id, results });
    await new Promise((done) => setTimeout(done, 0));
  }
}
