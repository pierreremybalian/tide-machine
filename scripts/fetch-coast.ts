// Bakes the coast data for the bay stages (HANDOFF §6, §8.1): terrain + bathymetry and in-bay tide stations.
//   node scripts/fetch-coast.ts [--region sf|nyc] [--only terrain|stations] [--refresh]
// Writes public/data/bay/<region>-terrain.{bin,json} and public/data/bay/<region>-stations.json.
//
// Terrain: AWS Open Data terrain tiles (Terrarium PNG; NED/3DEP, NOAA CRM, ETOPO1, GEBCO, SRTM… see DECISIONS.md),
// mosaicked in Web Mercator, resampled (area-averaged) to a regular lat/lng grid, stored as little-endian float16
// metres, deflated. Decoded with src/coast/png.ts + node:zlib (no new dependency).
// Stations: NOAA CO-OPS metadata API (public domain), every harmonic station in the region's box, with datums.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng } from '../src/coast/png.ts';
import { decodeTerrarium, latToTileY, lngToTileX, pixelMetres, terrariumUrl, TILE } from '../src/coast/terrarium.ts';
import { cellMetres, packHeights, type BBox, type HeightfieldMeta } from '../src/coast/heightfield.ts';

const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';
const CACHE = new URL('./cache/', import.meta.url);
const OUT = new URL('../public/data/bay/', import.meta.url);
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const refresh = args.includes('--refresh');

interface Region {
  id: string;
  name: string;
  bbox: BBox;
  zoom: number;
  nx: number;
  ny: number;
  /** Box for the station search (may be wider than the terrain so the edges are constrained). */
  stationBox: BBox;
  /**
   * Rebuild the water's bathymetry from coarser tiles: at high zoom some regions carry hydro-flattened water
   * (a lidar water surface at ≈ 0 m NAVD88 in a tile patchwork) instead of soundings.
   */
  rebuildWater?: { zoom: number; flat: number; flatSurface: number; ramp: number; minDepth: number; maxDepth: number; edgeDepth: number };
  /** Cut narrow spikes (buildings left in the lidar) higher than this above a 5×5 morphological opening (m). */
  despike?: number;
}

export const REGIONS: Region[] = [
  {
    id: 'sf',
    name: 'San Francisco Bay',
    bbox: { south: 37.4, north: 38.25, west: -122.75, east: -121.85 },
    // z11 ≈ 60 m pixels at 37.8°N; grid ≈ 61.8 × 61.2 m.
    zoom: 11,
    nx: 1280,
    ny: 1536,
    stationBox: { south: 37.4, north: 38.25, west: -122.75, east: -121.85 },
  },
  {
    id: 'nyc',
    name: 'New York Harbor',
    bbox: { south: 40.62, north: 40.78, west: -74.1, east: -73.93 },
    // z13 ≈ 14.6 m pixels, area-averaged 2×2 to ≈ 28.0 × 27.6 m.
    zoom: 13,
    nx: 512,
    ny: 640,
    // NY Harbor's 30 harmonic stations (Sandy Hook to Throgs Neck); the field uses those near the terrain box.
    stationBox: { south: 40.45, north: 40.95, west: -74.3, east: -73.7 },
    // Harbor water at z11–z13 is flattened to ≈ 0 m in a checkerboard of tiles; z10 keeps the soundings.
    // Manhattan's shores are bulkheads: the rebuilt water starts ≈ 2.5 m deep at the wall.
    rebuildWater: { zoom: 10, flat: 0.15, flatSurface: 1.0, ramp: 0.06, minDepth: 1.0, maxDepth: 15, edgeDepth: 2.5 },
    despike: 4,
  },
];

// NOAA's JSON is untyped at this boundary; fields are read by name and checked by the data tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function fetchBytes(url: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      if (r.status === 404) throw new Error(`404 ${url}`);
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

