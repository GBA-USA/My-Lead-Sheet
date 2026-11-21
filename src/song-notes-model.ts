/** A note a band admin pinned to a band song. Band-only like the song: it never goes into a chart or a share. */
export type SongNote = { noteId: string; songId: string; authorName: string; body: string; createdAt: number };

/** `POST /api/bands/notes/list`: the song's notes, newest first, and whether the caller may add or delete them, which only the server decides. */
export type NoteList = { notes: SongNote[]; canWrite: boolean };

export const NOTE_MAX_CHARS = 500;

/** Collapsed, the strip shows the newest note and says how many more. Expanded, it shows every note. */
export function visibleNotes(notes: SongNote[], expanded: boolean): { shown: SongNote[]; more: number } {
  if (expanded) return { shown: notes, more: 0 };
  return { shown: notes.slice(0, 1), more: Math.max(notes.length - 1, 0) };
}
