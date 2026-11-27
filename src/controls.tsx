import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScrollSpeed } from "./hooks";
import { MetronomeSheet } from "./metronome-sheet";
import { useSharedMetronome } from "./metronome-view";
import type { Notation } from "./music";
import { SPEED_MAX, SPEED_MIN, stepSpeed } from "./scroll-timing";

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

export const NOTATION_LABELS: [Notation, string][] = [
  ["notes", "Chords"],
  ["nashville", "Nashville"],
  ["chords", "Chords only"],
];

/** Rounded segmented radio group with equal parts, roving tabIndex, and arrow-key navigation. */
export function SegmentedPill<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly [T, string][];
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex(([option]) => option === value),
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const nextIndex = (activeIndex + step + options.length) % options.length;
    onChange(options[nextIndex][0]);
    buttons.current[nextIndex]?.focus();
  };

  return (
    <div
      className={className ? `segmented-pill ${className}` : "segmented-pill"}
      role="radiogroup"
      aria-label={label}
      style={{ "--pill-count": options.length } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      {options.map(([option, text], index) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

function NotationSwitch({ value, onChange }: { value: Notation; onChange: (next: Notation) => void }) {
  return <SegmentedPill className="notes-switch" label="Chord view" options={NOTATION_LABELS} value={value} onChange={onChange} />;
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
 * Live − and + for the scroll while it runs, held in the bottom corner where a thumb reaches them, folded bar or not.
 * The middle shows the speed against the song's own pace; a tap puts it back to 100%.
 */
function ScrollSpeed() {
  const [speed, setSpeed] = useScrollSpeed();
  const percent = Math.round(speed * 100);
  return (
    <div className="scroll-speed" role="group" aria-label="Scroll speed">
      <StepButton label="Scroll slower" onClick={() => setSpeed(stepSpeed(speed, -1))} disabled={speed <= SPEED_MIN} />
      <button type="button" className="speed-readout" aria-label={`Speed ${percent}%. Tap for 100%.`} onClick={() => setSpeed(1)}>
        {percent}%
      </button>
      <StepButton label="Scroll faster" onClick={() => setSpeed(stepSpeed(speed, 1))} disabled={speed >= SPEED_MAX} />
    </div>
  );
}

/**
 * The song's control rows. Key strip and Chords | Nashville | Chords only (on its own row under 430 px), plus the Scroll pill with its caret to the
 * Scroll sheet, the Metronome pill and its sheet, and Send when `onSend` is given. A take puts `take` in row 2's place.
 * While the scroll runs, outside a take, the live speed group shows too.
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
      {scrolling && !take ? <ScrollSpeed /> : null}
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
