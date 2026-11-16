import { useId, useState } from "react";
import { backupLine } from "./account";
import type { BackupResult } from "./backup";
import { PRIVACY_HREF } from "./data-kinds";
import type { MetronomePrefs } from "./metronome";
import { CLICK_PREFS, clickOf, type PersonalDefaults } from "./personal-settings-model";
import { YourSettings } from "./personal-settings";
import type { Account } from "./sign-in-methods";
import { THEMES, loadTheme, saveTheme, type Theme } from "./storage";
import "./settings.css";

const THEME_NAMES: Record<Theme, string> = {
  stage: "Stage",
  day: "Day",
  "cb-rg": "Red-green safe",
  "cb-by": "Blue-yellow safe",
  contrast: "High contrast",
};

const MESSAGES: Record<string, string> = {
  "not-saved": "This phone did not keep that change. It lasts until you close the app.",
};

/** Sets the look at once. The browser bar takes the theme's background, the same color `index.html` gives it at launch. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim());
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 6.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5ZM8.6 1.5h2.8l.45 2.2 1.55.9 2.12-.72 1.4 2.42-1.68 1.5v1.8l1.68 1.5-1.4 2.42-2.12-.72-1.55.9-.45 2.2H8.6l-.45-2.2-1.55-.9-2.12.72-1.4-2.42 1.68-1.5V8.1L3.08 6.6l1.4-2.42 2.12.72 1.55-.9.45-2.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsScreen({
  account,
  backup,
  textIndex,
  onTextIndex,
  personal,
  onPersonal,
  metronome,
  onAccount,
  onFriends,
  onMessages,
}: {
  account: Account | null;
  backup: BackupResult | null;
  textIndex: number;
  onTextIndex: (index: number) => boolean;
  personal: PersonalDefaults;
  onPersonal: (next: PersonalDefaults) => boolean;
  metronome: { prefs: MetronomePrefs; setPrefs: (patch: Partial<MetronomePrefs>) => void };
  onAccount: () => void;
  onFriends: () => void;
  onMessages: () => void;
}) {
  const lookId = useId();
  const accountId = useId();
  const aboutId = useId();
  const [theme, setTheme] = useState(loadTheme);
  const [error, setError] = useState("");
  const saved = (ok: boolean) => setError(ok ? "" : MESSAGES["not-saved"]);

  const pickTheme = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    saved(saveTheme(next));
  };

  return (
    <div className="settings">
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="settings-group" aria-labelledby={lookId}>
        <h2 id={lookId}>Look</h2>
        <div className="settings-chips" role="group" aria-label="Theme">
          {THEMES.map((option) => (
            <button key={option} type="button" aria-pressed={theme === option} onClick={() => pickTheme(option)}>
              {THEME_NAMES[option]}
            </button>
          ))}
        </div>
        <div className="settings-sample" role="img" aria-label="Theme sample">
          <span className="settings-sample-chords">
            <span className="is-sure">G</span>
            <span className="is-check">D/F♯</span>
            <span className="is-unsure">Em</span>
          </span>
          <span className="settings-sample-words">Harbor lights are burning</span>
        </div>
      </section>

      <YourSettings
        click={clickOf(metronome.prefs)}
        onClick={(click) => metronome.setPrefs(CLICK_PREFS[click])}
        textIndex={textIndex}
        onTextIndex={(index) => saved(onTextIndex(index))}
        personal={personal}
        onPersonal={(next) => saved(onPersonal(next))}
      />

      <section className="settings-group" aria-labelledby={accountId}>
        <h2 id={accountId}>Account</h2>
        <div className="settings-rows" role="group" aria-label="Account">
          {account ? (
            <>
              <p className="settings-note">
                Signed in as {account.displayName} · @{account.handle}
              </p>
              <button type="button" className="settings-row" onClick={onAccount}>
                Account
              </button>
              <button type="button" className="settings-row" onClick={onFriends}>
                Friends
              </button>
              <button type="button" className="settings-row" onClick={onMessages}>
                Messages
              </button>
              <p className="settings-note" role="status">
                {backupLine(backup)}
              </p>
            </>
          ) : (
            <>
              <p className="settings-note">Sign in to back up your songs, add friends and play with your band.</p>
              <button type="button" className="settings-row" onClick={onAccount}>
                Sign in
              </button>
            </>
          )}
        </div>
      </section>

      <section className="settings-group" aria-labelledby={aboutId}>
        <h2 id={aboutId}>About</h2>
        <a className="settings-row" href={PRIVACY_HREF}>
          Privacy: what we keep and why
        </a>
      </section>
    </div>
  );
}
