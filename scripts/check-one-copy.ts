import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = ["src", "worker"].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => `${dir}/${name}`),
);
const text = new Map(sources.map((file) => [file, readFileSync(join(root, file), "utf8")]));

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const filesWith = (pattern: RegExp, dir = "") => sources.filter((file) => file.startsWith(dir) && pattern.test(text.get(file)!));

const ONE_COPY: { what: string; pattern: RegExp; home: string | string[]; dir?: string; pending?: "pending until l1" }[] = [
  { what: "base64url encoding on the phone", pattern: /btoa\(/, home: "src/password.ts", dir: "src/" },
  { what: "Escape closes a sheet", pattern: /event\.key === "Escape"\) onClose\(\)/, home: "src/hooks.ts" },
  { what: "reading one cookie from a Cookie header", pattern: /\.split\(";"\)/, home: "worker/session.ts" },
  { what: "the request body size cap", pattern: /Refused\("too-large", 413\)/, home: "worker/refused.ts" },
  { what: "what counts as the same @name", pattern: /replace\(\/\^@\/, ""\)\.toLowerCase\(\)/, home: "src/handle.ts" },
  { what: "the @name made from a display name", pattern: /normalize\("NFKD"\)/, home: "src/handle.ts" },
  { what: "the app's name", pattern: /"Groovist"/, home: "src/data-kinds.ts", dir: "src/" },
  { what: "the room view: messages, composer and mute, on its screen and on the band page", pattern: /function Room\b/, home: "src/room.tsx" },
  {
    what: "the room socket, chat's and the gig's own line (a 4404 lineup close ends the gig line, not chat)",
    pattern: /new WebSocket\(/,
    home: ["src/chat.tsx", "src/links/server-link.ts"],
    dir: "src/",
  },
  { what: "the stage bar: Prev, Scroll, Next at 64 px", pattern: /function StageBar\b/, home: "src/stage-bar.tsx" },
  { what: "LeadSheet is the only sheet renderer", pattern: /className="sheet"/, home: "src/sheet.tsx", dir: "src/" },
  { what: "ROUTE_WORDS, the words for each kind of live link", pattern: /server: "Through the server"/, home: "src/routes.ts", dir: "src/" },
  { what: "unzip, the one zip reader, for a .zip and a .docx", pattern: /DecompressionStream\(|0x06054b50/, home: "src/import-read.ts", dir: "src/" },
  { what: "decodeText, which picks the encoding of a text file", pattern: /new TextDecoder\("utf-8", \{ fatal: true \}\)/, home: "src/song-import.ts", dir: "src/" },
  { what: "L1.9 the song listener, so analysis runs off the main thread,", pattern: /new SongListener\(/, home: "src/learn-worker.ts", dir: "src/" },
  { what: "general web search URL for chords and lyrics", pattern: /\b(?:function|const)\s+sheetSearchUrl\b/, home: "src/song-search.ts", dir: "src/" },
  { what: "general web search URL for lyrics", pattern: /\b(?:function|const)\s+lyricsSearchUrl\b/, home: "src/song-search.ts", dir: "src/" },
  { what: "general web search URL for chords", pattern: /\b(?:function|const)\s+chordsSearchUrl\b/, home: "src/song-search.ts", dir: "src/" },
  { what: "web search link for chords and lyrics", pattern: /className=\{[^}]*"find-chords"|className="find-chords"/, home: "src/song-search.tsx", dir: "src/" },
  { what: "smart paste reader", pattern: /\b(?:function|const)\s+readPaste\b/, home: "src/song-paste.ts", dir: "src/" },
  { what: "Learn this song chooser definition", pattern: /\b(?:function|const)\s+LearnChooser\b/, home: "src/learn-chooser.tsx", dir: "src/" },
  { what: "Learn this song chooser mount", pattern: /<LearnChooser\b/, home: "src/scroll-sheet.tsx", dir: "src/" },
  { what: "reading a stored song on the phone", pattern: /\b(?:function|const)\s+songFromStored\b/, home: "src/storage.ts", dir: "src/" },
  { what: "writing a stored song on the phone", pattern: /\b(?:function|const)\s+songToStored\b/, home: "src/storage.ts", dir: "src/" },
  { what: "reading a song at the phone's door", pattern: /\b(?:function|const)\s+songFromSent\b/, home: "src/band-library-model.ts", dir: "src/" },
  { what: "shaping a song the phone sends", pattern: /\b(?:function\s+sent\s*\(|const\s+sent\s*=\s*\()/, home: "src/band-library.tsx", dir: "src/" },
];

for (const { what, pattern, home, dir, pending } of ONE_COPY) {
  const found = filesWith(pattern, dir);
  const homes = [home].flat();
  const ok = found.length === homes.length && homes.every((file) => found.includes(file));
  const where = `${what} lives only in ${homes.join(" and ")} (found in: ${found.join(", ") || "none"})`;
  if (!pending) check(ok, where);
  else if (ok) check(false, `${where}: it holds now, so remove its "${pending}" mark`);
  else console.log(`FAIL ${where} (${pending})`);
}

const lines = (file: string) => text.get(file)?.split("\n").length ?? 0;
const defines = (file: string, name: string) => new RegExp(`^(export )?(async )?(function|const|interface|type) ${name}\\b`, "m").test(text.get(file) ?? "");

check(lines("src/App.tsx") <= 500, `src/App.tsx is at most 500 lines (has ${lines("src/App.tsx")})`);
check(!["parseHash", "SongList", "SetlistList", "SongBody", "Tab"].some((name) => defines("src/App.tsx", name)), "route parsing and the library lists live outside src/App.tsx");
check(lines("worker/directory-account.ts") <= 600, `worker/directory-account.ts is at most 600 lines (has ${lines("worker/directory-account.ts")})`);
check(!["handleDirectoryRequest", "signedIn", "readBody", "Context", "Reply"].some((name) => defines("worker/directory-account.ts", name)), "the Directory request plumbing lives outside the account routes");
check(
  ["worker/codes.ts", "worker/directory-friends.ts"].every((file) => /import \{[^}]*\bsignedIn\b[^}]*\} from "\.\/directory-http"/.test(text.get(file)! ?? "")),
  "codes and friends routes take signedIn from directory-http, not from the account routes",
);

// N9: Removed bass table names appear in none of music.ts, sheet.tsx, types.ts, styles.css
{
  const css = readFileSync(join(root, "src/styles.css"), "utf8");
  const musicGone = [
    "splitAliases",
    "aliasMap",
    "songUsesMinorSuffix",
    "SIMPLE_DEGREE",
    "convertNoteNames",
    "displayBassNote",
    "OPEN_STRINGS",
    "ORDINALS",
    "easiestPlace",
    "displayPlace",
    "nashvilleNumber",
    "displayChordCell",
    "BassNote",
  ].filter((name) => new RegExp(`\\b${name}\\b`).test(text.get("src/music.ts") ?? ""));
  const sheetGone = ["Your bass notes", "BassTable", "displayBassNote", "displayChordCell", "displayPlace", "nashvilleNumber"].filter((name) =>
    (text.get("src/sheet.tsx") ?? "").includes(name),
  );
  const typesGone = ["BassNote", "bassNotes"].filter((name) => new RegExp(`\\b${name}\\b`).test(text.get("src/types.ts") ?? ""));
  const cssHasBass = /\.bass\b/.test(css);
  const leftover = [
    ...musicGone.map((n) => `src/music.ts:${n}`),
    ...sheetGone.map((n) => `src/sheet.tsx:${n}`),
    ...typesGone.map((n) => `src/types.ts:${n}`),
    ...(cssHasBass ? ["src/styles.css:.bass"] : []),
  ];
  check(
    leftover.length === 0,
    `N9: src/music.ts, src/sheet.tsx, src/types.ts and src/styles.css name none of the removed bass-table items${leftover.length ? ` (found: ${leftover.join(", ")})` : ""}`,
  );
}

// W14: worker/ holds one reader of a stored song; no file but worker/room-library.ts calls JSON.parse on a song column
{
  const readers = filesWith(/\b(?:function|const)\s+storedSong\b/, "worker/");
  const songJson = filesWith(/JSON\.parse\(\s*[^)]*\.songs?\b/, "worker/").filter((file) => file !== "worker/room-library.ts");
  check(
    readers.length === 1 && readers[0] === "worker/room-library.ts" && songJson.length === 0,
    `W14: worker/ holds one storedSong reader (worker/room-library.ts) and no other worker file calls JSON.parse on a song column (readers: ${readers.join(", ") || "none"}; song JSON.parse: ${songJson.join(", ") || "none"})`,
  );
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
