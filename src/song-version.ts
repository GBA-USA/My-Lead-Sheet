import { useRef, useState } from "react";
import type { Owner } from "./account";
import { initialMetronomeBpm } from "./metronome";
import { clampScrollPercent, type Notation } from "./music";
import type { PersonalDefaults } from "./personal-settings-model";
import { nextVersionName, withTempo, type Learned, type ScrollPlan, type Tempo } from "./scroll-timing";
import { useStored } from "./hooks";
import {
  loadNotation,
  loadScrollPercent,
  loadScrollVersions,
  loadSongData,
  loadSongDraft,
  saveSongData,
  saveSongDraft,
  updateScrollVersions,
  type ScrollVersions,
  type StoredVersion,
} from "./storage";
import type { Song, SongData, SongRef } from "./types";

/** A named saved set of a song's attributes. A null attribute was saved before versions held it, and the song's default applies. */
export interface SongVersion {
  name: string;
  semitones: number | null;
  /** The metronome's bpm. */
  bpm: number | null;
  scrollPercent: number | null;
  notation: Notation | null;
  /** The taught or learned timing, or null for the even pace. */
  plan: ScrollPlan | null;
  learned?: Learned;
  data?: SongData;
}

/** What the sheet plays with now: every attribute set. It is a draft while it differs from the version in use. */
export type Draft = { semitones: number; bpm: number | null; scrollPercent: number; notation: Notation; plan: ScrollPlan | null; learned?: Learned; data?: SongData };

export const SAVE_REFUSED = "Couldn't save. Free some space and try again.";

/** A copy from a friend or a band, or a song held in a band's room. Locked songs show no Save, Revert or Send, and nothing they change is kept. */
export const locked = (song: Song): boolean => song.copy !== undefined || !song.ref.startsWith("local/");

function fromStored({ name, bpm, marks, tempo, learned, semitones, metronomeBpm, scrollPercent, notation, data }: StoredVersion): SongVersion {
  return {
    name,
    semitones: semitones ?? null,
    bpm: metronomeBpm ?? null,
    scrollPercent: scrollPercent ?? null,
    notation: notation ?? null,
    plan: bpm !== undefined && marks !== undefined ? { bpm, marks, ...(tempo ? { tempo } : {}) } : null,
    ...(learned ? { learned } : {}),
    ...(data ? { data } : {}),
  };
}

function toStored(name: string, draft: Draft): StoredVersion {
  return {
    name,
    ...(draft.plan ?? {}),
    ...(draft.learned ? { learned: draft.learned } : {}),
    semitones: draft.semitones,
    ...(draft.bpm === null ? {} : { metronomeBpm: draft.bpm }),
    scrollPercent: draft.scrollPercent,
    notation: draft.notation,
    ...(draft.data ? { data: draft.data } : {}),
  };
}

export function loadSongVersions(ref: SongRef): { versions: SongVersion[]; selected: number | null } {
  const { versions, selected } = loadScrollVersions(ref);
  return { versions: versions.map(fromStored), selected };
}

/** Whether any of the song's versions holds taught or learned timing. A version can hold only settings, such as a key. */
export const hasTiming = (ref: SongRef): boolean => loadSongVersions(ref).versions.some((version) => version.plan !== null);

/** The song as it opens with no version picked: the player's defaults and the song's own tempo and even pace. */
export function songDefaults(song: Song, personal: PersonalDefaults): Draft {
  return {
    semitones: personal.transpose,
    bpm: initialMetronomeBpm(song.tempo),
    scrollPercent: loadScrollPercent(song.ref),
    notation: loadNotation(song.ref, personal.chordStyle),
    plan: null,
  };
}

export function baseline(version: SongVersion | null, defaults: Draft): Draft {
  if (!version) return defaults;
  return {
    semitones: version.semitones ?? defaults.semitones,
    bpm: version.bpm ?? defaults.bpm,
    scrollPercent: version.scrollPercent ?? defaults.scrollPercent,
    notation: version.notation ?? defaults.notation,
    plan: version.plan,
    ...(version.learned ? { learned: version.learned } : {}),
    ...(version.data ? { data: version.data } : {}),
  };
}

const print = (draft: Draft) =>
  JSON.stringify([draft.semitones, draft.bpm, draft.scrollPercent, draft.notation, draft.plan, draft.learned ?? null, draft.data ?? null]);

export const differs = (draft: Draft, version: Draft): boolean => print(draft) !== print(version);

function parseDraft(value: unknown): Draft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Draft;
  const notation = draft.notation === "notes" || draft.notation === "nashville";
  const numbers = Number.isInteger(draft.semitones) && (draft.bpm === null || Number.isFinite(draft.bpm)) && Number.isFinite(draft.scrollPercent);
  if (!notation || !numbers) return null;
  const timing = draft.plan === null || (Array.isArray(draft.plan?.marks) && draft.plan.marks.length >= 2 && Number.isFinite(draft.plan.bpm));
  return timing ? { ...draft, scrollPercent: clampScrollPercent(draft.scrollPercent) } : null;
}

export const loadDraft = (owner: string | null, ref: SongRef): Draft | null => parseDraft(loadSongDraft(owner, ref));
export const saveDraft = (owner: string | null, ref: SongRef, draft: Draft | null): boolean => saveSongDraft(owner, ref, draft);

const NONE: ScrollVersions = { versions: [], selected: null };

