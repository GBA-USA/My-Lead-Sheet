import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { plural } from "./band-library";
import { bandSong } from "./band-setlist-view";
import { BandStatusFaces } from "./band-status";
import { playersFrom } from "./band-status-model";
import type { BandView } from "./bands-model";
import { downloadPack, type GigPack } from "./gig-pack";
import { gigLine, type GigView } from "./gig-plan-model";
import type { GigPosition } from "./gig-position";
import { displayKeyLabel } from "./music";
import { getFromPhone, heldFor, onPhoneChange, phoneGeneration } from "./phone-db";
import { bandHref, gigHref } from "./route";
import { ApiError, api } from "./sign-in-methods";
import { tempoText } from "./storage";

const MESSAGES: Record<string, string> = {
  "gig-ended": "That gig is over.",
  "not-found": "That gig isn't in the band any more.",
  "not-a-member": "You're not in this band any more.",
  "no-band": "This band isn't there any more.",
  "not-on-lineup": "This gig is for tonight's lineup.",
  "not-allowed": "Only the admin or tonight's leader can do that.",
};
const NEEDS_CONNECTION = "Needs a connection";
const PACK_OFFLINE = "Can't download now · try on Wi-Fi";
const FOLLOWING = "Following the leader starts when the gig goes live.";
const NOT_ON_PHONE = "This song isn't on this phone.";

const unreachable = (error: unknown) => error instanceof ApiError && (error.reason === "offline" || error.status >= 500);
const message = (error: unknown) => (error instanceof ApiError && MESSAGES[error.reason]) || "Something went wrong. Try again.";

let packRound = 0;
const packListeners = new Set<() => void>();
const packRoundNow = () => packRound;
const onPackRound = (listener: () => void) => {
  packListeners.add(listener);
  return () => void packListeners.delete(listener);
};

/** Downloads the pack and tells every screen holding one to read it again, since a plain put on the phone says nothing. */
async function fetchPack(me: string, bandId: string, gigId: string) {
  await downloadPack(me, bandId, gigId);
  packRound += 1;
  for (const listener of packListeners) listener();
}

/** The pack this phone holds for the gig: `undefined` while it looks, `null` when there is none for this account. */
export function useGigPack(me: string | null, gigId: string): GigPack | null | undefined {
  const generation = useSyncExternalStore(onPhoneChange, phoneGeneration, phoneGeneration);
  const round = useSyncExternalStore(onPackRound, packRoundNow, packRoundNow);
  const key = `${me}/${gigId}`;
  const [found, setFound] = useState<{ key: string; pack: GigPack | null } | null>(null);

  useEffect(() => {
    if (!me || !gigId || !heldFor(me)) return setFound({ key, pack: null });
    let live = true;
    getFromPhone("gigPacks", gigId).then(
      (pack) => live && setFound({ key, pack: pack ?? null }),
      () => live && setFound({ key, pack: null }),
    );
    return () => {
      live = false;
    };
  }, [key, generation, round]);

  return found?.key === key ? found.pack : undefined;
}

const onlineNow = () => navigator.onLine;
const watchOnline = (listener: () => void) => {
  addEventListener("online", listener);
  addEventListener("offline", listener);
  return () => {
    removeEventListener("online", listener);
    removeEventListener("offline", listener);
  };
};
const useOnline = () => useSyncExternalStore(watchOnline, onlineNow, () => true);

type Props = {
  me: string | null;
  bandId: string;
  gigId: string;
  pack: GigPack | null | undefined;
  position: GigPosition;
  onSignIn: () => void;
  onSignedOut: () => void;
};

/** What the gig-mode sheet shows in place of the sheet when this phone has no song for the route. */
export function GigSongMissing({ bandId, gigId, pack }: { bandId: string; gigId: string; pack: GigPack | null | undefined }) {
  if (pack === undefined) return null;
  return (
    <div className="missing">
      <p>{NOT_ON_PHONE}</p>
      <a href={gigHref(bandId, gigId)}>Back to the gig</a>
    </div>
  );
}

/**
 * The gig view at `#/gig/:bandId/:gigId`: the set runner. It renders from the pack on this phone with no server call,
 * so it opens with no signal; `gig/open` and the band's view are read once for the gig's status and for who is admin.
 * Whoever may move the set gets the set rows as buttons and the bottom Prev and Next; a member reads the following
 * line. End is for the leader, the backup or an admin, asks once, and needs a connection.
 */
