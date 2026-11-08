// Live terrain for the finale (HANDOFF §10.2): the AWS Terrarium tiles around a point, decoded with our own PNG
// reader (src/coast/png.ts) and resampled onto the regular latitude/longitude grid the coast renderer takes
// (src/coast/heightfield.ts). Pure: fetch and inflate are injectable (DecompressionStream in the browser, node:zlib
// in tests). Size is capped: ≈ 24 km square, at most 448 cells a side and 16 tiles.

import { parsePng, unfilter } from '../coast/png.ts';
import { latToTileY, lngToTileX, pixelMetres, terrariumHeight, terrariumUrl, TILE } from '../coast/terrarium.ts';
import { cellMetres, sampleGrid, type BBox, type Heightfield } from '../coast/heightfield.ts';
import type { FetchLike } from './eot20.ts';

export interface TerrainOptions {
  /** Half the box side, km. Default 12. */
  halfKm?: number;
  /** Cells along each side (the grid is square in km). Default 448. */
  cells?: number;
  /** Most tiles fetched; the zoom drops until the box fits. Default 16. */
  maxTiles?: number;
  fetch?: FetchLike;
  /** zlib inflate (async). Default: DecompressionStream('deflate'). */
  inflate?: (z: Uint8Array) => Promise<Uint8Array>;
  signal?: AbortSignal;
  /** Tile URL builder (tests). */
  url?: (z: number, x: number, y: number) => string;
}

export interface TerrainResult {
  hf: Heightfield;
  zoom: number;
  tiles: number;
  /** Ground size of one tile pixel at the centre, m. */
  pixelM: number;
}

export class TerrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainError';
  }
}

const KM_LAT = 110.574;
const KM_LNG = 111.32;

/** The box around a point (km half-side), in degrees. */
export function terrainBox(lat: number, lng: number, halfKm: number): BBox {
  const dLat = halfKm / KM_LAT;
  const dLng = halfKm / (KM_LNG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

/** Zoom and tile range for a box: the finest zoom whose pixels are ≤ 1.5 cells and whose tiles number ≤ maxTiles. */
export function tilePlan(b: BBox, cellM: number, maxTiles: number) {
  const lat = (b.south + b.north) / 2;
  let z = 15;
  while (z > 1 && pixelMetres(lat, z) < cellM / 1.5) z--;
  for (; z >= 1; z--) {
    const x0 = Math.floor(lngToTileX(b.west, z));
    const x1 = Math.floor(lngToTileX(b.east, z));
    const y0 = Math.floor(latToTileY(b.north, z));
    const y1 = Math.floor(latToTileY(b.south, z));
    const n = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (n <= maxTiles) return { z, x0, x1, y0, y1, n };
  }
  return { z: 0, x0: 0, x1: 0, y0: 0, y1: 0, n: 1 };
}

async function browserInflate(z: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Heights (m) of one Terrarium PNG (RGB or RGBA, 8 bit). */
export async function decodeTerrariumPng(bytes: Uint8Array, inflate: (z: Uint8Array) => Promise<Uint8Array>): Promise<Float32Array> {
  const { header, idat } = parsePng(bytes);
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new TerrainError('unexpected terrain tile format');
  const ch = colorType === 6 ? 4 : 3;
  const px = unfilter(await inflate(idat), width, height, ch);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = terrariumHeight(px[i * ch]!, px[i * ch + 1]!, px[i * ch + 2]!);
  return out;
}

/** Fetch the tiles around (lat, lng) and resample them onto a regular latitude/longitude grid. */
export async function loadTerrain(lat: number, lng: number, o: TerrainOptions = {}): Promise<TerrainResult> {
  const halfKm = o.halfKm ?? 12;
  const cells = o.cells ?? 448;
  const bbox = terrainBox(lat, lng, halfKm);
  const cellM = (2 * halfKm * 1000) / cells;
  const plan = tilePlan(bbox, cellM, o.maxTiles ?? 16);
  const fetchFn = o.fetch ?? ((u: string, i?: { signal?: AbortSignal }) => fetch(u, i));
  const inflate = o.inflate ?? browserInflate;
  const url = o.url ?? terrariumUrl;
  const get = (z: number, x0: number, x1: number, y0: number, y1: number) => mosaicOf(z, x0, x1, y0, y1, fetchFn, inflate, url, o.signal);
  // The fine tiles, and a coarse layer (zoom − 2) whose bathymetry fills seas that the fine sources flatten to 0 m.
  const cz = Math.max(1, plan.z - 2);
  const [fine, coarse] = await Promise.all([
    get(plan.z, plan.x0, plan.x1, plan.y0, plan.y1),
    get(cz, Math.floor(lngToTileX(bbox.west, cz)), Math.floor(lngToTileX(bbox.east, cz)), Math.floor(latToTileY(bbox.north, cz)), Math.floor(latToTileY(bbox.south, cz))).catch(() => null),
  ]);
  const nx = cells;
  const ny = cells;
  const data = resample(fine, bbox, nx, ny);
  const deep = coarse ? resample(coarse, bbox, nx, ny) : null;
  const hf: Heightfield = { nx, ny, bbox, data };
  despike(hf);
  fillFlatWater(hf, deep);
  return { hf, zoom: plan.z, tiles: plan.n, pixelM: pixelMetres(lat, plan.z) };
}

interface Mosaic {
  z: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Float32Array;
}

async function mosaicOf(
  z: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  fetchFn: FetchLike,
  inflate: (z: Uint8Array) => Promise<Uint8Array>,
  url: (z: number, x: number, y: number) => string,
  signal?: AbortSignal,
): Promise<Mosaic> {
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const MW = tw * TILE;
  const MH = th * TILE;
  const data = new Float32Array(MW * MH);
  const n = 2 ** z;
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n; // the antimeridian wraps
      jobs.push(
        (async () => {
          let r: Response;
          try {
            r = await fetchFn(url(z, wx, ty), { signal });
          } catch (err) {
            if (signal?.aborted) throw err;
            throw new TerrainError('terrain tiles could not be reached (offline?)');
          }
          if (!r.ok) throw new TerrainError(`terrain tile HTTP ${r.status}`);
          const h = await decodeTerrariumPng(new Uint8Array(await r.arrayBuffer()), inflate);
          const ox = (tx - x0) * TILE;
          const oy = (ty - y0) * TILE;
          for (let y = 0; y < TILE; y++) data.set(h.subarray(y * TILE, (y + 1) * TILE), (oy + y) * MW + ox);
        })(),
      );
    }
  await Promise.all(jobs);
  return { z, x0, y0, w: MW, h: MH, data };
}

/** Bilinear resample of a Web Mercator mosaic onto a regular latitude/longitude grid over bbox. */
function resample(m: Mosaic, bbox: BBox, nx: number, ny: number): Float32Array {
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const la = bbox.north - ((j + 0.5) / ny) * (bbox.north - bbox.south);
    const gy = (latToTileY(la, m.z) - m.y0) * TILE - 0.5;
    for (let i = 0; i < nx; i++) {
      const lo = bbox.west + ((i + 0.5) / nx) * (bbox.east - bbox.west);
      const gx = (lngToTileX(lo, m.z) - m.x0) * TILE - 0.5;
      out[j * nx + i] = sampleGrid(m.data, m.w, m.h, gx, gy);
    }
  }
  return out;
}

/** Single-cell spikes and pits (towers, voids) are clamped to their neighbours' range ± 25 m. */
export function despike(hf: Heightfield): number {
  const { nx, ny, data } = hf;
  const src = Float32Array.from(data);
  let n = 0;
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = -1; v <= 1; v++)
        for (let u = -1; u <= 1; u++) {
          if (!u && !v) continue;
          const q = src[k + v * nx + u]!;
          lo = Math.min(lo, q);
          hi = Math.max(hi, q);
        }
      const h = src[k]!;
      if (h > hi + 25 || h < lo - 25) {
        data[k] = Math.min(hi, Math.max(lo, h));
        n++;
      }
    }
  return n;
}

