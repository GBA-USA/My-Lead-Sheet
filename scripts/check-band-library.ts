import { fixtureBandTabs, visibleSongs, addToMySongs, shareLink } from "../src/band-library-model.ts";

function assertDeepEqual(actual: unknown, expected: unknown, name: string) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(
      `${name} failed:\nExpected: ${expectedStr}\nActual: ${actualStr}`
    );
  }
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, (err as Error).message);
    process.exit(1);
  }
}

test("tab b1 shows 4 songs", () => {
  const tab = fixtureBandTabs.find((t) => t.bandId === "b1")!;
  if (tab.songs.length !== 4) {
    throw new Error(`Expected 4 songs in b1, got ${tab.songs.length}`);
  }
});

test("tab b2 shows 2 songs", () => {
  const tab = fixtureBandTabs.find((t) => t.bandId === "b2")!;
  if (tab.songs.length !== 2) {
    throw new Error(`Expected 2 songs in b2, got ${tab.songs.length}`);
  }
});

test("filter by artist case-insensitive", () => {
  const result = visibleSongs(fixtureBandTabs, {
    tab: "b1",
    sort: "title",
    filter: "alex",
    tag: null,
  });
  if (result.length !== 2) {
    throw new Error(`Expected 2 results for "alex", got ${result.length}`);
  }
  if (!result.every((s) => s.artist.toLowerCase().includes("alex"))) {
    throw new Error("Not all results contain 'alex' in artist");
  }
});

test("tag filter", () => {
  const result = visibleSongs(fixtureBandTabs, {
    tab: "b1",
    sort: "title",
    filter: "",
    tag: "ballad",
  });
  if (result.length !== 2) {
    throw new Error(`Expected 2 ballads in b1, got ${result.length}`);
  }
  if (!result.every((s) => s.tags.includes("ballad"))) {
    throw new Error("Not all results have 'ballad' tag");
  }
});

test("sort by title A-Z", () => {
  const result = visibleSongs(fixtureBandTabs, {
    tab: "b1",
    sort: "title",
    filter: "",
    tag: null,
  });
  const titles = result.map((s) => s.title);
  const sorted = [...titles].sort((a, b) => a.localeCompare(b));
  assertDeepEqual(titles, sorted, "title sort");
});

test("sort by artist A-Z", () => {
  const result = visibleSongs(fixtureBandTabs, {
    tab: "b1",
    sort: "artist",
    filter: "",
    tag: null,
  });
  const artists = result.map((s) => s.artist);
  const sorted = [...artists].sort((a, b) => a.localeCompare(b));
  assertDeepEqual(artists, sorted, "artist sort");
});

test("sort by recent (addedAt descending)", () => {
  const result = visibleSongs(fixtureBandTabs, {
    tab: "b1",
    sort: "recent",
    filter: "",
    tag: null,
  });
  const times = result.map((s) => s.addedAt);
  const sorted = [...times].sort((a, b) => b - a);
  assertDeepEqual(times, sorted, "recent sort");
});

test("addToMySongs adds copy with 'my-' prefix", () => {
  const band = fixtureBandTabs.find((t) => t.bandId === "b1")!;
  const { mine, notice } = addToMySongs([], band, "s1");
  if (mine.length !== 1) {
    throw new Error(`Expected 1 song, got ${mine.length}`);
  }
  if (mine[0].id !== "my-s1") {
    throw new Error(`Expected id 'my-s1', got '${mine[0].id}'`);
  }
  if (notice !== "Added Golden Hour to My Songs") {
    throw new Error(`Wrong notice: ${notice}`);
  }
});

test("addToMySongs returns new array", () => {
  const band = fixtureBandTabs.find((t) => t.bandId === "b1")!;
  const before: unknown[] = [];
  const { mine } = addToMySongs(before, band, "s1");
  if (mine === before) {
    throw new Error("Expected new array, got same reference");
  }
});

test("addToMySongs second add returns unchanged array + 'Already in My Songs'", () => {
  const band = fixtureBandTabs.find((t) => t.bandId === "b1")!;
  const { mine: first } = addToMySongs([], band, "s1");
  const { mine: second, notice } = addToMySongs(first, band, "s1");
  if (second !== first) {
    throw new Error("Expected same array on duplicate");
  }
  if (notice !== "Already in My Songs") {
    throw new Error(`Wrong notice: ${notice}`);
  }
});

test("addToMySongs unknown id returns 'Song not found'", () => {
  const band = fixtureBandTabs.find((t) => t.bandId === "b1")!;
  const { mine, notice } = addToMySongs([], band, "unknown");
  if (mine.length !== 0) {
    throw new Error(`Expected empty array, got ${mine.length} songs`);
  }
  if (notice !== "Song not found") {
    throw new Error(`Wrong notice: ${notice}`);
  }
});

test("fixture bands deepEqual to structuredClone", () => {
  const clone = structuredClone(fixtureBandTabs);
  assertDeepEqual(fixtureBandTabs, clone, "fixture deepEqual");
});

test("shareLink encodes bandId and songId", () => {
  const result = shareLink("band with space", "song/id");
  const expected = `/band/${encodeURIComponent("band with space")}/song/${encodeURIComponent("song/id")}`;
  if (result !== expected) {
    throw new Error(`Expected ${expected}, got ${result}`);
  }
});

console.log("band-library: all checks passed");
