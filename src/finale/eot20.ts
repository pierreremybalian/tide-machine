// EOT20 global ocean tide tiles (Hart-Davis et al. 2021, CC BY 4.0): addressing, binary decode/encode, and
// sampling. Constants are interpolated as complex numbers H·e^{iκ} (never phase directly), so a point between
// two nodes whose phases straddle 0°/360° (or an amphidrome) gets the physically meaningful value. Pure: no DOM,
// no three; the loader takes an injectable fetch so it runs in tests and workers.
//
// Tile binary (little-endian), written by scripts/eot20_tiles.py:
//   0  'EOTT'            4  u8 version (1)     5  u8 n constituents   6  u16 step (units of 1/8°)
//   8  i16 lat0 (1/8°)   10 i16 lng0 (1/8°)    12 u16 rows            14 u16 cols
//   16 u32 stored nodes  20 u8 thin            21 u8 margin (nodes)   22 u16 reserved (0)
//   24 n × 4 bytes constituent names (ASCII, NUL-padded)
//   .. mask: rows·cols bits, row-major from the south-west node (rows northward, columns eastward), LSB first,
//      1 = stored; padded to a multiple of 4 bytes
//   .. per constituent: i16[stored] amplitude (mm), then u16[stored] Greenwich phase lag (0.01°)
// Nodes include both edges: a 10° tile at 1/8° is 81×81 nodes (80×80 cells) and shares its edges with its
// neighbours, so bilinear interpolation never needs a second tile.
// Thinning (thin = 2): ocean nodes more than `margin` nodes from land are stored only on the even lattice
// (every other row and column, i.e. 1/4°), where the tide varies over hundreds of kilometres; every ocean node
// near land is stored at the native 1/8°. A missing node is therefore land, or (off the even lattice) thinned
// open ocean; interpolateTile() falls back to the 1/4° lattice there.

import { BY_NAME, speed } from '../tides/constituents.ts';
import { distanceKm, mod360, wrapLng } from './geo.ts';

export const TILE_DEG = 10;
/** EOT20's native grid spacing, degrees. */
export const BASE_STEP = 1 / 8;
export const MAGIC = 'EOTT';
export const VERSION = 1;
const HEADER = 24;

/** One harmonic constituent: amplitude (m), Greenwich phase lag κ (degrees), speed (degrees per hour). */
export interface Harmonic {
  name: string;
  amplitude: number;
  phase: number;
  speed: number;
}

export interface Eot20Tile {
  /** Latitude and longitude of the south-west node, degrees. */
  lat0: number;
  lng0: number;
  /** Node spacing, degrees. */
  step: number;
  rows: number;
  cols: number;
  names: readonly string[];
  /** Node (r·cols + c, from the south-west) → index into the value arrays, or −1 (land, or thinned). */
  ocean: Int32Array;
  count: number;
  /** 2 when open ocean far from land is stored only on the even (1/4°) lattice; 0 when every ocean node is. */
  thin: number;
  /** Per constituent: amplitude (mm) and phase (0.01°) of each ocean node. */
  amp: Int16Array[];
  pha: Uint16Array[];
}

export interface Eot20Index {
  format: string;
  constituents: string[];
  scale: { amplitude: number; phase: number };
  grid: { tileDeg: number; baseStep: number };
  /** Names of the tiles that exist (all-land tiles are absent). */
  tiles: string[];
  overview?: { file: string; step: number; constituents: string[] };
  source: string;
  licence: string;
  credit: string;
}

export interface Eot20Sample {
  /** Where the constants apply: the requested point, or the nearest ocean node. */
  lat: number;
  lng: number;
  /** Distance from the requested point to (lat, lng), km (0 when interpolated at the point). */
  distanceKm: number;
  /** bilinear: four ocean nodes; partial: some corners on land, weights renormalised; nearest: on land. */
  method: 'bilinear' | 'partial' | 'nearest';
  /** Node spacing used, degrees. */
  step: number;
  constituents: Harmonic[];
}

