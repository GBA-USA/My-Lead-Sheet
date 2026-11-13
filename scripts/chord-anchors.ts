export interface Row {
  chords: string;
  lyrics?: string;
  /** The column each chord is drawn at, when measured from the page; else its place in `chords`. */
  at?: number[];
}

/**
 * Names every chord in `rows`, read in order, by the lyric word it sits over (or leads into from the space just
 * before it) and its column relative to that word's first letter. Words are counted across rows, so a row cut
 * inside a word, or a chord parted from its word, changes the names that follow.
 */
export function chordAnchors(rows: Row[]): string[] {
  const named: string[] = [];
  let seen = 0;
  for (const row of rows) {
    const words = [...(row.lyrics ?? "").matchAll(/\S+/g)];
    for (const [k, chord] of [...row.chords.matchAll(/\S+/g)].entries()) {
      const column = row.at?.[k] ?? chord.index;
      const index = words.findIndex((word) => word.index + word[0].length > column);
      named.push(index < 0 ? `${chord[0]} after word ${seen + words.length}` : `${chord[0]} on word ${seen + index + 1} "${words[index][0]}" at ${column - words[index].index}`);
    }
    seen += words.length;
  }
  return named;
}

export const lyricWords = (rows: Row[]) => rows.flatMap((row) => row.lyrics?.match(/\S+/g) ?? []);

const filled = (line: string | undefined, column: number) => line !== undefined && column < line.length && line[column] !== " ";

/** Whether `row` could be cut into two rows without cutting a word or a chord name or moving any chord off its word. */
export function canWrap(row: Row): boolean {
  const width = Math.max(row.chords.length, row.lyrics?.length ?? 0);
  const whole = chordAnchors([row]).join("|");
  for (let column = 1; column < width; column += 1) {
    if ((filled(row.chords, column - 1) && filled(row.chords, column)) || (filled(row.lyrics, column - 1) && filled(row.lyrics, column))) continue;
    const head = { chords: row.chords.slice(0, column), lyrics: row.lyrics?.slice(0, column) };
    const tail = { chords: row.chords.slice(column), lyrics: row.lyrics?.slice(column) };
    if (head.chords.trim() === "" && !head.lyrics?.trim()) continue;
    if (tail.chords.trim() === "" && !tail.lyrics?.trim()) continue;
    if (chordAnchors([head, tail]).join("|") === whole) return true;
  }
  return false;
}
