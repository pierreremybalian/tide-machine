// Stage 8 · A machine that adds (Kelvin, 1872). Pure script shared by the scene, the narration and the HUD.
//
// The machine is built in front of you, in Thomson's own order from the pen end (ICE Minutes vol. 65, p. 18):
// one crank and pulley (M2) whose height traces a sine wave; then S2 and the wire, and the pen draws their sum, the
// spring–neap beat; then the other eight; then the frame and gearing close round them and the full machine draws
// San Francisco. Machine time is a track of `local` (scroll is the argument); each new crank's pin slides out to
// its throw over a stretch of machine time, so the paper shows the moment it joined the sum.

import { KELVIN_1872 } from '../tides/machine.ts';
import { BY_NAME, speed } from '../tides/constituents.ts';
import { ramp, track, windowed, linear } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

/** Start of the run (the SF week in public/data/sf-week.json): the cranks are set for this instant. */
export const ADDS_T0 = Date.parse('2025-06-01T00:00Z');
export const DAY_MS = 86400e3;

/** Kelvin's ten from the pen end, the order Thomson lists them and the order they are added here. */
export const THOMSON_ORDER: readonly string[] = [...KELVIN_1872].reverse();

/** Display names (NOAA's ids are upper case ASCII). */
const PRETTY: Record<string, string> = {
  SA: 'Sa',
  SSA: 'Ssa',
  MM: 'Mm',
  MF: 'Mf',
  MSF: 'MSf',
  RHO: 'ρ1',
  LAM2: 'λ2',
  MU2: 'μ2',
  NU2: 'ν2',
};
export const pretty = (name: string): string => PRETTY[name] ?? name;

/** Period of a constituent in hours. */
export const periodHours = (name: string): number => 360 / speed(BY_NAME.get(name)!);