/** null: no tile there (all land or outside the index). */
export type TileGetter = (name: string) => Eot20Tile | null;

// ── Addressing ──────────────────────────────────────────────────────────────────────────────────────────────

/** Name of the tile whose south-west corner is (lat0, lng0), e.g. n30w130, s10e000. */
export function tileName(lat0: number, lng0: number): string {
  const la = Math.abs(lat0);
  const lo = Math.abs(lng0);
  return `${lat0 < 0 ? 's' : 'n'}${String(la).padStart(2, '0')}${lng0 < 0 ? 'w' : 'e'}${String(lo).padStart(3, '0')}`;
}

/** South-west corner of the 10° tile containing (lat, lng). Latitude 90 belongs to the 80–90 row. */
export function tileOrigin(lat: number, lng: number): { lat0: number; lng0: number } {
  const lat0 = Math.min(90 - TILE_DEG, Math.max(-90, Math.floor(lat / TILE_DEG) * TILE_DEG));
  const lng0 = Math.floor(wrapLng(lng) / TILE_DEG) * TILE_DEG;
  return { lat0, lng0 };
}

export function tileFor(lat: number, lng: number): string {
  const o = tileOrigin(lat, lng);
  return tileName(o.lat0, o.lng0);
}

/** Names of all tiles intersecting the box within `km` of (lat, lng). */
export function tilesNear(lat: number, lng: number, km: number): string[] {
  const w = window_(lat, km);
  const names = new Set<string>();
  const lngs: number[] = [];
  if (w.dLng >= 180) for (let l = -180; l < 180; l += TILE_DEG) lngs.push(l);
  else
    for (let l = Math.floor((lng - w.dLng) / TILE_DEG) * TILE_DEG; l <= lng + w.dLng; l += TILE_DEG)
      lngs.push(tileOrigin(0, l).lng0);
  for (let la = tileOrigin(w.latMin, 0).lat0; la <= tileOrigin(w.latMax, 0).lat0; la += TILE_DEG)
    for (const lo of lngs) names.add(tileName(la, lo));
  return [...names];
}

function window_(lat: number, km: number) {
  const dLat = km / 111.19;
  const c = Math.cos((Math.min(89.9, Math.abs(lat) + dLat) * Math.PI) / 180);
  return {
    latMin: Math.max(-90, lat - dLat),
    latMax: Math.min(90, lat + dLat),
    dLng: Math.min(180, dLat / c),
  };
}

// ── Binary codec ────────────────────────────────────────────────────────────────────────────────────────────

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Decodes one tile (or the overview grid). Copies, so any alignment of the input is accepted. */
export function decodeTile(input: ArrayBuffer | Uint8Array): Eot20Tile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== MAGIC) throw new Error(`EOT20 tile: bad magic ${JSON.stringify(magic)}`);
  const version = dv.getUint8(4);
  if (version !== VERSION) throw new Error(`EOT20 tile: unsupported version ${version}`);
  const n = dv.getUint8(5);
  const step = dv.getUint16(6, true) * BASE_STEP;
  const lat0 = dv.getInt16(8, true) * BASE_STEP;
  const lng0 = dv.getInt16(10, true) * BASE_STEP;
  const rows = dv.getUint16(12, true);
  const cols = dv.getUint16(14, true);
  const count = dv.getUint32(16, true);
  const thin = dv.getUint8(20);
  const names: string[] = [];
  for (let k = 0; k < n; k++) {
    let s = '';
    for (let j = 0; j < 4; j++) {
      const b = bytes[HEADER + 4 * k + j]!;
      if (b) s += String.fromCharCode(b);
    }
    names.push(s);
  }
  const maskAt = HEADER + 4 * n;
  const nodes = rows * cols;
  const ocean = new Int32Array(nodes).fill(-1);
  let o = 0;
  for (let i = 0; i < nodes; i++) if ((bytes[maskAt + (i >> 3)]! >> (i & 7)) & 1) ocean[i] = o++;
  if (o !== count) throw new Error(`EOT20 tile: mask has ${o} ocean nodes, header says ${count}`);
  let at = maskAt + pad4(Math.ceil(nodes / 8));
  if (at + n * 4 * count !== bytes.byteLength) throw new Error('EOT20 tile: size does not match header');
  const amp: Int16Array[] = [];
  const pha: Uint16Array[] = [];
  for (let k = 0; k < n; k++) {
    amp.push(read(bytes, dv, at, count, Int16Array));
    at += 2 * count;
    pha.push(read(bytes, dv, at, count, Uint16Array));
    at += 2 * count;
  }
  return { lat0, lng0, step, rows, cols, names, ocean, count, thin, amp, pha };
}

