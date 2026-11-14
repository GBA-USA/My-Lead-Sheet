import { reshareable, originalReshareable, type ShareChoice } from "./share-rule";

export type TimingVersion = { id: string; label: string };

export type SongPayload = { songId: string; title: string; chart?: string; versions: TimingVersion[]; data?: { key: string; bpm: number } };

export type FixtureSong = { songId: string; title: string; chart: string; versions: TimingVersion[]; data: { key: string; bpm: number }; reshareable: boolean; fromName?: string };

export const fixtureSong: FixtureSong = {
  songId: "no-half-steppin-001",
  title: "No Half Steppin'",
  chart: "[C]Hello",
  versions: [
    { id: "v1", label: "Main take" },
    { id: "v2", label: "Slow practice" },
  ],
  data: { key: "C", bpm: 92 },
  reshareable: true,
};

export type SendPick = { chart: boolean; versionIds: string[]; data: boolean; choice: ShareChoice | null };

export function canSend(pick: SendPick): boolean {
  if (pick.choice === null) return false;
  return pick.chart || pick.versionIds.length > 0 || pick.data;
}

export function buildMessage(
  song: FixtureSong,
  pick: SendPick,
  isOriginal: boolean,
): { ok: false; error: string } | { ok: true; payload: SongPayload; reshareable: boolean } {
  if (pick.choice === null) {
    return { ok: false, error: "Pick Private or Public" };
  }

  if (!canSend(pick)) {
    return { ok: false, error: "Tick at least one thing to send" };
  }

  if (!song.reshareable && !isOriginal) {
    return { ok: false, error: "This song can't be shared" };
  }

  const payload: SongPayload = {
    songId: song.songId,
    title: song.title,
    versions: song.versions.filter((v) => pick.versionIds.includes(v.id)).map((v) => ({ ...v })),
  };

  if (pick.chart) {
    payload.chart = song.chart;
  }

  if (pick.data) {
    payload.data = { ...song.data };
  }

  const reshareableFlag = isOriginal ? originalReshareable(pick.choice) : reshareable({ reshareable: song.reshareable }, pick.choice);

  return { ok: true, payload, reshareable: reshareableFlag };
}

export function addToMySongs(payload: SongPayload, reshareableFlag: boolean, fromName: string): FixtureSong {
  const chart = payload.chart ?? "";
  const data = payload.data ?? { key: "", bpm: 0 };

  return {
    songId: payload.songId,
    title: payload.title,
    chart,
    versions: payload.versions.map((v) => ({ ...v })),
    data: { ...data },
    reshareable: reshareableFlag,
    fromName,
  };
}

export type UpdateChoice = "keep-mine" | "take-theirs" | "keep-both";

export function applyUpdate(mine: FixtureSong, theirs: SongPayload, choice: UpdateChoice): FixtureSong[] {
  if (choice === "keep-mine") {
    return [mine];
  }

  if (choice === "take-theirs") {
    return [
      {
        ...mine,
        chart: theirs.chart ?? mine.chart,
        versions: theirs.versions.length ? theirs.versions.map((v) => ({ ...v })) : mine.versions,
        data: theirs.data ? { ...theirs.data } : mine.data,
      },
    ];
  }

  return [mine, { ...addToMySongs(theirs, mine.reshareable, mine.fromName ?? ""), title: theirs.title + " (update)" }];
}
