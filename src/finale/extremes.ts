// Highs and lows of a predicted tide, for the finale's place card (pure). The curve is sampled every 6 minutes and
// each turning point refined by a parabola through its three samples (times to well under a minute, heights to a
// fraction of a millimetre for tides of any size).

import { predict, type Prepared } from '../tides/predict.ts';

export interface Extreme {
  /** ms UTC */
  t: number;
  /** m above the source's datum */
  h: number;
  high: boolean;
}

export interface TideSeries {
  t0: number;
  stepMs: number;
  h: Float64Array;
  extremes: Extreme[];
}

const STEP = 6 * 60e3;

/** Sample [t0, t1] every 6 min and find every high and low inside it. */
export function tideSeries(p: Prepared, t0: number, t1: number, stepMs = STEP): TideSeries {
  const n = Math.max(3, Math.ceil((t1 - t0) / stepMs) + 1);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = predict(p, t0 + i * stepMs);
  const extremes: Extreme[] = [];
  for (let i = 1; i < n - 1; i++) {
    const a = h[i - 1]!;
    const b = h[i]!;
    const c = h[i + 1]!;
    const high = b > a && b >= c;
    const low = b < a && b <= c;
    if (!high && !low) continue;
    const den = a - 2 * b + c;
    const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const t = t0 + (i + off) * stepMs;
    extremes.push({ t, h: predict(p, t), high });
  }
  return { t0, stepMs, h, extremes };
}

/** The next high and the next low after ms. */
export function nextExtremes(s: TideSeries, ms: number): { high: Extreme | null; low: Extreme | null } {
  let high: Extreme | null = null;
  let low: Extreme | null = null;
  for (const e of s.extremes) {
    if (e.t <= ms) continue;
    if (e.high && !high) high = e;
    if (!e.high && !low) low = e;
    if (high && low) break;
  }
  return { high, low };
}

/** Rate of change at ms, m per hour (central difference over ±5 min). */
export function rateAt(p: Prepared, ms: number): number {
  return ((predict(p, ms + 300e3) - predict(p, ms - 300e3)) / 600e3) * 3.6e6;
}

/** Highest and lowest sample of a series. */
export function seriesRange(s: TideSeries): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of s.h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { lo, hi };
}
