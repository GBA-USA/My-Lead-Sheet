import { useEffect, useState, useSyncExternalStore } from "react";
import { plural, titleOf } from "./band-library";
import { bandSongRef, type BandLibrary, type BandSetlist, type BandSong } from "./band-library-model";
import type { GigPack } from "./gig-pack";
import type { GigView } from "./gig-plan-model";
import { getFromPhone, heldFor, onPhoneChange, phoneGeneration } from "./phone-db";
import { bandLiveHref, type Route } from "./route";
import { BandSetlistCode, CodeOfferButton } from "./setlist-code";
import { codeOffer } from "./setlist-code-model";
import type { Song } from "./types";

type HeldSetlist = { name: string; songIds: string[] };

/**
 * The band setlists this page load has seen, keyed `userId/bandId/setlistId`, so Live on one runs from this phone with
 * no signal, and another account on the phone never reads them. Gone on reload.
 */
const heldSetlists = new Map<string, HeldSetlist>();

export function holdSetlists(userId: string, bandId: string, library: BandLibrary) {
  for (const key of heldSetlists.keys()) if (key.startsWith(`${userId}/${bandId}/`)) heldSetlists.delete(key);
  for (const { setlistId, name, songIds } of library.setlists) heldSetlists.set(`${userId}/${bandId}/${setlistId}`, { name, songIds });
}

export const dropSetlists = (userId: string, bandId: string) => holdSetlists(userId, bandId, { songs: [], setlists: [] });

/** A band song as the song screen shows it: its ref is the band's, so U3's `locked` keeps it from Save and Send. */
export const bandSong = (bandId: string, songId: string, song: BandSong["song"]): Song => ({ ...song, ref: bandSongRef(bandId, songId), id: 0 });

/** What a band song or band Live route plays, read from this phone: the song, and for Live the setlist it is in. */
export type BandPlay = { ready: boolean; live: boolean; song?: Song; setlist?: HeldSetlist; index: number };

export function useBandPlay(route: Route, userId: string | null): BandPlay {
  const generation = useSyncExternalStore(onPhoneChange, phoneGeneration, phoneGeneration);
  const setlist = route.name === "band-live" && userId ? heldSetlists.get(`${userId}/${route.bandId}/${route.setlistId}`) : undefined;
  const index = route.name === "band-live" && setlist ? Math.min(Math.max(route.index, 0), Math.max(setlist.songIds.length - 1, 0)) : 0;
  const bandId = route.name === "band-song" || route.name === "band-live" ? route.bandId : null;
  const songId = route.name === "band-song" ? route.songId : setlist?.songIds[index];
  const key = bandId && songId ? bandSongRef(bandId, songId) : null;
  const [found, setFound] = useState<{ key: string; song?: Song } | null>(null);

  useEffect(() => {
    if (!key || !bandId || !songId || !userId) return setFound(null);
    // Nothing on this phone is this account's (a guest, or a member who hasn't opened the band here): it has looked.
    if (!heldFor(userId)) return setFound({ key });
    let live = true;
    getFromPhone("bandSongs", key).then(
      (cached) => live && setFound({ key, song: cached && bandSong(bandId, songId, cached.song) }),
      () => live && setFound({ key }),
    );
    return () => {
      live = false;
    };
  }, [key, userId, generation]);

  const live = route.name === "band-live";
  if (!bandId) return { ready: false, live, index };
  if (!key || !userId) return { ready: true, live, setlist, index };
  return { ready: found?.key === key, live, song: found?.key === key ? found.song : undefined, setlist, index };
}

/** What a band song or band Live route shows when this phone can't play it, once it has looked. */
export function BandPlayMissing({ play, back }: { play: BandPlay; back: string }) {
  if (!play.ready) return null;
  return (
    <div className="missing">
      <p>{play.live && !play.setlist ? "Open this setlist from the band page." : "That song isn't on this phone."}</p>
      <a href={back}>Back to the band</a>
    </div>
  );
}

/**
 * A band setlist as a member reads it: who shared it, the band-only line, its songs with Downloaded ✓ where a gig pack
 * on this phone holds them, Show code, Live, and Edit for an admin or the sharer and Plan a gig for an admin. When a gig
 * is planned from it, a song not on this phone offers Download and the foot offers Download all: both fetch that gig's
 * one pack, since the pack is per gig.
 */
export function BandSetlistView({
  bandId,
  bandName,
  setlist,
  songs,
  packs,
  gig,
  busy,
  onDownload,
  onBack,
  onEdit,
  onPlan,
  onCodeError,
}: {
  bandId: string;
  bandName: string;
  setlist: BandSetlist;
  songs: BandSong[];
  packs: Record<string, GigPack>;
  gig: GigView | undefined;
  busy: boolean;
  onDownload: (gig: GigView) => void;
  onBack: () => void;
  onEdit?: () => void;
  onPlan?: () => void;
  onCodeError: (error: unknown) => void;
}) {
  const [showing, setShowing] = useState(false);
  if (showing) return <BandSetlistCode bandId={bandId} bandName={bandName} setlist={setlist} onBack={() => setShowing(false)} onError={onCodeError} />;

  const byId = new Map(songs.map((item) => [item.songId, item]));
  const onPhone = new Set(Object.values(packs).flatMap((pack) => (pack.gig.bandId === bandId ? pack.songs.map((item) => item.songId) : [])));
  const count = setlist.songIds.length;
  return (
    <div className="band-setlist-view">
      <div className="band-setlist-top">
        <h3>{setlist.name}</h3>
        <CodeOfferButton offer={codeOffer(count, setlist.canSendOn)} onShow={() => setShowing(true)} />
      </div>
      <p className="account-note">
        {bandName} · {plural(count, "song")} · from {setlist.sharedByName}
      </p>
      <p className="account-note band-setlist-lock">
        <span aria-hidden="true">🔒 </span>Band songs stay in {bandName}. They don't go into My Songs.
      </p>
      {count === 0 ? (
        <p className="account-note">No songs in this setlist yet.</p>
      ) : (
        <ol className="band-setlist-songs">
          {setlist.songIds.map((songId) => (
            <li key={songId}>
              <span className="band-library-name">{titleOf(byId.get(songId))}</span>
              {onPhone.has(songId) ? (
                <small>Downloaded ✓</small>
              ) : gig ? (
                <button type="button" className="account-secondary" disabled={busy} onClick={() => onDownload(gig)}>
                  Download
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <div className="account-row">
        <button type="button" className="account-primary" disabled={count === 0} onClick={() => (window.location.hash = bandLiveHref(bandId, setlist.setlistId, 0))}>
          Live
        </button>
        {gig && count > 0 ? (
          <button type="button" className="account-secondary" disabled={busy} onClick={() => onDownload(gig)}>
            Download all
          </button>
        ) : null}
        {onEdit ? (
          <button type="button" className="account-secondary" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        {onPlan ? (
          <button type="button" className="account-secondary" onClick={onPlan}>
            Plan a gig
          </button>
        ) : null}
        <button type="button" className="account-link" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
