import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { BandLibraryTab, LIBRARY_MESSAGES, type LibraryTab } from "./band-library";
import type { BandLibrary } from "./band-library-model";
import { BandSettings } from "./band-settings";
import type { BandPreview, BandSummary, BandView } from "./bands-model";
import { CODE_REFUSED, codeInText, readPayload, type CodeKind } from "./code-link";
import { ScanCode, ShowCode } from "./codes";
import { APP_NAME } from "./data-kinds";
import { downloadPack, packsOnPhone, type GigPack } from "./gig-pack";
import { GigCard, GigPlanForm, GigSong, newGigId } from "./gig-plan";
import type { GigDraft, GigView } from "./gig-plan-model";
import { useCloseOnSong, useEscape } from "./hooks";
import { keepBandsOnPhone } from "./phone-db";
import { SETLIST_CODE_MESSAGES } from "./setlist-code";
import { GearIcon } from "./settings";
import { ApiError, api, type Account } from "./sign-in-methods";
import "./friends.css";

type InBand = "band" | "invite" | "settings";
type BandTab = LibraryTab | "chat" | "gigs" | "members";
type View =
  | { name: "list" }
  | { name: InBand; bandId: string }
  | { name: "plan"; bandId: string; setlistId: string; setlistName: string; gigId: string }
  | { name: "gig-song"; bandId: string; gigId: string; index: number }
  | { name: "scan" }
  | { name: "code"; code: string }
  | { name: "gig-code"; code: string }
  | { name: "setlist-code"; code: string };

const BAND_TABS: [BandTab, string][] = [
  ["songs", "Songs"],
  ["setlists", "Setlists"],
  ["chat", "Chat"],
  ["gigs", "Gigs"],
  ["members", "Members"],
];

const MESSAGES: Record<string, string> = {
  ...CODE_REFUSED,
  ...LIBRARY_MESSAGES,
  offline: "Can't reach the server. Check your connection and try again.",
  "bad-name": "Give the band a name of up to 40 letters.",
  "not-a-band-code": "That isn't a band code.",
  "not-a-member": "You're not in this band any more.",
  "no-band": "This band isn't there any more.",
  "not-admin": "Only a band admin can do that.",
  "last-admin": "Make someone else admin first.",
  "not-a-gig-code": "That isn't a gig code.",
  "not-on-lineup": "This gig is for tonight's lineup.",
  "not-allowed": "Only the admin or tonight's leader can do that.",
  "not-found": "That isn't in the band any more.",
  "bad-gig-name": "Give the gig a name of up to 60 letters.",
  "bad-date": "Pick the date of the gig.",
  "is-leader": "The backup leader has to be someone other than the leader.",
  "gig-ended": "That gig is over.",
  "not-in-band": SETLIST_CODE_MESSAGES["not-in-band"],
  "not-a-setlist-code": SETLIST_CODE_MESSAGES["not-a-setlist-code"],
};

const PACK_OFFLINE = "Can't download now · try on Wi-Fi";

const unreachable = (error: unknown) => error instanceof ApiError && (error.reason === "offline" || error.status >= 500);

const CODE_VIEWS: Partial<Record<CodeKind, (code: string) => View>> = {
  band: (code) => ({ name: "code", code }),
  gig: (code) => ({ name: "gig-code", code }),
  "band-setlist": (code) => ({ name: "setlist-code", code }),
};

const codeView = (code: string): View | null => {
  const kind = readPayload(code)?.kind;
  return kind ? (CODE_VIEWS[kind]?.(code) ?? null) : null;
};