/** Fetch through the gitignored cache (scripts/cache/). */
async function cached(key: string, url: string): Promise<Uint8Array> {
  const file = new URL(key, CACHE);
  if (!refresh && existsSync(file)) return new Uint8Array(readFileSync(file));
  const bytes = await fetchBytes(url);
  mkdirSync(new URL('.', file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes;
}

const cachedJson = async (key: string, url: string): Promise<Json> => JSON.parse(new TextDecoder().decode(await cached(key, url)));

// ── Terrain ──

interface Mosaic {
  z: number;
  tx0: number;
  ty0: number;
  W: number;
  H: number;
  data: Float32Array;
}

async function mosaicFor(b: BBox, z: number): Promise<Mosaic> {
  const tx0 = Math.floor(lngToTileX(b.west, z));
  const tx1 = Math.floor(lngToTileX(b.east, z));
  const ty0 = Math.floor(latToTileY(b.north, z));
  const ty1 = Math.floor(latToTileY(b.south, z));
  const W = (tx1 - tx0 + 1) * TILE;
  const H = (ty1 - ty0 + 1) * TILE;
  const mosaic = new Float32Array(W * H);
  let n = 0;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const png = await cached(`terrarium/${z}/${tx}/${ty}.png`, terrariumUrl(z, tx, ty));
      const { width, height, rgba } = decodePng(png, (d) => new Uint8Array(inflateSync(d)));
      if (width !== TILE || height !== TILE) throw new Error(`unexpected tile size ${width}×${height}`);
      const h = decodeTerrarium(rgba);
      const ox = (tx - tx0) * TILE;
      const oy = (ty - ty0) * TILE;
      for (let y = 0; y < TILE; y++) mosaic.set(h.subarray(y * TILE, (y + 1) * TILE), (oy + y) * W + ox);
      n++;
    }
  console.log(`  ${n} tiles at z${z} (${W}×${H} px, ${pixelMetres((b.south + b.north) / 2, z).toFixed(1)} m)`);
  return { z, tx0, ty0, W, H, data: mosaic };
}

/** Resample a mosaic onto the region grid: each cell averages s×s bilinear samples (s = cell / pixel). */
function resample(m: Mosaic, nx: number, ny: number, bbox: BBox): Float32Array {
  const { z, tx0, ty0, W, H, data: mosaic } = m;
  const cell = cellMetres({ nx, ny, bbox });
  const s = Math.max(1, Math.round((cell[0] + cell[1]) / 2 / pixelMetres((bbox.south + bbox.north) / 2, z)));
  const at = (px: number, py: number) => {
    const x = Math.min(Math.max(px, 0), W - 1.001);
    const y = Math.min(Math.max(py, 0), H - 1.001);
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = mosaic[j * W + i]!;
    const b = mosaic[j * W + i + 1]!;
    const c = mosaic[(j + 1) * W + i]!;
    const d = mosaic[(j + 1) * W + i + 1]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  const out = new Float32Array(nx * ny);
  const dLng = (bbox.east - bbox.west) / nx;
  const dLat = (bbox.north - bbox.south) / ny;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let v = 0; v < s; v++)
        for (let u = 0; u < s; u++) {
          const lng = bbox.west + (i + (u + 0.5) / s) * dLng;
          const lat = bbox.north - (j + (v + 0.5) / s) * dLat;
          sum += at((lngToTileX(lng, z) - tx0) * TILE - 0.5, (latToTileY(lat, z) - ty0) * TILE - 0.5);
        }
      out[j * nx + i] = sum / (s * s);
    }
  return out;
}

/**
 * Replace hydro-flattened water: water = cells near 0 m, or perfectly flat low surfaces (a river flattened at the
 * lidar's water level), connected to cells the coarse tiles call water. Depth = the deeper of the coarse soundings
 * and a synthetic shore profile (ramp × distance to shore, capped), because the coarse tiles are flattened too in
 * the narrow rivers (the Hudson reads ≈ 0 m at z10 off Manhattan, where it is ≈ 15 m deep).
 */
