import { useEffect, useId, useState } from "react";
import { METRONOME_MAX, METRONOME_MIN } from "./metronome";
import type { Song, SongData } from "./types";
import "./song-data-editor.css";

export function formatRuntime(seconds: number | null): string {
  if (seconds == null) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function parseRuntime(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

export function parseBpm(text: string): number | null {
  const bpm = Number(text.trim());
  return Number.isInteger(bpm) && bpm >= METRONOME_MIN && bpm <= METRONOME_MAX ? bpm : null;
}

export interface SongDataForm {
  runtime: string;
  bpm: string;
  timeSignature: string;
}

/** A blank field or one equal to the library's value keeps the library's value. Null when a field can't be read. */
export function songDataFromForm(original: Song, form: SongDataForm): SongData | null {
  const data: SongData = {};
  if (form.runtime.trim()) {
    const runtime = parseRuntime(form.runtime);
    if (runtime == null) return null;
    if (runtime !== original.officialRuntimeSec) data.officialRuntimeSec = runtime;
  }
  if (form.bpm.trim()) {
    const bpm = parseBpm(form.bpm);
    if (bpm == null) return null;
    if (bpm !== original.tempo) data.tempo = bpm;
  }
  const timeSignature = form.timeSignature.trim();
  if (timeSignature && timeSignature !== original.timeSignature) data.timeSignature = timeSignature;
  return data;
}

/** The BPM entry on its own, so a tempo finder can sit beside the input later. */
export function BpmField({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (next: string) => void }) {
  const id = useId();
  return (
    <div className="song-data-field">
      <label htmlFor={id}>BPM</label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={value.trim() !== "" && parseBpm(value) == null}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 3))}
      />
    </div>
  );
}

/** Runtime, BPM and time signature for this song on this device. */
export function SongDataEditor({
  song,
  original,
  onSave,
  onClose,
}: {
  song: Song;
  original: Song;
  onSave: (data: SongData) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const runtimeId = useId();
  const timeId = useId();
  const [form, setForm] = useState<SongDataForm>(() => ({
    runtime: formatRuntime(song.officialRuntimeSec),
    bpm: song.tempo == null ? "" : String(song.tempo),
    timeSignature: song.timeSignature,
  }));
  const data = songDataFromForm(original, form);
  const edited =
    song.officialRuntimeSec !== original.officialRuntimeSec ||
    song.tempo !== original.tempo ||
    song.timeSignature !== original.timeSignature;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (field: keyof SongDataForm) => (next: string) => setForm((current) => ({ ...current, [field]: next }));

  return (
    <div className="song-data-backdrop" onClick={onClose}>
      <form
        className="song-data"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (data) onSave(data);
        }}
      >
        <h2 id={titleId}>Song timing</h2>
        <div className="song-data-field">
          <label htmlFor={runtimeId}>Length (m:ss)</label>
          <input
            id={runtimeId}
            inputMode="numeric"
            autoComplete="off"
            placeholder={formatRuntime(original.officialRuntimeSec) || "m:ss"}
            value={form.runtime}
            aria-invalid={form.runtime.trim() !== "" && parseRuntime(form.runtime) == null}
            onChange={(event) => set("runtime")(event.target.value)}
          />
        </div>
        <BpmField value={form.bpm} placeholder={original.tempo == null ? "bpm" : String(original.tempo)} onChange={set("bpm")} />
        <div className="song-data-field">
          <label htmlFor={timeId}>Time signature</label>
          <input
            id={timeId}
            autoComplete="off"
            placeholder={original.timeSignature}
            value={form.timeSignature}
            onChange={(event) => set("timeSignature")(event.target.value)}
          />
        </div>
        <div className="song-data-actions">
          <button type="button" disabled={!edited} onClick={() => onSave({})}>
            Use original
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="is-primary" disabled={!data}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
