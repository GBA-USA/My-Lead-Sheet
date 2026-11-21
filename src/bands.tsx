import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BandLibraryTab, LIBRARY_MESSAGES, plural } from "./band-library";
import type { BandLibrary, BandSetlist } from "./band-library-model";
import { BandSetlistView, dropSetlists, holdSetlists } from "./band-setlist-view";
import { BandSettings } from "./band-settings";
import type { BandPreview, BandSummary, BandView } from "./bands-model";
import type { Inbox } from "./chat";
import { unread } from "./chat-model";
import { CODE_REFUSED, readPayload, type CodeKind } from "./code-link";
import { ScanCode, ShowCode, shareLink, useCode } from "./codes";
import { downloadPack, packsOnPhone, type GigPack } from "./gig-pack";
import { GigCard, GigPlanForm, newGigId } from "./gig-plan";
import type { GigDraft, GigView } from "./gig-plan-model";
import { useCloseOnSong, useEscape } from "./hooks";
import { NextGigCard, nextGig } from "./next-gig-card";
import { allOnPhone, clearBand, heldFor, holdBandSongs, keepBandsOnPhone, type CachedBandSong } from "./phone-db";
import { Room } from "./room";
import { BAND_SECTIONS, bandHref, bandPlanHref, bandSongHref, gigHref, sectionOf, type BandSection } from "./route";
import { SETLIST_CODE_MESSAGES } from "./setlist-code";
import { ApiError, api } from "./sign-in-methods";
import "./friends.css";

/** Where a sheet sends the player once a code or a new band leads to a band: the section, a notice, a setlist to mark. */
export type BandLanding = { bandId: string; section?: BandSection; notice?: string; setlistId?: string };

/** A `tapped` band code came in on a link and joins at once. A scanned one shows the band and asks first. */
type SheetView = { name: "list" } | { name: "scan" } | { name: "code"; code: string; tapped: boolean } | { name: "gig-code"; code: string } | { name: "setlist-code"; code: string };

type PageView = { name: "band" } | { name: "invite" } | { name: "settings" } | { name: "setlist"; setlistId: string };

const SECTION_LABELS: Record<BandSection, string> = { songs: "Songs", setlists: "Setlists", chat: "Chat", gigs: "Gigs", members: "Members" };

const OFFLINE = "Can't reach the server. Check your connection and try again.";

