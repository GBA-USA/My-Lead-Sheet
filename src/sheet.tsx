import { useLayoutEffect, useRef, useState } from "react";
import { MetronomeControl, type MetronomeState } from "./metronome-view";
import {
  displayBassNote,
  displayChordCell,
  displayChordLine,
  displayKeyLabel,
  nashvilleNumber,
  originalKey,
  type Notation,
} from "./music";
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
  const original = originalKey(song, semitones);
  const inOriginalKey = original ? <span className="hint"> · original key ({original})</span> : null;

  return (
    <article className="sheet" style={{ fontSize: `calc(16px * ${scale})` }}>
      <h1 className="sheet-title">
        <span className="sheet-name">{song.title}</span>
        <span className="sheet-artist"> — {song.artist}</span>
      </h1>

      {song.sourceNote ? <p className="source">{song.sourceNote}</p> : null}

      <p className="meta">
        Key: {displayKeyLabel(song, semitones)} • Time: {song.timeSignature} • Tempo: {tempoText(song.tempo)}
      </p>

      <MetronomeControl
        key={song.id}
        songTempo={song.tempo}
        bpm={metronome.bpm}
        playing={metronome.playing}
        onBpm={metronome.setBpm}
        onNudge={metronome.nudge}
        onToggle={metronome.toggle}
        onStop={metronome.stop}
      />

      {song.feel ? <p className="feel">Feel: {song.feel}</p> : null}

      <h2 className="sheet-label">Your bass notes</h2>
      <BassTable song={song} semitones={semitones} notation={notation} />

      {song.howToPlay ? (
        <>
          <h2 className="sheet-label">How to play{inOriginalKey}</h2>
          <p className="prose">{song.howToPlay}</p>
        </>
      ) : null}

      <Chart song={song} scale={scale} semitones={semitones} notation={notation} />

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
          <th scope="col">
            Easiest place to play it
            {originalKey(song, semitones) ? (
              <>
                <br />
                <span className="hint">original key</span>
              </>
            ) : null}
          </th>
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
              <td>{note.position}</td>
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
  const longest = longestAligned(song, semitones, notation);
  const [fontSize, setFontSize] = useState(12);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const fit = () => {
      const width = element.clientWidth;
      setFontSize(fitChartFont(width, longest, scale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [longest, scale, semitones, notation]);

  return (
    <div className="chart" ref={ref}>
      {song.body.map((section, index) => (
        <section key={`${section.heading}-${index}`} className="chart-section">
          <h3 className="chart-heading">{section.heading}</h3>
          {section.lines.map((line, lineIndex) => (
            <ChartRow
              key={lineIndex}
              line={line}
              fontSize={fontSize}
              song={song}
              semitones={semitones}
              notation={notation}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ChartRow({
  line,
  fontSize,
  song,
  semitones,
  notation,
}: {
  line: ChartLine;
  fontSize: number;
  song: Song;
  semitones: number;
  notation: Notation;
}) {
  const mono = { fontSize: `${fontSize}px` };
  const paired = line.chords !== undefined;
  const chords = line.chords === undefined ? "" : displayChordLine(line.chords, song, semitones, notation);
  const bars = line.bars === undefined ? "" : displayChordLine(line.bars, song, semitones, notation);
  return (
    <>
      {paired ? (
        <div className="pair">
          <div className="chords" style={mono}>
            {chords}
          </div>
          {line.lyrics !== undefined ? (
            <div className="lyrics" style={mono}>
              {line.lyrics}
            </div>
          ) : null}
        </div>
      ) : line.lyrics !== undefined ? (
        <p className="lyric-only">{line.lyrics}</p>
      ) : null}
      {line.bars !== undefined ? (
        <div className="bars" style={mono}>
          {bars}
        </div>
      ) : null}
      {line.note !== undefined ? <p className="chart-note">{line.note}</p> : null}
    </>
  );
}

function longestAligned(song: Song, semitones: number, notation: Notation): number {
  let max = 1;
  for (const section of song.body) {
    for (const line of section.lines) {
      if (line.chords) max = Math.max(max, displayChordLine(line.chords, song, semitones, notation).length);
      if (line.chords && line.lyrics) max = Math.max(max, line.lyrics.length);
      if (line.bars) max = Math.max(max, displayChordLine(line.bars, song, semitones, notation).length);
    }
  }
  return max;
}

let measureCanvas: CanvasRenderingContext2D | null | undefined;

function charAdvance(size: number): number {
  if (measureCanvas === undefined) {
    measureCanvas = document.createElement("canvas").getContext("2d");
  }
  if (!measureCanvas) return size * 0.6;
  measureCanvas.font = `500 ${size}px "IBM Plex Mono", ui-monospace, monospace`;
  return measureCanvas.measureText("0").width;
}

/** Largest chart size that keeps a Chain-Breaker-length line inside the sheet, then scaled by A+/A−. */
function fitChartFont(width: number, longest: number, scale: number): number {
  if (width <= 0) return 12 * scale;
  const preferred = 13 * scale;
  const fits = (size: number) => longest * charAdvance(size) <= width - 1;
  if (fits(preferred)) return preferred;
  let size = preferred;
  const floor = 8;
  while (size > floor && !fits(size)) size -= 0.25;
  if (scale > 1) {
    const base = fitChartFont(width, longest, 1);
    return Math.min(preferred, Math.max(size, base * scale));
  }
  return Math.max(floor, size);
}
