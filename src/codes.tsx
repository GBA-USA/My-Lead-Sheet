import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CODE_SCREEN, codeInText, readPayload, refreshDelay, type CodeKind, type CodeScreen } from "./code-link";
import { APP_NAME } from "./data-kinds";
import { scanCamera } from "./qr-scan";
import { qrSvg } from "./qr-svg";
import { api } from "./sign-in-methods";

export interface ShownCode {
  kind: CodeKind;
  code: string;
  link: string;
  expiresAt: number;
}

/** The code a `/c/<payload>` link landed with (`?open=<screen>&code=<payload>`), or null. */
export function landedCode(): { screen: CodeScreen; code: string } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const fields = code ? readPayload(code) : null;
  const screen = fields ? CODE_SCREEN[fields.kind] : null;
  return code && screen && screen === params.get("open") ? { screen, code } : null;
}

/** Takes a landed code out of the address bar, so a reload doesn't open it again. */
export function clearLanding() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("open");
  history.replaceState(history.state, "", url);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Worker gives a code that never ends, such as a band setlist's, an end ten years out. */
const endLine = (ms: number) => {
  const left = ms - Date.now();
  if (left > 365 * DAY_MS) return "Doesn't expire";
  const date = new Date(ms);
  const when = left < DAY_MS ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `Ends ${when}`;
};

type CodeRequest = { kind: CodeKind } & Record<string, unknown>;

/**
 * A code for `request`, made when the screen opens and made again when it ends, so a tap can use the link at once.
 * A null `request` asks for nothing, for a player the server would refuse. `problem` is why the last try failed. `retry` tries again.
 */
export function useCode(request: CodeRequest | null, onError?: (error: unknown) => void) {
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!request) return;
    if (shown && shown.expiresAt > Date.now()) {
      // While the end is still ahead a new round only re-arms the timer, so a never-ending code is asked for once.
      const timer = setTimeout(() => (shown.expiresAt > Date.now() ? setRound((n) => n + 1) : setShown(null)), refreshDelay(shown.expiresAt, Date.now()));
      return () => clearTimeout(timer);
    }
    let live = true;
    api<ShownCode>("/api/codes", request).then(
      (made) => {
        if (!live) return;
        setProblem(null);
        setShown(made);
      },
      (error) => {
        if (!live) return;
        setProblem(error);
        onError?.(error);
      },
    );
    return () => {
      live = false;
    };
  }, [shown, round, request === null]);

  const retry = () => {
    setShown(null);
    setRound((n) => n + 1);
  };
  return { shown, problem, retry };
}

/**
 * Opens the phone's share sheet with the link inside the tap, since iOS refuses a share that comes after an await.
 * Without a share sheet it copies the link. Resolves true once the link is copied.
 */
export function shareLink(link: string, title: string): Promise<boolean> {
  if (navigator.share) {
    navigator.share({ title, url: link }).catch(() => {});
    return Promise.resolve(false);
  }
  return copyLink(link);
}

/** Puts the link on the clipboard. Resolves false where the browser refuses, such as a page not on https. */
const copyLink = (link: string): Promise<boolean> => (navigator.clipboard ? navigator.clipboard.writeText(link).then(() => true, () => false) : Promise.resolve(false));

/**
 * Show my code: a big black-on-white QR code with the plain words under it and its end time.
 * With `share`, the whole link as text with Copy link, for a bandmate on a computer, and Share link where the phone has a share sheet.
 * `request` is the body for `POST /api/codes`. A code that ends is swapped for a fresh one while the screen is open.
 */
export function ShowCode({ request, words, share, onStopped, onError }: { request: CodeRequest; words: string; share?: true; onStopped: () => void; onError: (error: unknown) => void }) {
  const { shown } = useCode(request, onError);
  const linkText = useRef<HTMLParagraphElement>(null);
  /** The code whose link was copied, so a fresh code shows Copy link again. */
  const [copied, setCopied] = useState<string | null>(null);
  const [copyRefused, setCopyRefused] = useState(false);

  if (!shown) return <p className="account-note">Making your code…</p>;

  const stop = () => api("/api/codes/stop", { code: shown.code }).then(onStopped, onError);
  const copy = () =>
    copyLink(shown.link).then((done) => {
      setCopyRefused(!done);
      if (done) return setCopied(shown.code);
      if (linkText.current) getSelection()?.selectAllChildren(linkText.current);
    });

  return (
    <>
      <div className="codes-qr" role="img" aria-label={words} dangerouslySetInnerHTML={{ __html: qrSvg(shown.link) }} />
      <p className="codes-words">{words}</p>
      <p className="account-note">{endLine(shown.expiresAt)}</p>
      {share ? (
        <>
          <p ref={linkText} className="codes-link">
            {shown.link}
          </p>
          {copyRefused ? (
            <p className="account-note" role="alert">
              Select the link above and copy it.
            </p>
          ) : null}
          <button type="button" className="account-primary" onClick={copy}>
            {copied === shown.code ? "Copied" : "Copy link"}
          </button>
          {typeof navigator.share === "function" ? (
            <button type="button" className="account-secondary" onClick={() => shareLink(shown.link, words)}>
              Share link
            </button>
          ) : null}
        </>
      ) : null}
      <button type="button" className="account-secondary" onClick={stop}>
        Stop this code
      </button>
    </>
  );
}

/**
 * Scan a code: the camera, until it sees a code link, and Paste a link for a computer or a link sent in a message.
 * Both hand `onCode` the same payload, so a pasted link opens what a scan of its QR code opens.
 */
export function ScanCode({ onCode }: { onCode: (payload: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const pasteId = useId();
  const [problem, setProblem] = useState("");
  const [pasted, setPasted] = useState("");
  const [notALink, setNotALink] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    scanCamera(video.current!, controller.signal).then(onCode, () => {
      if (!controller.signal.aborted) setProblem("Can't open the camera. Allow camera access for this site, or paste the link below.");
    });
    return () => controller.abort();
  }, []);

  const open = (event: FormEvent) => {
    event.preventDefault();
    const payload = codeInText(pasted);
    if (payload) onCode(payload);
    else setNotALink(true);
  };

  return (
    <>
      <video ref={video} className="codes-camera" muted playsInline hidden={!!problem} />
      <p className="account-note" role={problem ? "alert" : undefined}>
        {problem || `Point the camera at a ${APP_NAME} code.`}
      </p>
      <form className="account-form" onSubmit={open}>
        <label className="account-field" htmlFor={pasteId}>
          Paste a link
        </label>
        <input
          id={pasteId}
          className="account-input"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={`${location.origin}/c/…`}
          value={pasted}
          onChange={(event) => {
            setPasted(event.target.value);
            setNotALink(false);
          }}
        />
        {notALink ? (
          <p className="account-error" role="alert">
            That isn't a {APP_NAME} link. Copy the whole link, then paste it again.
          </p>
        ) : null}
        <button type="submit" className="account-secondary" disabled={!pasted.trim()}>
          Open link
        </button>
      </form>
    </>
  );
}
