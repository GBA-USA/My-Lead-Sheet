import seedLibrary from "../data/library.json";
import type { LibraryFile, Song } from "./types";

export const LIBRARY_KEY = "leadSheetsLibrary";
export const AWAKE_KEY = "leadSheetsKeepAwake";
export const TEXT_SCALE_KEY = "leadSheetsTextScale";

/** Sheet body scale. 100% is the default. Steps are a Phase 1 stand-in; the spec doesn't set them. */
export const TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.7] as const;

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode and some embedded webviews throw. The in-memory copy still works. */
  }
}

function isLibrary(value: unknown): value is LibraryFile {
  if (!value || typeof value !== "object") return false;
  const record = value as LibraryFile;
  if (!Array.isArray(record.songs) || !Array.isArray(record.setlists)) return false;
  return record.songs.every(
    (song) =>
      !!song &&
      typeof song.id === "number" &&
      typeof song.title === "string" &&
      Array.isArray(song.bassNotes) &&
      Array.isArray(song.body),
  );
}

export function loadLibrary(): LibraryFile {
  const raw = readRaw(LIBRARY_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isLibrary(parsed)) return parsed;
    } catch {
      /* Reseed below. */
    }
  }
  const seed = JSON.parse(JSON.stringify(seedLibrary)) as LibraryFile;
  writeRaw(LIBRARY_KEY, JSON.stringify(seed));
  return seed;
}

export function loadAwake(): boolean {
  const raw = readRaw(AWAKE_KEY);
  if (raw === null) return true;
  return raw === "true";
}

export function saveAwake(on: boolean) {
  writeRaw(AWAKE_KEY, on ? "true" : "false");
}

export function loadTextScaleIndex(): number {
  const raw = readRaw(TEXT_SCALE_KEY);
  const index = raw === null ? 1 : Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= TEXT_SCALES.length) return 1;
  return index;
}

export function saveTextScaleIndex(index: number) {
  writeRaw(TEXT_SCALE_KEY, String(index));
}

export function tempoText(tempo: number | null): string {
  return tempo == null ? "—" : `~${tempo} bpm`;
}

export function songById(songs: Song[], id: number): Song | undefined {
  return songs.find((song) => song.id === id);
}
