// Stage 10 · Old Brass Brains (US Coast and Geodetic Survey Tide Predicting Machine No. 2). Pure script shared by
// the scene and the narration. A wide view, then a tour along the 37 pulleys from the chain's fixed end (Sa) to the
// pen end (M2), a stop at the record, and a calm pull back. Facts: DECISIONS.md, "Machine" (SP-32, NOAA, Ehret 2008).

import { OBB_37 } from '../tides/machine.ts';
import { ramp, track, windowed, linear } from '../time/tracks.ts';
import { ADDS_T0 } from './adds.ts';
import { registerStage, type Readout } from './index.ts';

export const BRASS_T0 = ADDS_T0;

/** Machine time (days since BRASS_T0): a week across the stage, starting with 2.5 days already on the paper. */
export const brassDays = track(
  [
    [0, 2.5],
    [1, 9.5],
  ],
  linear,
);

/**
 * Tour position along the chain, in pulleys from the fixed end (0 = Sa, 36 = M2): a pause at Sa, a glide along
 * the rear frame, a pause among the big components at the front.
 */
export const tourAt = track([
  [0.22, 0],
  [0.29, 0.6],
  [0.5, 26],
  [0.58, 31.5],
  [0.67, 36],
]);

/** Kelvin's ten against all 37 at San Francisco, one year hourly (src/script/__tests__/brass.test.ts computes it). */
export const TEN_VS_37 = { rmsCm: 6.5, maxCm: 20 };

export function brassState(local: number) {
  const tour = tourAt(local);
  return {
    days: brassDays(local),
    /** 0 → 1 from the wide view into the tour, and back out at the record. */
    tourIn: ramp(local, 0.16, 0.26),
    tourOut: ramp(local, 0.64, 0.74),
    /** The pull back to the whole machine for the last beats. */
    wide: ramp(local, 0.82, 0.95),
    /** Pulleys from the fixed end (fractional). */
    tour,
    /** The pulley in front of the camera. */
    focus: Math.min(OBB_37.length - 1, Math.max(0, Math.round(tour))),
    labels: {
      names: windowed(local, 0.18, 0.8, 0.04, 0.05),
      focus: windowed(local, 0.24, 0.68, 0.03, 0.03),
      chain: windowed(local, 0.42, 0.56, 0.03, 0.03),
      record: windowed(local, 0.7, 0.86, 0.03, 0.04),
    },
  };
}

export type BrassState = ReturnType<typeof brassState>;

export const brass = registerStage('brass', {
  note: 'Components, their order along the chain and every tooth count follow the Survey’s own description (Special Publication 32, 1915); the layout is schematic (one pulley each, not to scale). Cranks are set from NOAA’s San Francisco constants; a week of machine time passes.',
  readouts(local) {
    const rows: Readout[] = [];
    if (local >= 0.69) {
      rows.push(
        { label: 'A year, one port', value: '7–12 h of running', tone: 'warm' },
        { label: '10 vs 37 at SF', value: `${TEN_VS_37.rmsCm} cm RMS, ${TEN_VS_37.maxCm} cm max`, tone: 'b' },
        { label: 'In use', value: '1912–1965', tone: 'plain' },
        { label: 'Pulleys', value: '37 (Kelvin’s: 10)', tone: 'mute' },
      );
    } else {
      rows.push(
        { label: 'Pulleys', value: '37 (Kelvin’s: 10)', tone: 'warm' },
        { label: 'Size', value: '129¼ × 74¼ × 24 in', tone: 'mute' },
        { label: 'Weight', value: 'about 2,500 lb', tone: 'mute' },
        { label: 'In use', value: '1912–1965', tone: 'plain' },
      );
    }
    return rows;
  },
});