function read<T extends Int16Array | Uint16Array>(
  bytes: Uint8Array,
  dv: DataView,
  at: number,
  count: number,
  Ctor: new (n: number) => T,
): T {
  const out = new Ctor(count);
  if (LITTLE) {
    // An explicit copy: Node's Buffer.slice() is a view, so `.slice().buffer` would be the whole file.
    new Uint8Array(out.buffer).set(bytes.subarray(at, at + 2 * count));
    return out;
  }
  const signed = out instanceof Int16Array;
  for (let i = 0; i < count; i++)
    out[i] = signed ? dv.getInt16(at + 2 * i, true) : dv.getUint16(at + 2 * i, true);
  return out;
}

const pad4 = (n: number) => (n + 3) & ~3;

export interface TileInput {
  lat0: number;
  lng0: number;
  step: number;
  rows: number;
  cols: number;
  names: readonly string[];
  /** Per constituent, per node (row-major from the south-west): amplitude (m; NaN on land), phase (degrees). */
  amplitude: ArrayLike<number>[];
  phase: ArrayLike<number>[];
  /** Thin open ocean to the even lattice beyond `margin` nodes from land (see the format notes). */
  thin?: { margin: number };
}

/** Encodes a tile in the format above (the same bytes scripts/eot20_tiles.py writes). Land = NaN amplitude. */
export function encodeTile(t: TileInput): Uint8Array {
  const n = t.names.length;
  const nodes = t.rows * t.cols;
  const first = t.amplitude[0];
  if (!first || first.length !== nodes)
    throw new Error('encodeTile: amplitude arrays must have rows·cols values');
  const wet = (i: number) => Number.isFinite(first[i]!);
  const near = t.thin ? nearLand(t.rows, t.cols, wet, t.thin.margin) : null;
  const isOcean = (i: number) =>
    wet(i) && (!near || near[i] === 1 || (Math.floor(i / t.cols) % 2 === 0 && (i % t.cols) % 2 === 0));
  let count = 0;
  for (let i = 0; i < nodes; i++) if (isOcean(i)) count++;
  const maskBytes = pad4(Math.ceil(nodes / 8));
  const size = HEADER + 4 * n + maskBytes + n * 4 * count;
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  for (let j = 0; j < 4; j++) bytes[j] = MAGIC.charCodeAt(j);
  dv.setUint8(4, VERSION);
  dv.setUint8(5, n);
  dv.setUint16(6, Math.round(t.step / BASE_STEP), true);
  dv.setInt16(8, Math.round(t.lat0 / BASE_STEP), true);
  dv.setInt16(10, Math.round(t.lng0 / BASE_STEP), true);
  dv.setUint16(12, t.rows, true);
  dv.setUint16(14, t.cols, true);
  dv.setUint32(16, count, true);
  dv.setUint8(20, t.thin ? 2 : 0);
  dv.setUint8(21, t.thin?.margin ?? 0);
  t.names.forEach((name, k) => {
    for (let j = 0; j < Math.min(4, name.length); j++) bytes[HEADER + 4 * k + j] = name.charCodeAt(j);
  });
  const maskAt = HEADER + 4 * n;
  for (let i = 0; i < nodes; i++) if (isOcean(i)) bytes[maskAt + (i >> 3)]! |= 1 << (i & 7);
  let at = maskAt + maskBytes;
  for (let k = 0; k < n; k++) {
    const A = t.amplitude[k]!;
    const P = t.phase[k]!;
    let o = 0;
    for (let i = 0; i < nodes; i++) if (isOcean(i)) dv.setInt16(at + 2 * o++, quantAmp(A[i]!), true);
    at += 2 * count;
    o = 0;
    for (let i = 0; i < nodes; i++) if (isOcean(i)) dv.setUint16(at + 2 * o++, quantPhase(P[i]!), true);
    at += 2 * count;
  }
  return bytes;
}

