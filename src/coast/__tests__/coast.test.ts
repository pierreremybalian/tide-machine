import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng } from '../png.ts';
import { decodeTerrarium, latToTileY, lngToTileX, terrariumHeight, terrariumRgb, tileXToLng, tileYToLat } from '../terrarium.ts';
import {
  decodeHalfArray,
  floatToHalf,
  halfToFloat,
  packHeights,
  projection,
  sampleGrid,
  sampleLatLng,
  unpackHalfBits,
  type HeightfieldMeta,
} from '../heightfield.ts';
import { fastMarch, groupSpeed, phaseSpeed, shoaling, speedField, waveNumber } from '../eikonal.ts';
import { KIND_DIKED, KIND_POND, KIND_TIDAL, spillHeights, tidalDomain } from '../wetdry.ts';
import { createTideField, detourGrid, fillLevels, type BayStation } from '../tidefield.ts';
import { bandField, fetchMap } from '../waves.ts';
import { prepare, predict } from '../../tides/predict.ts';

const DATA = new URL('../../../public/data/bay/', import.meta.url);
const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, DATA), 'utf8')) as T;
const inflate = (d: Uint8Array) => new Uint8Array(inflateSync(d));

// ── A tiny PNG encoder for the decoder tests ──
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array) => {
  let c = ~0;
  for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
};
function chunk(type: string, data: Uint8Array): Uint8Array {
  const o = new Uint8Array(12 + data.length);
  const dv = new DataView(o.buffer);
  dv.setUint32(0, data.length);
  o.set(new TextEncoder().encode(type), 4);
  o.set(data, 8);
  dv.setUint32(8 + data.length, crc(o.subarray(4, 8 + data.length)));
  return o;
}
/** RGB 8-bit PNG; each row uses filter (row % 5) so every filter type is exercised. */
function encodeRgb(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const bpp = 3;
  const stride = w * bpp;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const ft = y % 5;
    raw[y * (stride + 1)] = ft;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x]!;
      const a = x >= bpp ? rgb[y * stride + x - bpp]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rgb[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][ft]!;
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('terrarium tiles', () => {
  it('decodes known pixel values', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(127, 255, 128)).toBe(-0.5);
    expect(terrariumHeight(132, 155, 64)).toBe(1179.25); // ≈ Mount Diablo's summit
    expect(terrariumHeight(127, 143, 32)).toBe(-112.875); // ≈ the Golden Gate's deepest scour
  });
  it('round-trips heights through RGB to 1/256 m', () => {
    for (const h of [-10_000, -112.875, -0.004, 0, 0.5, 2.3, 784.1, 8848]) {
      const [r, g, b] = terrariumRgb(h);
      expect(Math.abs(terrariumHeight(r, g, b) - h)).toBeLessThanOrEqual(1 / 512 + 1e-9);
    }
  });
  it('decodes a PNG (all five scanline filters) to the same heights', () => {
    const w = 7;
    const h = 10;
    const heights = Array.from({ length: w * h }, (_, i) => Math.round((Math.sin(i * 0.7) * 300 - 40 + i) * 256) / 256);
    const rgb = new Uint8Array(w * h * 3);
    heights.forEach((v, i) => rgb.set(terrariumRgb(v), i * 3));
    const png = decodePng(encodeRgb(w, h, rgb), inflate);
    expect(png.width).toBe(w);
    expect(png.height).toBe(h);
    const dec = decodeTerrarium(png.rgba);
    heights.forEach((v, i) => expect(dec[i]).toBeCloseTo(v, 6));
  });
  it('tile maths is self-consistent', () => {
    expect(tileXToLng(lngToTileX(-122.4, 11), 11)).toBeCloseTo(-122.4, 9);
    expect(tileYToLat(latToTileY(37.8, 11), 11)).toBeCloseTo(37.8, 9);
  });
});

