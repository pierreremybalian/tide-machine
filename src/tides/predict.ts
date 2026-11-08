// Harmonic tide prediction: h(t) = Z₀ + Σ fᵢ(t) Hᵢ cos(Vᵢ(t) + uᵢ(t) − κᵢ), with NOAA's Greenwich phases κ.
// The same sum Kelvin's machine performs with pulleys and a wire. Pure.

import { astro, D2R, type Astro } from './astro.ts';
import { BY_NAME, V, type Constituent } from './constituents.ts';

export interface StationConstants {
  id: string;
  /** Mean sea level above the chart datum (MLLW), m. */
  z0: number;
  constituents: readonly { name: string; amplitude: number; phase: number; speed: number }[];
}

export interface Term {
  c: Constituent;
  /** Amplitude H, m. */
  H: number;
  /** Greenwich phase lag κ, degrees. */
  kappa: number;
}

export interface Prepared {
  z0: number;
  terms: Term[];
  /** NOAA constituents this predictor does not model (none for the standard 37). */
  skipped: string[];
}

export function prepare(st: StationConstants, only?: readonly string[]): Prepared {
  const terms: Term[] = [];
  const skipped: string[] = [];
  for (const k of st.constituents) {
    if (only && !only.includes(k.name)) continue;
    const c = BY_NAME.get(k.name);
    if (!c) {
      skipped.push(k.name);
      continue;
    }
    terms.push({ c, H: k.amplitude, kappa: k.phase });
  }
  return { z0: st.z0, terms, skipped };
}

const scratch = {} as Astro;

/** Height of one term at time ms (m), given the astronomical state. */
export function termHeight(t: Term, a: Astro): number {
  return t.c.f(a) * t.H * Math.cos((V(t.c, a) + t.c.u(a) - t.kappa) * D2R);
}

/** Predicted height above MLLW (m) at a JS timestamp (ms, UTC). */
export function predict(p: Prepared, ms: number): number {
  const a = astro(ms, scratch);
  let h = p.z0;
  for (const t of p.terms) h += termHeight(t, a);
  return h;
}

/** Predictions at n evenly spaced times starting at startMs. */
export function predictSeries(p: Prepared, startMs: number, stepMinutes: number, n: number, out = new Float64Array(n)): Float64Array {
  for (let i = 0; i < n; i++) out[i] = predict(p, startMs + i * stepMinutes * 60000);
  return out;
}
