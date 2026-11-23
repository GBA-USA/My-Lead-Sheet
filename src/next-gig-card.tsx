import { plural } from "./band-library";
import type { BandLibrary } from "./band-library-model";
import { BandStatusFaces } from "./band-status";
import { playersFrom } from "./band-status-model";
import type { BandView } from "./bands-model";
import type { GigPack } from "./gig-pack";
import { shownDate } from "./gig-plan";
import type { GigView } from "./gig-plan-model";

/** The gig the band page puts on top: one that is live, else the soonest one still planned. */
export function nextGig(gigs: GigView[]): GigView | undefined {
  const live = gigs.find((item) => item.gig.status === "live");
  return live ?? gigs.filter((item) => item.gig.status === "planned").sort((a, b) => a.gig.date.localeCompare(b.gig.date))[0];
}

/**
 * The next gig on the band page: its name and day, how many songs and how much of its pack this phone holds, Start gig
 * for whoever can lead it, Open gig for the rest of the lineup, and Plan gig for an admin. Start gig opens the gig view
 * (`onStart`); Open gig opens the gig's card in Gigs (`onOpen`), where a song button opens it on stage. Plan gig starts
 * from the next gig's setlist when there is one. Under the card, the band status strip shows the gig's lineup.
 */
export function NextGigCard({
  band,
  me,
  gigs,
  packs,
  library,
  busy,
  onStart,
  onOpen,
  onPlan,
}: {
  band: BandView;
  me: string;
  gigs: GigView[];
  packs: Record<string, GigPack>;
  library: BandLibrary | null;
  busy: boolean;
  onStart: (gigId: string) => void;
  onOpen: (gigId: string) => void;
  onPlan: (setlistId?: string) => void;
}) {
  const admin = band.role === "admin";
  const next = nextGig(gigs);
  const plan = admin ? (
    <button type="button" className="account-secondary" disabled={busy} onClick={() => onPlan(next?.gig.setlistId)}>
      Plan gig
    </button>
  ) : null;
  if (!next) {
    return (
      <section className="next-gig" aria-label="Next gig">
        <p className="account-note">No gig planned.</p>
        {plan}
      </section>
    );
  }

  const { gig } = next;
  const pack = packs[gig.gigId];
  const songs = pack?.songs.length ?? library?.setlists.find((item) => item.setlistId === gig.setlistId)?.songIds.length;
  const playing = gig.lineup.includes(me);
  const held = pack && pack.packRev >= next.packRev ? pack.songs.length : 0;
  const leads = gig.leader === me || gig.backup === me || admin;
  const open = leads ? "Start gig" : playing ? "Open gig" : null;
  return (
    <>
      <section className="next-gig" data-next-gig={gig.gigId} aria-label={`Next gig: ${gig.name}`}>
        <h3>
          {gig.name} <small>{shownDate(gig.date)}</small>
        </h3>
        {songs === undefined ? null : (
          <p className="account-note">
            {plural(songs, "song")} · {playing || admin ? `Pack ${held} of ${songs} downloaded` : "You're not playing this one."}
          </p>
        )}
        {open || plan ? (
          <div className="account-row">
            {open ? (
              <button type="button" className="account-primary" onClick={() => (leads ? onStart : onOpen)(gig.gigId)}>
                {open}
              </button>
            ) : null}
            {plan}
          </div>
        ) : null}
      </section>
      <div className="band-status-slot">
        <BandStatusFaces players={playersFrom(next, band, me)} status={gig.status} />
      </div>
    </>
  );
}