describe('heightfield', () => {
  it('half floats round-trip within half precision', () => {
    for (const v of [0, 1, -1, 0.001, 2.3456, -112.875, 1164.2, 65504]) {
      const r = halfToFloat(floatToHalf(v));
      expect(Math.abs(r - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -24));
    }
  });
  it('packs and unpacks heights losslessly (beyond half rounding)', () => {
    const src = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 17) * 50 + (i % 13) * 0.01 - 3);
    const bits = unpackHalfBits(inflate(deflateSync(packHeights(src))));
    const back = decodeHalfArray(bits);
    src.forEach((v, i) => expect(back[i]).toBe(halfToFloat(floatToHalf(v))));
  });
  it('samples bilinearly between cell centres', () => {
    const d = Float32Array.from([0, 10, 20, 30]);
    expect(sampleGrid(d, 2, 2, 0.5, 0.5)).toBe(15);
    expect(sampleGrid(d, 2, 2, 1, 0)).toBe(10);
    expect(sampleGrid(d, 2, 2, -5, -5)).toBe(0);
  });
  it('projection round-trips and is ≈ 1 km per km', () => {
    const p = projection({ south: 37.4, north: 38.25, west: -122.75, east: -121.85 });
    expect(p.lng(p.x(-122.3))).toBeCloseTo(-122.3, 10);
    expect(p.lat(p.z(37.7))).toBeCloseTo(37.7, 10);
    // 1′ of latitude ≈ 1.843 km, and north is −z.
    expect(p.z(37.8) - p.z(37.8 + 1 / 60)).toBeCloseTo(1.843, 2);
  });
  it('baked SF terrain has the bay, the Gate and the hills where they belong', () => {
    const meta = load<HeightfieldMeta>('sf-terrain.json');
    const bits = unpackHalfBits(inflate(readFileSync(new URL('sf-terrain.bin', DATA))));
    expect(bits.length).toBe(meta.nx * meta.ny);
    const hf = { nx: meta.nx, ny: meta.ny, bbox: meta.bbox, data: decodeHalfArray(bits) };
    expect(sampleLatLng(hf, 37.8199, -122.4783)).toBeLessThan(-40); // Golden Gate channel
    expect(sampleLatLng(hf, 37.9235, -122.5965)).toBeGreaterThan(600); // Mount Tamalpais
    expect(sampleLatLng(hf, 37.8816, -121.9142)).toBeGreaterThan(1000); // Mount Diablo
    expect(sampleLatLng(hf, 37.6, -122.3)).toBeLessThan(0); // South Bay
  });
});

describe('dispersion', () => {
  const w = (2 * Math.PI) / 8;
  it('deep water: k = ω²/g, c = gT/2π', () => {
    expect(waveNumber(w, 4000)).toBeCloseTo((w * w) / 9.81, 9);
    expect(phaseSpeed(w, 4000)).toBeCloseTo((9.81 * 8) / (2 * Math.PI), 6);
    expect(groupSpeed(w, 4000) / phaseSpeed(w, 4000)).toBeCloseTo(0.5, 6);
  });
  it('shallow water: c → √(gh), c_g → c', () => {
    expect(phaseSpeed(w, 0.5)).toBeCloseTo(Math.sqrt(9.81 * 0.5), 1);
    expect(groupSpeed(w, 0.5) / phaseSpeed(w, 0.5)).toBeGreaterThan(0.97);
  });
  it('satisfies ω² = g k tanh(kh) at every depth', () => {
    for (const h of [0.3, 1, 3, 10, 30, 100]) {
      const k = waveNumber(w, h);
      expect(9.81 * k * Math.tanh(k * h)).toBeCloseTo(w * w, 10);
    }
  });
  it('shoaling dips below 1 at intermediate depth, then grows in the shallows (Green’s law ∝ h^−¼)', () => {
    expect(shoaling(w, 4000)).toBeCloseTo(1, 6);
    expect(shoaling(w, 15)).toBeLessThan(1);
    const r = shoaling(w, 0.5) / shoaling(w, 2);
    expect(r).toBeGreaterThan(1.3);
    expect(r).toBeCloseTo(Math.pow(0.5 / 2, -0.25), 1);
  });
});

