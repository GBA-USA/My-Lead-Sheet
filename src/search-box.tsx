import { songHref } from "./route";
import { youHaveLine, type SongChips } from "./search";
import type { Song } from "./types";
import "./search.css";

export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      className="search-box"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/** The key, band and Has timing chips under the box. `bands` maps each band id to its name. */
export function SearchChips({ keys, bands, chips, onChange }: { keys: string[]; bands: ReadonlyMap<string, string>; chips: SongChips; onChange: (chips: SongChips) => void }) {
  const toggle = (change: Partial<SongChips>) => onChange({ ...chips, ...change });
  return (
    <div className="search-chips" role="group" aria-label="Filter songs">
      <select className="search-chip" aria-label="Key" value={chips.key ?? ""} onChange={(event) => toggle({ key: event.target.value || null })}>
        <option value="">Any key</option>
        {keys.map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>
      {[...bands].map(([bandId, name]) => (
        <button key={bandId} type="button" className="search-chip" aria-pressed={chips.band === bandId} onClick={() => toggle({ band: chips.band === bandId ? null : bandId })}>
          {name}
        </button>
      ))}
      <button type="button" className="search-chip" aria-pressed={chips.timed} onClick={() => toggle({ timed: !chips.timed })}>
        Has timing
      </button>
    </div>
  );
}

/** The duplicate guard's offer, in place of an add: open the song this phone already has, or add the copy anyway. Never a refusal. */
export function YouHaveIt({ have, onAdd }: { have: Song; onAdd: () => void }) {
  return (
    <span className="you-have-it" role="status">
      <small>{youHaveLine(have)}</small>
      <a className="account-secondary" href={songHref(have.id, "songs")}>
        Open
      </a>
      <button type="button" className="account-secondary" onClick={onAdd}>
        Add anyway
      </button>
    </span>
  );
}
