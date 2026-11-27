import { useId } from "react";
import { NOTATION_LABELS, TextSizeButtons } from "./controls";
import type { ClickPrefs } from "./metronome";
import { TRANSPOSE_LIMIT, type PersonalDefaults } from "./personal-settings-model";
import { TEXT_SCALES } from "./storage";

const ON_OFF: ["on" | "off", string][] = [
  ["on", "On"],
  ["off", "Off"],
];
const CHORD_DEFAULTS = NOTATION_LABELS.filter(([notation]) => notation !== "chords");

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (next: T) => void }) {
  return (
    <div className="settings-choice" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const signed = (semitones: number) => (semitones > 0 ? `+${semitones}` : semitones < 0 ? `−${-semitones}` : "0");

export function YourSettings({
  click,
  onClick,
  textIndex,
  onTextIndex,
  personal,
  onPersonal,
}: {
  click: ClickPrefs;
  onClick: (patch: Partial<ClickPrefs>) => void;
  textIndex: number;
  onTextIndex: (index: number) => void;
  personal: PersonalDefaults;
  onPersonal: (next: PersonalDefaults) => void;
}) {
  const titleId = useId();
  return (
    <section className="settings-group" aria-labelledby={titleId}>
      <h2 id={titleId}>Your settings</h2>
      <div className="settings-field">
        <h3>Sound</h3>
        <Choice label="Sound" value={click.sound ? "on" : "off"} options={ON_OFF} onChange={(next) => onClick({ sound: next === "on" })} />
      </div>
      <div className="settings-field">
        <h3>Dot</h3>
        <Choice label="Dot" value={click.indicator ? "on" : "off"} options={ON_OFF} onChange={(next) => onClick({ indicator: next === "on" })} />
      </div>
      <div className="settings-field">
        <h3>Chords</h3>
        <Choice label="Chords" value={personal.chordStyle} options={CHORD_DEFAULTS} onChange={(chordStyle) => onPersonal({ ...personal, chordStyle })} />
        <p className="settings-note">For every song you have not switched yourself.</p>
      </div>
      <div className="settings-field">
        <h3>Text size</h3>
        <div className="settings-step" role="group" aria-label="Text size">
          <TextSizeButtons index={textIndex} count={TEXT_SCALES.length} onChange={onTextIndex} />
          <p className="settings-text-sample" aria-label="Text size sample" style={{ fontSize: `calc(16px * ${TEXT_SCALES[textIndex]})` }}>
            Harbor lights
          </p>
        </div>
      </div>
      <div className="settings-field">
        <h3>Transpose</h3>
        <div className="settings-step" role="group" aria-label="Transpose">
          <button type="button" aria-label="Transpose default down" disabled={personal.transpose <= -TRANSPOSE_LIMIT} onClick={() => onPersonal({ ...personal, transpose: personal.transpose - 1 })}>
            −
          </button>
          <span className="settings-value">{signed(personal.transpose)}</span>
          <button type="button" aria-label="Transpose default up" disabled={personal.transpose >= TRANSPOSE_LIMIT} onClick={() => onPersonal({ ...personal, transpose: personal.transpose + 1 })}>
            +
          </button>
        </div>
        <p className="settings-note">For an instrument tuned down. Every song you open starts here, and Original Key comes back here.</p>
      </div>
      <p className="settings-note">Your settings stay yours when you join a gig.</p>
    </section>
  );
}
