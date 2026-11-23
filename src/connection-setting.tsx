import { useCallback, useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useEscape, useStored } from "./hooks";
import { syncHistoryStore } from "./phone-db";
import { settingsHref } from "./route";
import { tonightLine } from "./route-policy";
import { CHOICE_WORDS, type RouteChoice } from "./routes";
import { loadConnection, saveConnection } from "./storage";
import { BandmateSheet, whoAmI, type BandmateConfig, type Who } from "./sync-bandmate";
import { BANDMATE_WAIT_MS, FREE_STUN, TEST_NOW_MS, loadSummaries, testNow, testOverrides } from "./sync-history";
import { ratingParts, type Route, type RouteSummary, type SettingChoice } from "./sync-rating";
import "./account.css";
import "./band-library.css";
import "./settings.css";

/** The gig this phone is in right now: the admin's route and the strip's line for it. Held in memory, so a reload or the gig's end clears it. */
export type Tonight = { route: RouteChoice; line: string | null };

let tonight: Tonight | null = null;
const tonightListeners = new Set<() => void>();

/** Join gig sets this with the gig's route, and sets null when the phone leaves the gig. The phone's own setting is never written. */
export function setTonight(next: Tonight | null) {
  tonight = next;
  for (const listener of tonightListeners) listener();
}

const onTonight = (listener: () => void) => {
  tonightListeners.add(listener);
  return () => tonightListeners.delete(listener);
};
const useTonight = () => useSyncExternalStore(onTonight, () => tonight, () => null);

/** A link to Test with a bandmate that came in from outside the app: goes to Settings, which opens Connection and the test with it. */
let landed: string | null = null;
const landedListeners = new Set<() => void>();

export function landSyncCheck(code: string | null) {
  if (code !== null) window.location.hash = settingsHref("songs");
  landed = code;
  for (const listener of landedListeners) listener();
}

const onLanded = (listener: () => void) => {
  landedListeners.add(listener);
  return () => landedListeners.delete(listener);
};
const useLanded = () => useSyncExternalStore(onLanded, () => landed, () => null);

const MESSAGES: Record<string, string> = {
  "not-saved": "This phone did not keep that change. It lasts until you close the app.",
};

/** Which rating each row of the list reads. */
const RATED_AS: Record<RouteChoice, SettingChoice> = { auto: "auto", band_wifi: "wifi", direct_cell: "internet", server: "server" };

/** What the address may change, for a check: how long Test now runs, which STUN server it asks, how long a bandmate has to answer. */
const configNow = (): BandmateConfig & { testMs: number } => {
  const overrides = testOverrides(window.location.search);
  return { stun: overrides.stun ?? FREE_STUN, testMs: overrides.testMs ?? TEST_NOW_MS, timeoutMs: overrides.timeoutMs ?? BANDMATE_WAIT_MS };
};

const CANT_TEST = "Can't test now. Check your connection and try again.";

const CHOICES = Object.keys(CHOICE_WORDS) as RouteChoice[];

/** The rating is a third line under the name and line, so it shares their width and never squeezes them into a strip. */
const RATING: CSSProperties = { gridColumn: 2, color: "var(--text-dim)", fontSize: 13 };
const WORD: CSSProperties = { color: "var(--text)", fontWeight: 700 };
const GREYED: CSSProperties = { opacity: 0.5 };

