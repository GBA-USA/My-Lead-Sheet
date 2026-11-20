import { useEffect, useState } from "react";

/** The phone's charge, or null where the browser cannot read it (iPhone and iPad Safari, Firefox). */
export type Battery = { level: number; low: boolean } | null;

/** 20% or less is low (t821u). */
const LOW_BATTERY = 0.2;

type BatteryManager = EventTarget & { level: number };

/** Read once on mount and again on each `levelchange`, so nothing polls beside the beat timer. */
export function useBattery(): Battery {
  const [battery, setBattery] = useState<Battery>(null);
  useEffect(() => {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }).getBattery;
    if (!getBattery) return;
    let manager: BatteryManager | null = null;
    let live = true;
    const read = () => manager && setBattery({ level: manager.level, low: manager.level <= LOW_BATTERY });
    getBattery.call(navigator).then(
      (found) => {
        if (!live) return;
        manager = found;
        read();
        found.addEventListener("levelchange", read);
      },
      () => {},
    );
    return () => {
      live = false;
      manager?.removeEventListener("levelchange", read);
    };
  }, []);
  return battery;
}
