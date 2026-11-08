// Harmonic analysis (Kelvin 1867; the method NOAA still uses): least-squares fit of h(t) = Z₀ + Σ fH cos(V+u−κ)
// to a record, giving each constituent's amplitude H and Greenwich phase κ. Node factors are evaluated per sample.
// Pure; solves the normal equations by Cholesky.

import { astro, D2R, R2D, type Astro } from './astro.ts';
import { BY_NAME, V, type Constituent } from './constituents.ts';

export interface Fit {
  z0: number;
  constituents: { name: string; amplitude: number; phase: number }[];
  /** RMS of the residual, m. */
  rms: number;
}

function cholesky(A: Float64Array, n: number, b: Float64Array): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= L[i * n + k]! * L[j * n + k]!;
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j]!;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

/** Fit `names` to samples (m, null = missing) starting at startMs, stepMinutes apart. */
export function analyse(values: readonly (number | null)[], startMs: number, stepMinutes: number, names: readonly string[]): Fit {
  const cs: Constituent[] = names.map((n) => {
    const c = BY_NAME.get(n);
    if (!c) throw new Error(`unknown constituent ${n}`);
    return c;
  });
  const n = 1 + 2 * cs.length;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  const row = new Float64Array(n);
  const a = {} as Astro;
  values.forEach((h, i) => {
    if (h === null) return;
    astro(startMs + i * stepMinutes * 60000, a);
    row[0] = 1;
    cs.forEach((c, k) => {
      const f = c.f(a);
      const ph = (V(c, a) + c.u(a)) * D2R;
      // f H cos(ph − κ) = f cos(ph)·(H cos κ) + f sin(ph)·(H sin κ)
      row[1 + 2 * k] = f * Math.cos(ph);
      row[2 + 2 * k] = f * Math.sin(ph);
    });
    for (let p = 0; p < n; p++) {
      b[p] += row[p]! * h;
      for (let q = 0; q <= p; q++) A[p * n + q] += row[p]! * row[q]!;
    }
  });
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) A[p * n + q] = A[q * n + p]!;
  const x = cholesky(A, n, b);
  const constituents = cs.map((c, k) => {
    const C = x[1 + 2 * k]!;
    const S = x[2 + 2 * k]!;
    return { name: c.name, amplitude: Math.hypot(C, S), phase: (((Math.atan2(S, C) * R2D) % 360) + 360) % 360 };
  });
  // Residual RMS.
  let se = 0;
  let m = 0;
  values.forEach((h, i) => {
    if (h === null) return;
    astro(startMs + i * stepMinutes * 60000, a);
    let p = x[0]!;
    cs.forEach((c, k) => {
      const ph = (V(c, a) + c.u(a)) * D2R;
      p += c.f(a) * (x[1 + 2 * k]! * Math.cos(ph) + x[2 + 2 * k]! * Math.sin(ph));
    });
    se += (h - p) ** 2;
    m++;
  });
  return { z0: x[0]!, constituents, rms: Math.sqrt(se / Math.max(1, m)) };
}
