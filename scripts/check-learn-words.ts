import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { canWrap, chordAnchors, type Row } from "./chord-anchors.ts";
import { listenThrough } from "./fake-worker.ts";
import { SAMPLE_RATE, render, type Rendered, type Score, type Truth } from "./learn-render.ts";
import { SONGS } from "./learn-songs.ts";
import { chartRows, lyricsOf, rechartRates, scoreListen } from "./learn-score.ts";
import type { HeardChange, HeardLine, HeardSection, Listen, SectionLabel } from "../src/learn-result.ts";

/**
 * The words in time: the player's words read into blocks, the syllable splitter, the line and syllable aligner, and
 * the chart built from them, on the sung songs of the L0 set.
 */

/** A TESTS-FIRST case its cook has not landed yet: it runs and prints, but its FAIL does not fail check:learn-words. */
type Pending = "pending until l8";
let failures = 0;
function check(ok: boolean, message: string, pending?: Pending) {
  if (pending && ok) {
    failures += 1;
    console.log(`FAIL ${message}: it holds now, so remove its "${pending}" mark`);
    return;
  }
  if (!ok && !pending) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}${pending ? ` (${pending})` : ""}`);
}
const L8: Pending = "pending until l8";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundled = await build({
  stdin: { contents: 'export * from "./src/learn-words.ts"; export { parseChord } from "./src/music.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const words = (await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`)) as typeof import("../src/learn-words.ts") &
  Pick<typeof import("../src/music.ts"), "parseChord">;

const blocksText = (text: string) => JSON.stringify(words.splitLyrics(text));
const block = (label: SectionLabel | null, number: number | null, ...lines: string[]) => ({ label, number, lines });

