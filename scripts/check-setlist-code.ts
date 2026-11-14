import { fixtureViewers, fixtureSetlist, fixtureMySetlist, canShowBandCode, bandSetlistPayload, mySetlistPayload } from "../src/setlist-code-model.ts";
import { qrMatrix, qrSvg } from "../src/qr-svg.ts";

function test(name: string, fn: () => boolean) {
  if (fn()) {
    console.log(`ok ${name}`);
  } else {
    throw new Error(`FAIL: ${name}`);
  }
}

test("member can show band code", () => {
  return canShowBandCode(fixtureViewers.member, fixtureSetlist);
});

test("guest can show band code", () => {
  return canShowBandCode(fixtureViewers.guest, fixtureSetlist);
});

test("stranger cannot show band code", () => {
  return !canShowBandCode(fixtureViewers.stranger, fixtureSetlist);
});

test("band payload parses to kind and id", () => {
  const payload = bandSetlistPayload(fixtureSetlist);
  const parsed = JSON.parse(payload);
  return parsed.kind === "setlist" && parsed.id === "sl1";
});

test("my payload has only ticked songIds in order", () => {
  const payload = mySetlistPayload(fixtureMySetlist);
  if (payload === null) return false;
  const parsed = JSON.parse(payload);
  return (
    parsed.kind === "my-setlist" &&
    JSON.stringify(parsed.songs) === JSON.stringify(["s1", "s3"])
  );
});

test("none ticked returns null", () => {
  const allUnticked = fixtureMySetlist.map((song) => ({ ...song, ticked: false }));
  return mySetlistPayload(allUnticked) === null;
});

test("qrMatrix is square and size >= 21", () => {
  const matrix = qrMatrix("test");
  const size = matrix.length;
  return size === matrix[0]?.length && size >= 21;
});

test("qrSvg starts with svg tag and contains rect", () => {
  const svg = qrSvg("test");
  return svg.startsWith("<svg") && svg.includes("<rect");
});

test("same input gives same svg", () => {
  const text = "consistent";
  const svg1 = qrSvg(text);
  const svg2 = qrSvg(text);
  return svg1 === svg2;
});

console.log("setlist-code: all checks passed");