/** Settings > Connection: four choices as rows of name, line and rating. During a gig the admin's choice shows and the rows are greyed out. */
function ConnectionSheet({ choice, onChoose, onClose }: { choice: RouteChoice; onChoose: (next: RouteChoice) => void; onClose: () => void }) {
  useEscape(onClose);
  const titleId = useId();
  const gig = useTonight();
  const arrived = useLanded();
  const [error, setError] = useState("");
  const [summaries, setSummaries] = useState<Partial<Record<Route, RouteSummary>> | null>(null);
  const [who, setWho] = useState<Who | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState("");
  const [bandmate, setBandmate] = useState(arrived !== null);
  const shown = gig?.route ?? choice;

  /** This phone's saved history, read again after anything that writes it. A phone that can't keep it shows Not tried yet. */
  const refresh = useCallback(() => {
    loadSummaries(syncHistoryStore, Date.now()).then(setSummaries, () => setSummaries({}));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    let live = true;
    whoAmI().then((now) => live && setWho(now));
    return () => {
      live = false;
    };
  }, []);
  const ready = summaries !== null && who !== null;
  useEffect(() => {
    if (arrived !== null) setBandmate(true);
  }, [arrived]);

  const runTest = async () => {
    const config = configNow();
    setTesting(true);
    setTested(`Testing for about ${Math.max(1, Math.round(config.testMs / 1000))} seconds…`);
    try {
      const result = await testNow(syncHistoryStore, { stun: config.stun, ms: config.testMs });
      setTested(result.outcome === "done" ? "Tested just now. The Wi-Fi link needs a bandmate: use Test with a bandmate." : CANT_TEST);
    } catch {
      setTested(CANT_TEST);
    } finally {
      setTesting(false);
      refresh();
    }
  };
  const closeBandmate = () => {
    setBandmate(false);
    landSyncCheck(null);
    refresh();
  };

  const pick = (next: RouteChoice) => {
    onChoose(next);
    setError(saveConnection(next) ? "" : MESSAGES["not-saved"]);
  };

  return (
    <>
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>Connection</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        {gig ? (
          <>
            <p className="account-note" role="status">
              {tonightLine(gig.route)}
            </p>
            {gig.line ? <p className="account-note">{gig.line}</p> : null}
          </>
        ) : (
          <p className="account-note">How this phone reaches the band. In a gig, the admin's choice is used.</p>
        )}
        {ready ? null : <p className="account-note">Checking…</p>}
        {ready ? <fieldset className="gig-plan-route" disabled={!!gig} style={gig ? GREYED : undefined}>
          <legend className="account-field">Connect by</legend>
          {CHOICES.map((route) => {
            const { word, age } = ratingParts(RATED_AS[route], summaries ?? {});
            return (
              <label key={route}>
                <input type="radio" name="connection" checked={shown === route} onChange={() => pick(route)} />
                <span data-slot="name">{CHOICE_WORDS[route].name}</span>
                <small data-slot="line">{CHOICE_WORDS[route].line}</small>
                <span data-slot="rating" style={RATING}>
                  <span data-word style={WORD}>{word}</span>
                  {age ? <> · <span data-age>{age}</span></> : null}
                </span>
              </label>
            );
          })}
        </fieldset> : null}
        {ready ? <div className="account-row">
          <button type="button" className="account-secondary" disabled={testing || !!gig} onClick={runTest}>
            Test now
          </button>
          <button type="button" className="account-secondary" disabled={testing || !!gig} onClick={() => setBandmate(true)}>
            Test with a bandmate
          </button>
        </div> : null}
        {tested ? (
          <p className="account-note" role="status" data-slot="test-status">
            {tested}
          </p>
        ) : null}
      </section>
    </div>
    {bandmate ? <BandmateSheet who={who} landed={arrived ?? undefined} config={configNow()} onClose={closeBandmate} onSaved={refresh} /> : null}
    </>
  );
}

/** The Connection row in Settings, naming the choice in use, and the screen it opens. */
export function ConnectionEntry() {
  const [choice, setChoice] = useStored(loadConnection);
  const [open, setOpen] = useState(false);
  /** Each tap on the row opens the screen fresh, so its ratings and sign-in are read again. */
  const [opens, setOpens] = useState(0);
  const gig = useTonight();
  const arrived = useLanded();
  useEffect(() => {
    if (arrived !== null) setOpen(true);
  }, [arrived]);
  return (
    <section className="settings-group" aria-label="Connection">
      <button type="button" className="settings-row" onClick={() => (setOpen(true), setOpens((n) => n + 1))}>
        Connection · {CHOICE_WORDS[gig?.route ?? choice].name}
      </button>
      {open ? <ConnectionSheet key={opens} choice={choice} onChoose={setChoice} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
