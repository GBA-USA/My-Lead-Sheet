import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useEscape, useKeyboardInset } from "./hooks";
import { matchingSongs } from "./search";
import {
  HOLD_MS,
  IDLE_DRAG,
  MAX_SETLIST_NAME,
  added,
  dragMove,
  dragPress,
  moved,
  named,
  removedAt,
  type DragState,
} from "./setlist-builder-model";
import { CodeOfferButton } from "./setlist-code";
import { codeOffer } from "./setlist-code-model";
import { SongRowText } from "./song-row";
import { addOwnSetlist, isBuiltInSetlist, removeOwnSetlist, saveOwnSetlist, songByRef } from "./storage";
import type { Setlist, Song, SongRef } from "./types";
import "./setlist-builder.css";

export type BuilderTarget = { kind: "new" } | { kind: "edit"; id: number };

type BuilderView = "songs" | "picker" | "delete";

const MESSAGES = {
  newTitle: "New setlist",
  nameLabel: "Setlist name",
  namePlaceholder: "Setlist name",
  save: "Save",
  close: "Close",
  back: "Back",
  addSongs: "+ Add songs",
  addTitle: "Add songs",
  addAction: "Add",
  searchSongs: "Search My Songs",
  noSongsYet: "No songs yet.",
  noSongsMatch: "No songs match.",
  alreadyIn: "Already in this setlist",
  missingSong: "Missing from this library",
  remove: "Remove",
  deleteSetlist: "Delete setlist",
  deleteAsk: "Delete this setlist? Your songs stay in My Songs.",
  deleteYes: "Yes, delete",
  deleteKeep: "Keep",
  builtInNote: "Built-in setlists can't be deleted.",
  emptyName: "Give the setlist a name.",
  tooLongName: "Use 60 characters or fewer.",
  saveFailed: "This phone couldn't save the setlist. Free some space and try again.",
} as const;

type SlotBox = { top: number; mid: number; bottom: number };

/**
 * One-sheet personal setlist builder: create a setlist, rename it, hold-and-drag or arrow-key reorder rows,
 * add songs from My Songs, open Show code while signed in, or delete non-built-in setlists behind a confirm.
 */
