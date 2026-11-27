import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/chordpro.ts";
import type { ChartLine, ChartSection } from "../src/types.ts";

type PlanLine = ChartLine;
type PlanSection = ChartSection;
type PlanSong = SongContent;

const root = fileURLToPath(new URL("..", import.meta.url));
const codecBundle = await build({
  entryPoints: [join(root, "src/chordpro.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { chordProToSong, songToChordPro } = (await import(
  `data:text/javascript;base64,${Buffer.from(codecBundle.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/chordpro.ts");
const read = (file: string) => readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
const PLAN = "docs/PLAN-chordpro-backbone.md";
const PHONE_BRIEF = "docs/cooks/chordpro-phone.md";
/** The commit the plan was written against. Its map and its tables describe the code at this commit. */
const BASE = "61f18be";
const plan = read(PLAN);
const phoneBrief = read(PHONE_BRIEF);

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const COOKS = [
  { letters: ["C", "N"], brief: "chordpro-codec" },
  { letters: ["W"], brief: "chordpro-worker" },
  { letters: ["P"], brief: "chordpro-phone" },
];

const cases = new Map<string, string>();
const repeated: string[] = [];
for (const [, id, text] of plan.matchAll(/^- ([A-Z]\d+)\. (.+)$/gm)) {
  if (cases.has(id)) repeated.push(id);
  cases.set(id, text);
}
const idsOf = (letter: string) => [...cases.keys()].filter((id) => id.startsWith(letter));
/** The case ids a cell names: "P1 to P5" is five ids, "W8, P16" is two. */
function idsIn(text: string): string[] {
  const ids: string[] = [];
  for (const [, letter, from, to] of text.matchAll(/\b([CNWP])(\d+)(?: to \1(\d+))?/g)) for (let n = Number(from); n <= Number(to ?? from); n += 1) ids.push(`${letter}${n}`);
  return ids;
}

const planLines = plan.split("\n");
/** The lines under a heading, up to the next heading of the same or a higher level. */
function section(heading: string, lines = planLines): string[] {
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const level = heading.indexOf(" ");
  let fence = false;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    if (lines[end].startsWith("```")) fence = !fence;
    else if (!fence && /^#+ /.test(lines[end]) && lines[end].indexOf(" ") <= level) break;
  }
  return lines.slice(start + 1, end);
}
const cells = (row: string) => row.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
/** The first table under `lines` whose first header cell is `firstColumn`, each row keyed by its header. */
function table(lines: string[], firstColumn: string): Record<string, string>[] {
  const header = lines.findIndex((line) => line.startsWith("|") && cells(line)[0] === firstColumn);
  if (header < 0) return [];
  const names = cells(lines[header]);
  const rows: Record<string, string>[] = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith("|"); i += 1) rows.push(Object.fromEntries(cells(lines[i]).map((cell, at) => [names[at], cell])));
  return rows;
}
const fenced = (lines: string[]) => /```text\n([\s\S]*?)\n```/.exec(lines.join("\n"))?.[1];
const paths = (cell: string) => [...cell.matchAll(/`((?:src|worker|scripts|public|data)\/[^`]+)`/g)].map((m) => m[1]);

// ---- The cases and the briefs agree with the plan.

for (const { letters } of COOKS) {
  for (const letter of letters) {
    const ids = idsOf(letter);
    check(ids.length > 0 && ids.every((id, i) => id === `${letter}${i + 1}`) && !repeated.some((id) => id.startsWith(letter)), `cases ${letter}1 to ${letter}${ids.length} are numbered in order with no gap and no repeat`);
  }
}

const handoff = (text: string) => /^## HANDOFF\n(?:.*\n)*?NEEDS OWNER:.*$/m.exec(text)?.[0] ?? "";
for (const { letters, brief } of COOKS) {
  const file = `docs/cooks/${brief}.md`;
  const standalone = handoff(read(file));
  const inPlan = handoff(section(planLines.find((line) => line.endsWith(`Brief: \`${brief}\``)) ?? "").join("\n"));
  check(standalone !== "" && standalone === inPlan, `the HANDOFF of ${file} equals the one in section 5 of the plan`);
  const done = /^DONE MEANS: (.*)$/m.exec(standalone)?.[1] ?? "";
  const off = letters.filter((letter) => !done.includes(`${letter}1 to ${letter}${idsOf(letter).length}`));
  check(off.length === 0, `DONE MEANS of ${brief} names every case of the plan (${letters.map((letter) => `${letter}1 to ${letter}${idsOf(letter).length}`).join(", ")})`);
}

