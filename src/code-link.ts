export const CODE_KINDS = ["band", "gig", "guest", "band-setlist", "my-setlist", "friend-now", "friend-link"] as const;
export type CodeKind = (typeof CODE_KINDS)[number];

export type CodeScreen = "bands" | "gig" | "setlists" | "friends";

/** Where each kind of code lands, for a link opened in a browser and for the in-app scanner alike (PLAN.md 9.3). */
export const CODE_SCREEN: Record<CodeKind, CodeScreen> = {
  band: "bands",
  gig: "gig",
  guest: "gig",
  "band-setlist": "setlists",
  "my-setlist": "setlists",
  "friend-now": "friends",
  "friend-link": "friends",
};

export const CODE_REFUSED: Record<"bad-code" | "code-ended" | "code-stopped", string> = {
  "bad-code": "This code doesn't work. Ask for a fresh one.",
  "code-ended": "This code has ended. Ask for a fresh one.",
  "code-stopped": "This code was stopped. Ask for a fresh one.",
};

/** What a code link carries, and nothing else: no band, song or person. */
export interface CodeFields {
  kind: CodeKind;
  codeId: string;
  expiresAt: number;
  nonce: string;
}

/** The signature is 32 bytes in 43 base64url characters, the last one with its two spare bits zero, so each code has exactly one spelling. */
const PAYLOAD = /^([a-z-]+)\.([A-Za-z0-9_-]{16})\.([1-9]\d{0,14})\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const IN_LINK = /\/c\/([^/?#\s]+)/;

const isKind = (value: string): value is CodeKind => (CODE_KINDS as readonly string[]).includes(value);

export const signedText = (fields: CodeFields) => `${fields.kind}.${fields.codeId}.${fields.expiresAt}.${fields.nonce}`;

/** The fields and signature of a payload, or null when it isn't shaped like one. Only the server can tell whether the signature is real. */
export function readPayload(payload: string): (CodeFields & { mac: string }) | null {
  const match = PAYLOAD.exec(payload);
  if (!match || !isKind(match[1])) return null;
  return { kind: match[1], codeId: match[2], expiresAt: Number(match[3]), nonce: match[4], mac: match[5] };
}

/** The payload in a scanned or pasted code: a `<site>/c/<payload>` link or the bare payload. */
export function codeInText(text: string): string | null {
  const trimmed = text.trim();
  const payload = IN_LINK.exec(trimmed)?.[1] ?? trimmed;
  return readPayload(payload) ? payload : null;
}