/**
 * Many land sources (SRTM, EU-DEM, lidar) flatten the sea and estuaries to a level surface near 0 m, and the tiles
 * keep it at fine zooms: the renderer would see a metre-deep sheet that dries at every low tide. Large flat areas
 * near 0 m connected to real water or the box edge are taken as water; their depth is the coarser layer's
 * bathymetry where it has some, and never shallower than a gentle shelf from the shore (0.3 m + 1.5 % of the
 * distance, capped at 25 m), the way NY Harbor is rebuilt for the labs (DECISIONS.md).
 */
export function fillFlatWater(hf: Heightfield, deep: Float32Array | null): number {
  const { nx, ny, data } = hf;
  const n = nx * ny;
  const flat = new Uint8Array(n);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = data[k]!;
      if (h < -0.5) {
        flat[k] = 2; // real water
        continue;
      }
      if (Math.abs(h) > 1) continue;
      let lo = h;
      let hi = h;
      for (let v = -1; v <= 1; v++)
        for (let u = -1; u <= 1; u++) {
          const q = data[Math.min(ny - 1, Math.max(0, j + v)) * nx + Math.min(nx - 1, Math.max(0, i + u))]!;
          lo = Math.min(lo, q);
          hi = Math.max(hi, q);
        }
      if (hi - lo < 0.05) flat[k] = 1;
    }
  // Connected regions of flat and real water; keep those that touch real water or the edge and are big enough.
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let filled = 0;
  for (let s = 0; s < n; s++) {
    if (!flat[s] || comp[s] !== -1) continue;
    const members: number[] = [];
    let wet = false;
    let edge = false;
    comp[s] = s;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      if (flat[k] === 2) wet = true;
      const i = k % nx;
      const j = (k - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const q of nb)
        if (q >= 0 && flat[q] && comp[q] === -1) {
          comp[q] = s;
          stack.push(q);
        }
    }
    const big = members.length >= Math.max(150, n * 0.004);
    if (!(big && (wet || edge))) for (const k of members) if (flat[k] === 1) flat[k] = 0;
  }
  // Distance from the shore (cells that are not water), two-pass chamfer, in cells.
  const dist = new Float32Array(n);
  for (let k = 0; k < n; k++) dist[k] = flat[k] ? 1e9 : 0;
  const D = Math.SQRT2;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!dist[k]) continue;
      let d = dist[k]!;
      if (i > 0) d = Math.min(d, dist[k - 1]! + 1);
      if (j > 0) {
        d = Math.min(d, dist[k - nx]! + 1);
        if (i > 0) d = Math.min(d, dist[k - nx - 1]! + D);
        if (i < nx - 1) d = Math.min(d, dist[k - nx + 1]! + D);
      }
      dist[k] = d;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!dist[k]) continue;
      let d = dist[k]!;
      if (i < nx - 1) d = Math.min(d, dist[k + 1]! + 1);
      if (j < ny - 1) {
        d = Math.min(d, dist[k + nx]! + 1);
        if (i < nx - 1) d = Math.min(d, dist[k + nx + 1]! + D);
        if (i > 0) d = Math.min(d, dist[k + nx - 1]! + D);
      }
      dist[k] = d;
    }
  const [cx, cy] = cellMetres(hf);
  const cell = (cx + cy) / 2;
  for (let k = 0; k < n; k++) {
    if (flat[k] !== 1) continue;
    const shelf = -Math.min(25, 0.3 + 0.015 * dist[k]! * cell);
    const c = deep ? deep[k]! : 0;
    data[k] = Math.min(shelf, c < -0.5 ? c : 0);
    filled++;
  }
  return filled;
}

