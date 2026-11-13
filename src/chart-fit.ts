/** One printed chord line, with the lyric slice under it when the row has lyrics. */
export interface ChartPiece {
  chords: string;
  lyrics?: string;
}

/** The chart's font size: 13px times the text scale. */
export const chartFont = (scale: number) => 13 * scale;

/** The chart font, unless `span` columns are wider than `width` there: then the largest size at which they fit. */
export function fitChartFont(width: number, span: number, scale: number, advance: (size: number) => number): number {
  let size = chartFont(scale);
  if (width > 0) while (size > 1 && span * advance(size) > width - 1) size -= 0.25;
  return size;
}

/** How many monospace characters fit across `width`, by the same rule `fitChartFont` uses. */
export function chartColumns(width: number, size: number, advance: (size: number) => number): number {
  return width > 0 ? Math.max(1, Math.floor((width - 1) / advance(size))) : Infinity;
}

const filled = (line: string | undefined, column: number) => line !== undefined && column < line.length && line[column] !== " ";

/**
 * For each column, whether a row may break before it: not inside a lyric word or a chord name, and not between a
 * chord and the syllable it sits on, or the word it leads into from the space just before.
 */
function breaks(chords: string, lyrics: string | undefined, width: number): boolean[] {
  const open = Array.from({ length: width + 1 }, () => true);
  const join = (from: number, to: number) => open.fill(false, from + 1, to + 1);
  for (const word of lyrics?.matchAll(/\S+/g) ?? []) join(word.index, word.index + word[0].length - 1);
  for (const chord of chords.matchAll(/\S+/g)) {
    const syllable = lyrics?.slice(chord.index).search(/\S/) ?? -1;
    join(chord.index, chord.index + Math.max(chord[0].length - 1, syllable));
  }
  return open;
}

/**
 * Cuts a chord line and its lyric line at the same columns so each chord keeps its syllable. A row that fits
 * `columns` comes back as it is. Otherwise each piece runs to the last word break in reach; a single chord and word
 * wider than `columns` goes on a row of its own. Columns blank in both lines at the start of a piece are dropped.
 */
export function wrapAligned(chords: string, lyrics: string | undefined, columns: number): ChartPiece[] {
  const width = Math.max(chords.length, lyrics?.length ?? 0);
  if (width <= columns) return [{ chords, lyrics }];
  const open = breaks(chords, lyrics, width);
  const pieces: ChartPiece[] = [];
  let from = 0;
  while (from < width) {
    while (from < width && !filled(chords, from) && !filled(lyrics, from)) from += 1;
    if (from >= width) break;
    let to = Math.min(width, from + columns);
    while (to > from && !open[to]) to -= 1;
    if (to === from) to = open.indexOf(true, from + columns);
    pieces.push({ chords: chords.slice(from, to).trimEnd(), lyrics: lyrics?.slice(from, to).trimEnd() });
    from = to;
  }
  return pieces;
}
