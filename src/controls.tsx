import { useEffect, useRef } from "react";
import type { Song } from "./types";

/**
 * Phase 1 draws the song header in the spec's phone and tablet arrangement.
 * Transpose, Nashville conversion, auto-scroll, and the Wake Lock API are Phase 2.
 * Screen on only stores the preference. Text size is wired.
 */

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

function StepButton({ label }: { label: string }) {
  return (
    <button type="button" className="step" aria-label={label}>
      {label.startsWith("Transpose down") || label.startsWith("Scroll slower") ? (
        <MinusIcon />
      ) : (
        <PlusIcon />
      )}
    </button>
  );
}

function NotationSwitch() {
  return (
    <div className="notes-switch" role="group" aria-label="Notes or Nashville">
      <button type="button" aria-pressed="true">
        Notes
      </button>
      <button type="button" aria-pressed="false">
        Nashville
      </button>
    </div>
  );
}

function ScrollGroup() {
  return (
    <div className="scroll-group">
      <button type="button" className="scroll-pill" aria-pressed="false">
        <PlayIcon />
        Scroll: Off
      </button>
      <StepButton label="Scroll slower" />
      <span className="percent">100%</span>
      <StepButton label="Scroll faster" />
    </div>
  );
}

export function TransposeStrip({ keyLabel }: { keyLabel: string }) {
  return (
    <div className="transpose">
      <div className="key-cluster">
        <StepButton label="Transpose down" />
        <div className="key-readout">
          <span className="key-kicker">KEY</span>
          <span className={keyLabel.length > 18 ? "key-name key-name-long" : "key-name"}>{keyLabel}</span>
        </div>
        <StepButton label="Transpose up" />
      </div>
      <button type="button" className="original">
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
  onEdit,
  onDelete,
}: {
  label: string;
  size?: "compact" | "shell";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector("button")?.focus();
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
        <div className="menu" role="menu" ref={menuRef}>
          <button type="button" role="menuitem" onClick={onEdit}>
            Edit
          </button>
          <button type="button" role="menuitem" className="danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SongControls({
  song,
  textIndex,
  textCount,
  onTextIndex,
  awake,
  onAwake,
  menuOpen,
  onMenuToggle,
  onMenuClose,
  onEdit,
  onDelete,
}: {
  song: Song;
  textIndex: number;
  textCount: number;
  onTextIndex: (index: number) => void;
  awake: boolean;
  onAwake: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
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
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
      <NotationSwitch />
      <ScrollGroup />
      <TransposeStrip keyLabel={song.keyLabel} />
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
