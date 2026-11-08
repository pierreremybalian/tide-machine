// Stage 11 · Turn the crank. Pure script shared by the scene, the narration and the HUD.
//
// Old Brass Brains, set to San Francisco (NOAA 9414290, Fort Point at the Golden Gate) for the first week of
// January 2026, beside the bay. Scroll turns the crank: machine time runs through the week, the pen draws, and the
// bay's water stands at the level the 35 in-bay stations predict for the same instant. The pen's height *is* the
// water at the Golden Gate. NOAA's own official hourly prediction for the station (public/data/validation) is laid
// over the trace, and the largest difference over the week's 169 hourly values is computed here, not typed.

import sfStation from '../../public/data/stations/9414290.json';
import noaaJan from '../../public/data/validation/9414290-2026-01.json';
import { createMachineModel, createMachineState, machineAt, penSeries } from '../tides/machine.ts';
import type { StationConstants } from '../tides/predict.ts';
import { ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

/** NOAA's San Francisco constants and datums (Fort Point, 9414290). */
export const SF: StationConstants & { lat: number; lng: number; name: string } = sfStation;
export const HOUR_MS = 3600e3;
export const WEEK_H = 168;
/** Machine time at local 0: 2026-01-01 00:00 PST (the winter king tides of the new year). */
export const CRANK_T0 = Date.UTC(2026, 0, 1, 8);
export const CRANK_SPAN = WEEK_H * HOUR_MS;

/** NOAA's official hourly predictions for the week, m above MLLW (169 values: both ends included). */
export const NOAA_WEEK: Float64Array = (() => {
  const start = Date.parse(noaaJan.start);
  const i0 = Math.round((CRANK_T0 - start) / HOUR_MS);
  const out = new Float64Array(WEEK_H + 1);
  for (let h = 0; h <= WEEK_H; h++) out[h] = noaaJan.values[i0 + h]! / 1000;
  return out;
})();

/**
 * Old Brass Brains' scale as the brass renderer sets it (0.4 machine units per metre, less for big tides): the
 * reading divides it out, so it only matters for the drawing; the pen series below is the mechanism's.
 */
const OBB_SCALE = Math.min(0.4, 0.23 / Math.max(...SF.constituents.map((c) => c.amplitude)));

const MODEL = createMachineModel(SF, 'obb', { t0: CRANK_T0, scale: OBB_SCALE });
const STATE = createMachineState(MODEL);

/** The machine's pen, hourly through the week (geared drive, cranks and node factors set at CRANK_T0), m above MLLW. */
export const PEN_WEEK: Float64Array = penSeries(MODEL, 'geared', CRANK_T0, 60, WEEK_H + 1);

/** The pen at any machine time (the mechanism itself, ≈ 25 µs). */
export const penAtMs = (ms: number): number => machineAt(MODEL, ms, 'geared', STATE).height;

/** Largest |pen − NOAA| over the week's hourly values (m), and when (hours from CRANK_T0). */
export const MAX_DIFF = (() => {
  let m = 0;
  let at = 0;
  let sq = 0;
  for (let h = 0; h <= WEEK_H; h++) {
    const d = Math.abs(PEN_WEEK[h]! - NOAA_WEEK[h]!);
    sq += d * d;
    if (d > m) {
      m = d;
      at = h;
    }
  }
  return { m, at, rms: Math.sqrt(sq / (WEEK_H + 1)) };
})();

/** Catmull–Rom through NOAA's hourly values (between hours only; at the hours it is NOAA's number exactly). */
export function noaaAt(hours: number): number {
  const h = Math.min(WEEK_H, Math.max(0, hours));
  const i = Math.min(WEEK_H - 1, Math.floor(h));
  const t = h - i;
  const p = (k: number) => NOAA_WEEK[Math.min(WEEK_H, Math.max(0, k))]!;
  const p0 = p(i - 1);
  const p1 = p(i);
  const p2 = p(i + 1);
  const p3 = p(i + 2);
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

// ── Timeline ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Machine hours since CRANK_T0: the first day slowly (watch pen and water move together), then the week. */
export const crankHours = track([
  [0.1, 0],
  [0.34, 24],
  [0.88, WEEK_H],
]);

export interface CrankState {
  hours: number;
  ms: number;
  /** 0 → 1: the two panels open from the machine alone. */
  split: number;
  /** 0 → 1: NOAA's hourly points on the trace and in the card. */
  noaaOn: number;
  /** 0 → 1: the difference readout and the card's residual strip. */
  diffOn: number;
  /** 0 → 1: the Golden Gate marker and the "same number" labels. */
  link: number;
  /** Hand-wheel glow while the crank turns. */
  turning: number;
}

export function crankState(local: number): CrankState {
  const hours = crankHours(local);
  return {
    hours,
    ms: CRANK_T0 + hours * HOUR_MS,
    split: ramp(local, 0.03, 0.11),
    noaaOn: ramp(local, 0.44, 0.5),
    diffOn: ramp(local, 0.56, 0.62),
    link: ramp(local, 0.12, 0.18),
    turning: windowed(local, 0.1, 0.88, 0.02),
  };
}

const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const formatMachineTime = (ms: number) => `${fmtTime.format(ms)} PST`;
const metres = (m: number) => `${m < 0 ? '−' : '+'}${Math.abs(m).toFixed(2)} m`;

/** The pen and the official number at machine time, m above MLLW. */
export function crankReadings(local: number) {
  const s = crankState(local);
  return { ...s, penM: penAtMs(s.ms), noaaM: noaaAt(s.hours) };
}

/** The pen between hourly samples: linear in the precomputed series is not enough at a crest, so Catmull–Rom too. */
export function penAt(hours: number): number {
  const h = Math.min(WEEK_H, Math.max(0, hours));
  const i = Math.min(WEEK_H - 1, Math.floor(h));
  const t = h - i;
  const p = (k: number) => PEN_WEEK[Math.min(WEEK_H, Math.max(0, k))]!;
  const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

export const crank = registerStage('crank', {
  note: 'The machine is Old Brass Brains’ mechanism, computed with its real gear trains and set once for the week from NOAA’s San Francisco constants; the bay’s water comes from 35 NOAA stations, interpolated. Heights above mean lower low water; relief and water ×3; a week of machine time across the scroll.',
  readouts(local) {
    const r = crankReadings(local);
    const rows: Readout[] = [
      { label: 'Machine time', value: formatMachineTime(r.ms), tone: 'plain' },
      { label: 'Pen · Golden Gate', value: metres(r.penM), tone: 'warm' },
    ];
    if (r.noaaOn > 0.5) rows.push({ label: 'NOAA official', value: metres(r.noaaM), tone: 'b' });
    if (r.diffOn > 0.5) rows.push({ label: 'Machine vs NOAA, max', value: `${(MAX_DIFF.m * 100).toFixed(1)} cm`, tone: 'both' });
    return rows;
  },
});