// L8.2 and Terry t838u: the words are read into blocks, with their tags, and formatted where the text says how.
check(
  blocksText("Shall we gather at the river\nWhere bright angel feet have trod\n\n\nYes, we'll gather at the river\n") ===
    JSON.stringify([block(null, null, "Shall we gather at the river", "Where bright angel feet have trod"), block(null, null, "Yes, we'll gather at the river")]),
  `L8.2 blank lines part the words into blocks, and a block with no tag has label null (${blocksText("Shall we gather at the river\nWhere bright angel feet have trod\n\n\nYes, we'll gather at the river\n")})`,
);
{
  const text = "  Oh!  Su-san-na,   don't you cry  \r\nFor me\r\n \r\n \r\nI come from Alabama\r";
  const want = [block(null, null, "Oh!  Su-san-na,   don't you cry", "For me"), block(null, null, "I come from Alabama")];
  check(blocksText(text) === JSON.stringify(want), `L8.2 the words are kept as written, only the space around a line dropped, with Windows line ends and blank lines of spaces (${blocksText(text)})`);
}
{
  const text = [
    "[Verse 1]",
    "Verse one first",
    "Verse one second",
    "",
    "Chorus:",
    "Chorus first",
    "Chorus second",
    "",
    "(Verse 2)",
    "Verse two",
    "",
    "[Pre-Chorus]",
    "Before the chorus",
    "",
    "[Bridge: Some Singer]",
    "The bridge",
    "",
    "[Intro]",
    "",
    "[Guitar Solo]",
    "",
    "[Outro]",
    "The end",
  ].join("\n");
  const want = [
    block("VERSE", 1, "Verse one first", "Verse one second"),
    block("CHORUS", null, "Chorus first", "Chorus second"),
    block("VERSE", 2, "Verse two"),
    block("PRE-CHORUS", null, "Before the chorus"),
    block("BRIDGE", null, "The bridge"),
    block("INTRO", null),
    block("SOLO", null),
    block("OUTRO", null, "The end"),
  ];
  check(blocksText(text) === JSON.stringify(want), `L8.2 [Chorus], Chorus: and (Chorus) tags name a block and its number, a singer's name after the label left out (${blocksText(text)})`);
}
{
  const spellings: [string, SectionLabel][] = [
    ["[CHORUS]", "CHORUS"],
    ["[Refrain]", "CHORUS"],
    ["[Hook]", "CHORUS"],
    ["[Prechorus]", "PRE-CHORUS"],
    ["[Pre Chorus]", "PRE-CHORUS"],
    ["[Interlude]", "INSTRUMENTAL"],
    ["[Instrumental]", "INSTRUMENTAL"],
    ["[Middle 8]", "BRIDGE"],
    ["Bridge", "BRIDGE"],
    ["VERSE 3", "VERSE"],
  ];
  const read = spellings.map(([tag]) => words.splitLyrics(`${tag}\nwords`)[0]?.label ?? null);
  check(read.every((label, i) => label === spellings[i][1]), `L8.2 tags are read in any case and in the spellings lyric pages use (${spellings.map(([tag], i) => `${tag} ${read[i]}`).join(", ")})`);
}
{
  const text = "Verse words\n[Chorus]\nChorus words\n[Post-Chorus]\nAfter it";
  const want = [block(null, null, "Verse words"), block("CHORUS", null, "Chorus words"), block(null, null, "After it")];
  check(blocksText(text) === JSON.stringify(want), `L8.2 a tag line starts a new block without a blank line, and a bracketed tag that names no section starts one with no label (${blocksText(text)})`);
}
{
  const lyrics = ["Oh, chorus girl", "(Ooh, yeah)", "And I said:", "Verse of my life", "Route 66", "Malcolm and the max2"];
  check(
    blocksText(lyrics.join("\n")) === JSON.stringify([block(null, null, ...lyrics)]),
    `L8.2 a lyric line that only looks like a tag, or ends in a number, stays a lyric line (${blocksText(lyrics.join("\n"))})`,
  );
}
{
  const cases: [string, ReturnType<typeof block>[]][] = [
    ["[Chorus x2]\nC one\nC two", [block("CHORUS", null, "C one", "C two", "C one", "C two")]],
    ["[Chorus] (x2)\nC one", [block("CHORUS", null, "C one", "C one")]],
    ["Chorus x3:\nC one", [block("CHORUS", null, "C one", "C one", "C one")]],
    ["Line one\nLine two\n(x2)", [block(null, null, "Line one", "Line two", "Line one", "Line two")]],
    ["Na na na (x3)\nYeah", [block(null, null, "Na na na", "Na na na", "Na na na", "Yeah")]],
    ["Oh oh [x2]\nOh no x2\nHey (2x)\nYou ×2", [block(null, null, "Oh oh", "Oh oh", "Oh no", "Oh no", "Hey", "Hey", "You", "You")]],
  ];
  const read = cases.map(([text]) => blocksText(text));
  check(read.every((each, i) => each === JSON.stringify(cases[i][1])), `L8.2 (x2) repeats a block or a line that many times, as sung (${read.join(" ")})`);
}
{
  const text = ["[Chorus]", "Chorus one", "Chorus two", "", "[Verse 2]", "Verse two", "", "[Chorus]", "", "[Verse 3]", "", "Repeat chorus", "", "[Chorus x2]"].join("\n");
  const chorus = ["Chorus one", "Chorus two"];
  const want = [block("CHORUS", null, ...chorus), block("VERSE", 2, "Verse two"), block("CHORUS", null, ...chorus), block("VERSE", 3), block("CHORUS", null, ...chorus), block("CHORUS", null, ...chorus, ...chorus)];
  check(blocksText(text) === JSON.stringify(want), `L8.2 a chorus tag with no words sings the chorus written before it, and a verse tag with no words stays empty (${blocksText(text)})`);
}
check(blocksText("") === "[]" && blocksText("\n \n\t\n") === "[]", `L8.2 no words give no blocks (${blocksText("")}, ${blocksText("\n \n\t\n")})`);

