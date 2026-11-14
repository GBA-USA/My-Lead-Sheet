export const GLIDE_MS = 400;

export type LookMode = "locked" | "looking" | "gliding";

export type LookState = {
  mode: LookMode;
  px: number;
  glideFromPx: number;
  glideStartMs: number;
};

export type Outbound = { kind: string };

export function initialLook(bandPx: number): LookState {
  return {
    mode: "locked",
    px: bandPx,
    glideFromPx: 0,
    glideStartMs: 0,
  };
}

export function touchAction(inGig: boolean): "look-ahead" | "stop-scroll" {
  return inGig ? "look-ahead" : "stop-scroll";
}

export function startDrag(
  s: LookState,
  inGig: boolean
): { state: LookState; out: Outbound[] } {
  if (inGig) {
    return {
      state: {
        ...s,
        mode: "looking",
      },
      out: [],
    };
  }
  return {
    state: s,
    out: [],
  };
}

export function dragTo(
  s: LookState,
  px: number
): { state: LookState; out: Outbound[] } {
  if (s.mode === "looking") {
    return {
      state: {
        ...s,
        px: Math.max(0, px),
      },
      out: [],
    };
  }
  return {
    state: s,
    out: [],
  };
}

export function release(
  s: LookState,
  nowMs: number
): { state: LookState; out: Outbound[] } {
  if (s.mode === "looking") {
    return {
      state: {
        ...s,
        mode: "gliding",
        glideFromPx: s.px,
        glideStartMs: nowMs,
      },
      out: [],
    };
  }
  return {
    state: s,
    out: [],
  };
}

export function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export function tick(
  s: LookState,
  nowMs: number,
  bandPx: number
): LookState {
  if (s.mode === "locked") {
    return {
      ...s,
      px: bandPx,
    };
  }

  if (s.mode === "looking") {
    return s;
  }

  // gliding
  const t = (nowMs - s.glideStartMs) / GLIDE_MS;
  if (t >= 1) {
    return {
      ...s,
      mode: "locked",
      px: bandPx,
    };
  }

  const px = s.glideFromPx + (bandPx - s.glideFromPx) * easeOut(t);
  return {
    ...s,
    px,
  };
}

export function tagText(s: LookState): string {
  if (s.mode === "looking" || s.mode === "gliding") {
    return "Looking ahead";
  }
  return "";
}

export function showBandLine(s: LookState): boolean {
  return s.mode === "looking" || s.mode === "gliding";
}