export function SetlistBuilder({
  target,
  setlists,
  songs,
  onShowCode,
  onCreated,
  onClose,
}: {
  target: BuilderTarget;
  setlists: Setlist[];
  songs: Song[];
  onShowCode?: (setlist: Setlist) => void;
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const keyboard = useKeyboardInset();
  const setlist = target.kind === "edit" ? setlists.find((item) => item.id === target.id) ?? null : null;

  const [nameDraft, setNameDraft] = useState(() => (setlist ? setlist.name : ""));
  const [view, setView] = useState<BuilderView>("songs");
  const [error, setError] = useState("");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickedOrder, setPickedOrder] = useState<SongRef[]>([]);
  const [drag, setDrag] = useState<DragState>(IDLE_DRAG);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<DragState>(IDLE_DRAG);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slotsRef = useRef<{ slots: SlotBox[]; startScrollTop: number }>({ slots: [], startScrollTop: 0 });
  const activePointerRef = useRef<{ id: number; el: HTMLElement | null } | null>(null);
  const addingRef = useRef(false);

  const setDragSync = useCallback((next: DragState) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const clearHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const cancelDrag = useCallback(() => {
    clearHold();
    const active = activePointerRef.current;
    if (active?.el) {
      try {
        active.el.releasePointerCapture(active.id);
      } catch {}
    }
    activePointerRef.current = null;
    if (dragRef.current.kind !== "idle") setDragSync(IDLE_DRAG);
  }, [clearHold, setDragSync]);

  // Focus the name box when opening "+ New setlist"
  useEffect(() => {
    if (target.kind === "new") {
      setNameDraft("");
      setView("songs");
      setError("");
      setPickerQuery("");
      setPickedOrder([]);
      cancelDrag();
      nameInputRef.current?.focus();
    }
  }, [target.kind, cancelDrag]);

  // Move focus into the sheet when it opens on an existing setlist
  const editId = target.kind === "edit" ? target.id : null;
  useEffect(() => {
    if (editId !== null) sheetRef.current?.focus({ preventScroll: true });
  }, [editId]);

  // Sync draft name when opening or updating an existing setlist
  useEffect(() => {
    if (target.kind === "edit" && setlist) {
      setNameDraft(setlist.name);
    }
  }, [target.kind, setlist?.id, setlist?.name]);

  // Close if the open setlist vanished externally (for example via backup sync)
  useEffect(() => {
    if (target.kind === "edit" && !setlist) onClose();
  }, [target.kind, setlist, onClose]);

  // Reset inner view and drag state when switching setlists
  useEffect(() => {
    setView("songs");
    setError("");
    setPickerQuery("");
    setPickedOrder([]);
    addingRef.current = false;
    cancelDrag();
  }, [target.kind, target.kind === "edit" ? target.id : -1, cancelDrag]);

  // Cleanup timer on unmount
  useEffect(() => () => clearHold(), [clearHold]);

  const commitReorder = useCallback(
    (from: number, to: number) => {
      if (!setlist || from === to) return;
      const nextRefs = moved(setlist.songRefs, from, to);
      if (nextRefs.every((ref, i) => ref === setlist.songRefs[i])) return;
      if (!saveOwnSetlist(setlist.id, setlist.name, nextRefs)) {
        setError(MESSAGES.saveFailed);
        return;
      }
      setError("");
    },
    [setlist],
  );
  const commitReorderRef = useRef(commitReorder);
  commitReorderRef.current = commitReorder;

  const computeOver = useCallback((clientY: number, fromIndex: number): number => {
    const list = listRef.current;
    const { slots, startScrollTop } = slotsRef.current;
    if (!list || slots.length === 0) return fromIndex;
    const y = clientY + (list.scrollTop - startScrollTop);
    let count = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (i !== fromIndex && slots[i].mid < y) count += 1;
    }
    return Math.max(0, Math.min(slots.length - 1, count));
  }, []);

  useEffect(() => {
    if (target.kind !== "edit" || view !== "songs") return;
    const list = listRef.current;

    const onTouchMove = (event: TouchEvent) => {
      const cur = dragRef.current;
      if (cur.kind === "idle") return;
      const touch = event.touches[0];
      if (!touch) return;
      if (cur.kind === "pressing") {
        const next = dragMove(cur, touch.clientY, cur.index);
        if (next.kind === "idle") {
          clearHold();
          setDragSync(IDLE_DRAG);
        }
        return;
      }
      event.preventDefault();
      const over = computeOver(touch.clientY, cur.index);
      const next = dragMove(cur, touch.clientY, over);
      if (next !== cur) setDragSync(next);
    };

    const onPointerMove = (event: PointerEvent) => {
      const cur = dragRef.current;
      if (cur.kind === "idle") return;
      if (cur.kind === "pressing") {
        const next = dragMove(cur, event.clientY, cur.index);
        if (next.kind === "idle") {
          clearHold();
          setDragSync(IDLE_DRAG);
        }
        return;
      }
      const over = computeOver(event.clientY, cur.index);
      const next = dragMove(cur, event.clientY, over);
      if (next !== cur) setDragSync(next);
    };

    const onEnd = () => {
      clearHold();
      const cur = dragRef.current;
      if (cur.kind === "idle") return;
      setDragSync(IDLE_DRAG);
      const active = activePointerRef.current;
      if (active?.el) {
        try {
          active.el.releasePointerCapture(active.id);
        } catch {}
      }
      activePointerRef.current = null;
      if (cur.kind === "dragging") commitReorderRef.current(cur.index, cur.over);
    };

    const onCancel = () => {
      cancelDrag();
    };

    list?.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("touchend", onEnd);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchcancel", onCancel);
    return () => {
      list?.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchcancel", onCancel);
    };
  }, [target.kind, view, clearHold, cancelDrag, computeOver, setDragSync]);

  const handleEscape = useCallback(() => {
    if (dragRef.current.kind !== "idle") {
      cancelDrag();
      return;
    }
    if (view !== "songs") {
      setView("songs");
      setPickedOrder([]);
      setPickerQuery("");
      setError("");
      addingRef.current = false;
      return;
    }
    onClose();
  }, [view, cancelDrag, onClose]);

  useEscape(handleEscape);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    const res = named(nameDraft);
    if (!res.ok) {
      setError(res.reason === "empty" ? MESSAGES.emptyName : MESSAGES.tooLongName);
      return;
    }
    const id = addOwnSetlist({ name: res.name, songIds: [] });
    if (id === null) {
      setError(MESSAGES.saveFailed);
      return;
    }
    setError("");
    onCreated(id);
  };

  const commitRename = () => {
    if (!setlist) return;
    const res = named(nameDraft);
    if (!res.ok) {
      setError(res.reason === "empty" ? MESSAGES.emptyName : MESSAGES.tooLongName);
      setNameDraft(setlist.name);
      return;
    }
    if (res.name === setlist.name) {
      setError("");
      setNameDraft(res.name);
      return;
    }
    if (!saveOwnSetlist(setlist.id, res.name, setlist.songRefs)) {
      setError(MESSAGES.saveFailed);
      setNameDraft(setlist.name);
      return;
    }
    setError("");
    setNameDraft(res.name);
  };

  const onNameBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest(".account-close")) return;
    commitRename();
  };

  const onNameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    }
  };

  const onRowPointerDown = (index: number, event: ReactPointerEvent<HTMLLIElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".setlist-builder-remove")) return;
    clearHold();
    const rowEl = event.currentTarget;
    const pointerId = event.pointerId;
    activePointerRef.current = { id: pointerId, el: rowEl };
    setDragSync(dragPress(index, event.clientY, Date.now()));
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (dragRef.current.kind !== "pressing" || dragRef.current.index !== index) return;
      const list = listRef.current;
      if (list) {
        const slots = [...list.querySelectorAll("[data-builder-row]")].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, mid: r.top + r.height / 2, bottom: r.bottom };
        });
        slotsRef.current = { slots, startScrollTop: list.scrollTop };
      }
      try {
        rowEl.setPointerCapture(pointerId);
      } catch {}
      setDragSync({ kind: "dragging", index, over: index });
    }, HOLD_MS);
  };

  const focusHandleAt = (index: number) => {
    requestAnimationFrame(() => {
      const handles = listRef.current?.querySelectorAll<HTMLButtonElement>(".setlist-builder-handle");
      handles?.[index]?.focus();
    });
  };

  const onHandleKeyDown = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!setlist) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      const nextRefs = moved(setlist.songRefs, index, index - 1);
      if (!saveOwnSetlist(setlist.id, setlist.name, nextRefs)) {
        setError(MESSAGES.saveFailed);
      } else {
        setError("");
        focusHandleAt(index - 1);
      }
    } else if (event.key === "ArrowDown" && index < setlist.songRefs.length - 1) {
      event.preventDefault();
      const nextRefs = moved(setlist.songRefs, index, index + 1);
      if (!saveOwnSetlist(setlist.id, setlist.name, nextRefs)) {
        setError(MESSAGES.saveFailed);
      } else {
        setError("");
        focusHandleAt(index + 1);
      }
    }
  };

  const removeRow = (index: number) => {
    if (!setlist) return;
    const nextRefs = removedAt(setlist.songRefs, index);
    if (!saveOwnSetlist(setlist.id, setlist.name, nextRefs)) {
      setError(MESSAGES.saveFailed);
      return;
    }
    setError("");
  };

  const togglePick = (ref: SongRef) => {
    setPickedOrder((current) => (current.includes(ref) ? current.filter((item) => item !== ref) : [...current, ref]));
  };

  const commitAdd = () => {
    if (!setlist || addingRef.current || pickedOrder.length === 0) return;
    addingRef.current = true;
    const nextRefs = added(setlist.songRefs, pickedOrder);
    if (nextRefs.length === setlist.songRefs.length) {
      setPickedOrder([]);
      setPickerQuery("");
      setView("songs");
      addingRef.current = false;
      return;
    }
    if (!saveOwnSetlist(setlist.id, setlist.name, nextRefs)) {
      setError(MESSAGES.saveFailed);
      addingRef.current = false;
      return;
    }
    setError("");
    setPickedOrder([]);
    setPickerQuery("");
    setView("songs");
    addingRef.current = false;
  };

  const confirmDelete = () => {
    if (!setlist) return;
    if (!removeOwnSetlist(setlist.id)) {
      setError(MESSAGES.saveFailed);
      return;
    }
    setError("");
    onClose();
  };

  const heading =
    target.kind === "new"
      ? MESSAGES.newTitle
      : view === "picker"
        ? MESSAGES.addTitle
        : setlist?.name ?? "";

  const displayedItems = (() => {
    if (!setlist) return [];
    const base = setlist.songRefs.map((ref, origIndex) => ({ ref, origIndex }));
    if (drag.kind !== "dragging" || drag.index === drag.over) return base;
    const next = [...base];
    const [picked] = next.splice(drag.index, 1);
    next.splice(drag.over, 0, picked);
    return next;
  })();

  const filteredSongs = view === "picker" ? matchingSongs(songs, pickerQuery) : [];
  const builtIn = setlist ? isBuiltInSetlist(setlist.id) : false;

  const sheet = (
    <div
      className="account-backdrop"
      style={{ "--keyboard": `${keyboard}px` } as CSSProperties}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={onClose}
    >
      <section
        ref={sheetRef}
        tabIndex={-1}
        className="setlist-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-top">
          <div className="setlist-builder-head-left">
            {target.kind === "edit" && view !== "songs" ? (
              <button
                type="button"
                className="setlist-builder-back"
                aria-label={MESSAGES.back}
                onClick={() => {
                  setView("songs");
                  setPickedOrder([]);
                  setPickerQuery("");
                  setError("");
                  addingRef.current = false;
                }}
              >
                <BackMark />
              </button>
            ) : null}
            <h2 id={titleId}>{heading}</h2>
          </div>
          <button type="button" className="account-close setlist-builder-close" aria-label={MESSAGES.close} onClick={onClose}>
            <CloseMark />
          </button>
        </header>

        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}

        {target.kind === "new" ? (
          <form className="account-form" onSubmit={handleCreate}>
            <div className="setlist-builder-name-wrap">
              <input
                ref={nameInputRef}
                type="text"
                className="account-input setlist-builder-name"
                aria-label={MESSAGES.nameLabel}
                placeholder={MESSAGES.namePlaceholder}
                maxLength={MAX_SETLIST_NAME}
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  if (error) setError("");
                }}
              />
            </div>
            <button type="submit" className="account-primary">
              {MESSAGES.save}
            </button>
          </form>
        ) : !setlist ? null : view === "picker" ? (
          <div className="setlist-picker">
            <div className="setlist-picker-search">
              <span className="setlist-picker-search-icon" aria-hidden="true">
                <SearchMark />
              </span>
              <input
                type="search"
                className="setlist-picker-input"
                aria-label={MESSAGES.searchSongs}
                placeholder={MESSAGES.searchSongs}
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {filteredSongs.length === 0 ? (
              <p className="account-note" role="status">
                {MESSAGES.noSongsMatch}
              </p>
            ) : (
              <ul className="setlist-picker-list">
                {filteredSongs.map((song) => {
                  const inSetlist = setlist.songRefs.includes(song.ref);
                  const checked = inSetlist || pickedOrder.includes(song.ref);
                  return (
                    <li key={song.ref}>
                      <label className={inSetlist ? "setlist-picker-row is-in" : "setlist-picker-row"}>
                        <input
                          type="checkbox"
                          className="setlist-picker-check"
                          checked={checked}
                          disabled={inSetlist}
                          onChange={() => {
                            if (!inSetlist) togglePick(song.ref);
                          }}
                        />
                        <span className="setlist-picker-song">
                          <SongRowText song={song} facts />
                          {inSetlist ? <span className="setlist-picker-in">{MESSAGES.alreadyIn}</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="setlist-builder-footer">
              <button type="button" className="account-primary" disabled={pickedOrder.length === 0} onClick={commitAdd}>
                {MESSAGES.addAction}
              </button>
            </div>
          </div>
        ) : view === "delete" ? (
          <div className="setlist-builder-confirm">
            <p className="account-note">{MESSAGES.deleteAsk}</p>
            <div className="setlist-builder-confirm-actions">
              <button type="button" className="setlist-builder-danger" onClick={confirmDelete}>
                {MESSAGES.deleteYes}
              </button>
              <button
                type="button"
                className="account-secondary"
                onClick={() => {
                  setView("songs");
                  setError("");
                }}
              >
                {MESSAGES.deleteKeep}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="setlist-builder-name-wrap">
              <input
                type="text"
                className="account-input setlist-builder-name"
                aria-label={MESSAGES.nameLabel}
                placeholder={MESSAGES.namePlaceholder}
                maxLength={MAX_SETLIST_NAME}
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  if (error) setError("");
                }}
                onBlur={onNameBlur}
                onKeyDown={onNameKeyDown}
              />
            </div>

            {setlist.songRefs.length === 0 ? (
              <p className="account-note" role="status">
                {MESSAGES.noSongsYet}
              </p>
            ) : (
              <ol className="setlist-builder-list" ref={listRef}>
                {displayedItems.map((item, displayIndex) => {
                  const song = songByRef(songs, item.ref);
                  const isDragged = drag.kind === "dragging" && drag.index === item.origIndex;
                  const songLabel = song?.title ?? MESSAGES.missingSong;
                  return (
                    <li
                      key={`${item.origIndex}-${item.ref}`}
                      data-builder-row=""
                      data-dragging={isDragged ? "true" : undefined}
                      className={isDragged ? "setlist-builder-row is-dragging" : "setlist-builder-row"}
                      onPointerDown={(event) => onRowPointerDown(displayIndex, event)}
                      onContextMenu={(event) => event.preventDefault()}
                    >
                      <button
                        type="button"
                        className="setlist-builder-handle"
                        aria-label={`Reorder ${songLabel}`}
                        onKeyDown={(event) => onHandleKeyDown(displayIndex, event)}
                      >
                        <GripMark />
                      </button>
                      <span className="setlist-builder-song">
                        {song ? <SongRowText song={song} facts /> : <span className="song-artist">{MESSAGES.missingSong}</span>}
                      </span>
                      <button
                        type="button"
                        className="setlist-builder-remove"
                        aria-label={`${MESSAGES.remove} ${songLabel}`}
                        onClick={() => removeRow(displayIndex)}
                      >
                        {MESSAGES.remove}
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="setlist-builder-footer">
              <button
                type="button"
                className="account-primary"
                onClick={() => {
                  setError("");
                  setPickedOrder([]);
                  setPickerQuery("");
                  addingRef.current = false;
                  setView("picker");
                }}
              >
                {MESSAGES.addSongs}
              </button>
              {onShowCode ? (
                <CodeOfferButton
                  offer={codeOffer(setlist.songRefs.length, setlist.copy?.canSendOn !== false)}
                  onShow={() => {
                    onClose();
                    onShowCode(setlist);
                  }}
                />
              ) : null}
              {builtIn ? (
                <p className="account-note">{MESSAGES.builtInNote}</p>
              ) : (
                <button
                  type="button"
                  className="account-secondary setlist-builder-delete"
                  onClick={() => {
                    setError("");
                    setView("delete");
                  }}
                >
                  {MESSAGES.deleteSetlist}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );

  return createPortal(sheet, document.body);
}

function CloseMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BackMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path d="M10.5 3.5 5.5 8l5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GripMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="4" r="1.2" fill="currentColor" />
      <circle cx="5.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

function SearchMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
