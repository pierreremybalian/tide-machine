// The bay's water-level field from its tide stations (pure; worker-safe).
//
// Every station's level comes from src/tides/predict.ts with its own NOAA harmonic constants. Levels are put on one
// vertical datum, NAVD88 (the terrain's land datum): h_j(t) = (MSL − NAVD88)_j + Σ f H cos(V + u − κ), i.e. the
// harmonic sum about local mean sea level plus the station's published MSL−NAVD88 tie. Stations without a NAVD88 tie
// take that offset by inverse-distance weighting from the stations that have one; stations without any datums are
// treated the same way (their tide is still about MSL, because the harmonic sum has no constant term).
//
// Between stations, levels are blended by modified Shepard weighting (Franke & Nielson 1980): w = ((R − d)/(R d))²,
// R = distance to the (k+1)-th nearest station, so the field is smooth, local, and exactly the station's own
// prediction at the station. Distances are water-path aware: d = |x − s| · detour(x), where detour ≥ 1 is the ratio
// of the shortest path through water (fast marching over the tidal domain) to the straight line. A station on the
// far side of a peninsula therefore weighs as little as the water path is long.

import { prepare, predict, type Prepared, type StationConstants } from '../tides/predict.ts';
import { fastMarch } from './eikonal.ts';
import { projection, sampleGrid, type BBox } from './heightfield.ts';

export interface BayStation {
  id: string;
  name: string;
  label: string;
  lat: number;
  lng: number;
  /** MSL above MLLW (m), null without datums. */
  z0: number | null;
  /** MSL above NAVD88 (m), null without a NAVD88 tie. */
  mslNavd88: number | null;
  constituents: StationConstants['constituents'];
  inTerrain?: boolean;
}

export interface FieldStation {
  id: string;
  label: string;
  lat: number;
  lng: number;
  /** World position (km) in the field's projection. */
  x: number;
  z: number;
  /** MSL above the common datum (m). */
  offset: number;
  /** True when offset was interpolated (no published NAVD88 tie). */
  inferred: boolean;
  /** MSL above MLLW (m) when published: converts our NAVD88 levels back to chart datum for readouts. */
  z0: number | null;
  /** Harmonic sum about MSL (z0 = 0). */
  prepared: Prepared;
}

/** Shortest-water-path / straight-line ratio per station on a regular grid over the bbox. */
export interface DetourGrid {
  nx: number;
  ny: number;
  bbox: BBox;
  /** One Float32Array per station (same order as the field's stations); 1 where unknown. */
  factors: Float32Array[];
}

export interface TideField {
  stations: FieldStation[];
  datum: 'NAVD88';
  /** Levels (m above datum) at every station at time ms. */
  levels(ms: number, out?: Float64Array): Float64Array;
  /** Interpolated level at a world point (km) given station levels. */
  at(x: number, z: number, levels: ArrayLike<number>): number;
  /** Interpolated level at a latitude/longitude. */
  atLatLng(lat: number, lng: number, levels: ArrayLike<number>): number;
  /** Precompute sparse weights for a grid of world points, for fast per-frame fills. */
  weights(points: Float32Array): FieldWeights;
  detour: DetourGrid | null;
}

export interface FieldWeights {
  /** Points (x, z pairs). */
  count: number;
  k: number;
  idx: Uint16Array;
  w: Float32Array;
  /** Index of an exactly coincident station, or −1. */
  exact: Int16Array;
}

export interface FieldOptions {
  /** Projection bbox (the terrain's). */
  bbox: BBox;
  /** Neighbours in the Shepard blend (R is the distance to the (k+1)-th). */
  k?: number;
  detour?: DetourGrid | null;
}

/** IDW (power 2) of known offsets to fill stations without a NAVD88 tie. */
function fillOffsets(st: BayStation[], xz: [number, number][]): { offset: number; inferred: boolean }[] {
  const known = st.map((s, i) => ({ i, v: s.mslNavd88 })).filter((k) => k.v !== null) as { i: number; v: number }[];
  return st.map((s, i) => {
    if (s.mslNavd88 !== null) return { offset: s.mslNavd88, inferred: false };
    if (!known.length) return { offset: 0, inferred: true };
    let sw = 0;
    let sv = 0;
    for (const k of known) {
      const dx = xz[i]![0] - xz[k.i]![0];
      const dz = xz[i]![1] - xz[k.i]![1];
      const w = 1 / Math.max(dx * dx + dz * dz, 1e-6);
      sw += w;
      sv += w * k.v;
    }
    return { offset: sv / sw, inferred: true };
  });
}

