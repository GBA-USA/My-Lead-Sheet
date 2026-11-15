import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { CODE_REFUSED, CODE_SCREEN, readPayload } from "./code-link";
import { ScanCode, ShowCode } from "./codes";
import { ApiError, api, type Account } from "./sign-in-methods";
import "./friends.css";

type Person = { userId: string; handle: string; name: string };
type Lists = { friends: Person[]; requests: Person[] };
type Outcome = "requested" | "friends" | "already-friends";
type Preview = { kind: "friend-now" | "friend-link"; name: string; handle: string };

type View = { name: "list" } | { name: "show"; kind: "friend-now" | "friend-link" } | { name: "scan" } | { name: "code"; code: string };

const MESSAGES: Record<string, string> = {
  ...CODE_REFUSED,
  offline: "Can't reach the server. Check your connection and try again.",
  "no-such-handle": "No one has that @name. Check the spelling.",
  yourself: "That's your own code. Show it to a friend to scan.",
  "not-a-friend-code": "That isn't a friend code.",
};

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const OUTCOME: Record<Outcome, (name: string) => string> = {
  requested: (name) => `Request sent. ${name} needs to accept.`,
  friends: (name) => `You and ${name} are friends.`,
  "already-friends": (name) => `You're already friends with ${name}.`,
};

function PersonRow({ person, children }: { person: Person; children: ReactNode }) {
  return (
    <li>
      <span>
        {person.name}
        <small>@{person.handle}</small>
      </span>
      <span className="friends-actions">{children}</span>
    </li>
  );
}