function rebuildWater(fine: Float32Array, coarse: Float32Array, nx: number, ny: number, cell: number, o: NonNullable<Region['rebuildWater']>): number {
  const n = nx * ny;
  const water = new Uint8Array(n);
  // Isolated nodata spikes in the fine tiles (hundreds of metres deep on land) take the coarse value.
  for (let i = 0; i < n; i++) if (fine[i]! < -40 && fine[i]! < coarse[i]! - 40) fine[i] = coarse[i]!;
  // Bridges and piers left in the lidar surface would cut rivers in two: where the coarse soundings say clearly
  // water, low structures (< 2 m) count as water too.
  const flatLow = new Uint8Array(n);
  for (let y = 1; y < ny - 1; y++)
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (fine[i]! >= o.flatSurface) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = -1; v <= 1; v++)
        for (let u = -1; u <= 1; u++) {
          const h = fine[i + v * nx + u]!;
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      if (hi - lo < 0.03) flatLow[i] = 1;
    }
  const cand = (i: number) => fine[i]! < o.flat || flatLow[i] === 1 || (coarse[i]! < -6 && fine[i]! < 2);
  // Smooth low surfaces (a river interpolated across by the lidar) may bridge short gaps between strict water.
  const relaxed = (i: number) => {
    if (fine[i]! >= 1.2) return false;
    const x = i % nx;
    const y = (i - x) / nx;
    if (x < 1 || y < 1 || x >= nx - 1 || y >= ny - 1) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = -1; v <= 1; v++)
      for (let u = -1; u <= 1; u++) {
        const h = fine[i + v * nx + u]!;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    return hi - lo < 0.4;
  };
  const N4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const flood = (seeds: number[]) => {
    const stack = seeds;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % nx;
      const y = (i - x) / nx;
      for (const [dx, dy] of N4) {
        const u = x + dx;
        const v = y + dy;
        if (u < 0 || v < 0 || u >= nx || v >= ny) continue;
        const k = v * nx + u;
        if (!water[k] && cand(k)) {
          water[k] = 1;
          stack.push(k);
        }
      }
    }
  };
  const seeds: number[] = [];
  for (let i = 0; i < n; i++)
    if (cand(i) && coarse[i]! < -2) {
      water[i] = 1;
      seeds.push(i);
    }
  flood(seeds);
  // Bridge gaps: breadth-first through relaxed cells up to `gap` steps from water, then flood strictly again.
  const gap = 14;
  for (let round = 0; round < 3; round++) {
    let frontier: number[] = [];
    for (let i = 0; i < n; i++) if (water[i]) frontier.push(i);
    const added: number[] = [];
    for (let step = 0; step < gap && frontier.length; step++) {
      const next: number[] = [];
      for (const i of frontier) {
        const x = i % nx;
        const y = (i - x) / nx;
        for (const [dx, dy] of N4) {
          const u = x + dx;
          const v = y + dy;
          if (u < 0 || v < 0 || u >= nx || v >= ny) continue;
          const k = v * nx + u;
          if (!water[k] && relaxed(k)) {
            water[k] = 2;
            next.push(k);
            added.push(k);
          }
        }
      }
      frontier = next;
    }
    // Keep only bridge cells that reach new strict water; the rest were dead ends on low land.
    const before = water.reduce((a, w) => a + (w === 1 ? 1 : 0), 0);
    const probe = added.filter((k) => {
      const x = k % nx;
      const y = (k - x) / nx;
      return N4.some(([dx, dy]) => {
        const u = x + dx;
        const v = y + dy;
        return u >= 0 && v >= 0 && u < nx && v < ny && !water[v * nx + u] && cand(v * nx + u);
      });
    });
    for (const k of probe) water[k] = 1;
    flood(probe);
    const after = water.reduce((a, w) => a + (w === 1 ? 1 : 0), 0);
    // Bridge cells stay water only where the strict flood continued beyond them.
    for (const k of added) if (water[k] === 2) water[k] = after - before > probe.length ? 1 : 0;
    if (after - before <= probe.length) break;
  }
  // Chamfer distance (cells) to the nearest dry cell.
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = water[i] ? 1e9 : 0;
  const D = Math.SQRT2;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (x > 0) dist[i] = Math.min(dist[i]!, dist[i - 1]! + 1);
      if (y > 0) dist[i] = Math.min(dist[i]!, dist[i - nx]! + 1);
      if (x > 0 && y > 0) dist[i] = Math.min(dist[i]!, dist[i - nx - 1]! + D);
      if (x < nx - 1 && y > 0) dist[i] = Math.min(dist[i]!, dist[i - nx + 1]! + D);
    }
  for (let y = ny - 1; y >= 0; y--)
    for (let x = nx - 1; x >= 0; x--) {
      const i = y * nx + x;
      if (x < nx - 1) dist[i] = Math.min(dist[i]!, dist[i + 1]! + 1);
      if (y < ny - 1) dist[i] = Math.min(dist[i]!, dist[i + nx]! + 1);
      if (x < nx - 1 && y < ny - 1) dist[i] = Math.min(dist[i]!, dist[i + nx + 1]! + D);
      if (x > 0 && y < ny - 1) dist[i] = Math.min(dist[i]!, dist[i + nx - 1]! + D);
    }
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    const shore = Math.min(o.ramp * (dist[i]! - 0.5) * cell + o.edgeDepth, o.maxDepth);
    const depth = Math.max(Math.min(-coarse[i]!, shore * 1.5), shore, o.minDepth);
    fine[i] = -depth;
    count++;
  }
  return count;
}

