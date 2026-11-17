import { useEffect, useRef, useState } from "react";
import { CODE_SCREEN, readPayload, type CodeKind, type CodeScreen } from "./code-link";
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

const endTime = (ms: number) =>
  ms - Date.now() < 24 * 60 * 60 * 1000
    ? new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

type CodeRequest = { kind: CodeKind } & Record<string, unknown>;

/**
 * A code for `request`, made when the screen opens and made again when it ends, so a tap can use the link at once.
 * `problem` is why the last try failed. `retry` tries again.
 */
export function useCode(request: CodeRequest, onError?: (error: unknown) => void) {
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (shown && shown.expiresAt > Date.now()) {
      const timer = setTimeout(() => setShown(null), shown.expiresAt - Date.now());
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
  }, [shown, round]);

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
  return navigator.clipboard ? navigator.clipboard.writeText(link).then(() => true, () => false) : Promise.resolve(false);
}

/**
 * Show my code: a big black-on-white QR code with the plain words under it and its end time.
 * `request` is the body for `POST /api/codes`. A code that ends is swapped for a fresh one while the screen is open.
 */
export function ShowCode({ request, words, share, onStopped, onError }: { request: CodeRequest; words: string; share?: true; onStopped: () => void; onError: (error: unknown) => void }) {
  const { shown } = useCode(request, onError);
  const [copied, setCopied] = useState(false);

  if (!shown) return <p className="account-note">Making your code…</p>;

  const stop = () => api("/api/codes/stop", { code: shown.code }).then(onStopped, onError);

  return (
    <>
      <div className="codes-qr" role="img" aria-label={words} dangerouslySetInnerHTML={{ __html: qrSvg(shown.link) }} />
      <p className="codes-words">{words}</p>
      <p className="account-note">Ends {endTime(shown.expiresAt)}</p>
      {share ? (
        <>
          <p className="codes-link">{shown.link}</p>
          <button type="button" className="account-primary" onClick={() => shareLink(shown.link, words).then((done) => done && setCopied(true))}>
            {copied ? "Link copied" : "Share link"}
          </button>
        </>
      ) : null}
      <button type="button" className="account-secondary" onClick={stop}>
        Stop this code
      </button>
    </>
  );
}

/** Scan a code: the camera, until it sees a code link. */
export function ScanCode({ onCode }: { onCode: (payload: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    scanCamera(video.current!, controller.signal).then(onCode, () => {
      if (!controller.signal.aborted) setProblem("Can't open the camera. Allow camera access for this site, or open the code with your phone's camera app.");
    });
    return () => controller.abort();
  }, []);

  return (
    <>
      <video ref={video} className="codes-camera" muted playsInline />
      <p className="account-note" role={problem ? "alert" : undefined}>
        {problem || `Point the camera at a ${APP_NAME} code.`}
      </p>
    </>
  );
}
