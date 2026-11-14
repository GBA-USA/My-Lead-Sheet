export type ClickMode = "out-loud" | "dot-only";
export type ChordStyle = "notes" | "nashville";
export type PersonalSettings = { click: ClickMode; textSize: number; chordStyle: ChordStyle; transpose: number };
export const defaultPersonalSettings: PersonalSettings = { click: "out-loud", textSize: 18, chordStyle: "notes", transpose: 0 };
export type GigImposed = { connectionRoute: "wifi" | "hotspot" | "internet"; scrollWithLeader: boolean };
export type GigJoin = { gigId: string; imposed: GigImposed; attempted?: Partial<PersonalSettings> };
export type FixtureStore = { saved: string | null };

export function savePersonal(_store: FixtureStore, s: PersonalSettings): FixtureStore {
  const clamped: PersonalSettings = {
    click: s.click,
    textSize: Math.max(12, Math.min(32, s.textSize)),
    chordStyle: s.chordStyle,
    transpose: Math.max(-11, Math.min(11, Math.round(s.transpose)))
  };
  return { saved: JSON.stringify(clamped) };
}

export function loadPersonal(store: FixtureStore): PersonalSettings {
  if (!store.saved) return { ...defaultPersonalSettings };
  try {
    const parsed = JSON.parse(store.saved);
    const result: PersonalSettings = {
      click: (parsed.click === "dot-only" || parsed.click === "out-loud") ? parsed.click : defaultPersonalSettings.click,
      textSize: typeof parsed.textSize === "number" ? Math.max(12, Math.min(32, parsed.textSize)) : defaultPersonalSettings.textSize,
      chordStyle: (parsed.chordStyle === "notes" || parsed.chordStyle === "nashville") ? parsed.chordStyle : defaultPersonalSettings.chordStyle,
      transpose: typeof parsed.transpose === "number" ? Math.max(-11, Math.min(11, Math.round(parsed.transpose))) : defaultPersonalSettings.transpose
    };
    return result;
  } catch {
    return { ...defaultPersonalSettings };
  }
}

export function setSetting<K extends keyof PersonalSettings>(s: PersonalSettings, key: K, value: PersonalSettings[K]): PersonalSettings {
  const updated = { ...s, [key]: value };
  if (key === "textSize" && typeof value === "number") {
    updated.textSize = Math.max(12, Math.min(32, value));
  }
  if (key === "transpose" && typeof value === "number") {
    updated.transpose = Math.max(-11, Math.min(11, Math.round(value)));
  }
  return updated;
}

export function joinGig(personal: PersonalSettings, join: GigJoin): { personal: PersonalSettings; imposed: GigImposed } {
  return {
    personal: { ...personal },
    imposed: {
      connectionRoute: join.imposed.connectionRoute,
      scrollWithLeader: join.imposed.scrollWithLeader
    }
  };
}