export function createTideField(input: BayStation[], o: FieldOptions): TideField {
  const proj = projection(o.bbox);
  const xz = input.map((s) => [proj.x(s.lng), proj.z(s.lat)] as [number, number]);
  const offs = fillOffsets(input, xz);
  const stations: FieldStation[] = input.map((s, i) => ({
    id: s.id,
    label: s.label,
    lat: s.lat,
    lng: s.lng,
    x: xz[i]![0],
    z: xz[i]![1],
    offset: offs[i]!.offset,
    inferred: offs[i]!.inferred,
    z0: s.z0,
    prepared: prepare({ id: s.id, z0: 0, constituents: s.constituents }),
  }));
  const n = stations.length;
  const k = Math.min(o.k ?? 6, n - 1);
  const detour = o.detour ?? null;
  const dist = new Float64Array(n);
  const order = new Int32Array(n);

  // Grid coordinates of a world point in the detour grid.
  const ext = detour
    ? { x0: proj.x(detour.bbox.west), x1: proj.x(detour.bbox.east), z0: proj.z(detour.bbox.north), z1: proj.z(detour.bbox.south) }
    : null;
  const detourAt = (j: number, x: number, z: number) => {
    if (!detour || !ext) return 1;
    const gx = ((x - ext.x0) / (ext.x1 - ext.x0)) * detour.nx - 0.5;
    const gy = ((z - ext.z0) / (ext.z1 - ext.z0)) * detour.ny - 0.5;
    return Math.max(1, sampleGrid(detour.factors[j]!, detour.nx, detour.ny, gx, gy));
  };

  /** Fills dist and order (ascending); returns the index of a coincident station or −1. */
  const rank = (x: number, z: number): number => {
    for (let j = 0; j < n; j++) {
      const s = stations[j]!;
      const e = Math.hypot(x - s.x, z - s.z);
      if (e < 1e-9) return j;
      dist[j] = e * detourAt(j, x, z);
      order[j] = j;
    }
    // Insertion sort (n ≈ 35).
    for (let a = 1; a < n; a++) {
      const v = order[a]!;
      let b = a - 1;
      while (b >= 0 && dist[order[b]!]! > dist[v]!) {
        order[b + 1] = order[b]!;
        b--;
      }
      order[b + 1] = v;
    }
    return -1;
  };

  const field: TideField = {
    stations,
    datum: 'NAVD88',
    detour,
    levels(ms, out = new Float64Array(n)) {
      for (let j = 0; j < n; j++) out[j] = stations[j]!.offset + predict(stations[j]!.prepared, ms);
      return out;
    },
    at(x, z, levels) {
      const hit = rank(x, z);
      if (hit >= 0) return levels[hit]!;
      const R = dist[order[k]!]!;
      let sw = 0;
      let sv = 0;
      for (let a = 0; a < k; a++) {
        const j = order[a]!;
        const d = dist[j]!;
        const w = ((R - d) / (R * d)) ** 2;
        sw += w;
        sv += w * levels[j]!;
      }
      // All k at the same distance as the (k+1)-th: fall back to plain inverse-distance.
      if (!(sw > 0)) {
        for (let a = 0; a < k; a++) {
          const j = order[a]!;
          const w = 1 / dist[j]! ** 2;
          sw += w;
          sv += w * levels[j]!;
        }
      }
      return sv / sw;
    },
    atLatLng(lat, lng, levels) {
      return field.at(proj.x(lng), proj.z(lat), levels);
    },
    weights(points) {
      const count = points.length >> 1;
      const idx = new Uint16Array(count * k);
      const w = new Float32Array(count * k);
      const exact = new Int16Array(count).fill(-1);
      for (let p = 0; p < count; p++) {
        const hit = rank(points[2 * p]!, points[2 * p + 1]!);
        if (hit >= 0) {
          exact[p] = hit;
          continue;
        }
        const R = dist[order[k]!]!;
        let sw = 0;
        for (let a = 0; a < k; a++) {
          const j = order[a]!;
          const d = dist[j]!;
          let wt = ((R - d) / (R * d)) ** 2;
          if (!(wt > 0)) wt = 1e-12 / (d * d);
          idx[p * k + a] = j;
          w[p * k + a] = wt;
          sw += wt;
        }
        for (let a = 0; a < k; a++) w[p * k + a]! /= sw;
      }
      return { count, k, idx, w, exact };
    },
  };
  return field;
}