const MESSAGES: Record<string, string> = {
  ...CODE_REFUSED,
  ...LIBRARY_MESSAGES,
  offline: OFFLINE,
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

/** What a member who isn't an admin sees on Invite and Show as QR, with no request to the server. */
const ASK_AN_ADMIN = `${MESSAGES["not-admin"]} Ask an admin to send you the link.`;

const PACK_OFFLINE = "Can't download now · try on Wi-Fi";

const unreachable = (error: unknown) => error instanceof ApiError && (error.reason === "offline" || error.status >= 500);

const CODE_VIEWS: Partial<Record<CodeKind, (code: string, tapped: boolean) => SheetView>> = {
  band: (code, tapped) => ({ name: "code", code, tapped }),
  gig: (code) => ({ name: "gig-code", code }),
  "band-setlist": (code) => ({ name: "setlist-code", code }),
};

const codeView = (code: string, tapped: boolean): SheetView | null => {
  const kind = readPayload(code)?.kind;
  return kind ? (CODE_VIEWS[kind]?.(code, tapped) ?? null) : null;
};

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/** The server's list of this account's bands. Songs of any other band leave the phone, so search stops finding them. */
const listed = (bands: BandSummary[]) => {
  keepBandsOnPhone(bands.map((band) => band.bandId)).catch(() => {});
  return bands;
};

function Status({ notice, error }: { notice: string; error: string }) {
  return (
    <>
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
    </>
  );
}

/**
 * The Bands sheet, for what comes before a band page: New band, Scan a code, and a band, gig or setlist code opened
 * from a link. `code` is the tapped code to open first. `onBand` goes to the band page the code or new band leads to.
 */
export function BandsSheet({
  code,
  onBand,
  onSetlistCopy,
  onSignedOut,
  onClose,
}: {
  code?: string;
  onBand: (landing: BandLanding) => void;
  onSetlistCopy: (code: string) => void;
  onSignedOut: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const [view, setView] = useState<SheetView>(() => (code ? (codeView(code, true) ?? { name: "list" }) : { name: "list" }));
  const [bands, setBands] = useState<BandSummary[] | null>(null);
  const [preview, setPreview] = useState<BandPreview | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const go = (next: SheetView) => {
    setError("");
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
    try {
      await work();
    } catch (caught) {
      failed(caught);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (view.name === "list") api<{ bands: BandSummary[] }>("/api/bands").then((reply) => setBands(listed(reply.bands)), failed);
    if (view.name === "code") {
      setPreview(null);
      let live = true;
      api<BandPreview>("/api/bands/code", { code: view.code }).then((found) => {
        if (!live) return;
        if (view.tapped) join(view.code, found);
        else setPreview(found);
      }, failed);
      return () => {
        live = false;
      };
    }
    if (view.name === "gig-code") api<GigView>("/api/bands/gig/code", { code: view.code }).then((opened) => onBand({ bandId: opened.gig.bandId, section: "gigs" }), failed);
    if (view.name === "setlist-code")
      api<{ bandId: string; setlistId: string }>("/api/bands/setlist-code", { code: view.code }).then((opened) => onBand({ bandId: opened.bandId, section: "setlists", setlistId: opened.setlistId }), failed);
  }, [view]);

  useEscape(onClose);
  useCloseOnSong(onClose);

  const join = (code: string, found: BandPreview) =>
    run(async () => {
      const joined = await api<BandView>("/api/bands/join", { code });
      onBand({ bandId: joined.bandId, notice: found.member ? `You're already in ${joined.name}.` : `You joined ${joined.name}.` });
    });

  const opened = (payload: string) => {
    const next = codeView(payload, false);
    if (next) go(next);
    else if (readPayload(payload)?.kind === "my-setlist") onSetlistCopy(payload);
    else setError("That isn't a band, gig or setlist code.");
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      const made = await api<BandView>("/api/bands/create", { name: newName });
      setNewName("");
      onBand({ bandId: made.bandId });
    });
  };

  const backToList = (
    <button type="button" className="account-link" onClick={() => go({ name: "list" })}>
      Back
    </button>
  );
  const waiting = (words: string) => (
    <>
      {error ? null : <p className="account-note">{words}</p>}
      {backToList}
    </>
  );

  const screens: Record<SheetView["name"], () => { title: string; body: ReactNode }> = {
    list: () => ({
      title: "Bands",
      body: (
        <>
          {!bands ? (
            <p className="account-note">Loading…</p>
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
                  <button type="button" className="account-secondary" onClick={() => onBand({ bandId: item.bandId })}>
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
          <button type="button" className="account-primary" onClick={() => go({ name: "scan" })}>
            Scan a code
          </button>
        </>
      ),
    }),
    "setlist-code": () => ({ title: "Setlist", body: waiting("Opening the setlist…") }),
    "gig-code": () => ({ title: "Gig", body: waiting("Opening the gig…") }),
    scan: () => ({
      title: "Scan a code",
      body: (
        <>
          <ScanCode onCode={opened} />
          {backToList}
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
          <button type="button" className="account-primary" disabled={busy} onClick={() => view.name === "code" && join(view.code, preview)}>
            {preview.member ? "Open band" : "Join"}
          </button>
          {backToList}
        </>
      ) : (
        waiting("Checking the code…")
      ),
    }),
  };

  const screen = screens[view.name]();
  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet bands-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-view={view.name} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>{screen.title}</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <Status notice="" error={error} />
        {screen.body}
      </section>
    </div>
  );
}

function SignInToBands({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="bands-tab">
      <p className="bands-tab-note">Sign in to see your bands.</p>
      <button type="button" className="live-launch bands-tab-button" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
}

/** `me` is the signed-in player, known from this phone while the server can't be reached; null when signed out. */
type PageProps = {
  me: string | null;
  bandId: string;
  section: BandSection | null;
  landing?: BandLanding;
  inbox: Inbox;
  onMessage: (userId: string) => Promise<void>;
  onSignIn: () => void;
  onSignedOut: () => void;
  onGone: (words: string) => void;
};

/**
 * One band's page at `#/band/:bandId`: Invite, the next gig, the status strip's slot, and the sections Songs, Setlists,
 * Chat, Gigs and Members, the open one kept in the hash. `onGone` lands on Bands with the words once the player is out.
 */
export function BandPage(props: PageProps) {
  return props.me ? <BandScreen {...props} me={props.me} /> : <SignInToBands onSignIn={props.onSignIn} />;
}

function BandScreen({ me, bandId, section: asked, landing, inbox, onMessage, onSignedOut, onGone }: PageProps & { me: string }) {
  const titleId = useId();
  const section = sectionOf(bandId, asked);
  const [view, setView] = useState<PageView>({ name: "band" });
  const [band, setBand] = useState<BandView | null>(null);
  const [library, setLibrary] = useState<BandLibrary | null>(null);
  const [gigs, setGigs] = useState<GigView[] | null>(null);
  const [packs, setPacks] = useState<Record<string, GigPack>>({});
  const [cached, setCached] = useState<CachedBandSong[] | null>(null);
  const [editing, setEditing] = useState<BandSetlist | undefined>(undefined);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inviteRound, setInviteRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(landing?.notice ?? "");
  const [error, setError] = useState("");
  const isAdmin = band?.role === "admin";
  /** Only an admin's phone asks for the invite code, since the server refuses anyone else. */
  const invite = useCode(isAdmin ? { kind: "band", bandId } : null);

  const toSection = (next: BandSection) => {
    setEditing(undefined);
    window.location.replace(bandHref(bandId, next));
  };

  const go = (next: PageView) => {
    setError("");
    setNotice("");
    setConfirming(null);
    setView(next);
  };

  const left = useRef(false);
  const gone = async (words: string) => {
    if (left.current) return;
    left.current = true;
    dropSetlists(me, bandId);
    await clearBand(bandId).catch(() => {});
    onGone(words);
  };

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
    if (caught instanceof ApiError && (caught.reason === "not-a-member" || caught.reason === "no-band")) return void gone(MESSAGES[caught.reason]);
    setError(message(caught));
  };

  /** With no signal the page shows the band songs and gig packs this phone holds, and the live sections say so. */
  const loaded = (caught: unknown) => {
    if (!unreachable(caught)) return failed(caught);
    const mine = heldFor(me) ? allOnPhone("bandSongs") : Promise.resolve([]);
    mine.then((all) => setCached(all.filter((item) => item.bandId === bandId)), () => setCached([]));
    if (heldFor(me)) allOnPhone("gigPacks").then((all) => setPacks(Object.fromEntries(all.filter((pack) => pack.gig.bandId === bandId).map((pack) => [pack.gig.gigId, pack]))), () => {});
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

  const reloadLibrary = async () => {
    const next = await api<BandLibrary>("/api/bands/library", { bandId });
    setLibrary(next);
    holdSetlists(me, bandId, next);
    return next;
  };

  /** The band's gigs and the packs this phone holds for them, set together so a card never pairs a gig with a pack it lacks. */
  const loadGigs = async () => {
    const { gigs: list } = await api<{ gigs: GigView[] }>("/api/bands/gig/list", { bandId });
    setPacks(await packsOnPhone(me, list.map((item) => item.gig.gigId)));
    setGigs(list);
  };

  useEffect(() => {
    if (asked === null) window.location.replace(bandHref(bandId, section));
  }, [asked]);

  useEffect(() => {
    reloadLibrary().catch(loaded);
    loadGigs().catch(loaded);
  }, []);

  /** The band as it is now, each time the page comes back from Invite, settings or a form, so Members shows who joined meanwhile. */
  useEffect(() => {
    if (view.name === "band") api<BandView>("/api/bands/open", { bandId }).then(setBand, loaded);
  }, [view.name]);

  useEffect(() => {
    if (band && library) holdBandSongs(me, bandId, band.name, library.songs).catch(() => {});
  }, [band?.name, library]);

  /** A lineup phone fetches a pack it lacks, or one older than the plan, as soon as it sees the gig. A failure waits for Get ready. */
  useEffect(() => {
    for (const item of gigs ?? []) {
      if (!item.gig.lineup.includes(me) || (packs[item.gig.gigId]?.packRev ?? 0) >= item.packRev) continue;
      downloadPack(me, bandId, item.gig.gigId).then(
        () => loadGigs(),
        () => {},
      );
    }
  }, [gigs]);

  const getReady = (item: GigView) =>
    run(async () => {
      try {
        const pack = await downloadPack(me, bandId, item.gig.gigId);
        setPacks((held) => ({ ...held, [pack.gig.gigId]: pack }));
      } catch (caught) {
        if (!unreachable(caught)) throw caught;
        return setError(PACK_OFFLINE);
      }
      await loadGigs();
    });

  const planFrom = (setlistId: string | null) => (window.location.hash = bandPlanHref(bandId, newGigId(), setlistId));

  const planFromTop = (setlistId?: string) =>
    run(async () => {
      if (setlistId || (library ?? (await reloadLibrary())).setlists.length === 0) return void planFrom(setlistId ?? null);
      toSection("setlists");
      setNotice("Pick a setlist below, then tap Plan a gig.");
    });

  const change = (path: string, body: object, done?: string) =>
    run(async () => {
      setBand(await api<BandView>(path, body));
      if (done) setNotice(done);
    });

  const shareInvite = () => {
    setError("");
    setNotice("");
    if (!isAdmin) return setError(band ? ASK_AN_ADMIN : OFFLINE);
    if (!invite.shown) {
      setError(invite.problem ? message(invite.problem) : "Making the link. Try again in a moment.");
      return invite.retry();
    }
    shareLink(invite.shown.link, `Join ${band?.name ?? "the band"}`).then((copied) => copied && setNotice("Link copied"));
  };

  const name = band?.name ?? cached?.[0]?.bandName ?? "Band";
  const chatEntry = inbox.chats?.find((c) => c.roomId === bandId);
  const loading = <p className="account-note">Loading…</p>;
  const cannotReach = <p className="account-note">{OFFLINE}</p>;
  const backToBand = (
    <button type="button" className="account-link" onClick={() => go({ name: "band" })}>
      Back
    </button>
  );

  const gigCards = (shown: BandView, list: GigView[]) =>
    list.map((item) => (
      <GigCard
        key={item.gig.gigId}
        view={item}
        band={shown}
        me={me}
        pack={packs[item.gig.gigId]}
        busy={busy}
        library={library}
        onGetReady={() => getReady(item)}
        onSong={(index) => (window.location.hash = gigHref(bandId, item.gig.gigId, index))}
      />
    ));

  const members = (shown: BandView) => (
    <>
      <ul className="friends-list bands-members">
        {shown.members.map((member) => (
          <li key={member.userId}>
            <span>
              {member.name}
              {member.role === "admin" ? <small>Admin</small> : null}
            </span>
            {member.userId !== me ? (
              <button type="button" className="account-link" disabled={busy} onClick={() => run(() => onMessage(member.userId))}>
                Message
              </button>
            ) : null}
            {isAdmin && member.userId !== me ? (
              <span className="friends-actions">
                {member.role === "member" ? (
                  <button type="button" className="account-link" disabled={busy} onClick={() => change("/api/bands/make-admin", { bandId, userId: member.userId }, `${member.name} is now an admin.`)}>
                    Make admin
                  </button>
                ) : null}
                {confirming === member.userId ? (
                  <button type="button" className="account-secondary" disabled={busy} onClick={() => change("/api/bands/remove", { bandId, userId: member.userId }, `Removed ${member.name}.`)}>
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
      {isAdmin ? (
        <button type="button" className="account-secondary" onClick={() => go({ name: "settings" })}>
          Band settings
        </button>
      ) : null}
      {confirming === "leave" ? (
        <button
          type="button"
          className="account-secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api("/api/bands/leave", { bandId });
              await gone(`You left ${shown.name}.`);
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
  );

  const libraryTab = (shown: BandView, tab: "songs" | "setlists") => (
    <BandLibraryTab
      band={shown}
      me={me}
      tab={tab}
      library={library}
      reload={() => reloadLibrary().then(() => {})}
      busy={busy}
      run={run}
      notify={setNotice}
      onOpenSong={(item) => (window.location.hash = bandSongHref(bandId, item.songId))}
      onOpenSetlist={(setlist) => go({ name: "setlist", setlistId: setlist.setlistId })}
      onPlanGig={isAdmin ? (setlist) => planFrom(setlist.setlistId) : undefined}
      landed={landing?.setlistId}
      editing={editing}
      onError={failed}
    />
  );

  const offlineSongs = (
    <>
      {cannotReach}
      {cached && cached.length > 0 ? (
        <ul className="friends-list band-library-songs">
          {cached.map((item) => (
            <li key={item.songId}>
              <button type="button" className="band-library-row" onClick={() => (window.location.hash = bandSongHref(bandId, item.songId))}>
                <span className="band-library-name">{item.song.title}</span>
                <small>{item.song.artist}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="account-note">No songs of this band are on this phone.</p>
      )}
    </>
  );

  const sections: Record<BandSection, () => ReactNode> = {
    songs: () => (band ? libraryTab(band, "songs") : offlineSongs),
    setlists: () => (band ? libraryTab(band, "setlists") : cannotReach),
    chat: () =>
      inbox.chats === null && !inbox.failed ? (
        loading
      ) : (
        <>
          {!band && cached ? cannotReach : null}
          <Room me={me} roomId={bandId} entry={chatEntry} inline onEntry={inbox.change} onGone={failed} onSignedOut={onSignedOut} />
        </>
      ),
    gigs: () =>
      !band || !gigs ? (
        cached ? cannotReach : loading
      ) : (
        <>
          {gigs.length === 0 ? <p className="account-note">No gigs planned yet.</p> : gigCards(band, gigs)}
          {isAdmin ? (
            <button type="button" className="account-secondary" disabled={busy} onClick={() => planFromTop()}>
              Plan a gig
            </button>
          ) : null}
        </>
      ),
    members: () => (band ? members(band) : cannotReach),
  };

  const badge = chatEntry && section !== "chat" ? unread(chatEntry) : 0;
  /** The gigs this phone can run with no signal: every pack it holds for this band whose gig is not over. */
  const held = Object.values(packs).filter((pack) => pack.gig.bandId === bandId && pack.gig.status !== "ended");

  const bodies: Record<PageView["name"], () => ReactNode> = {
    band: () => (
      <>
        {band && gigs ? (
          <NextGigCard band={band} me={me} gigs={gigs} packs={packs} library={library} busy={busy} onStart={(id) => (window.location.hash = gigHref(bandId, id))} onOpen={() => toSection("gigs")} onPlan={planFromTop} />
        ) : held.length > 0 ? (
          <section className="next-gig" aria-label="Gigs on this phone">
            {held.map((pack) => (
              <button key={pack.gig.gigId} type="button" className="account-primary" onClick={() => (window.location.hash = gigHref(bandId, pack.gig.gigId))}>
                Open {pack.gig.name}
              </button>
            ))}
          </section>
        ) : null}
        <div className="band-status-slot" />
        <div className="band-tabs" role="tablist" aria-label={name}>
          {BAND_SECTIONS.map((key) => (
            <span key={key} role="tab" aria-selected={section === key}>
              <button type="button" onClick={() => toSection(key)}>
                {SECTION_LABELS[key]}
              </button>
              {key === "chat" && badge > 0 ? <span className="chat-badge">{badge}</span> : null}
            </span>
          ))}
        </div>
        {sections[section]()}
      </>
    ),
    invite: () =>
      band && !isAdmin ? (
        <>
          <p className="account-note">{ASK_AN_ADMIN}</p>
          {backToBand}
        </>
      ) : band ? (
        <>
          <ShowCode
            key={inviteRound}
            request={{ kind: "band", bandId }}
            words={`Join ${band.name}`}
            share
            onStopped={() => {
              invite.retry();
              go({ name: "band" });
              setNotice("Code stopped. Nobody can use it now.");
            }}
            onError={failed}
          />
          <p className="account-note">Whoever scans this or opens the link can join after they sign in.</p>
          {isAdmin ? (
            <button
              type="button"
              className="account-secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("/api/bands/reset-link", { bandId });
                  invite.retry();
                  setInviteRound((round) => round + 1);
                  setNotice("Link reset. Old codes and links don't work any more.");
                })
              }
            >
              Reset link
            </button>
          ) : null}
          {backToBand}
        </>
      ) : (
        <>
          {cannotReach}
          {backToBand}
        </>
      ),
    settings: () =>
      band ? (
        <>
          <BandSettings band={band} busy={busy || !isAdmin} onScrollWithLeader={(on) => change("/api/bands/settings", { bandId, scrollWithLeader: on })} />
          {backToBand}
        </>
      ) : (
        loading
      ),
    setlist: () => {
      const setlist = view.name === "setlist" ? library?.setlists.find((item) => item.setlistId === view.setlistId) : undefined;
      if (!band || !library || !setlist) return library ? <p className="account-note">That isn't in the band any more.</p> : loading;
      return (
        <BandSetlistView
          bandId={bandId}
          bandName={band.name}
          setlist={setlist}
          songs={library.songs}
          packs={packs}
          gig={nextGig((gigs ?? []).filter((item) => item.gig.setlistId === setlist.setlistId))}
          busy={busy}
          onDownload={getReady}
          onBack={() => go({ name: "band" })}
          onEdit={
            isAdmin || setlist.sharedBy === me
              ? () => {
                  go({ name: "band" });
                  window.location.replace(bandHref(bandId, "setlists"));
                  setEditing({ ...setlist });
                }
              : undefined
          }
          onPlan={isAdmin ? () => planFrom(setlist.setlistId) : undefined}
          onCodeError={failed}
        />
      );
    },
  };

  if (!band && !cached) {
    return (
      <section className="band-page" data-band={bandId} data-view={view.name}>
        <Status notice={notice} error={error} />
        {loading}
      </section>
    );
  }
  return (
    <section className="band-page" data-band={bandId} data-view={view.name} aria-labelledby={titleId}>
      <header className="band-page-top">
        <h2 id={titleId}>{name}</h2>
        <span className="band-invite">
          <button type="button" className="account-primary" onClick={shareInvite}>
            Invite
          </button>
          <button type="button" className="account-link" onClick={() => go({ name: "invite" })}>
            Show as QR
          </button>
        </span>
      </header>
      <Status notice={notice} error={error} />
      {bodies[view.name]()}
    </section>
  );
}

type PlanProps = {
  me: string | null;
  bandId: string;
  gigId: string;
  setlistId: string | null;
  onSignIn: () => void;
  onSignedOut: () => void;
  onDone: (landing: BandLanding) => void;
};

/**
 * Plan gig at `#/band/:bandId/plan/:gigId?setlist=:setlistId`: the band read from the server on open, so a reload or a
 * link renders it, and the form for an admin. The gig id comes from the route, so a second Send after a lost reply
 * finds the gig already made. `onDone` returns to the band page, with the notice once the band has the gig.
 */
export function PlanGigScreen(props: PlanProps) {
  return props.me ? <PlanGig {...props} me={props.me} /> : <SignInToBands onSignIn={props.onSignIn} />;
}

function PlanGig({ me, bandId, gigId, setlistId, onSignedOut, onDone }: PlanProps & { me: string }) {
  const titleId = useId();
  const [loaded, setLoaded] = useState<{ band: BandView; library: BandLibrary } | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refused = (caught: unknown) => (caught instanceof ApiError && caught.status === 401 ? onSignedOut() : setProblem(caught));

  useEffect(() => {
    setProblem(null);
    Promise.all([api<BandView>("/api/bands/open", { bandId }), api<BandLibrary>("/api/bands/library", { bandId })]).then(([band, library]) => setLoaded({ band, library }), refused);
  }, [round]);

  const send = (draft: GigDraft) => {
    setBusy(true);
    setError("");
    api<GigView>("/api/bands/gig/plan", { bandId, setlistId, gigId, ...draft }).then(
      (made) => onDone({ bandId, section: "gigs", notice: `Sent ${made.gig.name} to the band.` }),
      (caught) => {
        setBusy(false);
        if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
        setError(message(caught));
      },
    );
  };

  const back = (
    <button type="button" className="account-link" onClick={() => onDone({ bandId })}>
      Back to the band
    </button>
  );
  const stop = (words: string, action?: ReactNode) => (
    <>
      <p className="account-note" role="alert">
        {words}
      </p>
      {action}
      {back}
    </>
  );
  const toSetlists = (
    <button type="button" className="account-primary" onClick={() => onDone({ bandId, section: "setlists" })}>
      Go to Setlists
    </button>
  );

  const body = () => {
    if (problem)
      return unreachable(problem)
        ? stop(OFFLINE, <button type="button" className="account-secondary" onClick={() => setRound((n) => n + 1)}>Try again</button>)
        : stop(message(problem));
    if (!loaded) return <p className="account-note">Loading…</p>;
    const { band, library } = loaded;
    if (band.role !== "admin") return stop(MESSAGES["not-admin"]);
    if (!setlistId) return stop(library.setlists.length === 0 ? "Share a setlist first. Then tap Plan a gig on it." : "Pick a setlist in Setlists, then tap Plan a gig on it.", toSetlists);
    const setlist = library.setlists.find((item) => item.setlistId === setlistId);
    if (!setlist) return stop(MESSAGES["not-found"], toSetlists);
    return <GigPlanForm band={band} me={me} setlistName={setlist.name} busy={busy} onSend={send} onCancel={() => onDone({ bandId })} />;
  };

  return (
    <section className="band-page plan-gig" role="dialog" aria-labelledby={titleId} data-band={bandId} data-view="plan">
      <header className="band-page-top">
        <h2 id={titleId}>Plan gig</h2>
      </header>
      <Status notice="" error={error} />
      {body()}
    </section>
  );
}

const BANDS_REFRESH_MS = 10_000;

/**
 * The Bands tab: the player's bands, each opening its band page, and + New band for the sheet. The list keeps up with
 * bands joined or left on another phone while it is on screen. A refresh that fails keeps the list it has.
 */
export function BandsTab({ me, notice, onNew, onSignIn, onSignedOut }: { me: string | null; notice: string; onNew: () => void; onSignIn: () => void; onSignedOut: () => void }) {
  const [bands, setBands] = useState<BandSummary[] | null>(null);
  const [error, setError] = useState("");
  const load = (quiet = false) => {
    if (!quiet) setError("");
    api<{ bands: BandSummary[] }>("/api/bands").then(
      (reply) => {
        setError("");
        setBands(listed(reply.bands));
      },
      (caught) => (caught instanceof ApiError && caught.status === 401 ? onSignedOut() : quiet || setError(message(caught))),
    );
  };
  useEffect(() => {
    setBands(null);
    if (!me) return;
    load();
    const refresh = () => document.visibilityState === "visible" && load(true);
    const timer = setInterval(refresh, BANDS_REFRESH_MS);
    addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [me]);

  if (!me) return <SignInToBands onSignIn={onSignIn} />;
  return (
    <div className="bands-tab">
      <Status notice={notice} error="" />
      {error ? (
        <>
          <p className="bands-tab-note" role="alert">
            {error}
          </p>
          <button type="button" className="live-launch bands-tab-button" onClick={() => load()}>
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
              <button type="button" className="song-row" onClick={() => (window.location.hash = bandHref(band.bandId))}>
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
      <button type="button" className="live-launch bands-tab-button" onClick={onNew}>
        + New band
      </button>
    </div>
  );
}
