import type { SongRef } from "./types";

export const MAX_SETLIST_NAME = 60;
export const HOLD_MS = 500;
const MOVE_LIMIT_PX = 10;

type NamedResult = { ok: true; name: string } | { ok: false; reason: "empty" | "too-long" };

/** Trims a setlist name and refuses empty names or names over 60 characters. */
export function named(raw: string): NamedResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_SETLIST_NAME) return { ok: false, reason: "too-long" };
  return { ok: true, name: trimmed };
}

/** Moves the row at `from` to `to`, leaving every other entry intact. */
export function moved(refs: readonly SongRef[], from: number, to: number): SongRef[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [...refs];
  if (from < 0 || from >= refs.length || to < 0 || to >= refs.length || from === to) return [...refs];
  const next = [...refs];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Appends each picked ref that is not already in `refs`, preserving the picked order. */
export function added(refs: readonly SongRef[], picked: readonly SongRef[]): SongRef[] {
  const seen = new Set<SongRef>(refs);
  const next = [...refs];
  for (const ref of picked) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    next.push(ref);
  }
  return next;
}

/** Removes the single row at `index`, never other rows with the same song ref. */
export function removedAt(refs: readonly SongRef[], index: number): SongRef[] {
  if (!Number.isInteger(index) || index < 0 || index >= refs.length) return [...refs];
  return [...refs.slice(0, index), ...refs.slice(index + 1)];
}

export type DragState =
  | { kind: "idle" }
  | { kind: "pressing"; index: number; startY: number; startedAt: number }
  | { kind: "dragging"; index: number; over: number };

export const IDLE_DRAG: DragState = { kind: "idle" };

export function dragPress(index: number, startY: number, startedAt: number): DragState {
  return { kind: "pressing", index, startY, startedAt };
}

export function dragMove(state: DragState, currentY: number, over: number): DragState {
  if (state.kind === "pressing") {
    if (Math.abs(currentY - state.startY) >= MOVE_LIMIT_PX) return IDLE_DRAG;
    return state;
  }
  if (state.kind === "dragging") {
    return state.over === over ? state : { ...state, over };
  }
  return state;
}