describe('eikonal (fast marching)', () => {
  const nx = 81;
  const ny = 81;
  const g = { nx, ny, dx: 10, dy: 10 };
  const src = 40 * nx + 40;
  const point = () => {
    const init = new Float64Array(nx * ny).fill(Infinity);
    init[src] = 0;
    return init;
  };
  it('uniform speed: travel time ≈ distance / speed and monotonic away from the source', () => {
    const T = fastMarch(g, new Float32Array(nx * ny).fill(2), point());
    for (const [i, j] of [
      [80, 40],
      [40, 0],
      [70, 70],
      [10, 25],
    ] as const) {
      const r = Math.hypot((i - 40) * 10, (j - 40) * 10);
      expect(Math.abs(T[j * nx + i]! - r / 2) / (r / 2)).toBeLessThan(0.1);
    }
    for (let i = 41; i < nx; i++) expect(T[40 * nx + i]!).toBeGreaterThan(T[40 * nx + i - 1]!);
    for (let j = 41; j < ny; j++) expect(T[j * nx + 40]!).toBeGreaterThan(T[(j - 1) * nx + 40]!);
    for (let k = 41; k < nx; k++) expect(T[k * nx + k]!).toBeGreaterThan(T[(k - 1) * nx + k - 1]!);
  });
  it('waves are slower over shallow water (dispersion over depth)', () => {
    // Depth 20 m in the west half, 1 m in the east half; 8 s waves.
    const depth = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) depth[j * nx + i] = i < 40 ? 20 : 1;
    const T = fastMarch(g, speedField(depth, 8), point());
    const west = T[40 * nx + 10]!;
    const east = T[40 * nx + 70]!;
    expect(east).toBeGreaterThan(west * 1.8);
    // Still monotonic along each ray.
    for (let i = 41; i < nx; i++) expect(T[40 * nx + i]!).toBeGreaterThan(T[40 * nx + i - 1]!);
    for (let i = 39; i >= 0; i--) expect(T[40 * nx + i]!).toBeGreaterThan(T[40 * nx + i + 1]!);
  });
  it('does not cross land (speed 0)', () => {
    const speed = new Float32Array(nx * ny).fill(1);
    for (let j = 0; j < ny - 10; j++) speed[j * nx + 60] = 0; // a wall with a gap at the bottom
    const T = fastMarch(g, speed, point());
    expect(T[20 * nx + 60]).toBe(Infinity);
    // Behind the wall the path goes round through the gap: longer than the straight line.
    const behind = T[20 * nx + 70]!;
    expect(behind).toBeGreaterThan(Math.hypot(300, 200) * 1.3);
  });
});

describe('wet and dry', () => {
  it('a diked basin stays dry until the tide overtops its levee', () => {
    // 1-D-ish strip: sea (−5) | flat (0.5) | levee (3) | basin (0)
    const nx = 40;
    const ny = 5;
    const h = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) h[j * nx + i] = i < 10 ? -5 : i < 20 ? 0.5 : i < 22 ? 3 : 0;
    const E = spillHeights(h, nx, ny);
    expect(E[2 * nx + 5]).toBe(-5);
    expect(E[2 * nx + 15]).toBeCloseTo(0.5);
    expect(E[2 * nx + 30]).toBe(3);
  });
  it('classifies flat ponds and diked depressions as non-tidal', () => {
    const nx = 60;
    const ny = 30;
    const h = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let v = i < 10 ? -6 : 0.2 + (i - 10) * 0.02; // sea, then a gently rising tidal flat
        if (i >= 30 && i < 32) v = 1.5; // a levee smeared low (below spring high water)
        if (i >= 32 && i < 46) v = j < 15 ? 0.6 + 0.05 * Math.sin(i + j) : 1.2; // diked land (north), pond (south)
        if (i >= 46) v = 8; // upland
        h[j * nx + i] = v;
      }
    const { spill, kind } = tidalDomain(h, nx, ny, { leveeBand: [0.5, 6] });
    expect(kind[5 * nx + 20]).toBe(KIND_TIDAL);
    expect(spill[5 * nx + 20]).toBeLessThan(1);
    expect(kind[25 * nx + 40]).toBe(KIND_POND);
    expect(kind[5 * nx + 40]).toBe(KIND_DIKED);
    expect(spill[5 * nx + 40]).toBe(Infinity);
    expect(spill[25 * nx + 40]).toBe(Infinity);
  });
});