type Patch = Partial<Draft> | ((draft: Draft) => Partial<Draft>);

/**
 * One visit to a song: the draft over the version in use, a locked song's pick, and whether the phone refused the last
 * Save of this draft. The keeper is the owner whose stored draft this is, or undefined on a locked song or while the
 * phone cannot name its account, when the draft lives here only.
 */
interface Visit {
  ref: SongRef | null;
  keeper: Owner;
  draft: Draft | null;
  selected: number | null;
  refused: boolean;
}

const opened = (ref: SongRef | null, keeper: Owner, selected: number | null): Visit => ({
  ref,
  keeper,
  draft: ref != null && keeper !== undefined ? loadDraft(keeper, ref) : null,
  selected,
  refused: false,
});

/** The owner changed on the same song. A change made before the phone could name its account becomes that account's draft. Otherwise the new owner's own draft shows. */
function renamed(visit: Visit, keeper: Owner): Visit {
  if (visit.ref == null || keeper === undefined) return { ...visit, keeper, draft: null };
  const carried = visit.keeper === undefined ? visit.draft : null;
  if (carried) saveDraft(keeper, visit.ref, carried);
  return { ...visit, keeper, draft: carried ?? loadDraft(keeper, visit.ref) };
}

/**
 * The song's versions and the draft over the version in use. An own song keeps the draft on this phone for this
 * account until Save, Revert or a pick, so a choice the player made holds even when it matches today's default. Save
 * shows while the draft differs from the version in use. A locked song keeps the draft, and any version picked, only
 * until the player leaves it. A phone signed in to an account it cannot name yet keeps the draft in memory until the
 * account answers, then hands it to that account. A refused Save shows until the draft goes. Every change the controls
 * make goes through `set`.
 */
export function useSongVersion(song: Song | null, owner: Owner, personal: PersonalDefaults) {
  const ref = song?.ref ?? null;
  const isLocked = song != null && locked(song);
  const keeper = isLocked ? undefined : owner;
  const [stored, setStored] = useStored(() => (ref == null ? NONE : loadScrollVersions(ref)), ref);
  const [slot, setVisit] = useState(() => opened(ref, keeper, stored.selected));
  const visit = slot.ref !== ref ? opened(ref, keeper, stored.selected) : slot.keeper !== keeper ? renamed(slot, keeper) : slot;
  if (visit !== slot) setVisit(visit);

  const versions = stored.versions.map(fromStored);
  const selected = isLocked ? visit.selected : stored.selected;
  const version = selected == null ? null : (versions[selected] ?? null);
  const defaults = song ? songDefaults(song, personal) : null;
  const base = defaults ? baseline(version, defaults) : null;
  const draft = visit.draft ?? base;
  const latest = useRef(draft);
  latest.current = draft;

  const keepDraft = (next: Draft | null) => {
    if (ref == null) return;
    if (keeper !== undefined) saveDraft(keeper, ref, next);
    setVisit((current) => ({ ...current, draft: next, refused: next !== null && current.refused }));
  };

  const set = (patch: Patch) => {
    if (!latest.current || !base) return;
    const next = { ...latest.current, ...(patch instanceof Function ? patch(latest.current) : patch) };
    latest.current = next;
    keepDraft(next);
  };

  const write = (change: (current: ScrollVersions) => ScrollVersions): boolean => {
    if (ref == null || isLocked) return false;
    const next = updateScrollVersions(ref, change);
    if (next) setStored(next);
    return next !== null;
  };

  const commit = (change: (current: ScrollVersions) => ScrollVersions): boolean => {
    if (!draft || ref == null) return false;
    if (!write(change)) {
      setVisit((current) => ({ ...current, refused: true }));
      return false;
    }
    if (draft.data) saveSongData(ref, { ...loadSongData(ref), ...draft.data });
    keepDraft(null);
    return true;
  };

  const edit = (index: number, change: (version: StoredVersion) => StoredVersion) =>
    write((current) => ({ ...current, versions: current.versions.map((each, i) => (i === index ? change(each) : each)) }));

  return {
    versions,
    selected,
    version,
    draft,
    locked: isLocked,
    changed: !isLocked && draft != null && base != null && differs(draft, base),
    refused: visit.refused,
    nextName: nextVersionName(versions),
    set,
    revert: () => keepDraft(null),
    saveAs: (name: string) => commit((current) => ({ versions: [...current.versions, toStored(name, draft!)], selected: current.versions.length })),
    saveToVersion: () => selected != null && commit((current) => ({ ...current, versions: current.versions.map((each, i) => (i === selected ? toStored(each.name, draft!) : each)) })),
    select: (index: number | null) => {
      if (isLocked) return setVisit((current) => ({ ...current, selected: index, draft: null }));
      if (write((current) => ({ ...current, selected: index }))) keepDraft(null);
    },
    rename: (index: number, name: string) => edit(index, (each) => ({ ...each, name })),
    retime: (index: number, tempo: Tempo[]) => edit(index, (each) => (each.bpm !== undefined && each.marks !== undefined ? withTempo({ ...each, bpm: each.bpm, marks: each.marks }, tempo) : each)),
    remove: (index: number) =>
      write((current) => ({
        versions: current.versions.filter((_, i) => i !== index),
        selected: current.selected === index || current.selected == null ? null : current.selected > index ? current.selected - 1 : current.selected,
      })),
  };
}

export type SongVersionState = ReturnType<typeof useSongVersion>;
