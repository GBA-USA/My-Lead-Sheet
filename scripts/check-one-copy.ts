import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
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
  { what: "L1.9 the song listener, so analysis runs off the main thread,", pattern: /new SongListener\(/, home: "src/learn-worker.ts", dir: "src/" },
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
  ["worker/codes.ts", "worker/directory-friends.ts"].every((file) => /import \{[^}]*\bsignedIn\b[^}]*\} from "\.\/directory-http"/.test(text.get(file) ?? "")),
  "codes and friends routes take signedIn from directory-http, not from the account routes",
);

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
