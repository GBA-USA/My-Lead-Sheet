import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MetronomeSheet } from "./metronome-sheet";
import { useSharedMetronome } from "./metronome-view";
import type { Notation } from "./music";

export function TextSizeButtons({
  index,
  count,
  onChange,
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
}) {
  return (
    <div className="text-size">
      <button
        type="button"
        onClick={() => onChange(index - 1)}
        disabled={index <= 0}
        aria-label="Smaller text"
      >
        A−
      </button>
      <button
        type="button"
        onClick={() => onChange(index + 1)}
        disabled={index >= count - 1}
        aria-label="Larger text"
      >
        A+
      </button>
    </div>
  );
}

export function StepButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const minus = label.startsWith("Transpose down") || label.startsWith("Scroll slower");
  return (
    <button type="button" className="step" aria-label={label} onClick={onClick} disabled={disabled}>
      {minus ? <MinusIcon /> : <PlusIcon />}
    </button>
  );
}

const NOTATION_LABELS: [Notation, string][] = [
  ["notes", "Notes"],
  ["nashville", "Nashville"],
  ["chords", "Chords only"],
];

/** On a narrow phone the switch scrolls sideways, and the mode in use is scrolled into view. */
function NotationSwitch({ value, onChange }: { value: Notation; onChange: (next: Notation) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pressed = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const [box, on] = [ref.current, pressed.current];
    if (!box || !on) return;
    box.scrollLeft = Math.min(Math.max(box.scrollLeft, on.offsetLeft + on.offsetWidth - box.clientWidth), on.offsetLeft);
  }, [value]);

  return (
    <div className="notes-switch" role="group" aria-label="Notes or Nashville" ref={ref}>
      {NOTATION_LABELS.map(([notation, label]) => (
        <button key={notation} type="button" aria-pressed={value === notation} ref={value === notation ? pressed : undefined} onClick={() => onChange(notation)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Key − and +, and the readout, which a tap puts back in the original key. */
export function TransposeStrip({
  keyLabel,
  onDown,
  onUp,
  onOriginal,
}: {
  keyLabel: string;
  onDown: () => void;
  onUp: () => void;
  onOriginal: () => void;
}) {
  return (
    <div className="transpose">
      <StepButton label="Transpose down" onClick={onDown} />
      <button type="button" className="key-readout" aria-label={`Key ${keyLabel}. Tap for the original key.`} onClick={onOriginal}>
        <span className="key-kicker">KEY</span>
        <span className={keyLabel.length > 18 ? "key-name key-name-long" : "key-name"}>{keyLabel}</span>
      </button>
      <StepButton label="Transpose up" onClick={onUp} />
    </div>
  );
}

/** A button that opens a menu below it. Escape or a tap outside closes it. */
export function Menu({
  button,
  label,
  className,
  open,
  onToggle,
  onClose,
  align = "end",
  children,
}: {
  button: ReactNode;
  label?: string;
  className: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={rootRef}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {button}
      </button>
      {open ? (
        <div className={align === "start" ? "menu menu-start" : "menu"} role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** `onEdit` and `onDelete` are there only for a song the player made; without them both items are off, with the reason. */
export function OverflowMenu({
  label,
  size = "compact",
  open,
  onToggle,
  onClose,
  onSongData,
  onEdit,
  onDelete,
  children,
}: {
  label: string;
  size?: "compact" | "shell";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSongData?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  children?: ReactNode;
}) {
  const noteId = useId();
  const item = (name: string, run: (() => void) | undefined) => (
    <button
      type="button"
      role="menuitem"
      disabled={!run}
      aria-describedby={run ? undefined : noteId}
      onClick={() => {
        onClose();
        run?.();
      }}
    >
      {name}
    </button>
  );

  return (
    <Menu
      button={<DotsIcon />}
      label={label}
      className={size === "shell" ? "icon-btn" : "more-btn"}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      {children}
      {onSongData ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onSongData();
          }}
        >
          Song timing
        </button>
      ) : null}
      {item("Edit", onEdit)}
      {item("Delete", onDelete)}
      {onEdit && onDelete ? null : (
        <p className="menu-note" id={noteId}>
          Only songs you made can be edited.
        </p>
      )}
    </Menu>
  );
}

/**
 * The song's two control rows. Row 1: the key and Notes | Nashville | Chords only. Row 2: the Scroll pill with its caret to the
 * Scroll sheet, the Metronome pill and its sheet, and Send when `onSend` is given. A take puts `take` in row 2's place.
 * `onMetronome` is unused since the pill opens its own sheet.
 */
export function SongControls({
  keyLabel,
  onTransposeDown,
  onTransposeUp,
  onOriginalKey,
  notation,
  onNotation,
  scrolling,
  onToggleScroll,
  onScrollSheet,
  onSend,
  take,
}: {
  keyLabel: string;
  onTransposeDown: () => void;
  onTransposeUp: () => void;
  onOriginalKey: () => void;
  notation: Notation;
  onNotation: (next: Notation) => void;
  scrolling: boolean;
  onToggleScroll: () => void;
  onScrollSheet: () => void;
  onMetronome?: () => void;
  onSend?: () => void;
  take?: ReactNode;
}) {
  const shared = useSharedMetronome();
  const [metronomeSheet, setMetronomeSheet] = useState(false);
  const bpm = shared?.metronome.playing ? shared.metronome.bpm : null;
  return (
    <div className="controls">
      <div className="control-row">
        <TransposeStrip keyLabel={keyLabel} onDown={onTransposeDown} onUp={onTransposeUp} onOriginal={onOriginalKey} />
        <NotationSwitch value={notation} onChange={onNotation} />
      </div>
      {take ?? (
        <div className="control-row">
          <button type="button" className={scrolling ? "scroll-pill is-on" : "scroll-pill"} aria-pressed={scrolling} onClick={onToggleScroll}>
            <PlayIcon />
            Scroll: {scrolling ? "On" : "Off"}
          </button>
          <button type="button" className="scroll-caret" aria-label="Scroll settings" aria-haspopup="dialog" onClick={onScrollSheet}>
            <CaretIcon />
          </button>
          <button type="button" className="metronome-pill" aria-haspopup="dialog" onClick={() => setMetronomeSheet(true)}>
            {bpm == null ? "Metronome" : `${bpm} bpm`}
          </button>
          {onSend ? (
            <button type="button" className="send-btn" aria-label="Send" onClick={onSend}>
              <SendIcon />
            </button>
          ) : null}
        </div>
      )}
      {metronomeSheet && shared
        ? createPortal(<MetronomeSheet songTempo={shared.songTempo} metronome={shared.metronome} onClose={() => setMetronomeSheet(false)} />, document.body)
        : null}
    </div>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M3 1.5v9l8-4.5-8-4.5z" fill="currentColor" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path d="M14.5 1.5 1.5 7l5 2 2 5 6-12.5zM6.5 9l8-7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        d="M10.5 3.5 5.5 8l5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
