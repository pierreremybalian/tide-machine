// Stage 7 · Taking the tide apart (harmonic analysis). Pure script shared by the scene, the HUD and the narration.
// A year of hourly readings at San Francisco (public/data/sf-year.json, NOAA gauge 9414290, 2025) is fitted with the
// speeds of 31 rhythms by least squares (src/tides/analysis.ts, Kelvin's method). The fit is precomputed here and a
// test reruns analyse() on the record and checks every number. Sa and Ssa are left out, as in the tide-core test:
// one year cannot separate the seasonal cycles from that year's weather (NOAA takes them from 20 years).

import { ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';
import { prettyName, sfConstant } from './rhythms.ts';

/** The record: hourly, from 2025-01-01 00:00 UTC, metres above MLLW (stored in mm). */
export const RECORD = { url: '/data/sf-year.json', start: Date.parse('2025-01-01T00:00Z'), hours: 8760 };

/** analyse(sf-year, all of San Francisco's constituents but SA and SSA): mean level, residual RMS (m). */
export const FIT_Z0 = 1.0123;
export const FIT_RMS = 0.072;

/** Our fit: name, amplitude H (m), Greenwich phase κ (degrees), sorted by height. */
export const FIT: readonly (readonly [name: string, H: number, kappa: number])[] = [
  ['M2', 0.5681, 209.2],
  ['K1', 0.3697, 225.7],
  ['O1', 0.2291, 209.2],
  ['S2', 0.1375, 216.7],
  ['N2', 0.1238, 183.9],
  ['P1', 0.114, 223.3],
  ['K2', 0.0421, 207.4],
  ['Q1', 0.0404, 200.3],
  ['NU2', 0.024, 188.4],
  ['M1', 0.0227, 244.7],
  ['M4', 0.0226, 130.8],
  ['J1', 0.0213, 239.2],
  ['L2', 0.021, 227.3],
  ['MK3', 0.0189, 126.3],
  ['2MK3', 0.0159, 94.1],
  ['2N2', 0.014, 161.7],
  ['OO1', 0.0113, 265.1],
  ['MS4', 0.0112, 143.3],
  ['MN4', 0.0098, 110.4],
  ['LAM2', 0.0085, 189.4],
  ['T2', 0.0079, 204.8],
  ['RHO', 0.0077, 194.2],
  ['MU2', 0.0057, 112.5],
  ['S1', 0.0055, 299.0],
  ['2Q1', 0.0053, 190.5],
  ['MF', 0.0053, 63.6],
  ['M3', 0.0031, 183.7],
  ['2SM2', 0.0027, 37.0],
  ['M6', 0.0016, 346.2],
  ['R2', 0.0016, 48.5],
  ['M8', 0.0, 49.0],
];
export const FIT_NAMES = FIT.map((r) => r[0]);

export function fitOf(name: string): { H: number; kappa: number } {
  const row = FIT.find((r) => r[0] === name);
  if (!row) throw new Error(`not fitted: ${name}`);
  return { H: row[1], kappa: row[2] };
}

/** The rows the record unweaves into (the eight largest), top to bottom. */
export const ROWS = ['M2', 'K1', 'O1', 'S2', 'N2', 'P1', 'K2', 'Q1'] as const;

/** The month shown up close: December 2025 (hours from RECORD.start). */
export const WINDOW = { from: 334 * 24, to: 8760 };
/** The largest hourly gap between record and fit: 2025-12-24 12:00 UTC, +0.47 m (tested). */
export const SURGE = { hours: 357 * 24 + 12, metres: 0.47 };

/** Hours (from RECORD.start) of the cursor that drives the dials. */
const cursor = track([
  [0.36, 19 * 24 + 334 * 24],
  [0.86, SURGE.hours],
]);

export interface ApartState {
  /** 0 → 1: the year is drawn. */
  draw: number;
  /** 0 → 1: from the year to December. */
  zoom: number;
  /** 0 → 1: the record moves into the right-hand column above the rows. */
  column: number;
  /** Per row, 0 → 1: peeled off the record into its own line (back to 0 when the rows give way). */
  peel: number[];
  /** Per row, 0 → 1: fitted (stays 1 once the row has peeled). */
  seen: number[];
  /** 0 → 1: the phase–amplitude plot (ours vs NOAA). */
  polar: number;
  /** 0–1: M2 singled out (our fit vs NOAA). */
  m2: number;
  /** Cursor time (hours from RECORD.start). */
  cursor: number;
  /** 0 → 1: the fitted sum laid over the record. */
  sum: number;
  /** 0 → 1: the rows give way to the residual. */
  residual: number;
  /** 0 → 1: the comparison table (HUD card). */
  table: number;
}

const PEEL0 = 0.38;
const PEEL_STEP = 0.024;

export function apartState(local: number, out?: ApartState): ApartState {
  const o = out ?? ({ peel: ROWS.map(() => 0), seen: ROWS.map(() => 0) } as ApartState);
  o.draw = ramp(local, 0.1, 0.23);
  o.zoom = ramp(local, 0.24, 0.33);
  o.column = ramp(local, 0.33, 0.4);
  const fade = 1 - ramp(local, 0.7, 0.75);
  for (let i = 0; i < ROWS.length; i++) {
    o.seen[i] = ramp(local, PEEL0 + i * PEEL_STEP, PEEL0 + i * PEEL_STEP + 0.05);
    o.peel[i] = o.seen[i]! * fade;
  }
  o.polar = ramp(local, 0.36, 0.42);
  o.m2 = windowed(local, 0.53, 0.66, 0.03);
  o.cursor = cursor(local);
  o.sum = ramp(local, 0.62, 0.68);
  o.residual = ramp(local, 0.72, 0.8);
  o.table = ramp(local, 0.84, 0.88);
  return o;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function recordDate(hours: number, withTime = false): string {
  const d = new Date(RECORD.start + hours * 3600e3);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withTime ? `${day} · ${String(d.getUTCHours()).padStart(2, '0')}:00` : day;
}

export function fmtArm(H: number, kappa: number): string {
  return `${H.toFixed(3)} m · ${kappa.toFixed(1)}°`;
}

const scratch = apartState(0);

export const apart = registerStage('apart', {
  note: 'The record is NOAA’s hourly water level at San Francisco for 2025; every height and phase on screen is our least-squares fit to it, set beside NOAA’s published constants. Rows are drawn to the same vertical scale.',
  readouts(local) {
    const s = apartState(local, scratch);
    const rows: Readout[] = [];
    if (s.draw > 0.3 && s.column < 0.5)
      rows.push({ label: 'Record', value: '8,760 hours · 2025', tone: 'plain' });
    if (s.column >= 0.5 && s.residual < 0.5)
      rows.push({
        label: 'Rhythms fitted',
        value: `${FIT.length} · ${2 * FIT.length + 1} numbers`,
        tone: 'plain',
      });
    if (s.peel[0]! > 0.5 || s.sum > 0) {
      const ours = fitOf('M2');
      const noaa = sfConstant('M2');
      rows.push({ label: `${prettyName('M2')} · our fit`, value: fmtArm(ours.H, ours.kappa), tone: 'b' });
      rows.push({ label: `${prettyName('M2')} · NOAA`, value: fmtArm(noaa.H, noaa.kappa), tone: 'mute' });
    }
    if (s.residual > 0.5)
      rows.push({ label: 'Left over (2025)', value: `${(FIT_RMS * 100).toFixed(1)} cm RMS`, tone: 'warm' });
    return rows;
  },
});
