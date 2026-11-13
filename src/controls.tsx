import { useEffect, useId, useRef } from "react";
import { SCROLL_MAX, SCROLL_MIN, SCROLL_STEP, type Notation } from "./music";

/** The song header keeps the Phase 1 phone and tablet arrangement. */

export function ScreenToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={on ? "screen-toggle is-on" : "screen-toggle"}
      aria-pressed={on}
      onClick={onToggle}
    >
      Screen on: {on ? "On" : "Off"}
    </button>
  );
}

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

function StepButton({
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

function NotationSwitch({ value, onChange }: { value: Notation; onChange: (next: Notation) => void }) {
  return (
    <div className="notes-switch" role="group" aria-label="Notes or Nashville">
      <button type="button" aria-pressed={value === "notes"} onClick={() => onChange("notes")}>
        Notes
      </button>
      <button type="button" aria-pressed={value === "nashville"} onClick={() => onChange("nashville")}>
        Nashville
      </button>
    </div>
  );
}

function ScrollGroup({
  on,
  percent,
  onToggle,
  onPercent,
}: {
  on: boolean;
  percent: number;
  onToggle: () => void;
  onPercent: (next: number) => void;
}) {
  return (
    <div className="scroll-group">
      <button type="button" className={on ? "scroll-pill is-on" : "scroll-pill"} aria-pressed={on} onClick={onToggle}>
        <PlayIcon />
        Scroll: {on ? "On" : "Off"}
      </button>
      <StepButton
        label="Scroll slower"
        onClick={() => onPercent(percent - SCROLL_STEP)}
        disabled={percent <= SCROLL_MIN}
      />
      <span className="percent">{percent}%</span>
      <StepButton
        label="Scroll faster"
        onClick={() => onPercent(percent + SCROLL_STEP)}
        disabled={percent >= SCROLL_MAX}
      />
    </div>
  );
}

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
      <div className="key-cluster">
        <StepButton label="Transpose down" onClick={onDown} />
        <div className="key-readout">
          <span className="key-kicker">KEY</span>
          <span className={keyLabel.length > 18 ? "key-name key-name-long" : "key-name"}>{keyLabel}</span>
        </div>
        <StepButton label="Transpose up" onClick={onUp} />
      </div>
      <button type="button" className="original" onClick={onOriginal}>
        Original Key
      </button>
    </div>
  );
}

export function OverflowMenu({
  label,
  size = "compact",
  open,
  onToggle,
  onClose,
}: {
  label: string;
  size?: "compact" | "shell";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const noteId = useId();
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
        className={size === "shell" ? "icon-btn" : "more-btn"}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <DotsIcon />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" disabled aria-describedby={noteId}>
            Edit
          </button>
          <button type="button" role="menuitem" disabled aria-describedby={noteId}>
            Delete
          </button>
          <p className="menu-note" id={noteId}>
            Coming in a later version
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function SongControls({
  textIndex,
  textCount,
  onTextIndex,
  awake,
  onAwake,
  menuOpen,
  onMenuToggle,
  onMenuClose,
  notation,
  onNotation,
  scrolling,
  onToggleScroll,
  percent,
  onPercent,
  keyLabel,
  onTransposeDown,
  onTransposeUp,
  onOriginalKey,
}: {
  textIndex: number;
  textCount: number;
  onTextIndex: (index: number) => void;
  awake: boolean;
  onAwake: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
  notation: Notation;
  onNotation: (next: Notation) => void;
  scrolling: boolean;
  onToggleScroll: () => void;
  percent: number;
  onPercent: (next: number) => void;
  keyLabel: string;
  onTransposeDown: () => void;
  onTransposeUp: () => void;
  onOriginalKey: () => void;
}) {
  return (
    <div className="controls">
      <div className="tools">
        <TextSizeButtons index={textIndex} count={textCount} onChange={onTextIndex} />
        <ScreenToggle on={awake} onToggle={onAwake} />
        <OverflowMenu
          label="Song actions"
          open={menuOpen}
          onToggle={onMenuToggle}
          onClose={onMenuClose}
        />
      </div>
      <NotationSwitch value={notation} onChange={onNotation} />
      <ScrollGroup on={scrolling} percent={percent} onToggle={onToggleScroll} onPercent={onPercent} />
      <TransposeStrip
        keyLabel={keyLabel}
        onDown={onTransposeDown}
        onUp={onTransposeUp}
        onOriginal={onOriginalKey}
      />
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