/** Lower cells that stand more than `limit` above the 5×5 opening (min then max filter): buildings, not hills. */
function despike(h: Float32Array, nx: number, ny: number, limit: number): number {
  const filt = (src: Float32Array, pick: (a: number, b: number) => number, init: number) => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        let m = init;
        for (let u = -2; u <= 2; u++) m = pick(m, src[y * nx + Math.min(nx - 1, Math.max(0, x + u))]!);
        tmp[y * nx + x] = m;
      }
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        let m = init;
        for (let v = -2; v <= 2; v++) m = pick(m, tmp[Math.min(ny - 1, Math.max(0, y + v)) * nx + x]!);
        out[y * nx + x] = m;
      }
    return out;
  };
  const opened = filt(filt(h, Math.min, Infinity), Math.max, -Infinity);
  let k = 0;
  for (let i = 0; i < h.length; i++)
    if (h[i]! > opened[i]! + limit) {
      h[i] = opened[i]! + limit;
      k++;
    }
  return k;
}

async function terrain(r: Region): Promise<void> {
  const { nx, ny, bbox } = r;
  console.log(`${r.id}: terrain`);
  const out = resample(await mosaicFor(bbox, r.zoom), nx, ny, bbox);
  const cell = cellMetres({ nx, ny, bbox });
  if (r.rebuildWater) {
    const coarse = resample(await mosaicFor(bbox, r.rebuildWater.zoom), nx, ny, bbox);
    const k = rebuildWater(out, coarse, nx, ny, (cell[0] + cell[1]) / 2, r.rebuildWater);
    console.log(`  rebuilt bathymetry under ${k} flattened water cells from z${r.rebuildWater.zoom}`);
  }
  if (r.despike) console.log(`  cut ${despike(out, nx, ny, r.despike)} spike cells`);
  let min = Infinity;
  let max = -Infinity;
  for (const h of out) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const packed = deflateSync(packHeights(out), { level: 9 });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL(`${r.id}-terrain.bin`, OUT), packed);
  const meta: HeightfieldMeta = {
    region: r.name,
    nx,
    ny,
    bbox,
    cell: [Math.round(cell[0] * 10) / 10, Math.round(cell[1] * 10) / 10],
    units: 'm',
    encoding: 'float16-delta-shuffle-deflate',
    verticalDatum: 'NAVD88 on land (USGS 3DEP/NED); bathymetry as compiled by the tile sources (NOAA CRM, ≈ mean sea level), see DECISIONS.md',
    zoom: r.zoom,
    source: 'AWS Open Data terrain tiles (Terrarium), https://registry.opendata.aws/terrain-tiles/',
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
  };
  writeFileSync(new URL(`${r.id}-terrain.json`, OUT), JSON.stringify(meta, null, 1));
  console.log(`  ${nx}×${ny} grid, ${meta.cell.join(' × ')} m cells, ${min.toFixed(1)}…${max.toFixed(1)} m, ${(packed.length / 1e6).toFixed(2)} MB`);
}

// ── Stations ──

