import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { chartColumns, chartFont, fitChartFont, wrapAligned, type ChartPiece } from "./chart-fit";
import { useBattery } from "./battery";
import { usePlayingLearned } from "./cues";
import { onPlayhead, useLookAhead } from "./hooks";
import { BeatDot, type MetronomeState } from "./metronome-view";
import {
  displayBassNote,
  displayChordCell,
  displayChordLine,
  displayKeyLabel,
  displayPlace,
  namesChords,
  nashvilleNumber,
  originalKey,
  type Notation,
} from "./music";
import { evenPlan } from "./scroll-timing";
import { hasTiming } from "./song-version";
import { tempoText } from "./storage";
import type { ChartLine, Song } from "./types";

export function LeadSheet({
  song,
  scale,
  semitones,
  notation,
  metronome,
}: {
  song: Song;
  scale: number;
  semitones: number;
  notation: Notation;
  metronome: MetronomeState;
}) {
  const notes = [song.keyNote, song.tempoNote].filter((note) => note.trim().length > 0);
  const atAGlance = song.atAGlance ? displayChordLine(song.atAGlance, song, semitones, notation) : "";
  const inOriginalKey = <OriginalKeyHint song={song} semitones={semitones} />;
  const battery = useBattery();

  return (
    <article className="sheet" style={{ fontSize: `calc(16px * ${scale})` }}>
      {metronome.playing ? <BeatDot metronome={metronome} battery={battery} /> : null}
      <LookTag />
      <h1 className="sheet-title">
        <span className="sheet-name">{song.title}</span>
        <span className="sheet-artist"> — {song.artist}</span>
      </h1>

      {song.sourceNote ? <p className="source">{song.sourceNote}</p> : null}

      <p className="meta">
        Key: {displayKeyLabel(song, semitones)} • Time: {song.timeSignature} • Tempo: {tempoText(song.tempo)}
      </p>

      {song.feel ? <p className="feel">Feel: {song.feel}</p> : null}

      <h2 className="sheet-label">Your bass notes</h2>
      <BassTable song={song} semitones={semitones} notation={notation} />

      {song.howToPlay ? (
        <>
          <h2 className="sheet-label">How to play{inOriginalKey}</h2>
          <p className="prose">{song.howToPlay}</p>
        </>
      ) : null}

      <Chart key={song.ref} song={song} scale={scale} semitones={semitones} notation={notation} />

      {song.atAGlance ? (
        <>
          <h2 className="sheet-label">At a glance</h2>
          <p className="prose">{atAGlance}</p>
        </>
      ) : null}

      {song.practiceTip ? (
        <>
          <h2 className="sheet-label">Practice tip{inOriginalKey}</h2>
          <p className="prose">{song.practiceTip}</p>
        </>
      ) : null}

      {notes.length > 0 ? (
        <>
          <h2 className="sheet-label">Key &amp; tempo notes</h2>
          {song.keyNote.trim() ? <p className="prose note-line">{song.keyNote}</p> : null}
          {song.tempoNote.trim() ? <p className="prose note-line">{song.tempoNote}</p> : null}
        </>
      ) : null}
    </article>
  );
}

/** While this phone looks ahead in a gig, the gold tag at the top of the view. */
function LookTag() {
  const look = useLookAhead();
  return look ? (
    <div className="look-rail">
      <span className="look-tag">{look.tag}</span>
    </div>
  ) : null;
}

/** While this phone looks ahead in a gig, a thin gold line in the margin where the band is on the chart. */
function BandLine() {
  const look = useLookAhead();
  return look ? <div className="band-line" style={{ top: look.bandAt }} aria-hidden="true" /> : null;
}

function OriginalKeyHint({ song, semitones }: { song: Song; semitones: number }) {
  const original = originalKey(song, semitones);
  return original ? <span className="hint"> · original key ({original})</span> : null;
}

