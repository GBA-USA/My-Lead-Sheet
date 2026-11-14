import { Fragment, useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { PRIVACY_HREF } from "./data-kinds";
import { commonPasswords, MIN_PASSWORD_LENGTH, passwordProblem } from "./password";
import {
  ApiError,
  SIGN_IN_METHODS,
  api,
  createWithPassword,
  setPassword,
  signInWithPassword,
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
  | { name: "backup-code" }
  | { name: "codes"; codes: string[] }
  | { name: "account" }
  | { name: "password" }
  | { name: "make-password" }
  | { name: "set-password"; reset?: true };

/** The word the Worker put in `?google=` when it sent the phone back from Google, or null. */
export const googleReturn = () => new URLSearchParams(window.location.search).get("google");

const SIGNED_IN_KEY = "leadSheetsSignedIn";

/** The signed-in account. Only a phone that signed in before asks the server on load, so signed-out use calls no API. */
export function useAccount(): { account: Account | null; setAccount: (account: Account | null) => void; checking: boolean } {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(() => {
    try {
      return localStorage.getItem(SIGNED_IN_KEY) !== null;
    } catch {
      return false;
    }
  });
  const remember = useCallback((next: Account | null) => {
    setAccount(next);
    try {
      if (next) localStorage.setItem(SIGNED_IN_KEY, "1");
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
  return { account, setAccount: remember, checking };
}

const MESSAGES: Record<string, string> = {
  NotAllowedError: "Face ID or fingerprint didn't finish. Try again. If it keeps failing, open My Lead Sheet in Safari or Chrome.",
  InvalidStateError: "This phone is already a way into your account.",
  offline: "Can't reach the server. Check your connection and try again.",
  "not-configured": "Sign-in isn't set up on this server yet.",
  "unknown-passkey": "That passkey isn't on an account here. Create an account, or use a backup code.",
  "wrong-code": "That @name and backup code don't match. Check both and try again.",
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
};

const minutes = (ms: number) => {
  const count = Math.max(1, Math.ceil(ms / 60000));
  return `${count} minute${count === 1 ? "" : "s"}`;
};

const message = (error: unknown) => {
  if (error instanceof ApiError && error.reason === "wait") return `Too many wrong tries. Try again in ${minutes(error.waitMs)}.`;
  const key = error instanceof ApiError ? (error.status >= 500 && error.reason !== "not-configured" ? "offline" : error.reason) : error instanceof DOMException ? error.name : "";
  const text = MESSAGES[key] ?? "Something went wrong. Try again.";
  return error instanceof ApiError && error.waitMs > 0 ? `${text} Wait ${minutes(error.waitMs)} before the next try.` : text;
};

const suggestedHandle = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);

const added = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function AccountSheet({ account, onAccount, onClose }: { account: Account | null; onAccount: (account: Account | null) => void; onClose: () => void }) {
  const titleId = useId();
  const nameId = useId();
  const handleId = useId();
  const codeId = useId();
  const secretId = useId();
  const [step, setStep] = useState<Step>(account ? { name: "account" } : { name: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
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
    api<AuthConfig>("/api/auth/config").then((reply) => live && setConfig(reply), () => {});
    api<SignedIn>("/api/me").then(
      async (reply) => {
        if (!live) return;
        onAccount(reply.account);
        if (returned === "new") {
          const fresh = await api<SignedIn>("/api/me/backup-codes", {}).catch(() => reply);
          if (live) setStep(fresh.backupCodes ? { name: "codes", codes: fresh.backupCodes } : { name: "account" });
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (next: Step) => {
    setError("");
    setSecret("");
    if (next.name === "make-password") setHandle((current) => current || suggestedHandle(name));
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

  const signedIn = (reply: SignedIn) => {
    onAccount(reply.account);
    go(reply.backupCodes ? { name: "codes", codes: reply.backupCodes } : { name: "account" });
  };

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
      This browser can't use {blocked.map((method) => `${method.wayLabel} sign-in`).join(" or ")}. Open My Lead Sheet in Safari or Chrome.
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
          <button type="button" className="account-link" onClick={() => go({ name: "backup-code" })}>
            Use a backup code
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
              <button key={method.kind} type="button" className="account-primary" disabled={busy || !typed} onClick={() => act(method.create, typed)}>
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

    "backup-code": () => {
      const submit = (event: FormEvent) => {
        event.preventDefault();
        run(async () => {
          const reply = await api<SignedIn>("/api/auth/backup-code", { handle, code });
          onAccount(reply.account);
          go(reply.account.ways.some((way) => way.kind === "password") ? { name: "set-password", reset: true } : { name: "account" });
        });
      };
      return {
        title: "Use a backup code",
        body: (
          <form className="account-form" onSubmit={submit}>
            {handleField("Your @name")}
            <label className="account-field" htmlFor={codeId}>
              Backup code
            </label>
            <input id={codeId} className="account-input account-mono" autoCapitalize="characters" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            <p className="account-note">Each code works once. With no code left and no other way to sign in, the account can't be recovered.</p>
            <button type="submit" className="account-primary" disabled={busy || !handle.trim() || !code.trim()}>
              Sign in
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "start" })}>
              Back
            </button>
          </form>
        ),
      };
    },

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
            <button type="button" className="account-link" onClick={() => go({ name: "backup-code" })}>
              Forgot password? Use a backup code
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
          if (await newPasswordOk()) signedIn(await createWithPassword(name.trim(), handle, secret));
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
      const reset = step.name === "set-password" && step.reset;
      const changing = !!account?.ways.some((way) => way.kind === "password");
      const submit = (event: FormEvent) => {
        event.preventDefault();
        run(async () => {
          if (await newPasswordOk()) signedIn(await setPassword(secret));
        });
      };
      return {
        title: reset ? "Set a new password" : changing ? "Change password" : "Add a password",
        body: (
          <form className="account-form" onSubmit={submit}>
            {reset && account ? <p className="account-note">Backup code used. {account.backupCodesLeft} left.</p> : null}
            {account ? <p className="account-handle">@{account.handle}</p> : null}
            {secretField("New password", "new-password")}
            <p className="account-note">At least {MIN_PASSWORD_LENGTH} characters. This signs you out on your other phones.</p>
            <button type="submit" className="account-primary" disabled={busy || !secret}>
              Save password
            </button>
            <button type="button" className="account-link" onClick={() => go({ name: "account" })}>
              {reset ? "Not now" : "Back"}
            </button>
          </form>
        ),
      };
    },

    codes: () => {
      const codes = step.name === "codes" ? step.codes : [];
      return {
        title: "Save your backup codes",
        body: (
          <>
            <p className="account-note">If you lose this phone, each code signs you in once. Keep them somewhere safe. We can't show them again.</p>
            <ul className="account-codes">
              {codes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="account-row">
              <button type="button" className="account-secondary" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>
                Copy
              </button>
              <button type="button" className="account-secondary" onClick={() => window.print()}>
                Print
              </button>
            </div>
            <button type="button" className="account-primary" onClick={() => go({ name: "account" })}>
              I saved them
            </button>
          </>
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
            <h3 className="account-section">Backup codes</h3>
            <div className="account-row">
              <span className="account-note">{account.backupCodesLeft} left</span>
              <button
                type="button"
                className="account-secondary"
                disabled={busy}
                onClick={() => run(async () => signedIn(await api<SignedIn>("/api/me/backup-codes", {})))}
              >
                Make new codes
              </button>
            </div>
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
