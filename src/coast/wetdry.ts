// Wet and dry (pure; worker-safe). A cell is under water when the water level stands above its *spill height*:
// the lowest level at which water from the open sea can reach it, i.e. the highest ground along the best path in.
// Diked salt ponds, subsided Delta islands and inland lakes stay dry until the tide overtops their levees, as they
// do in reality, instead of filling just because their floor is below the tide.
// Spill heights by priority flood (Barnes, Lehman & Mulla 2014) with a FIFO queue for cells inside depressions.

export interface SpillOptions {
  /** Boundary cells below this height seed the open sea (m). */
  boundarySeed?: number;
  /** Any cell below this height is open water (m). */
  interiorSeed?: number;
}

/** Spill height per cell (m); Infinity where no water path from a seed exists. */
export function spillHeights(h: Float32Array, nx: number, ny: number, o: SpillOptions = {}): Float32Array {
  const boundary = o.boundarySeed ?? -2;
  const interior = o.interiorSeed ?? -8;
  const n = nx * ny;
  const E = new Float32Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  // Min-heap on E.
  let keys = new Float32Array(1 << 16);
  let idx = new Int32Array(1 << 16);
  let hn = 0;
  const push = (k: number, i: number) => {
    if (hn === keys.length) {
      const k2 = new Float32Array(hn * 2);
      k2.set(keys);
      keys = k2;
      const i2 = new Int32Array(hn * 2);
      i2.set(idx);
      idx = i2;
    }
    let c = hn++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[c] = keys[p]!;
      idx[c] = idx[p]!;
      c = p;
    }
    keys[c] = k;
    idx[c] = i;
  };
  const pop = () => {
    const out = idx[0]!;
    const k = keys[--hn]!;
    const ix = idx[hn]!;
    let c = 0;
    for (;;) {
      let m = 2 * c + 1;
      if (m >= hn) break;
      if (m + 1 < hn && keys[m + 1]! < keys[m]!) m++;
      if (keys[m]! >= k) break;
      keys[c] = keys[m]!;
      idx[c] = idx[m]!;
      c = m;
    }
    keys[c] = k;
    idx[c] = ix;
    return out;
  };
  const seed = (i: number) => {
    if (closed[i]) return;
    closed[i] = 1;
    E[i] = h[i]!;
    push(E[i]!, i);
  };
  for (let x = 0; x < nx; x++) {
    if (h[x]! < boundary) seed(x);
    if (h[(ny - 1) * nx + x]! < boundary) seed((ny - 1) * nx + x);
  }
  for (let y = 0; y < ny; y++) {
    if (h[y * nx]! < boundary) seed(y * nx);
    if (h[y * nx + nx - 1]! < boundary) seed(y * nx + nx - 1);
  }
  for (let i = 0; i < n; i++) if (h[i]! < interior) seed(i);

  const pit = new Int32Array(n);
  let ph = 0;
  let pt = 0;
  while (hn > 0 || ph < pt) {
    const c = ph < pt ? pit[ph++]! : pop();
    if (ph === pt) ph = pt = 0;
    const e = E[c]!;
    const x = c % nx;
    for (let k = 0; k < 4; k++) {
      let j: number;
      if (k === 0) {
        if (x === 0) continue;
        j = c - 1;
      } else if (k === 1) {
        if (x === nx - 1) continue;
        j = c + 1;
      } else if (k === 2) {
        if (c < nx) continue;
        j = c - nx;
      } else {
        if (c >= n - nx) continue;
        j = c + nx;
      }
      if (closed[j]) continue;
      closed[j] = 1;
      const hj = h[j]!;
      if (hj <= e) {
        E[j] = e;
        pit[pt++] = j;
      } else {
        E[j] = hj;
        push(hj, j);
      }
    }
  }
  return E;
}

// ── Tidal domain ──
// At ≈ 60 m the levees around salt ponds and diked marsh are smeared below spring high water, and hydro-flattened
// pond surfaces sit at 1–2.3 m: a plain spill test would flood them every high tide. Three corrections, in order:
// 1. levee restoration: narrow ridges (top-hat of a morphological opening) on low ground are raised before the
//    spill test (connectivity only; the rendered terrain is untouched);
// 2. flat ponds: connected, perfectly flat areas (a lidar water surface) are still water, never tidal;
// 3. diked depressions: cells more than `depression` below their spill height (sill above low water) are diked
//    land; both kinds become barriers and the spill is recomputed, so nothing behind them is tidal either.

export const KIND_TIDAL = 0;
export const KIND_DIKED = 1;
export const KIND_POND = 2;