// L8.1 The syllable splitter, on common words, their counts as a dictionary gives them.
const DICTIONARY: Record<number, string> = {
  1: `the a and you me my we he she it they love heart night day time way home road sky sun rain eyes hand gone down town light dark blue red
gold cold old young sweet dream cry tears kiss arms world girl boy man friend life soul mind song sing dance walk run fall stay go come know feel
think need want hold take make break shake wake smile tried loved turned walked played danced laughed stopped kissed lived moved changed warm
strong long free true wrong right bright through though thought brought should would could where there here near far star times homes smiles
lives lies shoes waves bones knees clouds stars streets trees wings years words blood breath breathe chance choice church earth edge faith fear
ghost grace ground hope horse house judge moon noise one pain peace phone place pride queen rose sea smoke stone storm taste truth while white
wild wind wine`,
  2: `away again alone along above about around before behind believe between beyond better little mother father sister brother river water over
under never ever maybe baby lady happy lonely only crazy body pretty money party story city shelter razor heartaches morning darling sorrow
window shadow yellow silver golden broken open frozen given heaven seven dancing singing falling crying dying flying trying running waiting
sleeping talking coming going doing being seeing people simple table bottle candle gentle middle single trouble circle hello today tonight
inside without until because sometimes somewhere something nothing wanted needed started kisses wishes places faces roses voices changes highway
freedom music magic picture future mountain garden kitchen island rhythm guitar machine police sunday monday silent sudden ocean motion question
station sugar summer winter thunder wonder answer letter paper danger stranger finger lion quiet angel engine honey jealous lover lucky mirror
moment naked pocket secret season spirit sunshine thousand travel treasure wicked woman women`,
  3: `amazing beautiful together remember december november september october umbrella banana potato tomato important understand imagine animal
buffalo antelope cinnamon saturday yesterday carefully suddenly already another whatever however somebody anyone afternoon celebrate elephant
hospital computer piano radio video holiday energy melody harmony butterfly wonderful terrible possible forever tomorrow idea violin period
adventure beginning deliver discover electric enemy gasoline hurricane lemonade paradise romantic seventeen tennessee universe vacation volcano`,
  4: `alabama california celebration conversation education information revolution impossible invisible incredible anybody america discouraging
mississippi sentimental intelligent apology ridiculous`,
  5: "unbelievable imagination electricity university communication unforgettable",
};
const counted = Object.entries(DICTIONARY).flatMap(([count, list]) => list.split(/\s+/).filter(Boolean).map((word) => ({ word, count: Number(count) })));
check(counted.length >= 300 && new Set(counted.map((each) => each.word)).size === counted.length, `the dictionary list holds at least 300 different words (${counted.length})`);
const wrong = counted.filter(({ word, count }) => words.splitSyllables(word).length !== count);
const share = 1 - wrong.length / counted.length;
check(
  share >= 0.92,
  `L8.1 the syllable splitter counts common words right: ${Math.round(share * 100)}% of ${counted.length} (wrong: ${wrong.slice(0, 12).map(({ word, count }) => `${word} ${words.splitSyllables(word).length} not ${count}`).join(", ") || "none"}${wrong.length > 12 ? ", ..." : ""})`,
  L8,
);
const named: [string, number[]][] = [
  ["shelter", [0, 4]],
  ["heartaches", [0, 5]],
  ["razor", [0, 2]],
  ["away", [0, 1]],
];
check(
  named.every(([word, starts]) => JSON.stringify(words.splitSyllables(word)) === JSON.stringify(starts)),
  `L8.1 "shelter", "heartaches", "razor" and "away" are two syllables each, split where a dictionary splits them (${named.map(([word]) => `${word} ${JSON.stringify(words.splitSyllables(word))}`).join(", ")})`,
  L8,
);

// The sung songs of the set, heard the way the phone hears a picked file, with the words as a player would paste them.
interface Run {
  score: Score;
  take: Rendered;
  listen: Listen;
  lyrics: string;
}
const runs: Run[] = [];
const sung = SONGS.filter((score) => score.sections.some((section) => section.lines?.length));
for (const score of sung) {
  const take = render(score);
  const { listen } = await listenThrough(take.samples, SAMPLE_RATE, {
    beatsPerBar: score.beatsPerBar,
    lyrics: take.lyrics,
    source: { kind: "file", name: `${score.title}.wav`, stereo: false, sampleRate: SAMPLE_RATE },
    expectedSeconds: take.samples.length / SAMPLE_RATE,
    stopped: "finished",
  });
  if (listen && take.lyrics) runs.push({ score, take, listen, lyrics: take.lyrics });
}
check(runs.length === sung.length && runs.length >= 12, `every sung song of the set is heard, with its words (${runs.length} of ${sung.length})`);