export function GigViewScreen({ me, bandId, gigId, pack, position, onSignIn, onSignedOut }: Props) {
  const titleId = useId();
  const online = useOnline();
  const [opened, setOpened] = useState<GigView | null>(null);
  const [band, setBand] = useState<BandView | null>(null);
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refused = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
    if (!unreachable(caught) && caught instanceof ApiError && MESSAGES[caught.reason]) setProblem(MESSAGES[caught.reason]);
  };

  useEffect(() => {
    if (!me) return;
    api<GigView>("/api/bands/gig/open", { bandId, gigId }).then((view) => {
      setOpened(view);
      if (view.gig.status === "ended") setProblem(MESSAGES["gig-ended"]);
    }, refused);
    api<BandView>("/api/bands/open", { bandId }).then(setBand, () => {});
  }, [me, bandId, gigId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
      setError(unreachable(caught) ? NEEDS_CONNECTION : message(caught));
    } finally {
      setBusy(false);
    }
  };

  const getReady = () =>
    run(async () => {
      if (!me) return;
      try {
        await fetchPack(me, bandId, gigId);
      } catch (caught) {
        if (!unreachable(caught)) throw caught;
        setError(PACK_OFFLINE);
      }
    });

  const endGig = () =>
    run(async () => {
      await api<GigView>("/api/bands/gig/end", { bandId, gigId });
      window.location.replace(bandHref(bandId));
    });

  if (!me) {
    return (
      <section className="gig-view" data-gig={gigId}>
        <p className="account-note">Sign in to see this gig.</p>
        <button type="button" className="live-launch bands-tab-button" onClick={onSignIn}>
          Sign in
        </button>
      </section>
    );
  }
  if (problem) {
    return (
      <section className="gig-view" data-gig={gigId}>
        <p className="account-note" role="alert">
          {problem}
        </p>
        <a className="account-link" href={bandHref(bandId)}>
          Back to the band
        </a>
      </section>
    );
  }

  const gig = pack?.gig ?? opened?.gig;
  const songs = (pack?.songs ?? []).map((item) => bandSong(bandId, item.songId, item.song));
  const now = songs[position.index];
  const next = songs[position.index + 1];
  const mayEnd = gig !== undefined && (gig.leader === me || gig.backup === me || band?.role === "admin");
  const line = !online && !error ? NEEDS_CONNECTION : error;
  const meta = (song: (typeof songs)[number]) => `${displayKeyLabel(song, 0)} · ${tempoText(song.tempo)}`;

  return (
    <section className="gig-view" data-gig={gigId} aria-labelledby={titleId}>
      <header className="gig-top">
        <div className="gig-head">
          <h2 id={titleId}>{gig?.name ?? "Gig"}</h2>
          {gig ? <p className="gig-line">{gigLine(gig)}</p> : null}
        </div>
        {mayEnd && !asking ? (
          <button type="button" className="account-secondary" disabled={busy || !online} onClick={() => setAsking(true)}>
            End
          </button>
        ) : null}
      </header>
      {asking ? (
        <div className="gig-ask" role="alertdialog" aria-label="End the gig for everyone?">
          <p>End the gig for everyone?</p>
          <button type="button" className="account-primary" disabled={busy} onClick={endGig}>
            Yes, end
          </button>
          <button type="button" className="account-link" onClick={() => setAsking(false)}>
            Keep going
          </button>
        </div>
      ) : null}
      {line ? <p className="account-note gig-line">{line}</p> : null}
      {pack === undefined ? <p className="account-note">Loading…</p> : null}
      {pack === null ? (
        <>
          <p className="account-note">{NOT_ON_PHONE}</p>
          <button type="button" className="account-primary" disabled={busy} onClick={getReady}>
            Get ready
          </button>
        </>
      ) : null}
      {pack ? <p className="gig-count">{plural(songs.length, "song")} on this phone</p> : null}
      {songs.length > 0 ? (
        <div className="gig-progress" aria-label="Set progress">
          {songs.map((song, index) => (
            <span key={`${song.ref}-${index}`} aria-current={index === position.index ? "step" : undefined} />
          ))}
        </div>
      ) : null}
      {now ? (
        <section className="gig-now">
          <p className="gig-kicker">
            NOW · {position.index + 1} OF {songs.length}
          </p>
          <p className="gig-title">{now.title}</p>
          <p className="gig-meta">{meta(now)}</p>
          <div className="account-row">
            <button type="button" className="account-primary" onClick={() => (window.location.hash = gigHref(bandId, gigId, position.index))}>
              Open sheet
            </button>
            <button type="button" className="account-secondary" onClick={() => (window.location.hash = gigHref(bandId, gigId, position.index))}>
              Metronome
            </button>
          </div>
        </section>
      ) : null}
      {pack && !position.canMove ? <p className="account-note">{FOLLOWING}</p> : null}
      {next ? (
        <section className="gig-next">
          <p className="gig-kicker">NEXT</p>
          <p className="gig-title">{next.title}</p>
          <p className="gig-meta">{meta(next)}</p>
        </section>
      ) : null}
      <div className="band-status-slot">{opened && band ? <BandStatusFaces players={playersFrom(opened, band, me)} /> : null}</div>
      {songs.length > 0 ? (
        <section className="gig-set">
          <h3>Set</h3>
          <ol>
            {songs.map((song, index) => (
              <li key={`${song.ref}-${index}`} aria-current={index === position.index ? "true" : undefined}>
                <span className="gig-set-number">{index + 1}</span>
                {position.canMove && index !== position.index ? (
                  <button type="button" onClick={() => position.goTo(index)}>
                    {song.title}
                  </button>
                ) : (
                  <span>{song.title}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
