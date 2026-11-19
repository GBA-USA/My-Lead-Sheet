import { Fragment, useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { BackupResult } from "./backup";
import { APP_NAME, PRIVACY_HREF } from "./data-kinds";
import { handleFromName } from "./handle";
import { useEscape } from "./hooks";
import { commonPasswords, MIN_PASSWORD_LENGTH, passwordProblem } from "./password";
import { clearPhone } from "./phone-db";
import {
  ApiError,
  SIGN_IN_METHODS,
  api,
  createWithPassword,
  setPassword,
  signInWithPassword,
  WrongAddress,
  type Account,
  type Action,
  type AuthConfig,
  type SignedIn,
} from "./sign-in-methods";
import "./account.css";

type Step =
  | { name: "loading" }
  | { name: "start" }
  | { name: "create" }
  | { name: "forgot"; back: "start" | "password" }
  | { name: "nudge" }
  | { name: "account" }
  | { name: "password" }
  | { name: "make-password" }
  | { name: "set-password" };

/** The word the Worker put in `?google=` when it sent the phone back from Google, or null. */
export const googleReturn = () => new URLSearchParams(window.location.search).get("google");

/** The id of the account this phone signed in to. Older builds kept "1", which names no account. */
const SIGNED_IN_KEY = "leadSheetsSignedIn";
const UNNAMED = "1";

/** Whose data on this phone the app shows: an account id, null signed out, or undefined while signed in to an account the phone cannot name yet. */
export type Owner = string | null | undefined;

const signedInMark = () => {
  try {
    return localStorage.getItem(SIGNED_IN_KEY);
  } catch {
    return null;
  }
};

/**
 * The signed-in account. Only a phone that signed in before asks the server on load, so signed-out use calls no API.
 * Each time the phone learns it is signed out, band data leaves with the account (PLAN.md 10), even on a launch whose
 * session had already ended. A launch with no answer, such as one with no signal, keeps it, and `owner` still names
 * the account from the mark, so its changes on this phone stay its own.
 */
export function useAccount(): { account: Account | null; setAccount: (account: Account | null) => void; checking: boolean; owner: Owner } {
  const [account, setAccount] = useState<Account | null>(null);
  const [mark, setMark] = useState(signedInMark);
  const [checking, setChecking] = useState(mark !== null);
  const remember = useCallback((next: Account | null) => {
    setAccount(next);
    setMark(next?.userId ?? null);
    if (!next) clearPhone().catch(() => {});
    try {
      if (next) localStorage.setItem(SIGNED_IN_KEY, next.userId);
      else localStorage.removeItem(SIGNED_IN_KEY);
    } catch {}
  }, []);
  useEffect(() => {
    if (!checking) return;
    api<SignedIn>("/api/me")
      .then(
        (reply) => remember(reply.account),
        (error) => error instanceof ApiError && error.status === 401 && remember(null),
      )
      .finally(() => setChecking(false));
  }, []);
  const owner = account ? account.userId : mark === UNNAMED ? undefined : mark;
  return { account, setAccount: remember, checking, owner };
}

const MESSAGES: Record<string, string> = {
  NotAllowedError: `Face ID or fingerprint didn't finish. Try again. If it keeps failing, open ${APP_NAME} in Safari or Chrome.`,
  InvalidStateError: "This phone is already a way into your account.",
  offline: "Can't reach the server. Check your connection and try again.",
  "not-configured": "Sign-in isn't set up on this server yet.",
  "unknown-passkey": "That passkey isn't on an account here. Create an account, or sign in another way you set up.",
  "last-way": "This is your only way to sign in. Add another way first.",
  "challenge-expired": "That took too long. Try again.",
  "signed-out": "You're signed out. Sign in again.",
  "bad-name": "Type the name your bandmates know you by.",
  "wrong-password": "That @name and password don't match. Check both and try again.",
  "handle-taken": "That @name is taken. Pick another.",
  "bad-handle": "Your @name is 3 to 20 letters or numbers.",
  "google-taken": "That Google account already signs in to another account here.",
  "google-cancelled": "Google sign-in was cancelled.",
  "wrong-state": "Google sign-in didn't finish. Try again.",
  "google-refused": "Google sign-in didn't finish. Try again.",
  "wrong-origin": `Sign-in only works at ${APP_NAME}'s main address. Open that address and try again.`,
};

const minutes = (ms: number) => {
  const count = Math.max(1, Math.ceil(ms / 60000));
  return `${count} minute${count === 1 ? "" : "s"}`;
};

const message = (error: unknown): ReactNode => {
  if (error instanceof WrongAddress) {
    const main = new URL(location.href);
    main.protocol = "https:";
    main.hostname = error.host;
    main.port = "";
    main.search = "";
    return (
      <>
        Open <a href={main.href}>{error.host}</a> to use Face ID or fingerprint.
      </>
    );
  }
  if (error instanceof ApiError && error.reason === "wait") return `Too many wrong tries. Try again in ${minutes(error.waitMs)}.`;
  const key = error instanceof ApiError ? (error.status >= 500 && error.reason !== "not-configured" ? "offline" : error.reason) : error instanceof DOMException ? error.name : "";
  const text = MESSAGES[key] ?? "Something went wrong. Try again.";
  return error instanceof ApiError && error.waitMs > 0 ? `${text} Wait ${minutes(error.waitMs)} before the next try.` : text;
};

const BACKUP_PROBLEM = { offline: "can't reach the server", full: "your backup is full", failed: "the backup didn't go through" } as const;

export const backupLine = (backup: BackupResult | null) => {
  if (backup?.ok && backup.at) {
    const when = new Date(backup.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const held = backup.heldBack === 0 ? "" : ` · ${backup.heldBack} ${backup.heldBack === 1 ? "item" : "items"} not backed up`;
    return `Backed up · ${when}${held}`;
  }
  if (backup && !backup.ok) return `Not backed up · ${BACKUP_PROBLEM[backup.problem ?? "failed"]}`;
  return "Backing up this phone…";
};

/** A new account with no password ends on the nudge to add one when this server offers passwords. With no backup codes, a lost phone is otherwise a lost account. */
const afterCreate = (account: Account, config: AuthConfig | null): Step =>
  config?.password && !account.ways.some((way) => way.kind === "password") ? { name: "nudge" } : { name: "account" };

const added = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** `invite` says what signing in will do for a link that is waiting. Once signed in, the sheet closes itself so the link can finish. */
export function AccountSheet({
  account,
  backup,
  invite,
  onAccount,
  onClose,
}: {
  account: Account | null;
  backup: BackupResult | null;
  invite?: string;
  onAccount: (account: Account | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const handleId = useId();
  const secretId = useId();
  const [step, setStep] = useState<Step>(account ? { name: "account" } : { name: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [secret, setSecret] = useState("");
  const [config, setConfig] = useState<AuthConfig>({ google: false, password: false });
  const [returned] = useState(googleReturn);

  useEffect(() => {
    if (returned === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("google");
    history.replaceState(history.state, "", url);
  }, [returned]);

  useEffect(() => {
    let live = true;
    const configured = api<AuthConfig>("/api/auth/config").then(
      (reply) => {
        if (live) setConfig(reply);
        return reply;
      },
      () => null,
    );
    api<SignedIn>("/api/me").then(
      async (reply) => {
        if (!live) return;
        onAccount(reply.account);
        if (returned === "new") {
          const offered = await configured;
          if (live) setStep(afterCreate(reply.account, offered));
          return;
        }
        setStep({ name: "account" });
        if (returned !== null && returned !== "in" && returned !== "linked") setError(message(new ApiError(returned)));
      },
      (caught) => {
        if (!live) return;
        const signedOut = caught instanceof ApiError && caught.status === 401;
        if (signedOut) onAccount(null);
        setStep((current) => (current.name === "loading" || (signedOut && current.name === "account") ? { name: "start" } : current));
        if (returned !== null) setError(message(new ApiError(returned)));
      },
    );
    return () => {
      live = false;
    };
  }, [onAccount, returned]);

  useEscape(onClose);

  useEffect(() => {
    if (invite && account && step.name === "account") onClose();
  }, [invite, account, step.name]);

  const go = (next: Step) => {
    setError("");
    setSecret("");
    if (next.name === "make-password") setHandle((current) => current || handleFromName(name));
    setStep(next);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ApiError && caught.reason === "signed-out") {
        onAccount(null);
        setStep({ name: "start" });
      }
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = (reply: SignedIn, created = false) => {
    onAccount(reply.account);
    go(created ? afterCreate(reply.account, config) : { name: "account" });
  };

  const create = (action: Action<[displayName: string]>, displayName: string) =>
    typeof action === "string" ? go({ name: action }) : run(async () => signedIn(await action(displayName), true));

  const signOut = (path: string) =>
    run(async () => {
      await api(path, {});
      onAccount(null);
      go({ name: "start" });
    });

  const act = <Args extends unknown[]>(action: Action<Args>, ...args: Args) =>
    typeof action === "string" ? go({ name: action }) : run(async () => signedIn(await action(...args)));

  const offered = SIGN_IN_METHODS.filter((method) => method.offered(config));
  const usable = offered.filter((method) => method.works());
  const blocked = offered.filter((method) => !method.works());
  const browserNote = blocked.length ? (
    <p className="account-note" role="note">
      This browser can't use {blocked.map((method) => `${method.wayLabel} sign-in`).join(" or ")}. Open {APP_NAME} in Safari or Chrome.
    </p>
  ) : null;

  const newPasswordOk = async () => {
    const problem = passwordProblem(secret, await commonPasswords());
    if (problem) setError(problem);
    return !problem;
  };

  const secretField = (label: string, autoComplete: string) => (
    <>
      <label className="account-field" htmlFor={secretId}>
        {label}
      </label>
      <input id={secretId} className="account-input" type="password" autoComplete={autoComplete} value={secret} onChange={(event) => setSecret(event.target.value)} />
    </>
  );

  const handleField = (label: string) => (
    <>
      <label className="account-field" htmlFor={handleId}>
        {label}
      </label>
      <input id={handleId} className="account-input" autoCapitalize="none" autoComplete="username" value={handle} onChange={(event) => setHandle(event.target.value)} />
    </>
  );

  const screens: Record<Step["name"], () => { title: string; body: ReactNode }> = {
    loading: () => ({ title: "Sign in", body: <p className="account-note">Checking…</p> }),

    start: () => ({
      title: "Sign in",
      body: (
        <>
          {browserNote}
          {usable.map((method) => (
            <Fragment key={method.kind}>
              <button type="button" className="account-primary" disabled={busy} onClick={() => act(method.signIn)}>
                {method.label}
              </button>
              {method.note ? <p className="account-note">{method.note}</p> : null}
            </Fragment>
          ))}
          <button type="button" className="account-secondary" onClick={() => go({ name: "create" })}>
            New here? Create an account
          </button>
          <button type="button" className="account-link" onClick={() => go({ name: "forgot", back: "start" })}>
            Forgot your login?
          </button>
        </>
      ),
    }),

    create: () => {
      const typed = name.trim();
      return {
        title: "Create an account",
        body: (
          <>
            <label className="account-field" htmlFor={nameId}>
              Your name (what bandmates see)
            </label>
            <input id={nameId} className="account-input" autoComplete="name" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
            {browserNote}
            {usable.map((method) => (
              <button key={method.kind} type="button" className="account-primary" disabled={busy || !typed} onClick={() => create(method.create, typed)}>
                {method.createLabel}
              </button>
            ))}
            <button type="button" className="account-link" onClick={() => go({ name: "start" })}>
              I already have an account
            </button>
          </>
        ),
      };
    },

    forgot: () => ({
      title: "Forgot your login?",
      body: (
        <>
          <p className="account-note">Password and login reset is coming. For now, sign in another way you set up, or create a new account.</p>
          <button type="button" className="account-link" onClick={() => go({ name: step.name === "forgot" ? step.back : "start" })}>
            Back
          </button>
        </>
      ),
    }),

    nudge: () => ({
      title: "Your account is ready",
      body: (
        <>
          <p className="account-note">Add a password too, so you can sign in on a new phone. If this phone is lost, a password is the way back in.</p>
          <button type="button" className="account-primary" onClick={() => go({ name: "set-password" })}>
            Add a password
          </button>
          <button type="button" className="account-link" onClick={() => go({ name: "account" })}>
            Not now
          </button>
        </>
      ),
    }),

    password: () => {
      const submit = (event: FormEvent) => {
        event.preventDefault();
        run(async () => signedIn(await signInWithPassword(handle, secret)));
      };
      return {
        title: "Sign in with a password",
        body: (
          <form className="account-form" onSubmit={submit}>
            {handleField("Your @name")}
            {secretField("Password", "current-password")}
            <button type="submit" className="account-primary" disabled={busy || !handle.trim() || !secret}>
              Sign in
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "forgot", back: "password" })}>
              Forgot your login?
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "start" })}>
              Back
            </button>
          </form>
        ),
      };
    },

    "make-password": () => {
      const submit = (event: FormEvent) => {
        event.preventDefault();
        run(async () => {
          if (await newPasswordOk()) signedIn(await createWithPassword(name.trim(), handle, secret), true);
        });
      };
      return {
        title: "Make a password",
        body: (
          <form className="account-form" onSubmit={submit}>
            {handleField("Username (your public @name)")}
            {secretField("Password", "new-password")}
            <p className="account-note">At least {MIN_PASSWORD_LENGTH} characters. Common passwords are turned down.</p>
            <button type="submit" className="account-primary" disabled={busy || !handle.trim() || !secret}>
              Make account
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "create" })}>
              Back
            </button>
          </form>
        ),
      };
    },

    "set-password": () => {
      const changing = !!account?.ways.some((way) => way.kind === "password");
      const submit = (event: FormEvent) => {
        event.preventDefault();
        run(async () => {
          if (await newPasswordOk()) signedIn(await setPassword(secret));
        });
      };
      return {
        title: changing ? "Change password" : "Add a password",
        body: (
          <form className="account-form" onSubmit={submit}>
            {account ? <p className="account-handle">@{account.handle}</p> : null}
            {secretField("New password", "new-password")}
            <p className="account-note">At least {MIN_PASSWORD_LENGTH} characters. This signs you out on your other phones.</p>
            <button type="submit" className="account-primary" disabled={busy || !secret}>
              Save password
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "account" })}>
              Back
            </button>
          </form>
        ),
      };
    },

    account: () => {
      if (!account) return screens.loading();
      const onlyOne = account.ways.length <= 1;
      return {
        title: account.displayName,
        body: (
          <>
            <p className="account-handle">@{account.handle}</p>
            <p className="account-note" role="status">
              {backupLine(backup)}
            </p>
            <h3 className="account-section">Ways to sign in</h3>
            <ul className="account-ways">
              {account.ways.map((way) => {
                const method = SIGN_IN_METHODS.find((item) => item.kind === way.kind);
                return (
                  <li key={way.id}>
                    <span>
                      {method?.wayLabel ?? way.kind}
                      {way.detail ? ` (${way.detail})` : null}
                      <small>Added {added(way.createdAt)}</small>
                    </span>
                    <button
                      type="button"
                      className="account-secondary"
                      disabled={busy || onlyOne || !method}
                      title={onlyOne ? "Add another way before you remove this one" : undefined}
                      onClick={() => method && run(async () => onAccount(await method.remove(way.id)))}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
            {browserNote}
            {usable.map((method) => {
              const label = method.addLabel(account.ways);
              return label ? (
                <button key={method.kind} type="button" className="account-secondary" disabled={busy} onClick={() => act(method.add)}>
                  {label}
                </button>
              ) : null;
            })}
            <div className="account-row">
              <button type="button" className="account-secondary" disabled={busy} onClick={() => signOut("/api/auth/sign-out")}>
                Sign out
              </button>
              <button type="button" className="account-secondary" disabled={busy} onClick={() => signOut("/api/auth/sign-out-everywhere")}>
                Sign out everywhere
              </button>
            </div>
          </>
        ),
      };
    },
  };

  const { title, body } = screens[step.name]();

  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-step={step.name} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {invite && !account ? <p className="account-note">{invite}</p> : null}
        {body}
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        <a className="account-privacy" href={PRIVACY_HREF}>
          Privacy: what we keep and why
        </a>
      </section>
    </div>
  );
}
