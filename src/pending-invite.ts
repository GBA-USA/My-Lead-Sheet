import { useEffect, useState } from "react";
import { CODE_SCREEN, readPayload, type CodeKind, type CodeScreen } from "./code-link";
import { clearLanding, landedCode } from "./codes";
import { PENDING_INVITE_KEY, readRaw, removeRaw, writeRaw } from "./storage";

const KEEP_MS = 24 * 60 * 60 * 1000;

/** A code that came in on a link while nobody was signed in. `line` is what the sign-in sheet says signing in will do. */
export type Invite = { code: string; screen: CodeScreen; line?: string };

const LINES: Partial<Record<CodeKind, string>> = {
  band: "Sign in to join the band.",
  "friend-link": "Sign in to add your friend.",
  "friend-now": "Sign in to add your friend.",
};

type Held = { code: string; at: number };

const parseHeld = (raw: string): Held | null => {
  try {
    const value = JSON.parse(raw);
    return typeof value?.code === "string" && typeof value.at === "number" ? value : null;
  } catch {
    return null;
  }
};

const inviteOf = (code: string): Invite | null => {
  const kind = readPayload(code)?.kind;
  return kind ? { code, screen: CODE_SCREEN[kind], line: LINES[kind] } : null;
};

/** Keeps a landed code for after a sign-in or the Google redirect. The invite still works on this page if the phone refuses the write. */
function holdInvite(code: string): Invite | null {
  writeRaw(PENDING_INVITE_KEY, JSON.stringify({ code, at: Date.now() } satisfies Held));
  return inviteOf(code);
}

const clearInvite = () => removeRaw(PENDING_INVITE_KEY);

/** The invite waiting on this phone, or null. One older than a day is dropped here, as it is read. */
function pendingInvite(): Invite | null {
  const raw = readRaw(PENDING_INVITE_KEY);
  if (raw === null) return null;
  const held = parseHeld(raw);
  const invite = held && Date.now() - held.at < KEEP_MS ? inviteOf(held.code) : null;
  if (!invite) clearInvite();
  return invite;
}

/** The invite a `/c/` link just landed with, or the one still waiting from before a sign-in. `dropInvite` forgets it. */
export function useInvite() {
  const [invite, setInvite] = useState(() => {
    const landed = landedCode();
    return landed ? holdInvite(landed.code) : pendingInvite();
  });
  useEffect(clearLanding, []);
  const dropInvite = () => {
    clearInvite();
    setInvite(null);
  };
  return { invite, dropInvite };
}