/** "12 h 25 min" for periods under two days, else "14.8 d". */
export function formatPeriod(hours: number): string {
  if (hours >= 48) return `${(hours / 24).toFixed(1)} d`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m === 60 ? `${h + 1} h` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Kelvin's machine ran "a year's tides for any port in about four hours" (Thomson 1881): a year of machine time in
 * four hours of turning, about 2,200 times faster than the tide.
 */
export const KELVIN_SPEEDUP = (365.25 * 24) / 4;

// ── Timeline ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Machine time (days since ADDS_T0) through the stage: slow while one crank turns, a month for the beat, then calm. */
export const machineDays = track(
  [
    [0, 0],
    [0.12, 0.25],
    [0.34, 3],
    [0.4, 4],
    [0.56, 35],
    [0.72, 37],
    [0.8, 40],
    [1, 43],
  ],
  linear,
);

/** Days of record shown across the paper: a day and a half, opened out to a month for the beat, back to 2.5 days
 * (the full machine's paper feed) before the swap. */
export const windowDays = track([
  [0.4, 1.5],
  [0.52, 30],
  [0.58, 30],
  [0.72, 2.5],
]);

/** When each crank arrives (local), in Thomson's order: M2 is there from the start. */
export interface Arrival {
  name: string;
  /** Local at which it starts moving in, and at which it is seated. */
  a0: number;
  a1: number;
  /** Machine days over which its pin slides out to the full throw. */
  d0: number;
  d1: number;
}

const FLY = 0.012;
const SET = 0.01;
export const ARRIVALS: readonly Arrival[] = THOMSON_ORDER.map((name, q) => {
  const a0 = q === 0 ? -1 : q === 1 ? 0.335 : 0.56 + (q - 2) * 0.02;
  const a1 = q === 0 ? -1 : a0 + (q === 1 ? 0.03 : FLY);
  const s1 = q === 0 ? -1 : a1 + (q === 1 ? 0.03 : SET);
  return { name, a0, a1, d0: q === 0 ? -1e9 : machineDays(a1), d1: q === 0 ? -1e8 : machineDays(s1) };
});

/** The wire threads both pulleys here; the pen's record starts at this machine day. */
export const WIRE_LOCAL = [0.375, 0.41] as const;
export const WIRE_DAY = machineDays(WIRE_LOCAL[1]);
/** The frame, gear trains and record close round the ten (the brass assembly takes over). */
export const SWAP = [0.79, 0.83] as const;

/** Fraction of crank q's throw set at machine day d (0 before its pin moves, 1 once clamped). */
export function throwFrac(q: number, day: number): number {
  const a = ARRIVALS[q]!;
  if (day <= a.d0) return 0;
  if (day >= a.d1) return 1;
  const s = (day - a.d0) / (a.d1 - a.d0);
  return s * s * (3 - 2 * s);
}

export function addsState(local: number) {
  const days = machineDays(local);
  const arrive = ARRIVALS.map((a, q) => (q === 0 ? 1 : ramp(local, a.a0, a.a1)));
  let seated = 0;
  for (let q = 0; q < arrive.length; q++) if (arrive[q]! >= 1 && throwFrac(q, days) >= 0.5) seated = q + 1;
  return {
    days,
    window: windowDays(local),
    arrive,
    /** Cranks turning (pin out at least halfway). */
    seated,
    /** Phase 1: the lone pulley's height drawn as a trail. */
    trail: windowed(local, 0.12, 0.37, 0.04, 0.03),
    /** The wire, guides, pen and paper. */
    wire: ramp(local, WIRE_LOCAL[0], WIRE_LOCAL[1]),
    paper: ramp(local, 0.36, 0.4),
    /** 0 → 1: the brass assembly takes over from the rig. */
    swap: ramp(local, SWAP[0], SWAP[1]),
    labels: {
      throw: windowed(local, 0.15, 0.35, 0.025, 0.02),
      angle: windowed(local, 0.19, 0.35, 0.025, 0.02),
      gear: windowed(local, 0.23, 0.35, 0.025, 0.02),
      sine: windowed(local, 0.16, 0.35, 0.03, 0.02),
      period: windowed(local, 0.26, 0.35, 0.025, 0.02),
      /** The lone crank named with its period. */
      first: windowed(local, 0.13, 0.36, 0.03, 0.03),
      wire: windowed(local, 0.42, 0.58, 0.03, 0.03),
      pen: windowed(local, 0.45, 0.78, 0.03, 0.03),
      beat: windowed(local, 0.515, 0.585, 0.02, 0.02),
      names: ramp(local, 0.3, 0.34),
    },
    /** Camera: weights of the four framings (one crank, two and the record, ten, the full machine). */
    cam: {
      /** From the lone crank, centred, to the crank and its trail. */
      trail: ramp(local, 0.08, 0.2),
      two: ramp(local, 0.34, 0.44),
      ten: ramp(local, 0.56, 0.68),
      full: ramp(local, 0.76, 0.9),
    },
  };
}

export type AddsState = ReturnType<typeof addsState>;

const NAMES_SHOWN = 4;

export const adds = registerStage('adds', {
  note: 'Kelvin’s layout and Thomson’s ten components; every crank is set from NOAA’s San Francisco constants and turned by its gear train, so the pen is computed, not drawn. Six weeks of machine time pass across the stage; Kelvin’s machine did a year in about four hours.',
  readouts(local) {
    const s = addsState(local);
    const n = Math.max(1, s.seated);
    const names = THOMSON_ORDER.slice(0, n).map(pretty);
    const shown =
      names.length > NAMES_SHOWN
        ? `${names.slice(0, NAMES_SHOWN - 1).join(' + ')} + ${names.length - NAMES_SHOWN + 1} more`
        : names.join(' + ');
    const rows: Readout[] = [
      { label: 'Pulleys', value: `${n} of 10`, tone: 'warm' },
      { label: 'Summing', value: shown, tone: 'plain' },
      { label: 'Machine time', value: `day ${s.days.toFixed(1)}`, tone: 'warm' },
      {
        label: 'Kelvin, 1873',
        value: `a year in ~4 h (×${(Math.round(KELVIN_SPEEDUP / 100) * 100).toLocaleString('en-US')})`,
        tone: 'mute',
      },
    ];
    return rows;
  },
});