/** Friends: the list, requests waiting, Add by @name, Show my code, Share link and Scan a code. `code` is a friend code to open first. */
export function FriendsSheet({ account, code, onSignedOut, onClose }: { account: Account; code?: string; onSignedOut: () => void; onClose: () => void }) {
  const titleId = useId();
  const handleId = useId();
  const [view, setView] = useState<View>(code ? { name: "code", code } : { name: "list" });
  const [lists, setLists] = useState<Lists | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [handle, setHandle] = useState("");
  const [blocking, setBlocking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
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
    }
  };

  useEffect(() => {
    setPreview(null);
    if (view.name === "list") api<Lists>("/api/friends").then(setLists, failed);
    if (view.name === "code") api<Preview>("/api/friends/code", { code: view.code }).then(setPreview, failed);
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (next: View) => {
    setError("");
    setNotice("");
    setView(next);
  };

  const act = (path: string, body: object) =>
    run(async () => {
      setLists(await api<Lists>(path, body));
      setBlocking(null);
    });

  const ask = (path: string, body: object, name: string) =>
    run(async () => {
      const reply = await api<Lists & { outcome: Outcome }>(path, body);
      setLists(reply);
      setView({ name: "list" });
      setNotice(OUTCOME[reply.outcome](name));
    });

  const scanned = (payload: string) => {
    const fields = readPayload(payload);
    if (fields && CODE_SCREEN[fields.kind] === "friends") go({ name: "code", code: payload });
    else setError("This code opens a part of My Lead Sheet that isn't in this version yet.");
  };

  const addByName = (event: FormEvent) => {
    event.preventDefault();
    const typed = handle.trim().replace(/^@/, "");
    ask("/api/friends/request", { handle: typed }, `@${typed}`);
    setHandle("");
  };

  const back = (
    <button type="button" className="account-link" onClick={() => go({ name: "list" })}>
      Back
    </button>
  );

  const screens: Record<View["name"], () => { title: string; body: ReactNode }> = {
    list: () => ({
      title: "Friends",
      body: (
        <>
          {lists && lists.requests.length > 0 ? (
            <>
              <h3 className="account-section">Requests</h3>
              <ul className="friends-list friends-requests">
                {lists.requests.map((person) => (
                  <PersonRow key={person.userId} person={person}>
                    <button type="button" className="account-primary" disabled={busy} onClick={() => act("/api/friends/accept", { userId: person.userId })}>
                      Accept
                    </button>
                    <button type="button" className="account-secondary" disabled={busy} onClick={() => act("/api/friends/decline", { userId: person.userId })}>
                      Decline
                    </button>
                    <button type="button" className="account-link" disabled={busy} onClick={() => act("/api/friends/block", { userId: person.userId })}>
                      Block
                    </button>
                  </PersonRow>
                ))}
              </ul>
            </>
          ) : null}
          <h3 className="account-section">Your friends</h3>
          {!lists ? (
            <p className="account-note">Loading…</p>
          ) : lists.friends.length === 0 ? (
            <p className="account-note">No friends yet. Show your code, share a link, or add someone by @name.</p>
          ) : (
            <ul className="friends-list friends-friends">
              {lists.friends.map((person) => (
                <PersonRow key={person.userId} person={person}>
                  {blocking === person.userId ? (
                    <button type="button" className="account-secondary" disabled={busy} onClick={() => act("/api/friends/block", { userId: person.userId })}>
                      Yes, block
                    </button>
                  ) : (
                    <button type="button" className="account-link" onClick={() => setBlocking(person.userId)}>
                      Block
                    </button>
                  )}
                </PersonRow>
              ))}
            </ul>
          )}
          <form className="account-form" onSubmit={addByName}>
            <label className="account-field" htmlFor={handleId}>
              Add by @name
            </label>
            <input id={handleId} className="account-input" autoCapitalize="none" autoComplete="off" value={handle} onChange={(event) => setHandle(event.target.value)} />
            <button type="submit" className="account-secondary" disabled={busy || !handle.trim().replace(/^@/, "")}>
              Send request
            </button>
          </form>
          <div className="account-row">
            <button type="button" className="account-secondary" onClick={() => go({ name: "show", kind: "friend-now" })}>
              Show my code
            </button>
            <button type="button" className="account-secondary" onClick={() => go({ name: "show", kind: "friend-link" })}>
              Share link
            </button>
          </div>
          <button type="button" className="account-primary" onClick={() => go({ name: "scan" })}>
            Scan a code
          </button>
        </>
      ),
    }),

    show: () => {
      const kind = view.name === "show" ? view.kind : "friend-now";
      const stopped = () => {
        go({ name: "list" });
        setNotice("Code stopped. Nobody can use it now.");
      };
      return {
        title: kind === "friend-now" ? "Show my code" : "Share link",
        body: (
          <>
            <ShowCode key={kind} request={{ kind }} words={`Add ${account.displayName} as a friend`} share={kind === "friend-link" ? true : undefined} onStopped={stopped} onError={failed} />
            <p className="account-note">{kind === "friend-now" ? "Whoever scans this sends you a request to accept." : "Whoever opens this link becomes your friend. Stop this code to end it."}</p>
            {back}
          </>
        ),
      };
    },

    scan: () => ({
      title: "Scan a code",
      body: (
        <>
          <ScanCode onCode={scanned} />
          {back}
        </>
      ),
    }),

    code: () => ({
      title: "Add a friend",
      body: preview ? (
        <>
          <p className="codes-words">
            {preview.name} <small>@{preview.handle}</small>
          </p>
          <p className="account-note">{preview.kind === "friend-now" ? `${preview.name} gets a request to accept.` : `${preview.name} shared this link, so you'll be friends right away.`}</p>
          <button type="button" className="account-primary" disabled={busy} onClick={() => view.name === "code" && ask("/api/friends/add-by-code", { code: view.code }, preview.name)}>
            {preview.kind === "friend-now" ? "Send request" : "Add friend"}
          </button>
          {back}
        </>
      ) : (
        <>
          {error ? null : <p className="account-note">Checking the code…</p>}
          {back}
        </>
      ),
    }),
  };

  const screen = screens[view.name]();
  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet friends-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-view={view.name} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>{screen.title}</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {notice ? (
          <p className="account-note friends-notice" role="status">
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