function BassTable({
  song,
  semitones,
  notation,
}: {
  song: Song;
  semitones: number;
  notation: Notation;
}) {
  return (
    <table className="bass">
      <thead>
        <tr>
          <th scope="col">Chord</th>
          <th scope="col">Nashville</th>
          <th scope="col">
            Bass
            <br />
            note
          </th>
          <th scope="col">Easiest place to play it</th>
        </tr>
      </thead>
      <tbody>
        {song.bassNotes.map((note, index) => {
          const number = nashvilleNumber(note, song);
          return (
            <tr key={`${note.chord}-${index}`}>
              <td className="strong">{displayChordCell(note, song, semitones, notation)}</td>
              <td>
                {number}
                {number === note.nashville ? null : <span className="hint"> ({note.nashville})</span>}
              </td>
              <td className="strong">{displayBassNote(note.bassNote, song, semitones, notation)}</td>
              <td>{displayPlace(note, song, semitones)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Chart({
  song,
  scale,
  semitones,
  notation,
}: {
  song: Song;
  scale: number;
  semitones: number;
  notation: Notation;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const playing = usePlayingLearned();
  const columns = chartColumns(width, chartFont(scale), charAdvance);
  const fontFor = (piece: ChartPiece) => `${fitChartFont(width, Math.max(piece.chords.length, piece.lyrics?.length ?? 0), scale, charAdvance)}px`;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || notation !== "chords") return;
    const measure = () => timeChords(element);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notation, columns, song, semitones, scale, playing]);

  useLayoutEffect(() => {
    if (notation !== "chords") return;
    return onPlayhead((at) => ref.current?.style.setProperty("--playhead", String(at)));
  }, [notation]);

  return (
    <div className="chart" id="chord-section" ref={ref}>
      <BandLine />
      {notation === "chords" && !evenPlan(song) && !hasTiming(song.ref) ? (
        <p className="chart-note">This song has no tempo and length yet, so the chords don't fill as it plays.</p>
      ) : null}
      {song.body.map((section, index) => {
        const learned = playing?.sections[index];
        const heard = learned?.heading === section.heading ? learned.heard : undefined;
        const rows = heard ? [{ bars: heardRow(heard.map((cell) => cell.chord)) }, ...section.lines] : section.lines;
        return (
          <section key={`${section.heading}-${index}`} className="chart-section">
            <h3 className="chart-heading">{section.heading}</h3>
            {rows.map((line, lineIndex) => (
              <ChartRow
                key={lineIndex}
                line={line}
                columns={columns}
                fontFor={fontFor}
                song={song}
                semitones={semitones}
                notation={notation}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Gives each Chords only chord the stretch of the chart it plays over, as `--from` and `--to` in pixels down the
 * chart, the unit `--playhead` moves in. A row's slot runs to the next row's, the first row's from its section's top.
 * A chord starts at its share of its slot and plays until the next chord starts, the last one until the chart's end.
 * `--per` is one over the stretch's length. `--ink-from` and `--ink-to` are where its letters' ink starts and ends
 * across its box, so the fill covers the letters exactly over that stretch.
 */
function timeChords(chart: HTMLElement) {
  const top = chart.getBoundingClientRect().top;
  const below = (el: Element) => el.getBoundingClientRect().top - top;
  const slots = [...chart.querySelectorAll(".chart-section")].flatMap((section) =>
    [...section.querySelectorAll(".chords, .bars")].map((row, i) => ({ row, from: below(i === 0 ? section : row) })),
  );
  const starts = slots.flatMap(({ row, from }, i) => {
    const to = slots[i + 1]?.from ?? chart.offsetHeight;
    return [...row.querySelectorAll<HTMLElement>(".chord-fill")].map((chord) => ({ chord, at: from + (to - from) * Number(chord.dataset.at) }));
  });
  starts.forEach(({ chord, at }, i) => {
    chord.style.setProperty("--from", String(at));
    chord.style.setProperty("--per", String(1 / Math.max(0.01, (starts[i + 1]?.at ?? chart.offsetHeight) - at)));
    const ink = textMetrics(chord.textContent ?? "", monoFont(100));
    if (!ink || ink.width <= 0) return;
    chord.style.setProperty("--ink-from", String(Math.max(0, -ink.actualBoundingBoxLeft / ink.width)));
    chord.style.setProperty("--ink-to", String(Math.min(1, ink.actualBoundingBoxRight / ink.width)));
  });
}

/** A Chords only line: each chord a span that fills as it plays, marked with its column's share of the row's `width`. */
function TimedChords({ text, width }: { text: string; width: number }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const chord of text.matchAll(/[^\s|]+/g)) {
    parts.push(text.slice(cursor, chord.index));
    parts.push(
      <span key={chord.index} className="chord-fill" data-at={chord.index / width}>
        {chord[0]}
      </span>,
    );
    cursor = chord.index + chord[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Kept heard bars as a bar row, blank where Learn was not sure: "Heard | A7 |    | E7 |". */
function heardRow(heard: (string | null)[]): string {
  const width = Math.max(...heard.map((chord) => chord?.length ?? 0));
  return `Heard | ${heard.map((chord) => (chord ?? "").padEnd(width)).join(" | ")} |`;
}

function ChartRow({
  line,
  columns,
  fontFor,
  song,
  semitones,
  notation,
}: {
  line: ChartLine;
  columns: number;
  fontFor: (piece: ChartPiece) => string;
  song: Song;
  semitones: number;
  notation: Notation;
}) {
  const chordsOnly = notation === "chords";
  const chordText = (text: string, width: number) => (chordsOnly ? <TimedChords text={text} width={width} /> : text);
  return (
    <>
      {line.chords !== undefined ? (
        wrapAligned(displayChordLine(line.chords, song, semitones, notation), line.lyrics, columns).map((piece, index) => {
          if (chordsOnly && !piece.chords.trim()) return null;
          const mono = { fontSize: fontFor(piece) };
          return (
            <div className="pair" key={index}>
              <div className="chords" style={mono}>
                {chordText(piece.chords, Math.max(piece.chords.length, piece.lyrics?.length ?? 0))}
              </div>
              {piece.lyrics !== undefined && !chordsOnly ? (
                <div className="lyrics" style={mono}>
                  {piece.lyrics}
                </div>
              ) : null}
            </div>
          );
        })
      ) : line.lyrics !== undefined && !chordsOnly ? (
        <p className="lyric-only">{line.lyrics}</p>
      ) : null}
      {line.bars !== undefined
        ? wrapAligned(displayChordLine(line.bars, song, semitones, notation), undefined, columns).map((piece, index) => (
            <div className="bars" style={{ fontSize: fontFor(piece) }} key={index}>
              {chordText(piece.chords, piece.chords.length)}
            </div>
          ))
        : null}
      {line.note !== undefined ? (
        <p className="chart-note">
          {line.note}
          {namesChords(line.note) ? <OriginalKeyHint song={song} semitones={semitones} /> : null}
        </p>
      ) : null}
    </>
  );
}

let measureCanvas: CanvasRenderingContext2D | null | undefined;

function textMetrics(text: string, font: string): TextMetrics | null {
  if (measureCanvas === undefined) {
    measureCanvas = document.createElement("canvas").getContext("2d");
  }
  if (!measureCanvas) return null;
  measureCanvas.font = font;
  return measureCanvas.measureText(text);
}

const monoFont = (size: number) => `500 ${size}px "IBM Plex Mono", ui-monospace, monospace`;

function charAdvance(size: number): number {
  return textMetrics("0", monoFont(size))?.width ?? size * 0.6;
}
