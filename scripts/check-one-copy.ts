import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const sources = ["src", "worker"].flatMap((dir) =>
  readdirSync(join(root, dir))
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

const ONE_COPY: { what: string; pattern: RegExp; home: string; dir?: string }[] = [
  { what: "base64url encoding on the phone", pattern: /btoa\(/, home: "src/password.ts", dir: "src/" },
  { what: "Escape closes a sheet", pattern: /event\.key === "Escape"\) onClose\(\)/, home: "src/hooks.ts" },
  { what: "reading one cookie from a Cookie header", pattern: /\.split\(";"\)/, home: "worker/session.ts" },
  { what: "the request body size cap", pattern: /Refused\("too-large", 413\)/, home: "worker/refused.ts" },
  { what: "what counts as the same @name", pattern: /replace\(\/\^@\/, ""\)\.toLowerCase\(\)/, home: "src/handle.ts" },
  { what: "the @name made from a display name", pattern: /normalize\("NFKD"\)/, home: "src/handle.ts" },
];

for (const { what, pattern, home, dir } of ONE_COPY) {
  const found = filesWith(pattern, dir);
  check(found.length === 1 && found[0] === home, `${what} lives only in ${home} (found in: ${found.join(", ") || "none"})`);
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