/** 1 where a land node lies within `margin` nodes (box), as the Python's dilation (no wrap: tests only). */
function nearLand(rows: number, cols: number, wet: (i: number) => boolean, margin: number): Uint8Array {
  const out = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (wet(r * cols + c)) continue;
      for (let rr = Math.max(0, r - margin); rr <= Math.min(rows - 1, r + margin); rr++)
        for (let cc = Math.max(0, c - margin); cc <= Math.min(cols - 1, c + margin); cc++)
          out[rr * cols + cc] = 1;
    }
  return out;
}

/** Metres → integer millimetres, clamped to int16. */
export const quantAmp = (m: number) => Math.max(0, Math.min(32767, Math.round(m * 1000)));
/** Degrees → integer hundredths of a degree in [0, 36000). */
export const quantPhase = (deg: number) => Math.round(mod360(deg) * 100) % 36000;

// ── Sampling ────────────────────────────────────────────────────────────────────────────────────────────────

const D2R = Math.PI / 180;

/** Complex constant of constituent k at an ocean index: re, im in metres (H cos κ, H sin κ). */
function addNode(t: Eot20Tile, oi: number, w: number, re: Float64Array, im: Float64Array) {
  for (let k = 0; k < t.names.length; k++) {
    const H = t.amp[k]![oi]! / 1000;
    const kap = (t.pha[k]![oi]! / 100) * D2R;
    re[k]! += w * H * Math.cos(kap);
    im[k]! += w * H * Math.sin(kap);
  }
}

function harmonics(
  names: readonly string[],
  re: Float64Array,
  im: Float64Array,
  only?: readonly string[],
): Harmonic[] {
  const out: Harmonic[] = [];
  names.forEach((name, k) => {
    if (only && !only.includes(name)) return;
    const c = BY_NAME.get(name);
    if (!c) return;
    const r = re[k]!;
    const i = im[k]!;
    out.push({ name, amplitude: Math.hypot(r, i), phase: mod360(Math.atan2(i, r) / D2R), speed: speed(c) });
  });
  return out;
}

/** Latitude and longitude of node (r, c) of a tile. */
export function nodeLatLng(t: Eot20Tile, r: number, c: number): { lat: number; lng: number } {
  return { lat: t.lat0 + r * t.step, lng: wrapLng(t.lng0 + c * t.step) };
}

/** Constants at node (r, c), or null on land. */
export function nodeConstants(
  t: Eot20Tile,
  r: number,
  c: number,
  only?: readonly string[],
): Harmonic[] | null {
  const oi = t.ocean[r * t.cols + c];
  if (oi === undefined || oi < 0) return null;
  const re = new Float64Array(t.names.length);
  const im = new Float64Array(t.names.length);
  addNode(t, oi, 1, re, im);
  return harmonics(t.names, re, im, only);
}

/** Bilinear weights of the cell with spacing `k` nodes (1 or 2) containing fractional node (fy, fx). */
function cell(t: Eot20Tile, fy: number, fx: number, k: number): [number, number, number][] {
  const r0 = Math.min(Math.floor(fy / k) * k, t.rows - 1 - k);
  const c0 = Math.min(Math.floor(fx / k) * k, t.cols - 1 - k);
  const v = Math.min(1, (fy - r0) / k);
  const u = Math.min(1, (fx - c0) / k);
  return [
    [r0, c0, (1 - v) * (1 - u)],
    [r0, c0 + k, (1 - v) * u],
    [r0 + k, c0, v * (1 - u)],
    [r0 + k, c0 + k, v * u],
  ];
}

