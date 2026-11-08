// Monotone cubic Hermite interpolation (Fritsch–Carlson) with an exact inverse.
// Pure, allocation-free after construction.

export class MonotoneCubic {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  private readonly ms: Float64Array;
  private readonly increasing: boolean;

  constructor(xs: ArrayLike<number>, ys: ArrayLike<number>) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) throw new Error('MonotoneCubic: need ≥2 matching points');
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    for (let i = 1; i < n; i++) {
      if (!(this.xs[i]! > this.xs[i - 1]!)) throw new Error('MonotoneCubic: xs must be strictly increasing');
    }
    this.increasing = this.ys[n - 1]! > this.ys[0]!;
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = (this.ys[i + 1]! - this.ys[i]!) / (this.xs[i + 1]! - this.xs[i]!);
    const m = new Float64Array(n);
    m[0] = d[0]!;
    m[n - 1] = d[n - 2]!;
    for (let i = 1; i < n - 1; i++) {
      const a = d[i - 1]!;
      const b = d[i]!;
      if (a * b <= 0) m[i] = 0;
      else {
        // Weighted harmonic mean (Fritsch–Butland), monotone by construction.
        const h0 = this.xs[i]! - this.xs[i - 1]!;
        const h1 = this.xs[i + 1]! - this.xs[i]!;
        const w1 = 2 * h1 + h0;
        const w2 = h1 + 2 * h0;
        m[i] = (w1 + w2) / (w1 / a + w2 / b);
      }
    }
    this.ms = m;
  }

  /** Index i such that xs[i] ≤ x < xs[i+1], clamped to valid segments. */
  private segment(arr: Float64Array, v: number, ascending: boolean): number {
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ascending ? arr[mid]! <= v : arr[mid]! >= v) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private evalSeg(i: number, x: number): number {
    const x0 = this.xs[i]!;
    const h = this.xs[i + 1]! - x0;
    const s = (x - x0) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * this.ys[i]! +
      (s3 - 2 * s2 + s) * h * this.ms[i]! +
      (-2 * s3 + 3 * s2) * this.ys[i + 1]! +
      (s3 - s2) * h * this.ms[i + 1]!
    );
  }

  private derivSeg(i: number, x: number): number {
    const x0 = this.xs[i]!;
    const h = this.xs[i + 1]! - x0;
    const s = (x - x0) / h;
    const s2 = s * s;
    return (
      ((6 * s2 - 6 * s) * this.ys[i]! +
        (3 * s2 - 4 * s + 1) * h * this.ms[i]! +
        (-6 * s2 + 6 * s) * this.ys[i + 1]! +
        (3 * s2 - 2 * s) * h * this.ms[i + 1]!) /
      h
    );
  }

  /** y(x). Linear extrapolation outside the table using end slopes. */
  at(x: number): number {
    const n = this.xs.length;
    if (x <= this.xs[0]!) return this.ys[0]! + (x - this.xs[0]!) * this.ms[0]!;
    if (x >= this.xs[n - 1]!) return this.ys[n - 1]! + (x - this.xs[n - 1]!) * this.ms[n - 1]!;
    return this.evalSeg(this.segment(this.xs, x, true), x);
  }

  /** x such that at(x) = y. Exact inverse of `at` (Newton with bisection safeguard). */
  inverse(y: number): number {
    const n = this.xs.length;
    const inc = this.increasing;
    const y0 = this.ys[0]!;
    const yn = this.ys[n - 1]!;
    if (inc ? y <= y0 : y >= y0) return this.xs[0]! + (y - y0) / this.ms[0]!;
    if (inc ? y >= yn : y <= yn) return this.xs[n - 1]! + (y - yn) / this.ms[n - 1]!;
    const i = this.segment(this.ys, y, inc);
    let lo = this.xs[i]!;
    let hi = this.xs[i + 1]!;
    const ylo = this.ys[i]!;
    const yhi = this.ys[i + 1]!;
    let x = lo + ((y - ylo) / (yhi - ylo)) * (hi - lo);
    for (let iter = 0; iter < 60; iter++) {
      const f = this.evalSeg(i, x) - y;
      if (f === 0) return x;
      if (inc ? f > 0 : f < 0) hi = x;
      else lo = x;
      const df = this.derivSeg(i, x);
      let next = df !== 0 ? x - f / df : NaN;
      if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
      if (Math.abs(next - x) <= 1e-15 * Math.max(1, Math.abs(x))) return next;
      x = next;
    }
    return x;
  }
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, s: number): number => a + (b - a) * s;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const s = clamp((x - e0) / (e1 - e0), 0, 1);
  return s * s * (3 - 2 * s);
};
