import { bandSong, type BandPlay } from "./band-setlist-view";
import type { GigPack } from "./gig-pack";
import type { GigPosition } from "./gig-position";
import { bandLiveHref, type Route } from "./route";
import { songByRef } from "./storage";
import type { Library, Song } from "./types";

/** The set a stage route runs: how many songs, which one is up and its song, and how to move. `caption` is the bar's own words on `#/live`. */
export type StageSet = { count: number; index: number; song: Song | undefined; go: (index: number) => void; caption: string | null };

/**
 * The set behind each stage route, or null when the route has none to run: a setlist not in the library, a band setlist
 * this phone has not opened, or a gig with no pack on this phone. An empty setlist is a set with no songs. The gig view
 * itself has no song up; the gig-mode sheet has the one at the position.
 */
export function stageSetOf(route: Route, library: Library, play: BandPlay, pack: GigPack | null | undefined, position: GigPosition): StageSet | null {
  if (route.name === "live") {
    const setlist = library.setlists.find((set) => set.id === route.setlistId);
    if (!setlist) return null;
    const count = setlist.songRefs.length;
    const index = Math.min(Math.max(route.index, 0), Math.max(count - 1, 0));
    const song = count > 0 ? songByRef(library.songs, setlist.songRefs[index]) : undefined;
    return { count, index, song, go: (next) => (window.location.hash = `#/live/${route.setlistId}/${next}`), caption: `${setlist.name} · ${index + 1}/${count}` };
  }
  if (route.name === "band-live") {
    if (!play.setlist) return null;
    const count = play.setlist.songIds.length;
    return { count, index: play.index, song: play.song, go: (next) => (window.location.hash = bandLiveHref(route.bandId, route.setlistId, next)), caption: `${play.setlist.name} · ${play.index + 1}/${count}` };
  }
  if (route.name === "gig" && pack) {
    const item = route.index === null ? undefined : pack.songs[position.index];
    return { count: pack.songs.length, index: position.index, song: item && bandSong(route.bandId, item.songId, item.song), go: position.goTo, caption: null };
  }
  return null;
}

/**
 * The stage bar at the bottom of the screen: Prev and Next at the stage touch size, with the Scroll pill between them on
 * a sheet. Prev and Next are for whoever may move the set; a member's bar keeps only Scroll.
 */
export function StageBar({ set, canMove, scroll }: { set: StageSet; canMove: boolean; scroll?: { on: boolean; toggle: () => void } }) {
  return (
    <nav className="live-nav" aria-label="Set">
      {canMove ? (
        <button type="button" className="stage-step" aria-label="Previous song" disabled={set.index <= 0} onClick={() => set.go(set.index - 1)}>
          Prev
        </button>
      ) : (
        <span />
      )}
      <div className="stage-middle">
        {scroll ? (
          <button type="button" className={scroll.on ? "scroll-pill is-on" : "scroll-pill"} aria-pressed={scroll.on} onClick={scroll.toggle}>
            Scroll: {scroll.on ? "On" : "Off"}
          </button>
        ) : null}
        {set.caption ? <span className="live-count">{set.caption}</span> : null}
      </div>
      {canMove ? (
        <button type="button" className="stage-step" aria-label="Next song" disabled={set.index >= set.count - 1} onClick={() => set.go(set.index + 1)}>
          Next
        </button>
      ) : (
        <span />
      )}
    </nav>
  );
}
