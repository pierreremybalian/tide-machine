// Heightfields on a regular latitude/longitude grid, and the local projection to world units (pure; worker-safe).
// Grid convention: cell-centred, row 0 is the northern edge, data[j·nx + i] at
//   lng = west + (i + ½)·(east − west)/nx,  lat = north − (j + ½)·(north − south)/ny.
// World units (HANDOFF §5): x east, y up, z south, 1 unit = 1 km, local equirectangular about the bbox centre
// (scale error < 0.6 % across the SF box, far below what the eye can see).

export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface Heightfield {
  nx: number;
  ny: number;
  bbox: BBox;
  /** Metres above the vertical datum (NAVD88 on land), row-major from the north. */
  data: Float32Array;
}

/** Metadata stored next to a baked heightfield binary (public/data/bay/*-terrain.json). */
export interface HeightfieldMeta {
  region: string;
  nx: number;
  ny: number;
  bbox: BBox;
  /** Approximate cell size (m) east–west and north–south. */
  cell: [number, number];
  units: 'm';
  /** IEEE half floats, row-major from the north; zigzag deltas along rows, bytes split into planes, zlib. */
  encoding: 'float16-delta-shuffle-deflate';
  verticalDatum: string;
  zoom: number;
  source: string;
  min: number;
  max: number;
}

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_EQ = 111.32;

export interface Projection {
  lat0: number;
  lng0: number;
  /** km per degree of longitude / latitude at lat0. */
  kx: number;
  ky: number;
  /** World x (km east of the centre). */
  x(lng: number): number;
  /** World z (km south of the centre). */
  z(lat: number): number;
  lng(x: number): number;
  lat(z: number): number;
}

export function projection(b: BBox): Projection {
  const lat0 = (b.south + b.north) / 2;
  const lng0 = (b.west + b.east) / 2;
  const kx = KM_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = KM_PER_DEG_LAT;
  return {
    lat0,
    lng0,
    kx,
    ky,
    x: (lng) => (lng - lng0) * kx,
    z: (lat) => -(lat - lat0) * ky,
    lng: (x) => lng0 + x / kx,
    lat: (z) => lat0 - z / ky,
  };
}

/** World-space rectangle covered by the grid (outer cell edges), km. */
export function worldExtent(b: BBox): { x0: number; x1: number; z0: number; z1: number; width: number; depth: number } {
  const p = projection(b);
  const x0 = p.x(b.west);
  const x1 = p.x(b.east);
  const z0 = p.z(b.north);
  const z1 = p.z(b.south);
  return { x0, x1, z0, z1, width: x1 - x0, depth: z1 - z0 };
}

/** Cell size in metres (east–west, north–south). */
export function cellMetres(hf: Pick<Heightfield, 'nx' | 'ny' | 'bbox'>): [number, number] {
  const p = projection(hf.bbox);
  return [(((hf.bbox.east - hf.bbox.west) * p.kx) / hf.nx) * 1000, (((hf.bbox.north - hf.bbox.south) * p.ky) / hf.ny) * 1000];
}

/** Fractional grid coordinates (cell centres are integers) for a latitude/longitude. */
export function toGrid(hf: Pick<Heightfield, 'nx' | 'ny' | 'bbox'>, lat: number, lng: number): [number, number] {
  const b = hf.bbox;
  return [((lng - b.west) / (b.east - b.west)) * hf.nx - 0.5, ((b.north - lat) / (b.north - b.south)) * hf.ny - 0.5];
}

/** Bilinear sample at fractional grid coordinates, clamped to the edges. */
export function sampleGrid(data: ArrayLike<number>, nx: number, ny: number, gx: number, gy: number): number {
  const x = Math.min(Math.max(gx, 0), nx - 1);
  const y = Math.min(Math.max(gy, 0), ny - 1);
  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  const i1 = Math.min(i0 + 1, nx - 1);
  const j1 = Math.min(j0 + 1, ny - 1);
  const fx = x - i0;
  const fy = y - j0;
  const a = data[j0 * nx + i0]!;
  const b = data[j0 * nx + i1]!;
  const c = data[j1 * nx + i0]!;
  const d = data[j1 * nx + i1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Height (m) at a latitude/longitude, bilinear. */
export function sampleLatLng(hf: Heightfield, lat: number, lng: number): number {
  const [gx, gy] = toGrid(hf, lat, lng);
  return sampleGrid(hf.data, hf.nx, hf.ny, gx, gy);
}

/** Height (m) at a world point (km). */
export function sampleWorld(hf: Heightfield, x: number, z: number, p = projection(hf.bbox)): number {
  return sampleLatLng(hf, p.lat(z), p.lng(x));
}

/** Box-filter downsample by an integer factor (for coarse solver grids). */
export function downsample(hf: Heightfield, factor: number): Heightfield {
  const nx = Math.floor(hf.nx / factor);
  const ny = Math.floor(hf.ny / factor);
  const data = new Float32Array(nx * ny);
  const inv = 1 / (factor * factor);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let v = 0; v < factor; v++) for (let u = 0; u < factor; u++) s += hf.data[(j * factor + v) * hf.nx + i * factor + u]!;
      data[j * nx + i] = s * inv;
    }
  // The coarse grid keeps the outer edges, so its cells are slightly larger when nx is not a multiple.
  const b = hf.bbox;
  const bbox = { ...b, east: b.west + ((b.east - b.west) * nx * factor) / hf.nx, south: b.north - ((b.north - b.south) * ny * factor) / hf.ny };
  return { nx, ny, bbox, data };
}