const beatAt = (listen: Listen, time: number) => listen.analysis.beats.reduce((best, beat, k) => (Math.abs(beat - time) < Math.abs(listen.analysis.beats[best] - time) ? k : best), 0);
/** The score's chord changes, as a listen that heard every chord right gives them. */
const trueChanges = ({ take, listen }: Run): HeardChange[] =>
  take.truth.changes.map((change) => ({
    beat: beatAt(listen, change.at),
    at: change.at,
    chord: change.chord === "N.C." ? null : change.chord,
    confidence: 100,
    alternatives: [],
    evidence: { bass: null, tones: [], stable: 1 },
  }));
/** The score's sections on the listen's beats, named as the score names them. */
const trueSections = ({ take, listen }: Run): HeardSection[] => {
  const { sections, downbeats } = take.truth;
  const starts = sections.map((section, i) => (i === 0 ? 0 : beatAt(listen, downbeats[section.fromBar])));
  const count = (label: string) => sections.filter((each) => each.label === label).length;
  return sections.map((section, i) => ({
    fromBeat: starts[i],
    toBeat: starts[i + 1] ?? listen.analysis.beats.length,
    group: section.group,
    label: section.label as SectionLabel,
    number: count(section.label) > 1 ? sections.slice(0, i + 1).filter((each) => each.label === section.label).length : null,
    band: "sure",
  }));
};
/** The score's sung lines, as a listen that timed every syllable right gives them. */
const trueLines = (truth: Truth): HeardLine[] => {
  const lines: HeardLine[] = [];
  for (const syllable of truth.syllables) {
    const line = (lines[syllable.line] ??= { line: syllable.line, start: syllable.at, end: syllable.at, syllables: [] });
    line.end = syllable.at;
    line.syllables.push({ at: syllable.at, word: syllable.word, column: syllable.column, band: "sure" });
  }
  return lines.filter(Boolean);
};
const pooled = (parts: { value: number; of: number }[]) => {
  const of = parts.reduce((sum, part) => sum + part.of, 0);
  return of ? parts.reduce((sum, part) => sum + part.value * part.of, 0) / of : 0;
};
const percent = (value: number) => `${Math.round(value * 100)}%`;

// L8.4 On the clean set, each chord lands over the syllable it is sung on, the chart's chords given at their times.
{
  const rated = runs.map((run) => ({ run, rates: rechartRates(chartRows(run.take.chart), chartRows(words.buildChart(run.listen.sections, trueChanges(run), run.listen.lines, run.lyrics))) }));
  const exact = pooled(rated.map(({ rates }) => ({ value: rates.exact, of: rates.chords })));
  const withinSyllable = pooled(rated.map(({ rates }) => ({ value: rates.withinSyllable, of: rates.chords })));
  const worst = rated.reduce((low, each) => (each.rates.exact < low.rates.exact ? each : low), rated[0]);
  check(
    exact >= 0.85 && withinSyllable >= 0.95,
    `L8.4 chords land on the right syllable on the clean set: ${percent(exact)} exact and ${percent(withinSyllable)} within one syllable, scored by chordAnchors against the chart (want 85% and 95%; least exact ${worst?.run.score.title} ${percent(worst?.rates.exact ?? 0)})`,
    L8,
  );
}

