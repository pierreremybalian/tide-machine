// Stage 9 · Gears that keep astronomical time. Pure script shared by the scene, the narration and the HUD card.
//
// Each crank must turn at its constituent's speed, but gears can only make ratios of whole numbers of teeth.
// The stage looks at one train (Kelvin's M2, our closest two-stage approximation, since his tooth counts do not
// survive), then runs a simulated year and lays out how far every crank of the US machine (real SP-32 tooth counts)
// and of Kelvin's (ours) has drifted from the sky: the drift ladder. Then every crank is reset, as it was before
// each port and year.

import { BY_NAME, speed } from '../tides/constituents.ts';
import {
  DAY_SHAFT_SPEED,
  DEFAULT_TEETH,
  gearTrain,
  KELVIN_1872,
  OBB_37,
  OBB_SHAFT_SPEED,
  OBB_TRAINS,
  type GearTrain,
} from '../tides/machine.ts';
import { track, windowed, linear } from '../time/tracks.ts';
import { ADDS_T0, pretty } from './adds.ts';
import { registerStage, type Readout } from './index.ts';

export const GEARS_T0 = ADDS_T0;

/** Machine time of the Kelvin machine behind (days since GEARS_T0): carries on from stage 8, slowly. */
export const gearsDays = track(
  [
    [0, 43],
    [0.12, 43.2],
    [0.42, 46],
    [1, 47],
  ],
  linear,
);

/** The simulated year of the drift ladder, 0–1. */
export const yearRun = track([
  [0.5, 0],
  [0.77, 1],
]);

/** Every crank reset to the sky: the beads glide home. */
export const resetRun = track([
  [0.84, 0],
  [0.9, 1],
]);

// ── Trains ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LadderRow {
  name: string;
  /** Degrees per hour. */
  speed: number;
  obb: GearTrain;
  /** Kelvin's crank, if his machine had this constituent (our approximation). */
  kelvin?: GearTrain;
}

let rowsCache: LadderRow[] | null = null;

/** Old Brass Brains' 37 trains (SP-32 Table C; M1 is the best approximation) in order of speed, with Kelvin's ten. */
export function ladderRows(): LadderRow[] {
  if (rowsCache) return rowsCache;
  const kelvin = new Set(KELVIN_1872);
  rowsCache = [...OBB_37]
    .map((name) => {
      const sp = speed(BY_NAME.get(name)!);
      return {
        name,
        speed: sp,
        obb: gearTrain(sp, OBB_SHAFT_SPEED, DEFAULT_TEETH, OBB_TRAINS[name]),
        kelvin: kelvin.has(name) ? gearTrain(sp, DAY_SHAFT_SPEED) : undefined,
      };
    })
    .sort((a, b) => a.speed - b.speed);
  return rowsCache;
}

/** Kelvin's M2 train, the one in close-up. */
export function closeTrain(): GearTrain {
  return ladderRows().find((r) => r.name === 'M2')!.kelvin!;
}

/** The worst of Old Brass Brains' trains over a year. */
export function worstObb(): LadderRow {
  return ladderRows().reduce((w, r) => (Math.abs(r.obb.driftPerYear) > Math.abs(w.obb.driftPerYear) ? r : w));
}

/** Timing error after a year: the drift as minutes of the constituent's own cycle. */
export const driftMinutes = (row: LadderRow, train: GearTrain = row.obb): number =>
  (train.driftPerYear / row.speed) * 60;

/**
 * What a year of gearing error does to San Francisco's predicted tide, largest over the year (computed in
 * src/script/__tests__/gears.test.ts from the station's constants: crank angles geared vs true, node factors fixed).
 */
export const SF_GEAR_ERROR_MM = { obb: 2.7, kelvin: 0.4 };

/** Ladder full scale: ± this many degrees of crank angle. */
export const LADDER_DEG = 1;

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function gearsState(local: number) {
  const year = yearRun(local);
  const reset = resetRun(local);
  return {
    days: gearsDays(local),
    /** 0 → 1: the camera moves in on M2's train, and back out. */
    close: windowed(local, 0.12, 0.47, 0.1, 0.07),
    /** The ladder, in front of the dimmed machine. */
    ladder: windowed(local, 0.43, 1.01, 0.06, 0.01),
    /** Simulated time on the ladder (fraction of a year), and how far the reset has brought the beads home. */
    year,
    reset,
    /** Drift scale applied to the beads: the year so far, undone by the reset. */
    drift: year * (1 - reset),
    card: local > 0.21 && local < 0.45,
    labels: {
      teeth: windowed(local, 0.17, 0.44, 0.03, 0.03),
      shaft: windowed(local, 0.2, 0.44, 0.03, 0.03),
      crank: windowed(local, 0.2, 0.44, 0.03, 0.03),
      rows: windowed(local, 0.47, 1.01, 0.04, 0.01),
      notes: windowed(local, 0.66, 0.86, 0.04, 0.03),
      sky: windowed(local, 0.48, 1.01, 0.04, 0.01),
    },
  };
}

export type GearsState = ReturnType<typeof gearsState>;

const fmtRatio = (x: number) => x.toFixed(7);
const fmtDrift = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 0.1 ? 3 : 2)}°`;
export { fmtDrift, fmtRatio };

export const gears = registerStage('gears', {
  note: 'Tooth counts are Old Brass Brains’ own (US Coast and Geodetic Survey Special Publication 32); Kelvin’s do not survive, so his trains are the closest two-stage ratios we found. Drift is computed from the ratios over a simulated year.',
  readouts(local) {
    const s = gearsState(local);
    const rows: Readout[] = [];
    if (local < 0.45) {
      const t = closeTrain();
      rows.push(
        { label: 'Day shaft', value: '1 turn a day', tone: 'mute' },
        { label: 'M2 needs', value: `×${fmtRatio(t.target)}`, tone: 'b' },
        { label: 'Gears give', value: `×${fmtRatio(t.ratio)}`, tone: 'warm' },
        { label: 'Drift', value: `${fmtDrift(t.driftPerYear)} a year`, tone: 'plain' },
      );
    } else {
      const w = worstObb();
      const day = Math.round(s.year * 365);
      rows.push(
        { label: 'Run', value: s.reset > 0.5 ? 'reset for next year' : `day ${day} of 365`, tone: 'warm' },
        { label: 'Scale', value: `±${LADDER_DEG}° of crank angle`, tone: 'mute' },
        {
          label: 'Worst crank',
          value: `${pretty(w.name)}: ${fmtDrift(w.obb.driftPerYear)} a year`,
          tone: 'plain',
        },
        {
          label: 'At San Francisco',
          value: `< ${Math.ceil(SF_GEAR_ERROR_MM.obb)} mm after a year`,
          tone: 'b',
        },
      );
    }
    return rows;
  },
});
