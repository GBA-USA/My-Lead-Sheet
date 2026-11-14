import { qrSvg } from "../src/qr-svg.ts";
import {
  parseCode,
  handoffFor,
  scanFeed,
  stopCode,
  isLive,
  type ScannedCode,
  type MyCode,
} from "../src/qr-scan.ts";

function test(name: string, condition: boolean) {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  console.log(`ok ${name}`);
}

// Test qrSvg returns SVG string
const friendPayload = JSON.stringify({ kind: "friend", id: "u-alex", from: "@alex" });
const svg = qrSvg(friendPayload);
test("qrSvg returns svg tag", svg.startsWith("<svg"));

// Test parseCode with JSON for all 4 kinds
const friendCode = parseCode('{"kind":"friend","id":"u-dana"}');
test("parseCode friend JSON", friendCode?.kind === "friend" && friendCode?.id === "u-dana");

const bandCode = parseCode('{"kind":"band-invite","id":"b-sonic"}');
test("parseCode band-invite JSON", bandCode?.kind === "band-invite" && bandCode?.id === "b-sonic");

const setlistCode = parseCode('{"kind":"setlist","id":"s-live"}');
test("parseCode setlist JSON", setlistCode?.kind === "setlist" && setlistCode?.id === "s-live");

const guestCode = parseCode('{"kind":"guest","id":"g-conf"}');
test("parseCode guest JSON", guestCode?.kind === "guest" && guestCode?.id === "g-conf");

// Test handoffFor mappings
test("handoffFor friend", handoffFor(friendCode!) === "friend-request");
test("handoffFor band-invite", handoffFor(bandCode!) === "band-join");
test("handoffFor setlist", handoffFor(setlistCode!) === "setlist-import");
test("handoffFor guest", handoffFor(guestCode!) === "guest-join");

// Test parseCode with links
const linkCode = parseCode("https://x.app/c/band-invite/b%201");
test("parseCode link with URL-decoded id", linkCode?.kind === "band-invite" && linkCode?.id === "b 1");

// Test parseCode rejection cases
test("parseCode bad kind", parseCode('{"kind":"invalid","id":"123"}') === null);
test("parseCode empty id", parseCode('{"kind":"friend","id":""}') === null);
test("parseCode junk text", parseCode("junk text") === null);
test("parseCode bad encoding", parseCode("https://x.app/c/friend/%ZZ") === null);

// Test scanFeed
const frames = ["", '{"kind":"friend","id":"u-bob"}', "junk"];
const scannedFromFeed = scanFeed({ frames });
test("scanFeed skips empty and junk", scannedFromFeed?.kind === "friend" && scannedFromFeed?.id === "u-bob");

test("scanFeed all junk", scanFeed({ frames: ["", "junk", ""] }) === null);

// Test stopCode and isLive
const codes: MyCode[] = [
  { kind: "friend", id: "u-alex", active: true },
  { kind: "band-invite", id: "b-sonic", active: true },
];
const stopped = stopCode(codes, "u-alex");
test("stopCode marks target inactive", stopped[0].active === false);
test("stopCode other codes stay active", stopped[1].active === true);
test("stopCode does not mutate input", codes[0].active === true);

const scannedFriend: ScannedCode = { kind: "friend", id: "u-alex" };
test("isLive true for active code", isLive(stopped, scannedFriend) === false);
test("isLive true for active band code", isLive(stopped, { kind: "band-invite", id: "b-sonic" }) === true);
test("isLive false for non-existent code", isLive(stopped, { kind: "friend", id: "u-unknown" }) === false);

console.log("codes: all checks passed");