/** Corners a point actually touches (positive weight) that are missing from the tile. */
const missing = (t: Eot20Tile, cs: [number, number, number][]) =>
  cs.filter(([r, c, w]) => w > 0 && t.ocean[r * t.cols + c]! < 0);

/**
 * Bilinear interpolation of H·e^{iκ} inside one tile, at 1/8° where all four corners are stored. Where a
 * corner is missing off the even lattice and the surrounding 1/4° cell is complete, the node was thinned (open
 * ocean): interpolate on the 1/4° lattice. Otherwise the missing corners are land: drop them and renormalise
 * ('partial'). null when the point touches no stored node.
 */
export function interpolateTile(
  t: Eot20Tile,
  lat: number,
  lng: number,
  only?: readonly string[],
): Eot20Sample | null {
  const fy = Math.max(0, (lat - t.lat0) / t.step);
  const fx = Math.max(0, wrapLng(lng - t.lng0) / t.step);
  let corners = cell(t, fy, fx, 1);
  let step = t.step;
  let gone = missing(t, corners);
  if (gone.length && t.thin === 2 && gone.some(([r, c]) => r % 2 || c % 2)) {
    const coarse = cell(t, fy, fx, 2);
    if (!missing(t, coarse).length) {
      corners = coarse;
      step = 2 * t.step;
      gone = [];
    }
  }
  const re = new Float64Array(t.names.length);
  const im = new Float64Array(t.names.length);
  let wsum = 0;
  for (const [r, c, w] of corners) {
    const oi = t.ocean[r * t.cols + c]!;
    if (w <= 0 || oi < 0) continue; // untouched corner, or land
    addNode(t, oi, w, re, im);
    wsum += w;
  }
  if (wsum <= 1e-9) return null;
  for (let k = 0; k < re.length; k++) {
    re[k]! /= wsum;
    im[k]! /= wsum;
  }
  return {
    lat,
    lng: wrapLng(lng),
    distanceKm: 0,
    method: gone.length ? 'partial' : 'bilinear',
    step,
    constituents: harmonics(t.names, re, im, only),
  };
}

/** The nearest ocean node within `km` across the given tiles, or null. */
export function nearestNode(
  get: TileGetter,
  lat: number,
  lng: number,
  km: number,
): { tile: Eot20Tile; r: number; c: number; lat: number; lng: number; distanceKm: number } | null {
  const w = window_(lat, km);
  let best: { tile: Eot20Tile; r: number; c: number; lat: number; lng: number; distanceKm: number } | null =
    null;
  for (const name of tilesNear(lat, lng, km)) {
    const t = get(name);
    if (!t) continue;
    const lq = t.lng0 + wrapLng(lng - t.lng0);
    const rMin = Math.max(0, Math.ceil((w.latMin - t.lat0) / t.step));
    const rMax = Math.min(t.rows - 1, Math.floor((w.latMax - t.lat0) / t.step));
    const cMin = w.dLng >= 180 ? 0 : Math.max(0, Math.ceil((lq - w.dLng - t.lng0) / t.step));
    const cMax =
      w.dLng >= 180 ? t.cols - 1 : Math.min(t.cols - 1, Math.floor((lq + w.dLng - t.lng0) / t.step));
    for (let r = rMin; r <= rMax; r++)
      for (let c = cMin; c <= cMax; c++) {
        if (t.ocean[r * t.cols + c]! < 0) continue;
        const p = nodeLatLng(t, r, c);
        const d = distanceKm(lat, lng, p.lat, p.lng);
        if (d <= km && (!best || d < best.distanceKm))
          best = { tile: t, r, c, lat: p.lat, lng: p.lng, distanceKm: d };
      }
  }
  return best;
}

export interface SampleOptions {
  /** Search radius for the nearest ocean node when the point's cell is all land, km. Default 30. */
  searchKm?: number;
  /** Only these constituents. */
  only?: readonly string[];
}

