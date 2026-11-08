// Stage 13 · Any coast on Earth. Pure script shared by the scene, the narration and the finale panel.
// A short guided intro on the globe (where tides are measured, where they are modelled), then the tool: from TOOL_AT
// on, the reader picks the place. The dual clock shows the chosen place's numbers, which the finale panel computes
// and hands over with setFinaleReadouts (the narration redraws them through src/story/live.ts).

import { ramp } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

/** From here the tool is live (pointer, keyboard, search). */
export const TOOL_AT = 0.42;

export interface AnywhereState {
  /** 0 → 1: NOAA's harmonic stations light up along the US coasts (measured). */
  stations: number;
  /** 0 → 1: EOT20's M2 tint spreads over the oceans (modelled). */
  tint: number;
  /** 0 → 1: the tool is on. */
  tool: number;
  /** Slow automatic spin of the globe before the reader takes over (radians per second). */
  spin: number;
}

export function anywhereState(local: number): AnywhereState {
  const tool = ramp(local, TOOL_AT - 0.04, TOOL_AT);
  return {
    stations: ramp(local, 0.14, 0.22),
    tint: ramp(local, 0.26, 0.34),
    tool,
    spin: 0.05 * (1 - tool),
  };
}

let placeRows: Readout[] | null = null;

/** The finale panel's rows for the chosen place (null: none chosen). */
export function setFinaleReadouts(rows: Readout[] | null): void {
  placeRows = rows;
}

export const anywhere = registerStage('anywhere', {
  note: 'Measured where NOAA has a tide station within 25 km: its own harmonic constants, the same sum as the machine. Modeled everywhere else: the EOT20 global ocean tide model from satellite altimetry, relative to mean sea level and coarser inside bays. Terrain is live; relief and water are exaggerated (stated per place); waves are a default wind sea.',
  readouts(local) {
    const s = anywhereState(local);
    if (s.tool > 0.5 && placeRows) return placeRows;
    const rows: Readout[] = [];
    if (s.stations > 0.5) rows.push({ label: 'NOAA tide stations', value: '1,374 · measured', tone: 'warm' });
    if (s.tint > 0.5) rows.push({ label: 'Everywhere else', value: 'EOT20 · modeled', tone: 'b' });
    return rows;
  },
});