const firstView = (code: string | undefined, bandId: string | undefined): View => (code ? (codeView(code) ?? { name: "list" }) : bandId ? { name: "band", bandId } : { name: "list" });

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/** The server's list of this account's bands. Songs of any other band leave the phone, so search stops finding them. */
const listed = (bands: BandSummary[]) => {
  keepBandsOnPhone(bands.map((band) => band.bandId)).catch(() => {});
  return bands;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Bands: the list, one band's Setlists, Songs and Members tabs with Message on each bandmate, Invite and Band settings,
 * and a card for each gig not yet played. `code` is a band or gig code to open first.
 */
export function BandsSheet({
  account,
  code,
  bandId,
  onMessage,
  onChat,
  onSetlistCopy,
  onSettings,
  onSignedOut,
  onClose,
}: {
  account: Account;
  code?: string;
  bandId?: string;
  onMessage: (userId: string) => void;
  onChat: (roomId: string) => void;
  onSetlistCopy: (code: string) => void;
  onSettings?: () => void;
  onSignedOut: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const linkId = useId();
  const [view, setView] = useState<View>(() => firstView(code, bandId));
  const [landedSetlist, setLandedSetlist] = useState<string | undefined>(undefined);
  const [bands, setBands] = useState<BandSummary[] | null>(null);
  const [band, setBand] = useState<BandView | null>(null);
  const [preview, setPreview] = useState<BandPreview | null>(null);
  const [gigs, setGigs] = useState<{ bandId: string; list: GigView[] } | null>(null);
  const [packs, setPacks] = useState<Record<string, GigPack>>({});
  const [newName, setNewName] = useState("");
  const [link, setLink] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inviteRound, setInviteRound] = useState(0);
  const [bandTab, setBandTab] = useState<BandTab>("members");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const go = (next: View) => {
    setError("");
    setNotice("");
    setConfirming(null);
    setView(next);
  };

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      onClose();
      return onSignedOut();
    }
    if (caught instanceof ApiError && (caught.reason === "not-a-member" || caught.reason === "no-band")) setView({ name: "list" });
    setError(message(caught));
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  /** The band's gigs and the packs this phone holds for them, set together so the card never pairs a gig with a pack it lacks. */
  const loadGigs = async (bandId: string) => {
    const { gigs: list } = await api<{ gigs: GigView[] }>("/api/bands/gig/list", { bandId });
    const onPhone = await packsOnPhone(account.userId, list.map((item) => item.gig.gigId));
    setPacks(onPhone);
    setGigs({ bandId, list });
  };

  useEffect(() => {
    if (view.name === "list") api<{ bands: BandSummary[] }>("/api/bands").then((reply) => setBands(listed(reply.bands)), failed);
    if (view.name === "band" || view.name === "invite" || view.name === "settings" || view.name === "plan") api<BandView>("/api/bands/open", { bandId: view.bandId }).then(setBand, failed);
    if (view.name === "band") loadGigs(view.bandId).catch(failed);
    if (view.name === "code") {
      setPreview(null);
      api<BandPreview>("/api/bands/code", { code: view.code }).then(setPreview, failed);
    }
    if (view.name === "gig-code") api<GigView>("/api/bands/gig/code", { code: view.code }).then((opened) => setView({ name: "band", bandId: opened.gig.bandId }), failed);
    if (view.name === "setlist-code")
      api<{ bandId: string; setlistId: string }>("/api/bands/setlist-code", { code: view.code }).then((opened) => {
        setBandTab("setlists");
        setLandedSetlist(opened.setlistId);
        setView({ name: "band", bandId: opened.bandId });
      }, failed);
  }, [view]);

  /** A lineup phone fetches a pack it lacks, or one older than the plan, as soon as it sees the card. A failure waits for Get ready. */
  useEffect(() => {
    for (const item of gigs?.list ?? []) {
      if (!item.gig.lineup.includes(account.userId) || (packs[item.gig.gigId]?.packRev ?? 0) >= item.packRev) continue;
      downloadPack(account.userId, item.gig.bandId, item.gig.gigId).then(
        () => loadGigs(item.gig.bandId),
        () => {},
      );
    }
  }, [gigs]);

  const getReady = (item: GigView) =>
    run(async () => {
      try {
        const pack = await downloadPack(account.userId, item.gig.bandId, item.gig.gigId);
        setPacks((held) => ({ ...held, [pack.gig.gigId]: pack }));
      } catch (caught) {
        if (!unreachable(caught)) throw caught;
        return setError(PACK_OFFLINE);
      }
      await loadGigs(item.gig.bandId);
    });

  const sendPlan = (plan: Extract<View, { name: "plan" }>, draft: GigDraft) =>
    run(async () => {
      const made = await api<GigView>("/api/bands/gig/plan", { bandId: plan.bandId, setlistId: plan.setlistId, gigId: plan.gigId, ...draft });
      setView({ name: "band", bandId: plan.bandId });
      setNotice(`Sent ${made.gig.name} to the band.`);
    });

  const planFromTop = (bandId: string) =>
    run(async () => {
      const library = await api<BandLibrary>("/api/bands/library", { bandId });
      if (library.setlists.length === 0) return setNotice("Share a setlist first. Then tap Plan a gig on it.");
      setBandTab("setlists");
      setNotice("Pick a setlist below, then tap Plan a gig.");
    });

  useEscape(onClose);
  useCloseOnSong(onClose);

  const change = (path: string, body: object, done?: string) =>
    run(async () => {
      setBand(await api<BandView>(path, body));
      if (done) setNotice(done);
    });

  const opened = (payload: string) => {
    const next = codeView(payload);
    if (next) go(next);
    else if (readPayload(payload)?.kind === "my-setlist") onSetlistCopy(payload);
    else setError("That isn't a band, gig or setlist code.");
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      const made = await api<BandView>("/api/bands/create", { name: newName });
      setNewName("");
      setBand(made);
      setView({ name: "band", bandId: made.bandId });
    });
  };

  const openLink = (event: FormEvent) => {
    event.preventDefault();
    const payload = codeInText(link);
    setLink("");
    if (payload) opened(payload);
    else setError(`That link isn't a ${APP_NAME} code.`);
  };

  const shown = band && "bandId" in view && band.bandId === view.bandId ? band : null;
  const isAdmin = shown?.role === "admin";

  const gigCards =
    shown && gigs?.bandId === shown.bandId
      ? gigs.list.map((item) => (
          <GigCard
            key={item.gig.gigId}
            view={item}
            band={shown}
            me={account.userId}
            pack={packs[item.gig.gigId]}
            busy={busy}
            onGetReady={() => getReady(item)}
            onSong={(index) => go({ name: "gig-song", bandId: shown.bandId, gigId: item.gig.gigId, index })}
          />
        ))
      : null;

  const backTo = (next: View, label = "Back") => (
    <button type="button" className="account-link" onClick={() => go(next)}>
      {label}
    </button>
  );
  const loading = <p className="account-note">Loading…</p>;

  const screens: Record<View["name"], () => { title: string; body: ReactNode }> = {
    list: () => ({
      title: "Bands",
      body: (
        <>
          {!bands ? (
            loading
          ) : bands.length === 0 ? (
            <p className="account-note">No bands yet. Make one, or scan a bandmate's code.</p>
          ) : (
            <ul className="friends-list bands-list">
              {bands.map((item) => (
                <li key={item.bandId}>
                  <span>
                    {item.name}
                    <small>
                      {item.role === "admin" ? "Admin · " : ""}
                      {plural(item.members, "member")}
                    </small>
                  </span>
                  <button type="button" className="account-secondary" onClick={() => go({ name: "band", bandId: item.bandId })}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="account-form" onSubmit={create}>
            <label className="account-field" htmlFor={nameId}>
              New band
            </label>
            <input id={nameId} className="account-input" maxLength={40} placeholder="Band name" value={newName} onChange={(event) => setNewName(event.target.value)} />
            <button type="submit" className="account-secondary" disabled={busy || !newName.trim()}>
              Create band
            </button>
          </form>
          <form className="account-form" onSubmit={openLink}>
            <label className="account-field" htmlFor={linkId}>
              Join by link
            </label>
            <input id={linkId} className="account-input" autoCapitalize="none" autoComplete="off" placeholder="Paste the link" value={link} onChange={(event) => setLink(event.target.value)} />
            <button type="submit" className="account-secondary" disabled={!link.trim()}>
              Open link
            </button>
          </form>
          <button type="button" className="account-primary" onClick={() => go({ name: "scan" })}>
            Scan a code
          </button>
        </>
      ),
    }),

    band: () => ({
      title: shown?.name ?? "Band",
      body: !shown ? (
        loading
      ) : (
        <>
          {isAdmin ? (
            <div className="account-row">
              <button type="button" className="account-primary" onClick={() => go({ name: "invite", bandId: shown.bandId })}>
                Invite
              </button>
              <button type="button" className="account-secondary" onClick={() => go({ name: "settings", bandId: shown.bandId })}>
                Band settings
              </button>
              <button type="button" className="account-secondary" disabled={busy} onClick={() => planFromTop(shown.bandId)}>
                Plan a gig
              </button>
            </div>
          ) : null}
          {bandTab === "gigs" ? null : gigCards}
          <div className="band-tabs" role="tablist" aria-label={shown.name}>
            {BAND_TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={bandTab === key} onClick={() => setBandTab(key)}>
                {label}
              </button>
            ))}
          </div>
          {bandTab === "chat" ? (
            <>
              <p className="account-note">The band&apos;s messages, with its gig, song and setlist cards.</p>
              <button type="button" className="account-primary" onClick={() => onChat(shown.bandId)}>
                Open band chat
              </button>
            </>
          ) : bandTab === "gigs" ? (
            <>
              {!gigCards ? loading : gigCards.length === 0 ? <p className="account-note">No gigs planned yet.</p> : gigCards}
              {isAdmin ? (
                <button type="button" className="account-secondary" disabled={busy} onClick={() => planFromTop(shown.bandId)}>
                  Plan a gig
                </button>
              ) : null}
            </>
          ) : bandTab === "members" ? (
            <>
              <ul className="friends-list bands-members">
                {shown.members.map((member) => (
                  <li key={member.userId}>
                    <span>
                      {member.name}
                      {member.role === "admin" ? <small>Admin</small> : null}
                    </span>
                    {member.userId !== account.userId ? (
                      <button type="button" className="account-link" onClick={() => onMessage(member.userId)}>
                        Message
                      </button>
                    ) : null}
                    {isAdmin && member.userId !== account.userId ? (
                      <span className="friends-actions">
                        {member.role === "member" ? (
                          <button
                            type="button"
                            className="account-link"
                            disabled={busy}
                            onClick={() => change("/api/bands/make-admin", { bandId: shown.bandId, userId: member.userId }, `${member.name} is now an admin.`)}
                          >
                            Make admin
                          </button>
                        ) : null}
                        {confirming === member.userId ? (
                          <button
                            type="button"
                            className="account-secondary"
                            disabled={busy}
                            onClick={() => change("/api/bands/remove", { bandId: shown.bandId, userId: member.userId }, `Removed ${member.name}.`)}
                          >
                            Yes, remove
                          </button>
                        ) : (
                          <button type="button" className="account-link" onClick={() => setConfirming(member.userId)}>
                            Remove
                          </button>
                        )}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {confirming === "leave" ? (
                <button
                  type="button"
                  className="account-secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api("/api/bands/leave", { bandId: shown.bandId });
                      setView({ name: "list" });
                      setNotice(`You left ${shown.name}.`);
                    })
                  }
                >
                  Yes, leave {shown.name}
                </button>
              ) : (
                <button type="button" className="account-link" onClick={() => setConfirming("leave")}>
                  Leave band
                </button>
              )}
            </>
          ) : (
            <BandLibraryTab
              band={shown}
              me={account.userId}
              tab={bandTab}
              busy={busy}
              run={run}
              notify={setNotice}
              onPlanGig={isAdmin ? (setlist) => go({ name: "plan", bandId: shown.bandId, setlistId: setlist.setlistId, setlistName: setlist.name, gigId: newGigId() }) : undefined}
              landed={landedSetlist}
              onCodeError={failed}
            />
          )}
          {backTo({ name: "list" }, "All bands")}
        </>
      ),
    }),

    plan: () => ({
      title: "Plan a gig",
      body:
        !shown || view.name !== "plan" ? (
          loading
        ) : (
          <GigPlanForm band={shown} me={account.userId} setlistName={view.setlistName} busy={busy} onSend={(draft) => sendPlan(view, draft)} onCancel={() => go({ name: "band", bandId: shown.bandId })} />
        ),
    }),

    "gig-song": () => {
      if (view.name !== "gig-song") return { title: "Song", body: null };
      const item = packs[view.gigId]?.songs[view.index];
      const back = () => go({ name: "band", bandId: view.bandId });
      return {
        title: item?.song.title ?? "Song",
        body: item ? (
          <GigSong bandId={view.bandId} item={item} onBack={back} />
        ) : (
          <>
            <p className="account-note">This song isn't on this phone. Tap Get ready on the gig card.</p>
            {backTo({ name: "band", bandId: view.bandId })}
          </>
        ),
      };
    },

    "setlist-code": () => ({
      title: "Setlist",
      body: (
        <>
          {error ? null : <p className="account-note">Opening the setlist…</p>}
          {backTo({ name: "list" }, "All bands")}
        </>
      ),
    }),

    "gig-code": () => ({
      title: "Gig",
      body: (
        <>
          {error ? null : <p className="account-note">Opening the gig…</p>}
          {backTo({ name: "list" }, "All bands")}
        </>
      ),
    }),

    invite: () => ({
      title: "Invite",
      body: !shown ? (
        loading
      ) : (
        <>
          <ShowCode
            key={inviteRound}
            request={{ kind: "band", bandId: shown.bandId }}
            words={`Join ${shown.name}`}
            share
            onStopped={() => {
              go({ name: "band", bandId: shown.bandId });
              setNotice("Code stopped. Nobody can use it now.");
            }}
            onError={failed}
          />
          <p className="account-note">Whoever scans this or opens the link can join after they sign in.</p>
          <button
            type="button"
            className="account-secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("/api/bands/reset-link", { bandId: shown.bandId });
                setInviteRound((round) => round + 1);
                setNotice("Link reset. Old codes and links don't work any more.");
              })
            }
          >
            Reset link
          </button>
          {backTo({ name: "band", bandId: shown.bandId })}
        </>
      ),
    }),

    settings: () => ({
      title: "Band settings",
      body: !shown ? (
        loading
      ) : (
        <>
          <BandSettings band={shown} busy={busy || !isAdmin} onScrollWithLeader={(on) => change("/api/bands/settings", { bandId: shown.bandId, scrollWithLeader: on })} />
          {backTo({ name: "band", bandId: shown.bandId })}
        </>
      ),
    }),

    scan: () => ({
      title: "Scan a code",
      body: (
        <>
          <ScanCode onCode={opened} />
          {backTo({ name: "list" })}
        </>
      ),
    }),

    code: () => ({
      title: "Join a band",
      body: preview ? (
        <>
          <p className="codes-words">
            {preview.name} <small>Invited by {preview.invitedBy}</small>
          </p>
          <button
            type="button"
            className="account-primary"
            disabled={busy}
            onClick={() =>
              view.name === "code" &&
              run(async () => {
                const joined = await api<BandView>("/api/bands/join", { code: view.code });
                setBand(joined);
                setView({ name: "band", bandId: joined.bandId });
                setNotice(preview.member ? `You're already in ${joined.name}.` : `You joined ${joined.name}.`);
              })
            }
          >
            {preview.member ? "Open band" : "Join"}
          </button>
          {backTo({ name: "list" })}
        </>
      ) : (
        <>
          {error ? null : <p className="account-note">Checking the code…</p>}
          {backTo({ name: "list" })}
        </>
      ),
    }),
  };

  const screen = screens[view.name]();
  return (
    <div className="account-backdrop" onClick={onClose}>
      <section
        className="account-sheet bands-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-view={view.name}
        data-band={"bandId" in view ? view.bandId : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-top">
          <h2 id={titleId}>{screen.title}</h2>
          {view.name === "band" && onSettings ? (
            <button type="button" className="account-close" style={{ marginLeft: "auto" }} aria-label="Settings" onClick={onSettings}>
              <GearIcon />
            </button>
          ) : null}
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {notice ? (
          <p className="account-note bands-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        {screen.body}
      </section>
    </div>
  );
}

export function BandsTab({ account, onOpen, onSignIn, onSignedOut }: { account: Account | null; onOpen: (bandId?: string) => void; onSignIn: () => void; onSignedOut: () => void }) {
  const [bands, setBands] = useState<BandSummary[] | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    api<{ bands: BandSummary[] }>("/api/bands").then(
      (reply) => setBands(listed(reply.bands)),
      (caught) => (caught instanceof ApiError && caught.status === 401 ? onSignedOut() : setError(message(caught))),
    );
  };
  useEffect(() => {
    setBands(null);
    if (account) load();
  }, [account?.userId]);

  if (!account) {
    return (
      <div className="bands-tab">
        <p className="bands-tab-note">Play with your band. Sign in to share setlists and follow gigs.</p>
        <button type="button" className="live-launch bands-tab-button" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    );
  }
  return (
    <div className="bands-tab">
      {error ? (
        <>
          <p className="bands-tab-note" role="alert">
            {error}
          </p>
          <button type="button" className="live-launch bands-tab-button" onClick={load}>
            Try again
          </button>
        </>
      ) : !bands ? (
        <p className="bands-tab-note">Loading…</p>
      ) : bands.length === 0 ? (
        <p className="bands-tab-note">No bands yet. Make one, or scan a bandmate's code.</p>
      ) : (
        <ul className="song-list">
          {bands.map((band) => (
            <li key={band.bandId}>
              <button type="button" className="song-row" onClick={() => onOpen(band.bandId)}>
                <span className="song-title">{band.name}</span>
                <span className="song-artist">
                  {band.role === "admin" ? "Admin · " : ""}
                  {plural(band.members, "member")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="live-launch bands-tab-button" onClick={() => onOpen()}>
        + New band
      </button>
    </div>
  );
}
