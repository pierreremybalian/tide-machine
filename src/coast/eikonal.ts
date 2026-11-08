// Wave kinematics over bathymetry (pure; worker-safe): the linear dispersion relation and a fast-marching eikonal
// solver. A wave train of angular frequency ω crossing water of depth h travels at the phase speed c = ω/k with
// ω² = g·k·tanh(k·h); its crests are the level sets of the first-arrival time T(x), which solves |∇T| = 1/c(x)
// (geometric optics). Slower water bends the crests: refraction. Phase = ω·(T − t).

export const G = 9.81;

/** Wavenumber k (rad/m) for angular frequency ω (rad/s) in depth h (m): Newton on ω² = g k tanh(k h). */
export function waveNumber(omega: number, h: number): number {
  const k0 = (omega * omega) / G;
  if (!(h > 0)) return Infinity;
  // Fenton & McKee (1990) explicit start, then two Newton steps (relative error < 1e-9).
  const a = k0 * h;
  let k = (a / h) * Math.pow(Math.tanh(Math.pow(a, 0.75)), -2 / 3);
  for (let i = 0; i < 3; i++) {
    const t = Math.tanh(k * h);
    const f = G * k * t - omega * omega;
    const df = G * t + G * k * h * (1 - t * t);
    k -= f / df;
  }
  return k;
}

/** Phase speed (m/s). */
export const phaseSpeed = (omega: number, h: number) => omega / waveNumber(omega, h);

/** Group speed (m/s): energy travels at c_g = c/2 · (1 + 2kh / sinh 2kh). */
export function groupSpeed(omega: number, h: number): number {
  const k = waveNumber(omega, h);
  const kh = k * h;
  const n = kh > 20 ? 0.5 : 0.5 * (1 + (2 * kh) / Math.sinh(2 * kh));
  return (n * omega) / k;
}

/** Shoaling coefficient K_s = √(c_g,deep / c_g): wave height grows as energy flux slows in shallow water. */
export const shoaling = (omega: number, h: number) => Math.sqrt((0.5 * G) / omega / groupSpeed(omega, h));

/** Deep-water wavelength (m) for a period (s). */
export const deepWavelength = (period: number) => (G * period * period) / (2 * Math.PI);

// ── Fast marching ──

export interface MarchGrid {
  nx: number;
  ny: number;
  /** Cell size (m) along x (east) and y (rows, south). */
  dx: number;
  dy: number;
}

/** Binary min-heap of (key, index) with lazy deletion; typed arrays, grows by doubling. */
class Heap {
  keys: Float64Array;
  idx: Int32Array;
  n = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.idx = new Int32Array(cap);
  }
  push(key: number, i: number): void {
    if (this.n === this.keys.length) {
      const k = new Float64Array(this.n * 2);
      k.set(this.keys);
      this.keys = k;
      const ix = new Int32Array(this.n * 2);
      ix.set(this.idx);
      this.idx = ix;
    }
    let c = this.n++;
    const K = this.keys;
    const I = this.idx;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (K[p]! <= key) break;
      K[c] = K[p]!;
      I[c] = I[p]!;
      c = p;
    }
    K[c] = key;
    I[c] = i;
  }
  /** Pops the minimum; returns its index (key in this.top). */
  top = 0;
  pop(): number {
    const K = this.keys;
    const I = this.idx;
    const out = I[0]!;
    this.top = K[0]!;
    const key = K[--this.n]!;
    const ix = I[this.n]!;
    let c = 0;
    const n = this.n;
    for (;;) {
      let m = 2 * c + 1;
      if (m >= n) break;
      if (m + 1 < n && K[m + 1]! < K[m]!) m++;
      if (K[m]! >= key) break;
      K[c] = K[m]!;
      I[c] = I[m]!;
      c = m;
    }
    K[c] = key;
    I[c] = ix;
    return out;
  }
}

/**
 * First-arrival times T (s, or m when speed ≡ 1) by fast marching (Sethian 1996), first-order upwind.
 * speed: m/s per cell, 0 = impassable. init: finite values are sources (known times), others Infinity.
 * Unreached cells stay Infinity.
 */
export function fastMarch(g: MarchGrid, speed: ArrayLike<number>, init: ArrayLike<number>): Float64Array {
  const { nx, ny, dx, dy } = g;
  const n = nx * ny;
  const T = new Float64Array(n).fill(Infinity);
  const state = new Uint8Array(n); // 0 far, 1 trial, 2 known
  const heap = new Heap(1 << 16);
  const ax = 1 / (dx * dx);
  const ay = 1 / (dy * dy);
  for (let i = 0; i < n; i++) {
    const t = init[i]!;
    if (Number.isFinite(t)) {
      T[i] = t;
      heap.push(t, i);
      state[i] = 1;
    }
  }
  const update = (i: number) => {
    const s = speed[i]!;
    if (!(s > 0) || state[i] === 2) return;
    const x = i % nx;
    const y = (i - x) / nx;
    const l = x > 0 && state[i - 1] === 2 ? T[i - 1]! : Infinity;
    const r = x < nx - 1 && state[i + 1] === 2 ? T[i + 1]! : Infinity;
    const u = y > 0 && state[i - nx] === 2 ? T[i - nx]! : Infinity;
    const d = y < ny - 1 && state[i + nx] === 2 ? T[i + nx]! : Infinity;
    const a = l < r ? l : r;
    const b = u < d ? u : d;
    const f = 1 / s;
    let t: number;
    if (a === Infinity) t = b + f * dy;
    else if (b === Infinity) t = a + f * dx;
    else {
      // ((t − a)/dx)² + ((t − b)/dy)² = f²
      const A = ax + ay;
      const B = -2 * (a * ax + b * ay);
      const C = a * a * ax + b * b * ay - f * f;
      const disc = B * B - 4 * A * C;
      t = disc >= 0 ? (-B + Math.sqrt(disc)) / (2 * A) : Infinity;
      if (!(t >= Math.max(a, b))) t = Math.min(a + f * dx, b + f * dy);
    }
    if (t < T[i]!) {
      T[i] = t;
      state[i] = 1;
      heap.push(t, i);
    }
  };
  while (heap.n > 0) {
    const i = heap.pop();
    if (state[i] === 2 || heap.top > T[i]!) continue;
    state[i] = 2;
    const x = i % nx;
    if (x > 0) update(i - 1);
    if (x < nx - 1) update(i + 1);
    if (i >= nx) update(i - nx);
    if (i < n - nx) update(i + nx);
  }
  return T;
}

/** Wave speed field for a period over a depth grid (m); cells with depth ≤ 0 are impassable. */
export function speedField(depth: ArrayLike<number>, period: number, minDepth = 0.25, out = new Float32Array(depth.length)): Float32Array {
  const omega = (2 * Math.PI) / period;
  for (let i = 0; i < out.length; i++) {
    const h = depth[i]!;
    out[i] = h > 0 ? phaseSpeed(omega, Math.max(h, minDepth)) : 0;
  }
  return out;
}