/** Apply precomputed weights: out[p] = Σ w·levels (no allocation). */
export function fillLevels(fw: FieldWeights, levels: ArrayLike<number>, out: Float32Array, stride = 1, offset = 0): void {
  const { count, k, idx, w, exact } = fw;
  for (let p = 0; p < count; p++) {
    let v: number;
    const e = exact[p]!;
    if (e >= 0) v = levels[e]!;
    else {
      v = 0;
      const b = p * k;
      for (let a = 0; a < k; a++) v += w[b + a]! * levels[idx[b + a]!]!;
    }
    out[p * stride + offset] = v;
  }
}

/**
 * Detour factors by fast marching (unit speed) from each station through `water` cells of a coarse grid.
 * Stations outside the grid or on dry cells start from the nearest water cell. Unreached cells get the factor of
 * their nearest reached neighbour (dilation), so land just beside the water inherits sensible weights.
 */
export function detourGrid(stations: { lat: number; lng: number }[], water: Uint8Array, nx: number, ny: number, bbox: BBox): DetourGrid {
  const proj = projection(bbox);
  const dx = ((proj.x(bbox.east) - proj.x(bbox.west)) / nx) * 1000;
  const dy = ((proj.z(bbox.south) - proj.z(bbox.north)) / ny) * 1000;
  const speed = new Float32Array(nx * ny);
  for (let i = 0; i < speed.length; i++) speed[i] = water[i] ? 1 : 0;
  const factors: Float32Array[] = [];
  const init = new Float64Array(nx * ny);
  for (const s of stations) {
    const gx = ((s.lng - bbox.west) / (bbox.east - bbox.west)) * nx - 0.5;
    const gy = ((bbox.north - s.lat) / (bbox.north - bbox.south)) * ny - 0.5;
    const f = new Float32Array(nx * ny).fill(1);
    factors.push(f);
    if (gx < -0.5 || gy < -0.5 || gx > nx - 0.5 || gy > ny - 0.5) continue;
    // Seed: the nearest water cell (within a few cells), at its true distance from the station.
    let best = -1;
    let bd = Infinity;
    const ci = Math.round(gx);
    const cj = Math.round(gy);
    for (let r = 0; r <= 6 && best < 0; r++)
      for (let v = -r; v <= r; v++)
        for (let u = -r; u <= r; u++) {
          const i = ci + u;
          const j = cj + v;
          if (i < 0 || j < 0 || i >= nx || j >= ny || !water[j * nx + i]) continue;
          const d = Math.hypot((i - gx) * dx, (j - gy) * dy);
          if (d < bd) {
            bd = d;
            best = j * nx + i;
          }
        }
    if (best < 0) continue;
    init.fill(Infinity);
    init[best] = bd;
    const T = fastMarch({ nx, ny, dx, dy }, speed, init);
    const reached = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!Number.isFinite(T[c]!)) continue;
        const e = Math.hypot((i - gx) * dx, (j - gy) * dy);
        f[c] = e > Math.max(dx, dy) * 1.5 ? Math.max(1, T[c]! / e) : 1;
        reached[c] = 1;
      }
    // Dilate into unreached cells (8 passes).
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let c = 0; c < nx * ny; c++) {
        if (reached[c]) continue;
        const x = c % nx;
        let m = Infinity;
        if (x > 0 && reached[c - 1] === 1) m = Math.min(m, f[c - 1]!);
        if (x < nx - 1 && reached[c + 1] === 1) m = Math.min(m, f[c + 1]!);
        if (c >= nx && reached[c - nx] === 1) m = Math.min(m, f[c - nx]!);
        if (c < nx * (ny - 1) && reached[c + nx] === 1) m = Math.min(m, f[c + nx]!);
        if (m < Infinity) {
          f[c] = m;
          reached[c] = 2;
          changed = true;
        }
      }
      for (let c = 0; c < nx * ny; c++) if (reached[c] === 2) reached[c] = 1;
      if (!changed) break;
    }
  }
  return { nx, ny, bbox, factors };
}
