import { useState } from "react";
import {
  canEditBandSettings,
  setScrollWithLeader,
  fixtureSettingsBand,
  type SettingsBand,
} from "./band-settings-model";

export function BandSettingsScreen({ me }: { me: string }) {
  const [band, setBand] = useState<SettingsBand>(fixtureSettingsBand);

  const canEdit = canEditBandSettings(band, me);

  const handleScrollWithLeaderChange = (checked: boolean) => {
    const result = setScrollWithLeader(band, me, checked);
    if (result.ok) {
      setBand(result.band);
    }
  };

  return (
    <div className="band-settings-screen">
      <h1>{band.name}</h1>
      {canEdit ? (
        <div className="band-settings-control">
          <label htmlFor="scroll-with-leader">Scroll with the leader</label>
          <input
            id="scroll-with-leader"
            type="checkbox"
            role="switch"
            aria-checked={band.settings.scrollWithLeader}
            checked={band.settings.scrollWithLeader}
            onChange={(e) => handleScrollWithLeaderChange(e.target.checked)}
          />
          <p className="band-settings-help">
            When on, everyone's chart scrolls with the gig leader.
          </p>
        </div>
      ) : (
        <p className="band-settings-readonly">
          Only band admins can change band settings.
        </p>
      )}
    </div>
  );
}
