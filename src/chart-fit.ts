/** One printed chord line, with the lyric slice under it when the row has lyrics. */
export interface ChartPiece {
  chords: string;
  lyrics?: string;
}

/**
 * 13px times the text scale when the longest line fits. Otherwise, at 100% and below, shrink until it fits
 * (not under 8px). Above 100%, grow the 100% fit by the scale. Lines still too long wrap (see `wrapAligned`).
 */
export function fitChartFont(width: number, longest: number, scale: number, advance: (size: number) => number): number {
  if (width <= 0) return 12 * scale;
  const preferred = 13 * scale;
  const fits = (size: number) => longest * advance(size) <= width - 1;
  if (fits(preferred)) return preferred;
  let size = preferred;
  const floor = 8;
  while (size > floor && !fits(size)) size -= 0.25;
  if (scale > 1) {
    const base = fitChartFont(width, longest, 1, advance);
    return Math.min(preferred, Math.max(size, base * scale));
  }
  return Math.max(floor, size);
}

/** How many monospace characters fit across `width`, by the same rule `fitChartFont` uses. */
export function chartColumns(width: number, size: number, advance: (size: number) => number): number {
  return width > 0 ? Math.max(1, Math.floor((width - 1) / advance(size))) : Infinity;
}

const filled = (line: string | undefined, column: number) => line !== undefined && column < line.length && line[column] !== " ";

/** A break before `column` that cuts neither a chord name nor (when `words` holds) a lyric word. */
function cleanBreak(chords: string, lyrics: string | undefined, column: number, words: boolean): boolean {
  if (filled(chords, column - 1) && filled(chords, column)) return false;
  return !words || !(filled(lyrics, column - 1) && filled(lyrics, column));
}

/**
 * Cuts a chord line and its lyric line at the same columns so neither is wider than `columns`, keeping every chord
 * over its syllable. A row that fits comes back as it is. Breaks fall at a space in the lyric when one is in reach,
 * else between chords, else at the edge. Columns blank in both lines at the start of a piece are dropped.
 */
export function wrapAligned(chords: string, lyrics: string | undefined, columns: number): ChartPiece[] {
  const width = Math.max(chords.length, lyrics?.length ?? 0);
  if (width <= columns) return [{ chords, lyrics }];
  const pieces: ChartPiece[] = [];
  let from = 0;
  while (from < width) {
    while (from < width && !filled(chords, from) && !filled(lyrics, from)) from += 1;
    if (from >= width) break;
    let to = Math.min(width, from + columns);
    if (to < width) {
      const reach = (words: boolean) => {
        for (let column = to; column > from; column -= 1) if (cleanBreak(chords, lyrics, column, words)) return column;
        return 0;
      };
      to = reach(true) || reach(false) || to;
    }
    pieces.push({ chords: chords.slice(from, to).trimEnd(), lyrics: lyrics?.slice(from, to).trimEnd() });
    from = to;
  }
  return pieces;
}
