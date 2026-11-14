import { useLayoutEffect, useRef, useState } from "react";
import { chartColumns, chartFont, fitChartFont, wrapAligned, type ChartPiece } from "./chart-fit";
import { usePlayingLearned } from "./cues";
import { BeatDot, MetronomeControl, type MetronomeState } from "./metronome-view";
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
      {metronome.playing && metronome.prefs.indicator ? <BeatDot offsetMs={metronome.prefs.syncOffsetMs} /> : null}
      <h1 className="sheet-title">
        <span className="sheet-name">{song.title}</span>
        <span className="sheet-artist"> — {song.artist}</span>
      </h1>

      {song.sourceNote ? <p className="source">{song.sourceNote}</p> : null}

      <p className="meta">
        Key: {displayKeyLabel(song, semitones)} • Time: {song.timeSignature} • Tempo: {tempoText(song.tempo)}
      </p>

      <MetronomeControl key={song.id} songTempo={song.tempo} metronome={metronome} />

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

  return (
    <div className="chart" id="chord-section" ref={ref}>
      {song.body.map((section, index) => {
        const learned = playing?.sections[index];
        const heard = learned?.heading === section.heading ? learned.heard : undefined;
        const rows = heard ? [{ bars: heardRow(heard) }, ...section.lines] : section.lines;
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
  return (
    <>
      {line.chords !== undefined ? (
        wrapAligned(displayChordLine(line.chords, song, semitones, notation), line.lyrics, columns).map((piece, index) => {
          const mono = { fontSize: fontFor(piece) };
          return (
            <div className="pair" key={index}>
              <div className="chords" style={mono}>
                {piece.chords}
              </div>
              {piece.lyrics !== undefined ? (
                <div className="lyrics" style={mono}>
                  {piece.lyrics}
                </div>
              ) : null}
            </div>
          );
        })
      ) : line.lyrics !== undefined ? (
        <p className="lyric-only">{line.lyrics}</p>
      ) : null}
      {line.bars !== undefined
        ? wrapAligned(displayChordLine(line.bars, song, semitones, notation), undefined, columns).map((piece, index) => (
            <div className="bars" style={{ fontSize: fontFor(piece) }} key={index}>
              {piece.chords}
            </div>
          ))
        : null}
      {line.note !== undefined ? <p className="chart-note">{line.note}</p> : null}
    </>
  );
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