export interface TidalOptions extends SpillOptions {
  /** Opening radius (cells) for levee detection. */
  leveeRadius?: number;
  /** Minimum ridge prominence (m) above the opening to count as a levee. */
  leveeProminence?: number;
  /** Height added to levee cells for the connectivity test (m). */
  leveeRaise?: number;
  /** Levees are looked for between these heights (m). */
  leveeBand?: [number, number];
  /** Max 3×3 range (m) for a flat pond cell, and the minimum pond size (cells). */
  pondFlatness?: number;
  pondMinCells?: number;
  /** Depth below the spill height (m) that marks a diked depression, and the sill level it must exceed. */
  depression?: number;
  depressionSill?: number;
}

export interface TidalDomain {
  /** Spill height (m) for tidal water; Infinity for ponds, diked land and anything only reachable through them. */
  spill: Float32Array;
  /** KIND_TIDAL, KIND_DIKED or KIND_POND per cell. */
  kind: Uint8Array;
}

function minMax(src: Float32Array, nx: number, ny: number, r: number, max: boolean): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pick = max ? Math.max : Math.min;
  const init = max ? -Infinity : Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let m = init;
      for (let u = -r; u <= r; u++) m = pick(m, src[j * nx + Math.min(nx - 1, Math.max(0, i + u))]!);
      tmp[j * nx + i] = m;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let m = init;
      for (let v = -r; v <= r; v++) m = pick(m, tmp[Math.min(ny - 1, Math.max(0, j + v)) * nx + i]!);
      out[j * nx + i] = m;
    }
  return out;
}

export function tidalDomain(h: Float32Array, nx: number, ny: number, o: TidalOptions = {}): TidalDomain {
  const n = nx * ny;
  const r = o.leveeRadius ?? 2;
  const prom = o.leveeProminence ?? 0.15;
  const raise = o.leveeRaise ?? 1;
  const [b0, b1] = o.leveeBand ?? [0.5, 6];
  const flatTol = o.pondFlatness ?? 0.015;
  const pondMin = o.pondMinCells ?? 20;
  const dep = o.depression ?? 0.3;
  const sill = o.depressionSill ?? -0.5;

  // 1. Levees.
  const opened = minMax(minMax(h, nx, ny, r, false), nx, ny, r, true);
  const hc = new Float32Array(h);
  for (let i = 0; i < n; i++) if (h[i]! > b0 && h[i]! < b1 && h[i]! - opened[i]! > prom) hc[i] = h[i]! + raise;

  // 2. Flat ponds: connected components of cells whose 3×3 range is below flatTol.
  const kind = new Uint8Array(n);
  const flat = new Uint8Array(n);
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      const hv = h[c]!;
      if (hv < -0.5 || hv > 20) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = -1; v <= 1; v++)
        for (let u = -1; u <= 1; u++) {
          const x = h[c + v * nx + u]!;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      if (hi - lo < flatTol) flat[c] = 1;
    }
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!flat[s] || comp[s]! >= 0) continue;
    let sp = 0;
    let m = 0;
    stack[sp++] = s;
    comp[s] = s;
    while (sp) {
      const k = stack[--sp]!;
      members[m++] = k;
      const x = k % nx;
      for (let q = 0; q < 4; q++) {
        const j = q === 0 ? (x > 0 ? k - 1 : -1) : q === 1 ? (x < nx - 1 ? k + 1 : -1) : q === 2 ? k - nx : k + nx;
        if (j < 0 || j >= n || !flat[j] || comp[j]! >= 0 || Math.abs(h[j]! - h[k]!) >= flatTol) continue;
        comp[j] = s;
        stack[sp++] = j;
      }
    }
    if (m >= pondMin) for (let q = 0; q < m; q++) kind[members[q]!] = KIND_POND;
  }

  // 3. Diked depressions, then the spill again with every non-tidal cell as a wall.
  const E1 = spillHeights(hc, nx, ny, o);
  for (let i = 0; i < n; i++) if (kind[i] !== KIND_POND && E1[i]! > sill && E1[i]! - h[i]! > dep) kind[i] = KIND_DIKED;
  for (let i = 0; i < n; i++) if (kind[i]) hc[i] = 1e4;
  const spill = spillHeights(hc, nx, ny, o);
  for (let i = 0; i < n; i++) if (kind[i] || spill[i]! >= 1e4) spill[i] = Infinity;
  return { spill, kind };
}

/** Water depth (m) where wet, 0 where dry. */
export const depthAt = (terrain: number, spill: number, level: number) => (level > spill ? Math.max(level - terrain, 0) : 0);

/** True when the cell is under water at this level. */
export const isWet = (spill: number, level: number) => level > spill;

/**
 * Wet area (km²) of a region at a uniform level or a per-cell level field, counting cells where mask(i) holds.
 * cellKm2: area of one cell.
 */
export function wetArea(spill: Float32Array, level: number | ArrayLike<number>, cellKm2: number, mask?: (i: number) => boolean): number {
  let a = 0;
  for (let i = 0; i < spill.length; i++) {
    if (mask && !mask(i)) continue;
    const L = typeof level === 'number' ? level : level[i]!;
    if (L > spill[i]!) a += cellKm2;
  }
  return a;
}
