import { useState } from "react";
import { type PersonalSettings, type FixtureStore, savePersonal, loadPersonal, setSetting } from "./personal-settings-model";

export function PersonalSettingsScreen() {
  const [store, setStore] = useState<FixtureStore>({ saved: null });
  const [settings, setSettings] = useState<PersonalSettings>(loadPersonal(store));

  const handleSettingChange = <K extends keyof PersonalSettings>(key: K, value: PersonalSettings[K]) => {
    const updated = setSetting(settings, key, value);
    setSettings(updated);
    setStore(savePersonal(store, updated));
  };

  return (
    <div className="personal-settings-screen">
      <div className="personal-settings-field">
        <label>Click</label>
        <div className="personal-settings-radio-group">
          <label>
            <input
              type="radio"
              name="click"
              value="out-loud"
              checked={settings.click === "out-loud"}
              onChange={() => handleSettingChange("click", "out-loud")}
            />
            Out loud
          </label>
          <label>
            <input
              type="radio"
              name="click"
              value="dot-only"
              checked={settings.click === "dot-only"}
              onChange={() => handleSettingChange("click", "dot-only")}
            />
            Dot only
          </label>
        </div>
      </div>

      <div className="personal-settings-field">
        <label>Text size</label>
        <div className="personal-settings-control">
          <input
            type="range"
            min="12"
            max="32"
            value={settings.textSize}
            onChange={(e) => handleSettingChange("textSize", parseInt(e.currentTarget.value, 10))}
          />
          <span className="personal-settings-value">{settings.textSize}</span>
        </div>
      </div>

      <div className="personal-settings-field">
        <label>Chords</label>
        <div className="personal-settings-radio-group">
          <label>
            <input
              type="radio"
              name="chordStyle"
              value="notes"
              checked={settings.chordStyle === "notes"}
              onChange={() => handleSettingChange("chordStyle", "notes")}
            />
            Notes
          </label>
          <label>
            <input
              type="radio"
              name="chordStyle"
              value="nashville"
              checked={settings.chordStyle === "nashville"}
              onChange={() => handleSettingChange("chordStyle", "nashville")}
            />
            Nashville
          </label>
        </div>
      </div>

      <div className="personal-settings-field">
        <label>Transpose</label>
        <div className="personal-settings-control">
          <button onClick={() => handleSettingChange("transpose", settings.transpose - 1)}>−</button>
          <span className="personal-settings-value">{settings.transpose}</span>
          <button onClick={() => handleSettingChange("transpose", settings.transpose + 1)}>+</button>
        </div>
      </div>

      <p className="personal-settings-note">Your settings stay yours when you join a gig.</p>
    </div>
  );
}
