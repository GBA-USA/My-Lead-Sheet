import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { BandSettings } from "./band-settings";
import type { BandPreview, BandSummary, BandView } from "./bands-model";
import { CODE_REFUSED, CODE_SCREEN, codeInText, readPayload } from "./code-link";
import { ScanCode, ShowCode } from "./codes";
import { ApiError, api, type Account } from "./sign-in-methods";
import "./friends.css";

type InBand = "band" | "invite" | "settings";
type View = { name: "list" } | { name: InBand; bandId: string } | { name: "scan" } | { name: "code"; code: string };

const MESSAGES: Record<string, string> = {
  ...CODE_REFUSED,
  offline: "Can't reach the server. Check your connection and try again.",
  "bad-name": "Give the band a name of up to 40 letters.",
  "not-a-band-code": "That isn't a band code.",
  "not-a-member": "You're not in this band any more.",
  "no-band": "This band isn't there any more.",
  "not-admin": "Only a band admin can do that.",
  "last-admin": "Make someone else admin first.",
};

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Bands: your bands, New band, joining by a scanned code or link, and each band's members, Invite and Band settings. `code` is a band code to open first. */
export function BandsSheet({ account, code, onSignedOut, onClose }: { account: Account; code?: string; onSignedOut: () => void; onClose: () => void }) {
  const titleId = useId();
  const nameId = useId();
  const linkId = useId();
  const [view, setView] = useState<View>(code ? { name: "code", code } : { name: "list" });
  const [bands, setBands] = useState<BandSummary[] | null>(null);
  const [band, setBand] = useState<BandView | null>(null);
  const [preview, setPreview] = useState<BandPreview | null>(null);
  const [newName, setNewName] = useState("");
  const [link, setLink] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inviteRound, setInviteRound] = useState(0);
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
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
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

  useEffect(() => {
    if (view.name === "list") api<{ bands: BandSummary[] }>("/api/bands").then((reply) => setBands(reply.bands), failed);
    if (view.name === "band" || view.name === "invite" || view.name === "settings") api<BandView>("/api/bands/open", { bandId: view.bandId }).then(setBand, failed);
    if (view.name === "code") {
      setPreview(null);
      api<BandPreview>("/api/bands/code", { code: view.code }).then(setPreview, failed);
    }
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const change = (path: string, body: object, done?: string) =>
    run(async () => {
      setBand(await api<BandView>(path, body));
      if (done) setNotice(done);
    });

  const opened = (payload: string) => {
    const fields = readPayload(payload);
    if (fields && CODE_SCREEN[fields.kind] === "bands") go({ name: "code", code: payload });
    else setError("That isn't a band code.");
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
    else setError("That link isn't a My Lead Sheet code.");
  };

  const shown = band && "bandId" in view && band.bandId === view.bandId ? band : null;
  const isAdmin = shown?.role === "admin";

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
            </div>
          ) : null}
          <h3 className="account-section">Members</h3>
          <ul className="friends-list bands-members">
            {shown.members.map((member) => (
              <li key={member.userId}>
                <span>
                  {member.name}
                  {member.role === "admin" ? <small>Admin</small> : null}
                </span>
                {isAdmin && member.userId !== account.userId ? (
                  <span className="friends-actions">
                    {member.role === "member" ? (
                      <button type="button" className="account-link" disabled={busy} onClick={() => change("/api/bands/make-admin", { bandId: shown.bandId, userId: member.userId }, `${member.name} is now an admin.`)}>
                        Make admin
                      </button>
                    ) : null}
                    {confirming === member.userId ? (
                      <button type="button" className="account-secondary" disabled={busy} onClick={() => change("/api/bands/remove", { bandId: shown.bandId, userId: member.userId }, `Removed ${member.name}.`)}>
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
      <section className="account-sheet bands-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-view={view.name} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>{screen.title}</h2>
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
