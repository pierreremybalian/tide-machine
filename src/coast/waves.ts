// Wind-wave fields over the bathymetry (pure; worker-safe). For each wave band (a period and a direction) we solve
// the eikonal |∇T| = 1/c(x) by fast marching, with c from the dispersion relation at the local mean depth; the
// renderer's crests are the level sets of ω·(T − t), so they slow, shorten and bend toward shore over shallow water.
// Two source kinds:
//   'ocean' — swell entering through the open-sea edge of the grid (a plane front);
//   'shore' — locally generated wind sea: fronts start on every upwind shore (and the upwind edge), all on the same
//             plane-wave clock T₀ = d·p / c₀, so fronts from different shores agree in deep water.
// Amplitude factors: swell is sheltered by how much longer its path is than the straight line (diffraction around
// headlands and through the Golden Gate loses energy); wind sea grows with fetch (distance over water upwind).

import { fastMarch, phaseSpeed } from './eikonal.ts';

export interface WaveBand {
  /** Period (s). */
  period: number;
  /** Direction the waves travel toward, degrees clockwise from north. */
  toward: number;
  source: 'ocean' | 'shore';
  /** Wind sea: fetch (m) at which the band is two-thirds grown. Swell: shelter length (m). */
  scale: number;
}

export interface WaveGrid {
  nx: number;
  ny: number;
  /** Cell size (m). */
  dx: number;
  dy: number;
  /** Still-water depth (m) at mean level; ≤ 0 is land. */
  depth: Float32Array;
  /** 1 where the cell can be wet (tidal water at high tide). */
  water: Uint8Array;
}

export interface WaveBandField {
  band: WaveBand;
  /** Travel time (s); −1 where unreached. */
  T: Float32Array;
  /** Amplitude factor 0–1 (shelter or fetch growth). */
  amp: Float32Array;
  /** Ocean bands only: marine reach 0–1, exp(−excess path / reachScale): how directly the cell sees the open sea. */
  reach?: Float32Array;
}

