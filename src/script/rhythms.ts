// Stage 6 · Many rhythms (the constituent spectrum). Pure script shared by the scene, the HUD and the narration.
// Each of NOAA's constituents is a line at its speed (fixed by astronomy: src/tides/constituents.ts) with a height
// measured at San Francisco. The camera zooms through the families: twice a day, once a day, slow, shallow water.

import { BY_NAME, period, speed, type Constituent, type Family } from '../tides/constituents.ts';
import { ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

/**
 * NOAA's harmonic constants for San Francisco, 9414290 (public/data/stations/9414290.json; a test keeps them equal):
 * name, amplitude H (m), Greenwich phase lag κ (degrees). NOAA lists 37 constituents; Mm, MSf, S4 and S6 have zero
 * height here (Mm and MSf are "unstable and not used"), which leaves these 33. Sorted by height.
 */
export const SF_CONSTANTS: readonly (readonly [name: string, H: number, kappa: number])[] = [
  ['M2', 0.576, 208.2],
  ['K1', 0.37, 225.4],
  ['O1', 0.23, 208.4],
  ['S2', 0.137, 216.2],
  ['N2', 0.122, 183.2],
  ['P1', 0.114, 222.1],
  ['SA', 0.044, 200.2],
  ['Q1', 0.041, 202.4],
  ['K2', 0.04, 206],
  ['SSA', 0.03, 272.3],
  ['NU2', 0.026, 189.9],
  ['M4', 0.022, 136.8],
  ['J1', 0.019, 244.3],
  ['MK3', 0.018, 124.1],
  ['L2', 0.018, 229.6],
  ['MF', 0.015, 153.1],
  ['2MK3', 0.014, 92.2],
  ['2N2', 0.013, 153.3],
  ['OO1', 0.012, 260],
  ['M1', 0.011, 237.5],
  ['MS4', 0.01, 149],
  ['RHO', 0.009, 200],
  ['T2', 0.009, 204.6],
  ['MN4', 0.008, 112],
  ['MU2', 0.007, 100.2],
  ['LAM2', 0.007, 214.3],
  ['S1', 0.007, 282.6],
  ['2Q1', 0.006, 208.6],
  ['2SM2', 0.003, 37.3],
  ['M3', 0.003, 37.6],
  ['M6', 0.002, 7.3],
  ['R2', 0.001, 126.8],
  ['M8', 0.001, 108.5],
];
/** NOAA's standard list (the four zero-height ones included). */
export const NOAA_COUNT = 37;

export function sfConstant(name: string): { H: number; kappa: number } {
  const row = SF_CONSTANTS.find((r) => r[0] === name);
  if (!row) throw new Error(`no San Francisco constant for ${name}`);
  return { H: row[1], kappa: row[2] };
}

/** Conventional typography for constituent names (NOAA writes them in capitals). */
const PRETTY: Record<string, string> = {
  SA: 'Sa',
  SSA: 'Ssa',
  MF: 'Mf',
  MM: 'Mm',
  MSF: 'MSf',
  RHO: 'ρ1',
  MU2: 'μ2',
  NU2: 'ν2',
  LAM2: 'λ2',
};
export function prettyName(name: string): string {
  return PRETTY[name] ?? name;
}

export interface Line {
  name: string;
  label: string;
  c: Constituent;
  family: Family;
  /** Degrees per hour. */
  speed: number;
  /** Hours. */
  period: number;
  H: number;
  kappa: number;
}

export const LINES: readonly Line[] = SF_CONSTANTS.map(([name, H, kappa]) => {
  const c = BY_NAME.get(name);
  if (!c) throw new Error(`unknown constituent ${name}`);
  return { name, label: prettyName(name), c, family: c.family, speed: speed(c), period: period(c), H, kappa };
});

export function lineByName(name: string): Line {
  const l = LINES.find((x) => x.name === name);
  if (!l) throw new Error(`no line ${name}`);
  return l;
}

/** Overview axis (°/h → axis units): linear to 60°/h, compressed beyond so the 6- and 8-a-day overtides fit. */
export function axisOf(speedDegH: number): number {
  return speedDegH <= 60 ? speedDegH : 60 + (speedDegH - 60) * 0.15;
}

/** The views the stage zooms through: centre and half-width on the overview axis. */
export const VIEWS = {
  all: { centre: 33.4, half: 35, y: 1 },
  semi: { centre: 29.25, half: 2.05, y: 1 },
  diurnal: { centre: 14.45, half: 2.1, y: 1 },
  long: { centre: 0.56, half: 0.72, y: 8 },
  shallow: { centre: 50.7, half: 9.2, y: 14 },
} as const;
export type ViewId = keyof typeof VIEWS;

/** Beats: which view is on screen, and which lines are singled out with their cause. */
export const BEATS: readonly { from: number; view: ViewId; focus: readonly string[] }[] = [
  { from: 0, view: 'all', focus: [] },
  { from: 0.25, view: 'semi', focus: ['M2', 'S2', 'N2'] },
  { from: 0.39, view: 'diurnal', focus: ['K1', 'O1'] },
  { from: 0.53, view: 'long', focus: ['SA'] },
  { from: 0.65, view: 'shallow', focus: ['M4'] },
  { from: 0.79, view: 'all', focus: [] },
];

const centre = track([
  [0.25, VIEWS.all.centre],
  [0.3, VIEWS.semi.centre],
  [0.39, VIEWS.semi.centre],
  [0.44, VIEWS.diurnal.centre],
  [0.53, VIEWS.diurnal.centre],
  [0.58, VIEWS.long.centre],
  [0.65, VIEWS.long.centre],
  [0.7, VIEWS.shallow.centre],
  [0.79, VIEWS.shallow.centre],
  [0.85, VIEWS.all.centre],
]);
// The half-width is interpolated in log space so zooms feel even.
const logHalf = track([
  [0.25, Math.log(VIEWS.all.half)],
  [0.3, Math.log(VIEWS.semi.half)],
  [0.39, Math.log(VIEWS.semi.half)],
  [0.415, Math.log(5)],
  [0.44, Math.log(VIEWS.diurnal.half)],
  [0.53, Math.log(VIEWS.diurnal.half)],
  [0.555, Math.log(6)],
  [0.58, Math.log(VIEWS.long.half)],
  [0.65, Math.log(VIEWS.long.half)],
  [0.675, Math.log(8)],
  [0.7, Math.log(VIEWS.shallow.half)],
  [0.79, Math.log(VIEWS.shallow.half)],
  [0.85, Math.log(VIEWS.all.half)],
]);
// Vertical magnification (the small families are drawn taller; the grid labels say so).
const logY = track([
  [0.53, 0],
  [0.58, Math.log(VIEWS.long.y)],
  [0.65, Math.log(VIEWS.long.y)],
  [0.7, Math.log(VIEWS.shallow.y)],
  [0.79, Math.log(VIEWS.shallow.y)],
  [0.85, 0],
]);

export interface RhythmsState {
  /** 0 → 1: lines grow from the axis. */
  grow: number;
  /** View centre and half-width on the overview axis. */
  centre: number;
  half: number;
  /** Vertical magnification (1 = the overview's scale). */
  yScale: number;
  /** Index into BEATS of the beat on screen. */
  beat: number;
  /** 0–1: how settled the current view is (labels fade in once a zoom lands). */
  settled: number;
  /** 0 → 1: family names over the overview. */
  families: number;
  /** 0 → 1: the closing overview makes room for the table card. */
  table: number;
}

export function rhythmsState(local: number): RhythmsState {
  let beat = 0;
  for (let i = 0; i < BEATS.length; i++) if (local >= BEATS[i]!.from) beat = i;
  const b = BEATS[beat]!;
  const next = BEATS[beat + 1]?.from ?? 1.2;
  return {
    grow: ramp(local, 0.1, 0.2),
    centre: centre(local),
    half: Math.exp(logHalf(local)),
    yScale: Math.exp(logY(local)),
    beat,
    settled:
      beat === 0 ? ramp(local, 0.16, 0.22) : windowed(local, b.from + 0.045, next + 0.005, 0.02, 0.012),
    families: windowed(local, 0.15, 0.27, 0.03, 0.02) + ramp(local, 0.86, 0.9),
    table: ramp(local, 0.82, 0.88),
  };
}

export function hmPeriod(hours: number): string {
  if (hours > 72) return `${(hours / 24).toFixed(hours > 2400 ? 1 : 2)} days`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m === 60 ? `${h + 1} h 00 min` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export function cm(H: number): string {
  return H >= 0.1 ? `${H.toFixed(2)} m` : `${(H * 100).toFixed(1)} cm`;
}

export const rhythms = registerStage('rhythms', {
  note: 'Speeds come from astronomy (Doodson’s six cycles); heights are NOAA’s for San Francisco, drawn to scale (the slow and shallow-water families are magnified 8× and 14×, as the grid shows). The speed axis is linear up to four tides a day and compressed beyond.',
  readouts(local) {
    const s = rhythmsState(local);
    const rows: Readout[] = [{ label: 'Rhythms in NOAA’s list', value: String(NOAA_COUNT), tone: 'plain' }];
    const b = BEATS[s.beat]!;
    for (const name of b.focus) {
      const l = lineByName(name);
      rows.push({
        label: l.label,
        value: `${hmPeriod(l.period)} · ${cm(l.H)}`,
        tone:
          name === 'M2' || name === 'S2' || name === 'N2'
            ? 'b'
            : name === 'SA'
              ? 'light'
              : name === 'M4'
                ? 'plain'
                : 'a',
      });
    }
    if (!b.focus.length && s.grow > 0.5)
      rows.push({ label: 'Largest at San Francisco', value: `M2 · ${cm(lineByName('M2').H)}`, tone: 'b' });
    return rows;
  },
});