// ── IEEE 754 half floats (no Float16Array dependency) ──

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function floatToHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) h++;
    return sign | h;
  }
  // Round half up; a carry into the exponent correctly overflows to infinity.
  return (sign | (e << 10) | (mant >>> 13)) + ((mant >>> 12) & 1);
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function decodeHalfArray(src: Uint16Array, out = new Float32Array(src.length)): Float32Array {
  for (let i = 0; i < src.length; i++) out[i] = halfToFloat(src[i]!);
  return out;
}

export function encodeHalfArray(src: ArrayLike<number>, out = new Uint16Array(src.length)): Uint16Array {
  for (let i = 0; i < src.length; i++) out[i] = floatToHalf(src[i]!);
  return out;
}

// ── Storage: half floats, delta along rows (mod 2¹⁶, zigzag), high bytes then low bytes ──
// Smooth terrain makes neighbouring half-float bit patterns close, so this deflates ≈ 35 % smaller than raw halves.

export function packHeights(h: ArrayLike<number>): Uint8Array {
  const n = h.length;
  const out = new Uint8Array(n * 2);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = floatToHalf(h[i]!);
    const d = ((v - prev) << 16) >> 16;
    const zz = ((d << 1) ^ (d >> 31)) & 0xffff;
    out[i] = zz >> 8;
    out[n + i] = zz & 255;
    prev = v;
  }
  return out;
}

/** Inverse of packHeights (input already inflated): the half-float bits, ready for a HalfFloat texture. */
export function unpackHalfBits(bytes: Uint8Array): Uint16Array {
  const n = bytes.length >> 1;
  const out = new Uint16Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const zz = (bytes[i]! << 8) | bytes[n + i]!;
    const d = (zz >>> 1) ^ -(zz & 1);
    prev = (prev + d) & 0xffff;
    out[i] = prev;
  }
  return out;
}

// ── Derived fields ──

/** Separable box blur (radius r cells), edges clamped. */
export function boxBlur(src: Float32Array, nx: number, ny: number, r: number, out = new Float32Array(src.length)): Float32Array {
  const tmp = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(Math.max(k, 0), nx - 1)]!;
    for (let i = 0; i < nx; i++) {
      tmp[row + i] = s / w;
      s += src[row + Math.min(i + r + 1, nx - 1)]! - src[row + Math.max(i - r, 0)]!;
    }
  }
  for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(Math.max(k, 0), ny - 1) * nx + i]!;
    for (let j = 0; j < ny; j++) {
      out[j * nx + i] = s / w;
      s += tmp[Math.min(j + r + 1, ny - 1) * nx + i]! - tmp[Math.max(j - r, 0) * nx + i]!;
    }
  }
  return out;
}

/**
 * Ambient occlusion proxy (0 = fully occluded, 1 = open) from multi-scale "local relief": a point below the mean of
 * its neighbourhood is in a valley. Heights are compared as slopes (relief / radius) so every scale weighs equally.
 * `exaggeration` matches the rendered vertical scale.
 */
export function ambientOcclusion(hf: Heightfield, exaggeration = 1, radii = [2, 6, 18]): Float32Array {
  const [cx, cy] = cellMetres(hf);
  const cell = (cx + cy) / 2;
  const ao = new Float32Array(hf.data.length).fill(0);
  const land = new Float32Array(hf.data.length);
  // Underwater relief does not occlude the sky; clamp to sea level so channels do not darken the shore.
  for (let i = 0; i < land.length; i++) land[i] = Math.max(hf.data[i]!, -2);
  for (const r of radii) {
    const blur = boxBlur(land, hf.nx, hf.ny, r);
    const scale = exaggeration / (r * cell);
    for (let i = 0; i < ao.length; i++) ao[i] += Math.max(0, blur[i]! - land[i]!) * scale;
  }
  for (let i = 0; i < ao.length; i++) ao[i] = 1 / (1 + 2.2 * ao[i]!);
  return ao;
}