const map = table(section("### The map"), "#");
const strays = map.flatMap((row) => idsIn(row["Proved by"] ?? "").filter((id) => !cases.has(id)).map((id) => `row ${row["#"]} names ${id}`));
check(map.length > 0 && strays.length === 0, `each of the map's ${map.length} rows is proved by cases the plan holds${strays.length ? ` (${strays.join("; ")})` : ""}`);

// ---- The build at BASE, as code: where a song enters and leaves the phone, and what an old tab does after the update.

mkdirSync(join(root, ".verify-logs"), { recursive: true });
const tree = mkdtempSync(join(root, ".verify-logs", "chordpro-plan-"));
type OldBuild = typeof import("../src/backup.ts") & typeof import("../src/storage.ts");
let oldBuild: OldBuild;
let entering: string[];
let sending: string[];
try {
  const tar = execFileSync("git", ["archive", "--format=tar", BASE, "src", "data", "tsconfig.json", "scripts/learn-bands.json"], { cwd: root, maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", tree], { input: tar });
  const bundle = await build({ stdin: { contents: `export * from "./src/backup.ts"; export * from "./src/storage.ts";`, resolveDir: tree, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  oldBuild = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

  // The sweep. Everything `api()` returns, everything read from a phone store and the parsed text of a song card is
  // typed as "this song may be text". Each file the compiler then refuses takes a song in at that place.
  const patch = (file: string, from: string, to: string) => {
    const before = readFileSync(join(tree, file), "utf8").replaceAll("\r\n", "\n");
    if (!before.includes(from)) throw new Error(`the sweep found no "${from}" in ${file} at ${BASE}`);
    writeFileSync(join(tree, file), before.replace(from, to));
  };
  writeFileSync(
    join(tree, "src/wire.ts"),
    `import type { Song } from "./types";
type Chart = Omit<Song, "ref" | "id" | "copy">;
export type SentSong = { chordpro: string };
export type Wire<T> = T extends Chart ? Chart | SentSong : T extends readonly (infer U)[] ? Wire<U>[] : T extends ArrayBuffer | ArrayBufferView ? T : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
`,
  );
  const wire = `import type { Wire } from "./wire";\n`;
  patch("src/sign-in-methods.ts", "export async function api<T>(path: string, body?: object): Promise<T> {", `${wire}export async function api<T>(path: string, body?: object): Promise<Wire<T>> {`);
  patch("src/sign-in-methods.ts", "  return reply as T;", "  return reply as Wire<T>;");
  patch("src/phone-db.ts", `): Promise<PhoneStores[S]["value"] | undefined> {`, `): Promise<Wire<PhoneStores[S]["value"]> | undefined> {`);
  patch("src/phone-db.ts", `as IDBRequest<PhoneStores[S]["value"] | undefined>);`, `as IDBRequest<PhoneStores[S]["value"] | undefined>) as never;`);
  patch("src/phone-db.ts", `): Promise<PhoneStores[S]["value"][]> {`, `): Promise<Wire<PhoneStores[S]["value"]>[]> {`);
  patch("src/phone-db.ts", `as IDBRequest<PhoneStores[S]["value"][]>);`, `as IDBRequest<PhoneStores[S]["value"][]>) as never;`);
  patch("src/phone-db.ts", "export function getFromPhone<", `${wire}export function getFromPhone<`);
  patch("src/send-song-model.ts", "const message = JSON.parse(text) as SongMessage;", "const message = JSON.parse(text) as Wire<SongMessage>;");
  patch("src/send-song-model.ts", "export function songMessageIn(", `${wire}export function songMessageIn(`);
  let refused = "";
  try {
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--noErrorTruncation", "-p", tree], { cwd: tree, maxBuffer: 1 << 28 });
  } catch (error) {
    refused = String((error as { stdout?: Buffer }).stdout ?? "");
  }
  // One block an error: its first line names the file, and the lines under it say which type did not fit.
  const blocks = refused.split(/^(?=src\/)/m).filter((block) => block.trim());
  entering = [...new Set(blocks.filter((block) => block.includes("SentSong")).map((block) => /^(src\/[\w-]+\.tsx?)\(/.exec(block)?.[1]))].filter((file): file is string => !!file).sort();
  const stray = blocks.filter((block) => !block.includes("SentSong")).map((block) => block.split("\n")[0]);
  if (stray.length) console.log(`note: the sweep's compile also said, about something other than a song:\n${stray.join("\n")}`);
  sending = execFileSync("git", ["grep", "-l", "-E", "\\bcontent\\(", BASE, "--", "src"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(BASE.length + 1))
    .sort();
} finally {
  rmSync(tree, { recursive: true, force: true });
}

const doors = table(section("### Where a song enters and leaves the phone"), "File");
const doorFiles = new Map(doors.map((row) => [paths(row.File)[0], row]));
const owned = new Set(table(phoneBrief.split("\n"), "File").flatMap((row) => paths(row.File)));
const fenced_off = paths(phoneBrief.split("\n").find((line) => line.startsWith("Do not touch:")) ?? "");
check(entering.length > 0 && sending.length > 0, `the sweep of ${BASE} finds where a song enters the phone (${entering.join(", ") || "nowhere"}) and each caller of \`content\` (${sending.join(", ") || "none"})`);
for (const file of [...new Set([...entering, ...sending])].sort()) {
  const row = doorFiles.get(file);
  // A caller of `content` that only copies a song in memory needs a case that it still works, and no edit.
  const unchanged = !entering.includes(file) && (row?.["After cook 3"] ?? "").startsWith("No change");
  const problems = [
    !row && "the plan's table of where a song enters and leaves the phone has no row for it",
    !unchanged && !owned.has(file) && `${PHONE_BRIEF} does not own it`,
    !unchanged && fenced_off.includes(file) && `${PHONE_BRIEF} lists it under Do not touch`,
    unchanged && owned.has(file) && `the plan says it does not change and ${PHONE_BRIEF} owns it`,
    row && !idsIn(row.Cases ?? "").some((id) => id.startsWith("P") && cases.has(id)) && "its row names no P case the plan holds",
  ].filter(Boolean);
  const wants = unchanged ? "the plan gives it a row and a P case, and says it does not change" : "the plan gives it a row, a P case, and the phone cook owns it";
  check(problems.length === 0, `${file} ${entering.includes(file) ? "takes a song in" : "calls `content`"} at ${BASE}: ${wants}${problems.length ? ` (${problems.join("; ")})` : ""}`);
}
for (const [file, row] of doorFiles) {
  if (entering.includes(file) || sending.includes(file)) continue;
  check(owned.has(file) && idsIn(row.Cases ?? "").some((id) => cases.has(id)), `${file}, a row of that table the sweep did not find, is owned by the phone cook and names a case`);
}

// What an old tab does once the new build has opened on the same phone. The plan's table says what the new build
// does to each key the old build reads. This applies the table, then runs the old build's own backup and storage.
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
const oldKeys = table(section("### Keeping an old build safe"), "Key the old build reads");
const verbs = oldKeys.map((row) => [/`([A-Za-z.]+)`/.exec(row["Key the old build reads"])?.[1], /^(Left as it is|Removed)\b/.exec(row["What the new build does to it"] ?? "")?.[1]] as const);
const tabled = verbs.length > 0 && verbs.every(([key, verb]) => key && verb) && ["leadSheetsLibrary", "leadSheetsBackup"].every((key) => verbs.some(([named]) => named === key));
const untabled = tabled ? "" : " (not run as the plan has it: there is no table to apply)";
check(
  tabled,
  `the plan says what the new build does to each key the old build reads, \`leadSheetsLibrary\` and \`leadSheetsBackup\` among them, as "Left as it is" or "Removed" (${verbs.map(([key, verb]) => `${key}: ${verb}`).join(", ") || "no such table"})`,
);
{
  const store = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
  const room = { rev: 0, rows: new Map<string, { key: string; value: string | null; rev: number }>() };
  const sent: { key: string; value: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_path, init) => {
    const body = JSON.parse(String(init?.body)) as { since: number; changes: { key: string; value: string | null }[] };
    for (const change of body.changes) {
      sent.push(change);
      room.rev += 1;
      room.rows.set(change.key, { key: change.key, value: change.value, rev: room.rev });
    }
    const rows = [...room.rows.values()].filter((row) => row.rev > body.since || body.changes.some((change) => change.key === row.key));
    return new Response(JSON.stringify({ rev: room.rev, rows, counts: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const chart = (title: string) => ({ title, artist: "The Made Up Band", keyLabel: "C major", keyRoot: "C", keyMode: "major" as const, keyNote: "", tempo: 100, tempoNote: "", timeSignature: "4/4", officialRuntimeSec: null, feel: "", sourceNote: "", atAGlance: "", howToPlay: "", practiceTip: "", bassNotes: [], body: [{ heading: "VERSE 1", lines: [{ chords: "C", lyrics: "la la" }] }] });
    oldBuild.loadLibrary();
    const titles = ["Paper Boats", "Tin Kites", "Glass Drums"];
    for (const title of titles) oldBuild.addOwnSong(chart(title));
    oldBuild.backupOn("account-a");
    await oldBuild.syncBackup();
    const held = () => [...room.rows.values()].filter((row) => row.key.startsWith("leadSheetsSong.") && row.value !== null).length;
    const before = held();
    // The new build opens: it copies what it needs to its own keys, then does to each old key what the table says.
    store.setItem("leadSheetsLibraryV2", store.getItem("leadSheetsLibrary")!);
    store.setItem("leadSheetsBackupV2", store.getItem("leadSheetsBackup")!);
    for (const [key, verb] of verbs) if (key && verb === "Removed") store.removeItem(key);
    const mine = [store.getItem("leadSheetsLibraryV2"), store.getItem("leadSheetsBackupV2")];
    sent.length = 0;
    // The old tab's timer fires (`runBackup(true)` in src/App.tsx), then the player adds a song in the old tab.
    await oldBuild.syncBackup({ onlyIfChanged: true });
    const removed = sent.filter((change) => change.value === null).map((change) => change.key);
    check(tabled && before === titles.length && removed.length === 0 && held() === before, `after the new build opens, the old build's next backup sends no song as removed: the room held ${before} songs and holds ${held()}${removed.length ? ` (sent as removed: ${removed.join(", ")})` : ""}${untabled}`);
    oldBuild.loadLibrary();
    oldBuild.addOwnSong(chart("Late Edit"));
    check(tabled && store.getItem("leadSheetsLibraryV2") === mine[0] && store.getItem("leadSheetsBackupV2") === mine[1], `a load and a save in the old build leave the new build's library and backup keys as they were${untabled}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- The format: every written example of section 1 is what the reference writes, and reads back as the same line.

const blank: PlanSong = { title: "T", artist: "", keyLabel: "C major", keyRoot: "C", keyMode: "major", keyNote: "", tempo: null, tempoNote: "", timeSignature: "", officialRuntimeSec: null, feel: "", sourceNote: "", atAGlance: "", howToPlay: "", practiceTip: "", body: [] };
const FACTS = "{title: T}\n{key: C}\n";
const FIELDS = ["chords", "lyrics", "bars", "note"] as const;
/** A section as promise 2 compares it: `bars` and `note` exactly, `chords` and `lyrics` without spaces at the end, an absent field as an empty one. */
const shape = (body: PlanSection[]) => JSON.stringify(body.map((each) => [each.heading, each.lines.map((line) => FIELDS.map((field) => (field === "bars" || field === "note" ? (line[field] ?? "") : (line[field]?.trimEnd() ?? ""))))]));

const examples = (fenced(section("### Every mix of the four fields, written")) ?? "").split("\n----\n").filter(Boolean);
const sections: PlanSection[] = [];
const wrong: string[] = [];
for (const example of examples) {
  const [first, ...rest] = example.split("\n");
  const [kind, json] = [first.slice(0, first.indexOf(" ")), first.slice(first.indexOf(" ") + 1)];
  let made: PlanSection;
  try {
    made = kind === "line" ? { heading: "VERSE 1", lines: [JSON.parse(json) as PlanLine] } : (JSON.parse(json) as PlanSection);
  } catch {
    wrong.push(`"${first}" is not a line or a section`);
    continue;
  }
  sections.push(made);
  const text = rest.join("\n");
  const writes = songToChordPro({ ...blank, body: [made] }).slice(FACTS.length);
  if (writes !== text) wrong.push(`${first} is written\n${writes}\nand the plan shows\n${text}`);
  else if (shape(chordProToSong(FACTS + text).body) !== shape([made])) wrong.push(`${first} reads back as ${JSON.stringify(chordProToSong(FACTS + text).body)}`);
}
const mixOf = (line: PlanLine) => FIELDS.filter((field) => line[field] !== undefined).join("+") || "no field";
const shownMixes = new Set(sections.filter((each) => each.heading === "VERSE 1" && each.lines.length === 1).map((each) => mixOf(each.lines[0])));
const everyMix = Array.from({ length: 16 }, (_, mask) => FIELDS.filter((_field, bit) => mask & (1 << bit)).join("+") || "no field");
const missing = everyMix.filter((mix) => !shownMixes.has(mix));
check(missing.length === 0, `the format shows the written text of a chart line for every mix of chords, lyrics, bars and note, 16 in all${missing.length ? ` (none for: ${missing.join(", ")})` : ""}`);
const SHAPES: [string, (each: PlanSection) => boolean][] = [
  ["a section with an empty heading", (each) => each.heading === "" && each.lines.length > 0],
  ["a section with no lines", (each) => each.lines.length === 0],
  ["a note that opens a section of bar rows", (each) => each.lines.length > 1 && mixOf(each.lines[0]) === "note" && mixOf(each.lines[1]) === "bars"],
  ["a note that opens a section of sung lines", (each) => each.lines.length > 1 && mixOf(each.lines[0]) === "note" && each.lines[1].bars === undefined],
  ["a bar row, then a chord row, then a bar row in one section", (each) => each.lines.length === 3 && mixOf(each.lines[0]) === "bars" && mixOf(each.lines[1]) === "chords" && mixOf(each.lines[2]) === "bars"],
];
const unshown = SHAPES.filter(([, has]) => !sections.some(has)).map(([name]) => name);
check(unshown.length === 0, `the format shows the written text of each section shape a cook would otherwise have to invent${unshown.length ? ` (none for: ${unshown.join("; ")})` : ""}`);
check(examples.length > 0 && wrong.length === 0, `each of the ${examples.length} written examples is exactly what the reference writes, and reads back as the same lines${wrong.length ? `\n${wrong.join("\n")}` : ""}`);

const worked = fenced(section("### A worked example")) ?? "";
const workedSong = chordProToSong(worked);
const sizes = /The text is ([\d,]+) characters\. The same song as JSON is ([\d,]+)\./.exec(plan);
check(
  worked !== "" && songToChordPro(workedSong) === worked && sizes !== null && Number(sizes[1].replace(",", "")) === worked.length && Number(sizes[2].replace(",", "")) === JSON.stringify(workedSong).length,
  `the worked example is what the reference writes for the song it reads back, at the sizes the plan gives (${worked.length} characters as text, ${JSON.stringify(workedSong).length} as JSON)`,
);
const wholeText = section("### The text as a whole").join("\n");
check(!/There is no blank line\b/.test(wholeText) && /empty line/.test(wholeText), '"The text as a whole" says where an empty line may stand, and does not say there is none');

// ---- Two smaller facts the plan states.

const takeIn = section("### Keeping an old build safe").join("\n");
const ownerCases = idsOf("P").filter((id) => cases.get(id)!.includes("`leadSheetsLeftBy`"));
check(takeIn.includes("`leadSheetsLeftBy`") && ownerCases.length > 0, `the plan says which account owns a song taken in from an old tab (\`leadSheetsLeftBy\`), and a P case proves it (${ownerCases.join(", ") || "none"})`);

const sheet = execFileSync("git", ["show", `${BASE}:src/sheet.tsx`], { cwd: root, encoding: "utf8" }).split("\n");
const at = (text: string) => sheet.findIndex((line) => line.includes(text)) + 1;
const places = section("### Things in the brief or the repo that look wrong").find((line) => line.includes("near line 140")) ?? "";
check(
  places.includes(`\`src/sheet.tsx:${at("Your bass notes")}\``) && places.includes(`\`src/sheet.tsx:${at("function BassTable")}\``),
  `the plan corrects the brief's "near line 140": the heading is at src/sheet.tsx:${at("Your bass notes")} and BassTable at src/sheet.tsx:${at("function BassTable")} at ${BASE}`,
);

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