export const DEFAULT_SEARCH_KM = 30;

/**
 * EOT20 constants at (lat, lng): bilinear in the containing tile, else the nearest ocean node within
 * `searchKm`; null if there is no ocean that close. `get` must return every tile in tilesNear(lat, lng, searchKm).
 */
export function sampleAt(
  get: TileGetter,
  lat: number,
  lng: number,
  opts: SampleOptions = {},
): Eot20Sample | null {
  const tile = get(tileFor(lat, lng));
  const s = tile && interpolateTile(tile, lat, lng, opts.only);
  if (s) return s;
  const n = nearestNode(get, lat, lng, opts.searchKm ?? DEFAULT_SEARCH_KM);
  if (!n) return null;
  return {
    lat: n.lat,
    lng: n.lng,
    distanceKm: n.distanceKm,
    method: 'nearest',
    step: n.tile.step,
    constituents: nodeConstants(n.tile, n.r, n.c, opts.only) ?? [],
  };
}

// ── Loader ──────────────────────────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface LoaderOptions {
  /** Directory URL of the tiles, with a trailing slash. Default '/data/eot20/'. */
  baseUrl?: string;
  fetch?: FetchLike;
}

/** Fetches the index once, then tiles on demand (each at most once). */
export class Eot20 {
  private readonly tiles = new Map<string, Promise<Eot20Tile | null>>();
  private readonly ready = new Map<string, Eot20Tile | null>();
  private overviewTile?: Promise<Eot20Tile>;
  private names?: Set<string>;
  readonly index: Eot20Index;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  // Plain fields, not parameter properties, so scripts can import this file with Node's type stripping.
  private constructor(index: Eot20Index, baseUrl: string, fetchFn: FetchLike) {
    this.index = index;
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
  }

  static async load(opts: LoaderOptions = {}): Promise<Eot20> {
    const baseUrl = opts.baseUrl ?? '/data/eot20/';
    const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    const r = await fetchFn(`${baseUrl}index.json`);
    if (!r.ok) throw new Error(`EOT20 index: HTTP ${r.status}`);
    return new Eot20((await r.json()) as Eot20Index, baseUrl, fetchFn);
  }

  /** True if the index lists a tile (not all land). */
  has(name: string): boolean {
    this.names ??= new Set(this.index.tiles);
    return this.names.has(name);
  }

  tile(name: string): Promise<Eot20Tile | null> {
    let p = this.tiles.get(name);
    if (!p) {
      p = this.has(name)
        ? this.bytes(`${name}.bin`).then((b) => {
            const t = decodeTile(b);
            this.ready.set(name, t);
            return t;
          })
        : Promise.resolve(null);
      p.catch(() => this.tiles.delete(name)); // retry after a network failure
      this.tiles.set(name, p);
    }
    return p;
  }

  /** The global 1/2° overview (M2, S2, K1, O1) for globe tints and co-tidal maps. */
  overview(): Promise<Eot20Tile> {
    const file = this.index.overview?.file;
    if (!file) return Promise.reject(new Error('EOT20 index has no overview'));
    this.overviewTile ??= this.bytes(file).then(decodeTile);
    return this.overviewTile;
  }

  /** Constants at a point (see sampleAt); loads only the tiles it needs. */
  async at(lat: number, lng: number, opts: SampleOptions = {}): Promise<Eot20Sample | null> {
    const get: TileGetter = (n) => this.ready.get(n) ?? null;
    const home = await this.tile(tileFor(lat, lng));
    const s = home && interpolateTile(home, lat, lng, opts.only);
    if (s) return s;
    await Promise.all(tilesNear(lat, lng, opts.searchKm ?? DEFAULT_SEARCH_KM).map((n) => this.tile(n)));
    return sampleAt(get, lat, lng, opts);
  }

  private async bytes(file: string): Promise<ArrayBuffer> {
    const r = await this.fetchFn(`${this.baseUrl}${file}`);
    if (!r.ok) throw new Error(`EOT20 ${file}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
}
