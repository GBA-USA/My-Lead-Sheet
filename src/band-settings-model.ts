export type BandSettings = { bandId: string; scrollWithLeader: boolean };

export type SettingsBand = {
  id: string;
  name: string;
  admins: string[];
  settings: BandSettings;
};

export const fixtureSettingsBand: SettingsBand = {
  id: "b1",
  name: "Back Porch",
  admins: ["@alex"],
  settings: { bandId: "b1", scrollWithLeader: false },
};

export function canEditBandSettings(band: SettingsBand, me: string): boolean {
  return band.admins.includes(me);
}

export function setScrollWithLeader(
  band: SettingsBand,
  me: string,
  on: boolean
): { band: SettingsBand; ok: boolean } {
  if (!canEditBandSettings(band, me)) {
    return { band, ok: false };
  }

  return {
    band: {
      ...band,
      settings: { ...band.settings, scrollWithLeader: on },
    },
    ok: true,
  };
}
