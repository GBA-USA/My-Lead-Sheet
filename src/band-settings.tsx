import { useId } from "react";
import type { BandView } from "./bands-model";

export function BandSettings({ band, busy, onScrollWithLeader }: { band: BandView; busy: boolean; onScrollWithLeader: (on: boolean) => void }) {
  const id = useId();
  return (
    <>
      <div className="account-row">
        <label htmlFor={id}>Scroll with the leader</label>
        <input id={id} type="checkbox" role="switch" checked={band.scrollWithLeader} disabled={busy} onChange={(event) => onScrollWithLeader(event.target.checked)} />
      </div>
      <p className="account-note">When on, everyone's chart scrolls with the leader's song, using the band's timing. Nobody's private versions are shared.</p>
    </>
  );
}