// ── What the terrain says about the place ──────────────────────────────────────────────────────────────────────

export interface CoastFacts {
  /** Fraction of cells below mean sea level. */
  water: number;
  /** Where to look: the water cell nearest the requested point that touches land (else the nearest water cell, else
   * the point itself). */
  target: { lat: number; lng: number };
  /** Bearing (degrees from north) from the open water towards the land: the swell's direction and the camera's view. */
  towardLand: number;
  /** 99th percentile of land heights, m. */
  reliefP99: number;
}

export function coastFacts(hf: Heightfield, lat: number, lng: number): CoastFacts {
  const { nx, ny, bbox, data } = hf;
  const cx = ((lng - bbox.west) / (bbox.east - bbox.west)) * nx - 0.5;
  const cy = ((bbox.north - lat) / (bbox.north - bbox.south)) * ny - 0.5;
  let wet = 0;
  let best = -1;
  let bestD = Infinity;
  let anyBest = -1;
  let anyD = Infinity;
  let sx = 0;
  let sz = 0;
  let sw = 0;
  const land: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = data[k]!;
      if (h < 0) {
        wet++;
        const d = (i - cx) ** 2 + (j - cy) ** 2;
        if (d < anyD) {
          anyD = d;
          anyBest = k;
        }
        const shore = (i > 0 && data[k - 1]! >= 0) || (i < nx - 1 && data[k + 1]! >= 0) || (j > 0 && data[k - nx]! >= 0) || (j < ny - 1 && data[k + nx]! >= 0);
        if (shore && d < bestD) {
          bestD = d;
          best = k;
        }
        // Direction of the open water: deeper water weighs more.
        const w = Math.min(60, -h);
        sx += w * (i + 0.5 - nx / 2);
        sz += w * (j + 0.5 - ny / 2);
        sw += w;
      } else if (land.length < 40000 || (i + j) % 4 === 0) land.push(h);
    }
  const pick = best >= 0 ? best : anyBest;
  const target = pick >= 0 ? { lat: bbox.north - ((Math.floor(pick / nx) + 0.5) / ny) * (bbox.north - bbox.south), lng: bbox.west + (((pick % nx) + 0.5) / nx) * (bbox.east - bbox.west) } : { lat, lng };
  // Grid x is east, grid j is south: the water's centroid direction, reversed, points at the land.
  let towardLand = 90;
  if (sw > 0 && Math.hypot(sx, sz) > 1e-6 * sw) {
    const ex = -sx;
    const north = sz; // −(−z)
    towardLand = ((Math.atan2(ex, north) * 180) / Math.PI + 360) % 360;
  }
  land.sort((a, b) => a - b);
  const reliefP99 = land.length ? land[Math.min(land.length - 1, Math.floor(land.length * 0.99))]! : 0;
  return { water: wet / (nx * ny), target, towardLand, reliefP99 };
}

/** Vertical exaggeration for a place: tall enough to read a tide, never so tall that mountains become spikes. */
export function exaggerationFor(reliefP99: number): number {
  const e = 1400 / Math.max(1, reliefP99);
  return Math.round(Math.min(3, Math.max(1.5, e)) * 2) / 2;
}
