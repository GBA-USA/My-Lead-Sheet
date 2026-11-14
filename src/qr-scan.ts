export type CodeKind = "friend" | "band-invite" | "setlist" | "guest";
export type ScannedCode = { kind: CodeKind; id: string; from?: string };
export type Handoff = "friend-request" | "band-join" | "setlist-import" | "guest-join";

export function parseCode(raw: string): ScannedCode | null {
  const trimmed = raw.trim();
  
  // Try JSON
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed.kind === "friend" || parsed.kind === "band-invite" || parsed.kind === "setlist" || parsed.kind === "guest") &&
        typeof parsed.id === "string" &&
        parsed.id.length > 0
      ) {
        return {
          kind: parsed.kind,
          id: parsed.id,
          ...(typeof parsed.from === "string" ? { from: parsed.from } : {}),
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  
  // Try link
  if (trimmed.startsWith("https://")) {
    const match = trimmed.match(/^https:\/\/[^/]+\/c\/([^/]+)\/(.+)$/);
    if (match) {
      const kind = match[1];
      const encodedId = match[2];
      if (kind === "friend" || kind === "band-invite" || kind === "setlist" || kind === "guest") {
        try {
          const id = decodeURIComponent(encodedId);
          if (id.length > 0) {
            return { kind, id };
          }
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  
  return null;
}

export function handoffFor(code: ScannedCode): Handoff {
  switch (code.kind) {
    case "friend":
      return "friend-request";
    case "band-invite":
      return "band-join";
    case "setlist":
      return "setlist-import";
    case "guest":
      return "guest-join";
  }
}

export type FakeCamera = { frames: string[] };

export function scanFeed(cam: FakeCamera): ScannedCode | null {
  for (const frame of cam.frames) {
    const parsed = parseCode(frame);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export type MyCode = { kind: CodeKind; id: string; active: boolean };

export function stopCode(codes: MyCode[], id: string): MyCode[] {
  return codes.map((code) =>
    code.id === id ? { ...code, active: false } : code
  );
}

export function isLive(codes: MyCode[], scanned: ScannedCode): boolean {
  return codes.some((code) => code.kind === scanned.kind && code.id === scanned.id && code.active);
}
