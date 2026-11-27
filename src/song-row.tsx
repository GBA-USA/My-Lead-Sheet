import { tempoText } from "./storage";
import type { CopyMark, Song } from "./types";
import "./song-row.css";

export type SongRowSong = Pick<Song, "title" | "artist" | "keyLabel" | "tempo"> & Partial<Pick<Song, "copy">>;

/** Tempo label for a list row, or null when the song has no tempo (unlike `tempoText(null)`, which returns a dash). */
export function rowTempoText(tempo: number | null): string | null {
  return tempo == null ? null : tempoText(tempo);
}

/** Where a copy came from, and the lock when it was shared Private, so it can't be passed on. Nothing for the player's own songs. */
export function CopyNote({ copy }: { copy?: CopyMark }) {
  if (!copy) return null;
  return (
    <span className="song-copy-note">
      {copy.from ? `From ${copy.from.name}` : "From a band"}
      {copy.canSendOn ? null : (
        <span role="img" aria-label="Private">
          {" "}🔒
        </span>
      )}
    </span>
  );
}

/**
 * Shared text block for a song list row across My Songs, search results, personal setlists, band Songs, and band setlists.
 * `facts` controls whether the key and tempo line renders (`A major · ~96 bpm`, or key alone when tempo is missing).
 */
export function SongRowText({
  song,
  facts = false,
  titleClass = "song-title",
}: {
  song: SongRowSong;
  facts?: boolean;
  titleClass?: string;
}) {
  const tempo = facts ? rowTempoText(song.tempo) : null;
  return (
    <>
      <span className={titleClass}>{song.title}</span>
      {song.artist ? <span className="song-artist">{song.artist}</span> : null}
      <CopyNote copy={song.copy} />
      {facts && (song.keyLabel || tempo) ? (
        <span className="song-meta">
          {song.keyLabel ? <span className="song-key">{song.keyLabel}</span> : null}
          {tempo ? <span>{song.keyLabel ? ` · ${tempo}` : tempo}</span> : null}
        </span>
      ) : null}
    </>
  );
}