// L8.5 The built chart, from the words timed right, keeps the layout rules.
{
  const built = runs.map((run) => ({ run, chart: words.buildChart(trueSections(run), trueChanges(run), trueLines(run.take.truth), run.lyrics) }));
  const roundTrip = built.filter(({ run, chart }) => JSON.stringify(chordAnchors(chartRows(chart))) === JSON.stringify(run.take.truth.anchors));
  check(
    roundTrip.length === runs.length,
    `L8.5 chordAnchors of every built chart names each chord's word and column as the song sings it (${roundTrip.length} of ${runs.length}; first off: ${built.find((each) => !roundTrip.includes(each))?.run.score.title ?? "none"})`,
    L8,
  );
  const rows: Row[] = built.flatMap(({ chart }) => chartRows(chart));
  const wide = rows.filter((row) => Math.max(row.chords.length, row.lyrics?.length ?? 0) > 40);
  const stuck = wide.filter((row) => !canWrap(row));
  check(rows.length > 0 && stuck.length === 0, `L8.5 every built row wider than 40 columns can wrap without moving a chord off its word (${wide.length} wide of ${rows.length} rows; stuck: ${JSON.stringify(stuck[0] ?? null)})`, L8);
  const tokens = rows.flatMap((row) => row.chords.match(/\S+/g) ?? []);
  const unreadable = tokens.filter((token) => !words.parseChord(token) && token !== "N.C." && token !== "?");
  check(tokens.length > 0 && unreadable.length === 0, `L8.5 no chord runs into another: every token of every built chord line is one chord (${tokens.length} tokens; run together: ${unreadable.slice(0, 5).join(", ") || "none"})`, L8);
  const unsung = built.flatMap(({ run, chart }) =>
    run.take.chart.flatMap((section, i) => (section.lines.some((line) => line.lyrics !== undefined) ? [] : [{ title: run.score.title, heading: section.heading, built: chart[i] }])),
  );
  const barRows = unsung.filter((each) => !!each.built && each.built.lines.length > 0 && each.built.lines.every((line) => line.bars !== undefined && line.lyrics === undefined));
  check(
    unsung.length > 0 && barRows.length === unsung.length,
    `L8.5 a section with no words is built as bar rows (${barRows.length} of ${unsung.length}; first off: ${unsung.find((each) => !barRows.includes(each)) ? `${unsung.find((each) => !barRows.includes(each))!.title} ${unsung.find((each) => !barRows.includes(each))!.heading}` : "none"})`,
    L8,
  );
}

const gather = runs.find((run) => run.score.title === "Gather at the River")!;
const lyricLines = (text: string) => text.split("\n").filter((line) => line.trim());

// L8.6 A line with no sung phrase is still placed: between its neighbours, red, its chords at its start.
{
  const spoken = "Everybody listen to the preacher now";
  const lines = lyricLines(gather.lyrics);
  const text = gather.lyrics.replace(`${lines[0]}\n`, `${lines[0]}\n${spoken}\n`);
  const heard = words.hearLines(gather.listen.analysis.voiceOnsets, gather.listen.analysis.beats, trueSections(gather), trueChanges(gather), text);
  const [before, own, after] = [0, 1, 2].map((line) => heard.find((each) => each.line === line));
  const between = !!before && !!own && !!after && before.start < own.start && own.start < after.start;
  check(
    between && own!.syllables.length > 0 && own!.syllables.every((syllable) => syllable.band === "check"),
    `L8.6 an unsung line gets a time between its neighbours' and every syllable of it is red (${own ? `${own.start.toFixed(2)} s between ${before?.start.toFixed(2)} and ${after?.start.toFixed(2)}, bands ${[...new Set(own.syllables.map((each) => each.band))].join(" ")}` : "no time"})`,
    L8,
  );
  const rows = chartRows(words.buildChart(trueSections(gather), trueChanges(gather), heard, text));
  const row = rows.find((each) => each.lyrics === spoken);
  const others = rechartRates(chartRows(gather.take.chart), rows.filter((each) => each !== row));
  check(
    !!row && /^(\S+( \S+)*)?$/.test(row.chords.trimEnd()) && others.exact >= 0.85,
    `L8.6 its chords sit at its start and the sung lines keep theirs (${row ? JSON.stringify(row.chords) : "no row"}; the rest ${percent(others.exact)} exact)`,
    L8,
  );
}

// L8.7 A chart's own lyrics are lined up the same way: every lyric line of it gets a time.
{
  const timed = runs.filter((run) => {
    const count = lyricLines(run.lyrics).length;
    const starts = Array.from({ length: count }, (_, line) => run.listen.lines.find((each) => each.line === line)?.start ?? NaN);
    return starts.every((start, i) => Number.isFinite(start) && (i === 0 || start > starts[i - 1]));
  });
  check(timed.length === runs.length, `L8.7 a chart's own lyrics are aligned: every lyric line of each sung song's chart gets a time, in order (${timed.length} of ${runs.length} songs)`, L8);
}

