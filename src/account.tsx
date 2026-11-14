import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { PRIVACY_HREF } from "./data-kinds";
import { ApiError, SIGN_IN_METHODS, api, type Account, type SignedIn } from "./sign-in-methods";
import "./account.css";

type Step =
  | { name: "loading" }
  | { name: "start" }
  | { name: "create" }
  | { name: "backup-code" }
  | { name: "codes"; codes: string[] }
  | { name: "account" };

const MESSAGES: Record<string, string> = {
  NotAllowedError: "Face ID or fingerprint didn't finish. Try again. If it keeps failing, open My Lead Sheet in Safari or Chrome.",
  InvalidStateError: "This phone is already a way into your account.",
  offline: "Can't reach the server. Check your connection and try again.",
  "not-configured": "Sign-in isn't set up on this server yet.",
  "unknown-passkey": "That passkey isn't on an account here. Create an account, or use a backup code.",
  "wrong-code": "That @name and backup code don't match. Check both and try again.",
  "last-way": "This is your only way to sign in. Add another phone first.",
  "challenge-expired": "That took too long. Try again.",
  "signed-out": "You're signed out. Sign in again.",
  "bad-name": "Type the name your bandmates know you by.",
};

const message = (error: unknown) => {
  const key = error instanceof ApiError ? (error.status >= 500 && error.reason !== "not-configured" ? "offline" : error.reason) : error instanceof DOMException ? error.name : "";
  return MESSAGES[key] ?? "Something went wrong. Try again.";
};

const methodsThatWork = SIGN_IN_METHODS.filter((method) => method.works());

const added = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function AccountSheet({ account, onAccount, onClose }: { account: Account | null; onAccount: (account: Account | null) => void; onClose: () => void }) {
  const titleId = useId();
  const nameId = useId();
  const handleId = useId();
  const codeId = useId();
  const [step, setStep] = useState<Step>(account ? { name: "account" } : { name: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    let live = true;
    api<SignedIn>("/api/me").then(
      (reply) => live && (onAccount(reply.account), setStep({ name: "account" })),
      (caught) => {
        if (!live) return;
        const signedOut = caught instanceof ApiError && caught.status === 401;
        if (signedOut) onAccount(null);
        setStep((current) => (current.name === "loading" || (signedOut && current.name === "account") ? { name: "start" } : current));
      },
    );
    return () => {
      live = false;
    };
  }, [onAccount]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (next: Step) => {
    setError("");
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

  const noPasskeys = methodsThatWork.length < SIGN_IN_METHODS.length ? (
    <p className="account-note" role="note">
      This browser can't use Face ID or fingerprint sign-in. Open My Lead Sheet in Safari or Chrome.
    </p>
  ) : null;

  const screens: Record<Step["name"], () => { title: string; body: ReactNode }> = {
    loading: () => ({ title: "Sign in", body: <p className="account-note">Checking…</p> }),

    start: () => ({
      title: "Sign in",
      body: (
        <>
          {noPasskeys}
          {methodsThatWork.map((method) => (
            <button key={method.kind} type="button" className="account-primary" disabled={busy} onClick={() => run(async () => signedIn(await method.signIn()))}>
              {method.label}
            </button>
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
            {noPasskeys}
            {methodsThatWork.map((method) => (
              <button key={method.kind} type="button" className="account-primary" disabled={busy || !typed} onClick={() => run(async () => signedIn(await method.create(typed)))}>
                {method.label}
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
        run(async () => signedIn(await api<SignedIn>("/api/auth/backup-code", { handle, code })));
      };
      return {
        title: "Use a backup code",
        body: (
          <form className="account-form" onSubmit={submit}>
            <label className="account-field" htmlFor={handleId}>
              Your @name
            </label>
            <input id={handleId} className="account-input" autoCapitalize="none" autoComplete="username" value={handle} onChange={(event) => setHandle(event.target.value)} />
            <label className="account-field" htmlFor={codeId}>
              Backup code
            </label>
            <input id={codeId} className="account-input account-mono" autoCapitalize="characters" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            <p className="account-note">Each code works once.</p>
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
            {noPasskeys}
            {methodsThatWork.map((method) => (
              <button key={method.kind} type="button" className="account-secondary" disabled={busy} onClick={() => run(async () => onAccount(await method.add()))}>
                + Add another phone
              </button>
            ))}
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