const SMALL = new Set(['a', 'an', 'and', 'at', 'of', 'the', 'on', 'in']);
/** NOAA names come in mixed styles ("NORTH POINT, PIER 41, S.F.BAY"); tidy them for labels. */
function tidy(name: string): string {
  const base = name
    .replace(/,?\s*(S\.F\.\s?BAY|SAN FRANCISCO BAY|S\.F\. BAY)$/i, '')
    .replace(/\bC\.M\. NO\. (\d+)/i, 'Channel Marker $1')
    .trim();
  if (base !== base.toUpperCase()) return base;
  return base
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^([a-z])/, (c) => c.toUpperCase())))
    .join('')
    .replace(/\bS\.f\./gi, 'S.F.')
    .replace(/\b(Nas|Uscg|Coe|Ft|Pt|Li|Cc)\b/g, (m) => (m.length <= 3 ? m.toUpperCase() : m))
    .replace(/\bR,?$/, 'River')
    .replace(/, Hudson R\b/, ', Hudson River')
    .replace(/\s+,/g, ',');
}

const inBox = (b: BBox, lat: number, lng: number) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

async function stations(r: Region): Promise<void> {
  const list = (await cachedJson('noaa/harcon-stations.json', `${MD}.json?type=harcon`)).stations as Json[];
  const picked = list.filter((s) => inBox(r.stationBox, s.lat, s.lng)).sort((a, b) => b.lat - a.lat);
  const out: Json[] = [];
  for (const s of picked) {
    const id = String(s.id);
    try {
      const harcon = (await cachedJson(`noaa/${id}-harcon.json`, `${MD}/${id}/harcon.json?units=metric`)).HarmonicConstituents as Json[];
      const dj = await cachedJson(`noaa/${id}-datums.json`, `${MD}/${id}/datums.json?units=metric`);
      const d: Record<string, number> = Object.fromEntries(((dj.datums ?? []) as { name: string; value: number }[]).map((x) => [x.name, x.value]));
      const constituents = (harcon ?? [])
        .filter((c) => c.amplitude > 0)
        .map((c) => ({ name: c.name as string, amplitude: c.amplitude as number, phase: c.phase_GMT as number, speed: c.speed as number }));
      if (constituents.length < 4) throw new Error(`only ${constituents.length} constituents`);
      const has = (k: string) => typeof d[k] === 'number';
      out.push({
        id,
        name: s.name as string,
        label: tidy(s.name as string),
        lat: s.lat as number,
        lng: s.lng as number,
        inTerrain: inBox(r.bbox, s.lat, s.lng),
        /** Mean sea level above MLLW, m (predict()'s constant term relative to MLLW); null without datums. */
        z0: has('MSL') && has('MLLW') ? r3(d.MSL! - d.MLLW!) : null,
        /** Local mean sea level above NAVD88, m; null when NOAA publishes no NAVD88 tie for this station. */
        mslNavd88: has('MSL') && has('NAVD88') ? r3(d.MSL! - d.NAVD88!) : null,
        /** Datums relative to the station datum (STND), m, as published. */
        datums: Object.fromEntries(['MHHW', 'MHW', 'MSL', 'MLW', 'MLLW', 'NAVD88'].filter(has).map((k) => [k, d[k]])),
        epoch: (dj.epoch as string) || null,
        constituents,
      });
    } catch (err) {
      console.warn(`skip ${id} ${s.name}: ${(err as Error).message}`);
    }
  }
  const withMsl = out.filter((s) => s.z0 !== null).length;
  const withNavd = out.filter((s) => s.mslNavd88 !== null).length;
  const doc = {
    region: r.name,
    bbox: r.bbox,
    stationBox: r.stationBox,
    source: 'NOAA CO-OPS metadata API (harmonic constituents and datums, public domain)',
    fetched: new Date().toISOString().slice(0, 10),
    datum:
      'Water levels are referenced to NAVD88: h = (MSL − NAVD88) + tide about MSL. Stations without a published NAVD88 tie take the offset interpolated from their neighbours; stations without datums are referenced to MSL the same way.',
    stations: out,
  };
  writeFileSync(new URL(`${r.id}-stations.json`, OUT), JSON.stringify(doc, null, 1));
  console.log(`${r.id}: ${out.length} stations (${withMsl} with MSL/MLLW, ${withNavd} with a NAVD88 tie)`);
}

const only = opt('only');
const region = opt('region');
for (const r of REGIONS) {
  if (region && r.id !== region) continue;
  if (!only || only === 'terrain') await terrain(r);
  if (!only || only === 'stations') await stations(r);
}
