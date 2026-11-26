import { tempoChoices } from "./bpm-detect";
import { sheetSearchUrl } from "./song-search.js";
// @ts-expect-error TS5097: song-search.ts holds the same stem, so only ".tsx" names this file in tsc, Vite and esbuild.
import { WebSearchLink } from "./song-search.tsx";
import { madeHere } from "./storage";
import type { Song } from "./types";

/**
 * Which start panel a song needs: the full panel when it has no chart yet, a short line when it already has chords
 * or bar rows with no words, or null when it is not the player's own song or already has words.
 */
function startMode(song: Song): "empty" | "chords-only" | null {
  if (!madeHere(song)) return null;
  const hasWords = song.body.some((section) => section.lines.some((line) => Boolean(line.lyrics?.trim())));
  if (hasWords) return null;
  const hasChords = song.body.some((section) => section.lines.some((line) => Boolean(line.chords?.trim() || line.bars?.trim())));
  return hasChords ? "chords-only" : "empty";
}

/**
 * On a song the player made with no words yet: one panel for web search, pasting what was copied, or learning the
 * song by listening. On a song that already has chords and no words, one short line to add words.
 */
export function SongStartPanel({
  song,
  onPaste,
  onLearn,
  onBpm,
}: {
  song: Song;
  onPaste: (text: string) => void;
  onLearn: () => void;
  onBpm: (bpm: number) => void;
}) {
  const mode = startMode(song);
  if (!mode) return null;

  const hasQuery = Boolean(song.title.trim() || song.artist.trim());
  const otherTempos =
    song.tempo == null
      ? []
      : tempoChoices(song.tempo).filter((choice) => choice.feel !== "Suggested" && choice.bpm !== Math.round(song.tempo!));

  const paste = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* Refused or unavailable: open the full editor with the landed fallback message. */
    }
    onPaste(text);
  };

  const tempoRow =
    otherTempos.length > 0 ? (
      <div className="song-start-chips">
        <span className="song-start-chip-label">Tempo feel wrong?</span>
        {otherTempos.map(({ bpm, feel }) => (
          <button
            key={feel}
            type="button"
            className="song-start-chip"
            aria-label={`Use ${bpm} BPM, ${feel.toLowerCase()}`}
            onClick={() => onBpm(bpm)}
          >
            Use {bpm} bpm ({feel.toLowerCase()})
          </button>
        ))}
      </div>
    ) : null;

  if (mode === "chords-only") {
    return (
      <section className="song-search-start is-short" aria-label="Add words">
        <p className="song-start-lead">Chords are in. Copy the words from anywhere, then paste them here.</p>
        <div className="song-start-actions">
          {hasQuery ? <WebSearchLink label="Find chord / lead sheet" href={sheetSearchUrl(song.title, song.artist)} /> : null}
          <button type="button" className="song-start-btn" onClick={paste}>
            Paste what you copied
          </button>
        </div>
        {tempoRow}
      </section>
    );
  }

  return (
    <section className="song-search-start" aria-label="Finish this sheet">
      <p className="song-start-lead">No words yet.</p>
      <div className="song-start-actions">
        {hasQuery ? <WebSearchLink label="Find chord / lead sheet" href={sheetSearchUrl(song.title, song.artist)} /> : null}
        <button type="button" className="song-start-btn" onClick={paste}>
          Paste what you copied
        </button>
        <button type="button" className="song-start-btn" onClick={onLearn}>
          Learn this song
        </button>
      </div>
      <p className="song-start-note">Listen to set the tempo and the length.</p>
      {tempoRow}
    </section>
  );
}