describe('tide field', () => {
  const doc = load<{ bbox: { south: number; north: number; west: number; east: number }; stations: BayStation[] }>('sf-stations.json');
  const times = [Date.UTC(2026, 0, 3, 7), Date.UTC(2026, 6, 14, 19, 30), Date.UTC(2026, 11, 24, 2, 12)];

  it('SF Bay has its 35 harmonic stations, most with datums', () => {
    expect(doc.stations.length).toBe(35);
    expect(doc.stations.filter((s) => s.mslNavd88 !== null).length).toBeGreaterThanOrEqual(15);
    for (const s of doc.stations) expect(s.constituents.length).toBeGreaterThanOrEqual(4);
  });

  for (const withDetour of [false, true]) {
    it(`reproduces every station’s own prediction at its location to < 1 mm${withDetour ? ' (water-path aware)' : ''}`, () => {
      const bbox = doc.bbox;
      let detour = null;
      if (withDetour) {
        // A coarse all-water mask with one wall is enough to exercise the detour path.
        const nx = 30;
        const ny = 36;
        const water = new Uint8Array(nx * ny).fill(1);
        for (let j = 0; j < 20; j++) water[j * nx + 12] = 0;
        detour = detourGrid(doc.stations, water, nx, ny, bbox);
      }
      const f = createTideField(doc.stations, { bbox, detour });
      for (const t of times) {
        const lv = f.levels(t);
        f.stations.forEach((s, j) => {
          const own = s.offset + predict(prepare({ id: s.id, z0: 0, constituents: doc.stations[j]!.constituents }), t);
          expect(Math.abs(f.atLatLng(s.lat, s.lng, lv) - own)).toBeLessThan(1e-3);
          // Grid weights agree at the station too.
          const out = new Float32Array(1);
          fillLevels(f.weights(Float32Array.from([s.x, s.z])), lv, out);
          expect(Math.abs(out[0]! - own)).toBeLessThan(1e-3);
        });
      }
    });
  }

  it('NAVD88 levels convert back to NOAA’s MLLW predictions where datums are published', () => {
    const f = createTideField(doc.stations, { bbox: doc.bbox });
    const t = times[1]!;
    const lv = f.levels(t);
    f.stations.forEach((s, j) => {
      const st = doc.stations[j]!;
      if (st.z0 === null || st.mslNavd88 === null) return;
      const mllw = predict(prepare({ id: st.id, z0: st.z0, constituents: st.constituents }), t);
      expect(Math.abs(lv[j]! - s.offset + st.z0 - mllw)).toBeLessThan(1e-6);
    });
  });

  it('is smooth between stations and bounded by them', () => {
    const f = createTideField(doc.stations, { bbox: doc.bbox });
    const lv = f.levels(times[0]!);
    const lo = Math.min(...lv);
    const hi = Math.max(...lv);
    let prev = f.atLatLng(37.6, -122.35, lv);
    for (let k = 1; k <= 50; k++) {
      const v = f.atLatLng(37.6 + k * 0.002, -122.35, lv);
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
  });
});

describe('wave bands', () => {
  // An open sea in the west, a headland, and a beach shoaling to the east.
  const nx = 80;
  const ny = 60;
  const depth = new Float32Array(nx * ny);
  const water = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      depth[c] = 30 - i * 0.45;
      if (i > 30 && i < 40 && j < 25) depth[c] = -5; // headland
      water[c] = depth[c]! > 0 ? 1 : 0;
    }
  const g = { nx, ny, dx: 50, dy: 50, depth, water };
  it('swell crests slow toward the beach and the lee of the headland is sheltered', () => {
    const f = bandField(g, { period: 10, toward: 90, source: 'ocean', scale: 1000 });
    // Equal 10-cell steps take longer in shallower water.
    const row = 45 * nx;
    expect(f.T[row + 60]! - f.T[row + 50]!).toBeGreaterThan(f.T[row + 20]! - f.T[row + 10]!);
    expect(f.amp[row + 20]!).toBeCloseTo(1, 3);
    expect(f.amp[5 * nx + 45]!).toBeLessThan(0.5);
  });
  it('wind sea grows with fetch', () => {
    const F = fetchMap(g, 90, 0);
    expect(F[45 * nx + 60]!).toBeGreaterThan(F[45 * nx + 20]!);
    expect(F[5 * nx + 41]!).toBeLessThan(200); // just downwind of the headland
  });
});

describe('sun', () => {
  it('is high at local noon in June and below the horizon at midnight (San Francisco)', async () => {
    const { sunPosition } = await import('../sun.ts');
    // Solar noon in SF ≈ 20:10 UTC in June.
    const noon = sunPosition(Date.UTC(2026, 5, 21, 20, 10), 37.8, -122.4);
    expect(noon.elevation).toBeGreaterThan(74);
    expect(noon.elevation).toBeLessThan(76.5);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(6);
    expect(sunPosition(Date.UTC(2026, 5, 22, 8, 10), 37.8, -122.4).elevation).toBeLessThan(-20);
    // Sunset in the west-northwest in June.
    const eve = sunPosition(Date.UTC(2026, 5, 22, 3, 30), 37.8, -122.4);
    expect(eve.azimuth).toBeGreaterThan(290);
    expect(eve.azimuth).toBeLessThan(305);
  });
});