// L8.8 One extra word and one missing word against the words sung still line up.
{
  const parts = runs.map((run) => {
    const lines = lyricLines(run.lyrics);
    const extra = `${lines[0]} now`;
    const missing = lines[1].replace(/\s+\S+$/, "");
    const text = run.lyrics.replace(lines[0], extra).replace(lines[1], missing);
    const heard = words.hearLines(run.listen.analysis.voiceOnsets, run.listen.analysis.beats, trueSections(run), trueChanges(run), text);
    return scoreListen({ ...run.listen, lines: heard }, run.take.truth).values;
  });
  const misses = parts.map((values) => values["line start error in ms"]).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const median = misses.length ? misses[Math.floor(misses.length / 2)] : null;
  const withinWord = parts.map((values) => values["syllable placement within one word"]).filter((value): value is number => value !== null);
  const word = withinWord.length ? withinWord.reduce((sum, value) => sum + value, 0) / withinWord.length : 0;
  check(
    misses.length === runs.length && median !== null && median <= 300 && withinWord.length === runs.length && word >= 0.9,
    `L8.8 a changed word count still aligns: line starts ${median === null ? "n/a" : `${Math.round(median)} ms`} off in the middle song, syllables within one word ${percent(word)} (want 300 ms and 90%)`,
    L8,
  );
}

// L8.9 A chord takes the syllable sung, not the one even spacing of the line would give it.
{
  const hard: { run: Run; chord: string; word: number }[] = [];
  for (const run of runs) {
    const { truth } = run.take;
    const before: number[] = [];
    let count = 0;
    for (const line of lyricLines(run.lyrics)) {
      before.push(count);
      count += line.split(/\s+/).filter(Boolean).length;
    }
    const lines = new Map<number, Truth["syllables"]>();
    for (const syllable of truth.syllables) lines.set(syllable.line, [...(lines.get(syllable.line) ?? []), syllable]);
    for (const [line, own] of lines) {
      if (own.length < 2) continue;
      const [start, end] = [own[0].at, own[own.length - 1].at];
      for (const change of truth.changes) {
        const sungOn = own.find((syllable) => Math.abs(syllable.at - change.at) < 1e-9);
        if (!sungOn || change.at <= start) continue;
        const even = own.map((_, k) => start + ((end - start) * k) / (own.length - 1));
        const guess = even.reduce((best, at, k) => (Math.abs(at - change.at) < Math.abs(even[best] - change.at) ? k : best), 0);
        if (own[guess].word !== sungOn.word) hard.push({ run, chord: change.chord, word: before[line] + sungOn.word + 1 });
      }
    }
  }
  const placed = hard.filter(({ run, chord, word }) =>
    chordAnchors(chartRows(words.buildChart(run.listen.sections, trueChanges(run), run.listen.lines, run.lyrics))).some((anchor) => anchor.startsWith(`${chord} on word ${word} `)),
  );
  check(
    hard.length >= 3 && placed.length === hard.length,
    `L8.9 the chord picks the syllable sung, not the one even spacing would give it: ${placed.length} of ${hard.length} such changes land on the word sung (${hard.map(({ run, chord, word }) => `${run.score.title} ${chord} word ${word}`).join(", ")})`,
    L8,
  );
}

// Terry t838u: a chorus written once is laid over every chorus the recording repeats.
{
  const chart = gather.take.chart;
  const firstChorus = chart.findIndex((section) => section.heading.startsWith("CHORUS"));
  const once = lyricsOf(chart.filter((section, i) => !section.heading.startsWith("CHORUS") || i === firstChorus))!;
  const heard = words.hearLines(gather.listen.analysis.voiceOnsets, gather.listen.analysis.beats, trueSections(gather), trueChanges(gather), once);
  const rows = chartRows(words.buildChart(trueSections(gather), trueChanges(gather), heard, once));
  const lyricsAsSung = chartRows(chart).map((row) => row.lyrics);
  const rates = rechartRates(chartRows(chart), rows);
  check(
    JSON.stringify(rows.map((row) => row.lyrics)) === JSON.stringify(lyricsAsSung) && rates.exact >= 0.85,
    `the chorus pasted once is sung at each of the recording's ${chart.filter((section) => section.heading.startsWith("CHORUS")).length} choruses, its chords over its syllables each time (${rows.length} of ${lyricsAsSung.length} rows as sung, ${percent(rates.exact)} exact)`,
    L8,
  );
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
