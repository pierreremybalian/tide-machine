// Stage 3 · The bulge is a wave (HANDOFF §7 row 3). Pure: shared by the scene, the narration and the HUD.
//
// The ocean's M2 tide from EOT20 (satellite altimetry) drawn on a globe: co-tidal lines (equal Greenwich phase lag κ)
// wheel around amphidromic points as the M2 argument V + u advances. Then the West Coast: high water of M2 reaches
// San Diego, Los Angeles, San Francisco, Newport and Seattle in the order of their NOAA phase lags. Every time here is
// computed from NOAA's M2 constants (below, checked against public/data/stations in the tests) and src/tides.

import { astro, mod360 } from '../tides/astro.ts';
import { BY_NAME, V, speed } from '../tides/constituents.ts';
import { linear, ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

const M2 = BY_NAME.get('M2')!;
/** M2 speed, degrees per hour (28.984°/h: one cycle in 12 h 25 min). */
export const M2_SPEED = speed(M2);
export const M2_PERIOD_H = 360 / M2_SPEED;

export interface CoastStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** NOAA M2 amplitude (m) and Greenwich phase lag κ (degrees). */
  amp: number;
  kappa: number;
}

/** South to north. NOAA CO-OPS harmonic constants (public/data/stations/<id>.json). */
export const WEST_COAST: readonly CoastStation[] = [
  { id: '9410170', name: 'San Diego', lat: 32.715557, lng: -117.17667, amp: 0.542, kappa: 143.3 },
  { id: '9410660', name: 'Los Angeles', lat: 33.72, lng: -118.272, amp: 0.515, kappa: 145.5 },
  { id: '9414290', name: 'San Francisco', lat: 37.806305, lng: -122.46589, amp: 0.576, kappa: 208.2 },
  { id: '9435380', name: 'Newport', lat: 44.625446, lng: -124.044945, amp: 0.887, kappa: 231.2 },
  { id: '9447130', name: 'Seattle', lat: 47.60264, lng: -122.3393, amp: 1.063, kappa: 10.8 },
];

/** Hours after San Diego that M2 high water reaches each station (phase lag difference / M2 speed, unwrapped northward). */
export const DELAY_H: readonly number[] = (() => {
  const out = [0];
  let acc = 0;
  for (let i = 1; i < WEST_COAST.length; i++) {
    acc += mod360(WEST_COAST[i]!.kappa - WEST_COAST[i - 1]!.kappa);
    out.push(acc / M2_SPEED);
  }
  return out;
})();

const scratch = astro(0);

/** M2's astronomical argument V + u at a time (degrees, 0–360). */
export function m2Argument(ms: number): number {
  const a = astro(ms, scratch);
  return mod360(V(M2, a) + M2.u(a));
}

/** First M2 high water at or after `fromMs` at a place with phase lag κ (bisection on V + u − κ crossing 0). */
export function nextCrest(kappa: number, fromMs: number): number {
  const lag = mod360(kappa - m2Argument(fromMs));
  let t = fromMs + (lag / M2_SPEED) * 3600e3;
  // V + u is not exactly linear in time (u drifts slowly): refine.
  for (let k = 0; k < 4; k++) {
    let d = mod360(m2Argument(t) - kappa);
    if (d > 180) d -= 360;
    t -= (d / M2_SPEED) * 3600e3;
  }
  return t;
}

/** The sweep starts with M2 high water at San Diego on the afternoon of 1 June 2025 (the week of stage 1). */
export const SWEEP_MS = nextCrest(WEST_COAST[0]!.kappa, Date.UTC(2025, 5, 1, 19));

/** Hours relative to San Diego's high water: two M2 cycles over the globe, then a slower clock along the coast. */
export const sweepHours = track(
  [
    [0, -29],
    [0.12, -28.2],
    [0.5, -3.4],
    [0.62, -1.2],
    [0.9, 8.6],
    [1, 9.3],
  ],
  linear,
);

/** Crest times (ms) at each West Coast station for this sweep. */
export const CREST_MS: readonly number[] = WEST_COAST.map((s) => nextCrest(s.kappa, SWEEP_MS - 600e3));

export function waveState(local: number) {
  const hours = sweepHours(local);
  const ms = SWEEP_MS + hours * 3600e3;
  // Each marker flares as the crest passes (a 50-minute half-width in tide time).
  const flare = CREST_MS.map((c) => Math.exp(-(((ms - c) / (50 * 60e3)) ** 2)));
  let passed = -1;
  CREST_MS.forEach((c, i) => {
    if (ms >= c) passed = i;
  });
  return {
    ms,
    hours,
    /** M2 argument now (degrees). */
    arg: m2Argument(ms),
    /** Co-tidal phase lines on the ocean. */
    lines: ramp(local, 0.14, 0.24),
    /** The travelling crest (high water of M2) drawn bright. */
    crest: ramp(local, 0.2, 0.3),
    /** Amphidromic points marked. */
    amphi: windowed(local, 0.3, 0.56, 0.04, 0.05),
    /** West Coast stations and the sweep. */
    coast: ramp(local, 0.54, 0.62),
    flare,
    /** Index of the last station high water has reached (−1 before San Diego). */
    passed,
    card: windowed(local, 0.6, 1.01, 0.04, 0),
  };
}

const PDT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function fmtDelay(h: number): string {
  const m = Math.round(h * 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const wave = registerStage('wave', {
  note: 'The ocean’s main lunar tide (M2) from EOT20, a model built from satellite altimetry; high-water times along the coast computed from NOAA’s M2 constants. About 30 hours of tide over this stage, slower along the coast.',
  readouts(local) {
    const s = waveState(local);
    const rows: Readout[] = [{ label: 'Pacific time', value: `${PDT.format(s.ms)} PDT`, tone: 'plain' }];
    if (s.coast > 0.5) {
      const i = s.passed;
      rows.push(
        i < 0
          ? { label: 'M2 high water', value: 'offshore', tone: 'b' }
          : { label: 'M2 high water at', value: i === 0 ? WEST_COAST[0]!.name : `${WEST_COAST[i]!.name} +${fmtDelay(DELAY_H[i]!)}`, tone: 'b' },
      );
    } else rows.push({ label: 'One cycle', value: '12 h 25 min', tone: 'b' });
    return rows;
  },
});
