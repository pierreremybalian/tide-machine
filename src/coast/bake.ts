// Everything the coast renderer derives from a heightfield and its tide stations, in one pure function (run in a
// Web Worker by src/shared/water/, cached per region): the tidal domain (spill heights, diked land, ponds), ambient
// occlusion, the coarse grid of the tide field with water-path detours, and the wave bands' travel times.

import { ambientOcclusion, cellMetres, projection, type BBox, type Heightfield } from './heightfield.ts';
import { KIND_DIKED, KIND_POND, signedDistance, tidalDomain, type TidalOptions } from './wetdry.ts';
import { createTideField, detourGrid, fillLevels, type BayStation, type DetourGrid } from './tidefield.ts';
import { bandField, type WaveBand } from './waves.ts';

export interface BakeOptions {
  /** Wave grid = heightfield / waveDown. */
  waveDown?: number;
  /** Tide-field grid = heightfield / fieldDown. */
  fieldDown?: number;
  bands: WaveBand[];
  /** Cells that can be wet at this height above local mean sea level count as water for waves and detours (m). */
  highAboveMean?: number;
  tidal?: TidalOptions;
  /** AO exaggeration (match the rendered relief). */
  aoExaggeration?: number;
}

export interface CoarseGrid {
  nx: number;
  ny: number;
  bbox: BBox;
}

export interface CoastBake {
  /** Full resolution. Spill height (m), Infinity where never tidal. */
  spill: Float32Array;
  kind: Uint8Array;
  /** Signed distances (cells, ±4, positive inside) to salt ponds and to diked land, for smooth class edges. */
  pondSdf: Float32Array;
  dikedSdf: Float32Array;
  ao: Float32Array;
  /** Tide-field grid (coarse). */
  field: CoarseGrid & { meanLevel: Float32Array };
  detour: DetourGrid;
  wave: CoarseGrid & { dx: number; dy: number; T: Float32Array[]; amp: Float32Array[]; bands: WaveBand[]; reach: Float32Array };
  /** Milliseconds per step, for the perf notes. */
  timings: Record<string, number>;
}

/** Coarse grid whose cells are exact blocks of the fine grid (edges trimmed when not divisible). */
function coarse(hf: Heightfield, f: number): CoarseGrid {
  const nx = Math.floor(hf.nx / f);
  const ny = Math.floor(hf.ny / f);
  const b = hf.bbox;
  return {
    nx,
    ny,
    bbox: { ...b, east: b.west + ((b.east - b.west) * nx * f) / hf.nx, south: b.north - ((b.north - b.south) * ny * f) / hf.ny },
  };
}

/** Block reduction of a fine field onto a coarse grid. */
function reduce(src: ArrayLike<number>, hf: Heightfield, g: CoarseGrid, f: number, op: 'min' | 'mean'): Float32Array {
  const out = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      let acc = op === 'min' ? Infinity : 0;
      for (let v = 0; v < f; v++)
        for (let u = 0; u < f; u++) {
          const x = src[(j * f + v) * hf.nx + i * f + u]!;
          acc = op === 'min' ? Math.min(acc, x) : acc + x;
        }
      out[j * g.nx + i] = op === 'min' ? acc : acc / (f * f);
    }
  return out;
}

/** World-space cell centres (x, z pairs, km) of a coarse grid in the heightfield's projection. */
export function gridPoints(g: CoarseGrid, bbox: BBox): Float32Array {
  const p = projection(bbox);
  const pts = new Float32Array(g.nx * g.ny * 2);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      const lng = g.bbox.west + ((i + 0.5) / g.nx) * (g.bbox.east - g.bbox.west);
      const lat = g.bbox.north - ((j + 0.5) / g.ny) * (g.bbox.north - g.bbox.south);
      pts[(j * g.nx + i) * 2] = p.x(lng);
      pts[(j * g.nx + i) * 2 + 1] = p.z(lat);
    }
  return pts;
}

export function bakeCoast(hf: Heightfield, stations: BayStation[], o: BakeOptions): CoastBake {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    timings[k] = Math.round(now - t);
    t = now;
  };
  const { spill, kind } = tidalDomain(hf.data, hf.nx, hf.ny, o.tidal);
  const pondSdf = signedDistance((i) => kind[i] === KIND_POND, hf.nx, hf.ny);
  const dikedSdf = signedDistance((i) => kind[i] === KIND_DIKED || kind[i] === KIND_POND, hf.nx, hf.ny);
  lap('tidal');
  const ao = ambientOcclusion(hf, o.aoExaggeration ?? 2.5);
  lap('ao');

  // Tide-field grid: mean sea level everywhere (zero tide) from the stations' offsets.
  const fd = o.fieldDown ?? 10;
  const fg = coarse(hf, fd);
  const plain = createTideField(stations, { bbox: hf.bbox });
  const offsets = plain.stations.map((s) => s.offset);
  const fpts = gridPoints(fg, hf.bbox);
  const meanLevel = new Float32Array(fg.nx * fg.ny);
  fillLevels(plain.weights(fpts), offsets, meanLevel);
  const high = o.highAboveMean ?? 1.0;
  const spillF = reduce(spill, hf, fg, fd, 'min');
  const waterF = new Uint8Array(fg.nx * fg.ny);
  for (let i = 0; i < waterF.length; i++) waterF[i] = spillF[i]! < meanLevel[i]! + high ? 1 : 0;
  const detour = detourGrid(stations, waterF, fg.nx, fg.ny, fg.bbox);
  lap('detour');

  // Wave grid.
  const wd = o.waveDown ?? 2;
  const wg = coarse(hf, wd);
  const hW = reduce(hf.data, hf, wg, wd, 'mean');
  const sW = reduce(spill, hf, wg, wd, 'min');
  const [cx, cy] = cellMetres(hf);
  const depth = new Float32Array(wg.nx * wg.ny);
  const water = new Uint8Array(wg.nx * wg.ny);
  for (let j = 0; j < wg.ny; j++)
    for (let i = 0; i < wg.nx; i++) {
      const c = j * wg.nx + i;
      // Mean level from the field grid (nearest coarse cell is plenty: it varies by centimetres per km).
      const fi = Math.min(fg.nx - 1, Math.floor(((i + 0.5) * wd) / fd));
      const fj = Math.min(fg.ny - 1, Math.floor(((j + 0.5) * wd) / fd));
      const m = meanLevel[fj * fg.nx + fi]!;
      depth[c] = m - hW[c]!;
      water[c] = sW[c]! < m + high ? 1 : 0;
    }
  const grid = { nx: wg.nx, ny: wg.ny, dx: cx * wd, dy: cy * wd, depth, water };
  const T: Float32Array[] = [];
  const amp: Float32Array[] = [];
  let reach: Float32Array = new Float32Array(wg.nx * wg.ny);
  for (const b of o.bands) {
    const f = bandField(grid, b);
    T.push(f.T);
    amp.push(f.amp);
    if (f.reach) reach = f.reach;
    lap(`band ${b.period}s`);
  }
  return {
    spill,
    kind,
    pondSdf,
    dikedSdf,
    ao,
    field: { ...fg, meanLevel },
    detour,
    wave: { ...wg, dx: grid.dx, dy: grid.dy, T, amp, bands: o.bands, reach },
    timings,
  };
}
