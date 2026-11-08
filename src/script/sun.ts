// Stage 5 · The Sun joins in (spring and neap). Pure script shared by the scene, the HUD and the narration.
// San Francisco's two biggest twice-daily rhythms, M2 (Moon) and S2 (Sun), as arms on a dial: each arm's angle is
// V + u − κ and its length f·H, exactly the terms src/tides/predict.ts sums. S2 turns faster and laps M2 every
// 14.77 days (computed from the two speeds): the sum's length breathes between spring and neap.

import { astro, mod360, type Astro } from '../tides/astro.ts';
import { BY_NAME, period, speed, V } from '../tides/constituents.ts';
import { termHeight, type Term } from '../tides/predict.ts';
import { ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';
import { sfConstant } from './rhythms.ts';

/** NOAA's San Francisco (9414290) constants for the two rhythms. */
export const SF_M2 = sfConstant('M2');
export const SF_S2 = sfConstant('S2');

const M2 = BY_NAME.get('M2')!;
const S2 = BY_NAME.get('S2')!;
export const TERM_M2: Term = { c: M2, H: SF_M2.H, kappa: SF_M2.kappa };
export const TERM_S2: Term = { c: S2, H: SF_S2.H, kappa: SF_S2.kappa };

/** Degrees per hour. */
export const SPEED_M2 = speed(M2);
export const SPEED_S2 = speed(S2);
/** Hours for S2 to lap M2: the spring–neap cycle (≈ 354.4 h = 14.77 days). */
export const SPRING_NEAP_H = 360 / (SPEED_S2 - SPEED_M2);
/** Hours from syzygy (Sun–Earth–Moon in line) to the spring tide at San Francisco: the "age" of the tide. */
export const TIDE_AGE_H = (SF_S2.kappa - SF_M2.kappa) / (SPEED_S2 - SPEED_M2);
export const PERIOD_M2_H = period(M2);
export const PERIOD_S2_H = period(S2);

/** Start of the month shown: the new moon of 29 March 2025 (UTC). One month of 30 days follows. */
export const T0 = Date.parse('2025-03-29T00:00Z');
export const SPAN_H = 720;
/** Hours shown before the chart zooms out to the whole month. */
export const FIRST_WINDOW_H = 72;
/** S2 joins at this hour. */
export const S2_JOIN_H = 30;

/** Hours since T0 through the stage. */
export const sunHours = track([
  [0.12, 0],
  [0.4, FIRST_WINDOW_H],
  [0.47, FIRST_WINDOW_H],
  [0.84, SPAN_H],
]);

/** S2 grows onto the end of M2 over the hours before S2_JOIN_H (the chart's sum stays continuous). */
export function s2Weight(hours: number): number {
  const x = Math.min(1, Math.max(0, (hours - (S2_JOIN_H - 6)) / 6));
  return x * x * (3 - 2 * x);
}

export interface SunState {
  hours: number;
  /** 0 → 1: the M2 dial and curve appear. */
  m2: number;
  /** 0 → 1: S2 hangs on the end of M2. */
  s2: number;
  /** 0 → 1: the chart shows the whole month instead of three days. */
  zoomOut: number;
  /** 0 → 1: the dial rides along with M2 (M2 points up, S2 creeps around it). */
  frame: number;
  /** 0 → 1: spring / neap envelope and labels. */
  envelope: number;
  /** 0 → 1: the Sun–Earth–Moon sketch. */
  sky: number;
  /** 0 → 1: moon-phase ticks on the time axis. */
  phases: number;
}

export function sunState(local: number): SunState {
  return {
    hours: sunHours(local),
    m2: ramp(local, 0.1, 0.17),
    s2: s2Weight(sunHours(local)),
    zoomOut: ramp(local, 0.4, 0.465),
    frame: ramp(local, 0.405, 0.465) * (1 - ramp(local, 0.9, 0.97)),
    envelope: ramp(local, 0.46, 0.55),
    sky: windowed(local, 0.62, 1.01, 0.06, 0.001),
    phases: ramp(local, 0.64, 0.72),
  };
}

export interface Arms {
  /** Arm angles θ = V + u − κ (degrees, 0–360) and lengths f·H (m). */
  m2: number;
  s2: number;
  fm2: number;
  fs2: number;
  /** Heights of each term and their sum (m, relative to mean level). */
  hm2: number;
  hs2: number;
  /** Length of the M2 + S2 arm (m): the envelope. */
  sum: number;
  /** Moon's elongation from the Sun (mean, degrees 0–360): 0 new, 90 first quarter, 180 full, 270 last quarter. */
  elongation: number;
}

const D2R = Math.PI / 180;
const scratch = {} as Astro;

export function arms(hours: number, out = {} as Arms): Arms {
  const a = astro(T0 + hours * 3600e3, scratch);
  const thM = mod360(V(M2, a) + M2.u(a) - SF_M2.kappa);
  const thS = mod360(V(S2, a) + S2.u(a) - SF_S2.kappa);
  const fM = M2.f(a) * SF_M2.H;
  const fS = S2.f(a) * SF_S2.H;
  out.m2 = thM;
  out.s2 = thS;
  out.fm2 = fM;
  out.fs2 = fS;
  out.hm2 = termHeight(TERM_M2, a);
  out.hs2 = termHeight(TERM_S2, a);
  const dx = fM + fS * Math.cos((thS - thM) * D2R);
  const dy = fS * Math.sin((thS - thM) * D2R);
  out.sum = Math.hypot(dx, dy);
  out.elongation = mod360(a.s - a.h);
  return out;
}

/** Sampled month: M2 alone, M2 + S2 (S2 growing in before S2_JOIN_H), and the envelope |M2 + S2|, every `stepH`
 * hours from T0. */
export function sunCurves(stepH = 0.25): {
  t: Float32Array;
  m2: Float32Array;
  both: Float32Array;
  env: Float32Array;
} {
  const n = Math.round(SPAN_H / stepH) + 1;
  const t = new Float32Array(n);
  const m2 = new Float32Array(n);
  const both = new Float32Array(n);
  const env = new Float32Array(n);
  const r = {} as Arms;
  for (let i = 0; i < n; i++) {
    const h = i * stepH;
    arms(h, r);
    t[i] = h;
    m2[i] = r.hm2;
    both[i] = r.hm2 + r.hs2 * s2Weight(h);
    env[i] = r.sum;
  }
  return { t, m2, both, env };
}

export interface SkyEvent {
  hours: number;
  kind: 'new' | 'first' | 'full' | 'last' | 'spring' | 'neap';
}

let events: SkyEvent[] | null = null;

/** Moon phases (mean) and spring / neap peaks of |M2 + S2| inside the month (hours from T0). */
export function skyEvents(): SkyEvent[] {
  if (events) return events;
  const out: SkyEvent[] = [];
  const r = {} as Arms;
  const step = 0.25;
  let prevE = arms(0, r).elongation;
  const env: number[] = [];
  for (let h = 0; h <= SPAN_H + 1e-9; h += step) {
    arms(h, r);
    env.push(r.sum);
    const e = r.elongation;
    if (h > 0) {
      for (const [q, kind] of [
        [0, 'new'],
        [90, 'first'],
        [180, 'full'],
        [270, 'last'],
      ] as const) {
        const a = mod360(prevE - q + 180) - 180;
        const b = mod360(e - q + 180) - 180;
        if (a < 0 && b >= 0) out.push({ hours: h - step * (b / (b - a)), kind });
      }
    }
    prevE = e;
  }
  for (let i = 1; i < env.length - 1; i++) {
    const a = env[i - 1]!;
    const b = env[i]!;
    const c = env[i + 1]!;
    if (b > a && b >= c) out.push({ hours: i * step, kind: 'spring' });
    if (b < a && b <= c) out.push({ hours: i * step, kind: 'neap' });
  }
  events = out.sort((x, y) => x.hours - y.hours);
  return events;
}

export function moonPhaseName(elongation: number): string {
  const names = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ];
  return names[Math.floor(mod360(elongation + 22.5) / 45) % 8]!;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateLabel(hours: number, withTime = true): string {
  const d = new Date(T0 + hours * 3600e3);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (!withTime) return day;
  return `${day} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function hm(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m === 60 ? `${h + 1} h 00 min` : `${h} h ${String(m).padStart(2, '0')} min`;
}

const scratchArms = {} as Arms;

export const sun = registerStage('sun', {
  note: 'Amplitudes and phases are NOAA’s for San Francisco and every arm angle is computed for the date shown; only M2 and S2 are drawn (the full tide adds 35 more rhythms). Time is compressed: three days, then a month, pass across the stage. The Sun–Earth–Moon sketch is not to scale.',
  readouts(local) {
    const s = sunState(local);
    const r = arms(s.hours, scratchArms);
    const rows: Readout[] = [];
    const early = s.envelope < 0.5;
    if (s.m2 > 0.5 && early)
      rows.push({ label: 'M2 · Moon', value: `${SF_M2.H.toFixed(2)} m · ${hm(PERIOD_M2_H)}`, tone: 'b' });
    if (s.s2 > 0.5 && early)
      rows.push({ label: 'S2 · Sun', value: `${SF_S2.H.toFixed(2)} m · ${hm(PERIOD_S2_H)}`, tone: 'warm' });
    if (s.s2 > 0.5) rows.push({ label: 'M2 + S2', value: `${r.sum.toFixed(2)} m`, tone: 'both' });
    if (!early && s.sky < 0.5)
      rows.push({
        label: 'Spring to spring',
        value: `${(SPRING_NEAP_H / 24).toFixed(2)} days`,
        tone: 'plain',
      });
    if (s.sky > 0.5) rows.push({ label: 'Moon', value: moonPhaseName(r.elongation), tone: 'light' });
    if (s.m2 > 0.5) rows.push({ label: '2025 · UTC', value: dateLabel(s.hours), tone: 'mute' });
    return rows;
  },
});
