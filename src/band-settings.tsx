import { useId, useRef, useState, type ChangeEvent } from "react";
import type { BandView } from "./bands-model";
import { ApiError, api } from "./sign-in-methods";

type Counted = { added: number; skipped: number };
export type Imported = { songs: Counted; setlists: Counted };

const MOVE_MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "bad-file": "That isn't a band file.",
  "own-file": "That file came from this band, so there's nothing to import.",
  "too-large": "That file is too big to import.",
  "not-admin": "Only a band admin can do that.",
  "not-a-member": "You're not in this band any more.",
  "signed-out": "You're signed out. Sign in again first.",
};

const moveMessage = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MOVE_MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const counted = (counts: Imported, field: keyof Counted) =>
  [plural(counts.songs[field], "song"), plural(counts.setlists[field], "setlist")].filter((part) => !part.startsWith("0 ")).join(" and ");

function importWords(counts: Imported): string {
  const added = counted(counts, "added");
  const skipped = counted(counts, "skipped");
  if (!added && !skipped) return "Nothing to import. The file holds no songs or setlists.";
  if (!added) return `Already here · ${skipped} skipped`;
  return skipped ? `Added ${added}. ${skipped} already here.` : `Added ${added}.`;
}

export function BandSettings({ band, busy, onScrollWithLeader }: { band: BandView; busy: boolean; onScrollWithLeader: (on: boolean) => void }) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState("");
  const [trouble, setTrouble] = useState("");

  const move = async (work: () => Promise<string>) => {
    setMoving(true);
    setMoved("");
    setTrouble("");
    try {
      setMoved(await work());
    } catch (caught) {
      setTrouble(moveMessage(caught));
    } finally {
      setMoving(false);
    }
  };

  const download = () =>
    move(async () => {
      const file = await api<object>(`/api/bands/export?bandId=${encodeURIComponent(band.bandId)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `${band.name}.json` }).click();
      return `Downloaded ${band.name}.json.`;
    });

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    move(async () => {
      let file: unknown;
      try {
        file = JSON.parse(await picked.text());
      } catch {
        throw new ApiError("bad-file", 400);
      }
      return importWords(await api<Imported>(`/api/rooms/${band.bandId}`, file as object));
    });
  };

  return (
    <>
      <div className="account-row">
        <label htmlFor={id}>Scroll with the leader</label>
        <input id={id} type="checkbox" role="switch" checked={band.scrollWithLeader} disabled={busy} onChange={(event) => onScrollWithLeader(event.target.checked)} />
      </div>
      <p className="account-note">When on, everyone's chart scrolls with the leader's song, using the band's timing. Nobody's private versions are shared.</p>
      <div className="account-row">
        <button type="button" className="account-secondary" disabled={busy || moving} onClick={download}>
          Download band file
        </button>
        <button type="button" className="account-secondary" disabled={busy || moving} onClick={() => fileInput.current?.click()}>
          Import band file
        </button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-label="Band file" onChange={importFile} />
      </div>
      <p className="account-note">The band file holds the band's songs and setlists with their Private or Public choice, for moving them to a band on another server. Chat and gig logs stay here.</p>
      {moved ? (
        <p className="account-note" role="status">
          {moved}
        </p>
      ) : null}
      {trouble ? (
        <p className="account-error" role="alert">
          {trouble}
        </p>
      ) : null}
    </>
  );
}