/** Unit vector (x east, z south) of a compass bearing. */
export function bearingVector(deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** Fetch (m): distance over water upwind of each cell along the direction of travel, by an ordered sweep. */
export function fetchMap(g: WaveGrid, toward: number, edgeFetch: number): Float32Array {
  const { nx, ny, dx, dy, water } = g;
  const [ux, uz] = bearingVector(toward);
  const n = nx * ny;
  const F = new Float32Array(n);
  // Visit cells in increasing d·p so the upwind sample is always final.
  const key = new Float32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) key[j * nx + i] = ux * i * dx + uz * j * dy;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => key[a]! - key[b]!);
  const step = Math.min(dx, dy);
  const sx = (ux * step) / dx;
  const sy = (uz * step) / dy;
  for (let q = 0; q < n; q++) {
    const c = order[q]!;
    if (!water[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    const x = i - sx;
    const y = j - sy;
    let up: number;
    if (x < 0 || y < 0 || x > nx - 1 || y > ny - 1) up = edgeFetch;
    else {
      const i0 = Math.floor(x);
      const j0 = Math.floor(y);
      const i1 = Math.min(i0 + 1, nx - 1);
      const j1 = Math.min(j0 + 1, ny - 1);
      const fx = x - i0;
      const fy = y - j0;
      up =
        (F[j0 * nx + i0]! * (1 - fx) + F[j0 * nx + i1]! * fx) * (1 - fy) + (F[j1 * nx + i0]! * (1 - fx) + F[j1 * nx + i1]! * fx) * fy;
      // A dry corner in the bilinear stencil means the shore is right there.
      if (!water[j0 * nx + i0] || !water[j0 * nx + i1] || !water[j1 * nx + i0] || !water[j1 * nx + i1]) up = Math.min(up, step);
    }
    F[c] = up + step;
  }
  return F;
}

/** Travel times and amplitude factors for one band. */
export function bandField(g: WaveGrid, band: WaveBand, minDepth = 0.3, reachScale = 12000): WaveBandField {
  const { nx, ny, dx, dy, depth, water } = g;
  const n = nx * ny;
  const omega = (2 * Math.PI) / band.period;
  const c0 = (9.81 * band.period) / (2 * Math.PI);
  const [ux, uz] = bearingVector(band.toward);
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) speed[i] = water[i] ? phaseSpeed(omega, Math.max(depth[i]!, minDepth)) : 0;

  const plane = (i: number, j: number) => ux * i * dx + uz * j * dy;
  const init = new Float64Array(n).fill(Infinity);
  const unit = new Float64Array(n).fill(Infinity);
  const isWater = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && water[j * nx + i] === 1;
  // Upwind neighbour offset (one cell against the direction of travel).
  const ui = -Math.sign(ux) * (Math.abs(ux) > 0.38 ? 1 : 0);
  const uj = -Math.sign(uz) * (Math.abs(uz) > 0.38 ? 1 : 0);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!water[c]) continue;
      const pi = i + ui;
      const pj = j + uj;
      const offGrid = pi < 0 || pj < 0 || pi >= nx || pj >= ny;
      let src: boolean;
      if (band.source === 'ocean') src = offGrid && depth[c]! > 5;
      else src = offGrid || !isWater(pi, pj);
      if (!src) continue;
      init[c] = plane(i, j) / c0;
      unit[c] = plane(i, j);
    }
  const T64 = fastMarch({ nx, ny, dx, dy }, speed, init);
  // Continue the travel time two cells onto land (after the march, so it opens no shortcut across a spit): the
  // renderer interpolates bilinearly and needs valid corners right up to the waterline.
  const slow = phaseSpeed(omega, minDepth);
  for (let pass = 0; pass < 2; pass++) {
    const prev = Float64Array.from(T64);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (Number.isFinite(prev[c]!)) continue;
        let m = Infinity;
        if (i > 0) m = Math.min(m, prev[c - 1]! + dx / slow);
        if (i < nx - 1) m = Math.min(m, prev[c + 1]! + dx / slow);
        if (j > 0) m = Math.min(m, prev[c - nx]! + dy / slow);
        if (j < ny - 1) m = Math.min(m, prev[c + nx]! + dy / slow);
        T64[c] = m;
      }
  }
  const T = new Float32Array(n);
  for (let i = 0; i < n; i++) T[i] = Number.isFinite(T64[i]!) ? T64[i]! : -1;

  const amp = new Float32Array(n);
  let reach: Float32Array | undefined;
  if (band.source === 'ocean') {
    reach = new Float32Array(n);
    // Shelter: excess of the shortest water path over the straight plane-wave path.
    const ones = new Float32Array(n);
    for (let i = 0; i < n; i++) ones[i] = water[i] ? 1 : 0;
    const D = fastMarch({ nx, ny, dx, dy }, ones, unit);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!Number.isFinite(D[c]!)) continue;
        const excess = Math.max(0, D[c]! - plane(i, j));
        amp[c] = Math.exp(-excess / band.scale);
        reach[c] = Math.exp(-excess / reachScale);
      }
    // Carry the exposure a few cells inland so the renderer can tell surf beaches from sheltered mud.
    for (let pass = 0; pass < 4; pass++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          if (water[c]) continue;
          let m = amp[c]!;
          if (i > 0) m = Math.max(m, amp[c - 1]! * 0.85);
          if (i < nx - 1) m = Math.max(m, amp[c + 1]! * 0.85);
          if (j > 0) m = Math.max(m, amp[c - nx]! * 0.85);
          if (j < ny - 1) m = Math.max(m, amp[c + nx]! * 0.85);
          amp[c] = m;
        }
  } else {
    const F = fetchMap(g, band.toward, band.scale * 4);
    for (let i = 0; i < n; i++) amp[i] = water[i] ? Math.tanh(Math.sqrt(F[i]! / band.scale)) : 0;
    // Two cells onto land, like T, so the filtered amplitude does not dip at the waterline.
    for (let pass = 0; pass < 2; pass++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          if (water[c]) continue;
          let m = amp[c]!;
          if (i > 0) m = Math.max(m, amp[c - 1]!);
          if (i < nx - 1) m = Math.max(m, amp[c + 1]!);
          if (j > 0) m = Math.max(m, amp[c - nx]!);
          if (j < ny - 1) m = Math.max(m, amp[c + nx]!);
          amp[c] = m;
        }
  }
  return { band, T, amp, reach };
}
