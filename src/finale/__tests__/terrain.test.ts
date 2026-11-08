import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { coastFacts, decodeTerrariumPng, despike, exaggerationFor, fillFlatWater, loadTerrain, terrainBox, tilePlan } from '../terrain.ts';
import { terrariumRgb } from '../../coast/terrarium.ts';
import type { Heightfield } from '../../coast/heightfield.ts';
import { nextExtremes, rateAt, tideSeries } from '../extremes.ts';
import { prepare, predict } from '../../tides/predict.ts';

const inflate = async (z: Uint8Array) => new Uint8Array(inflateSync(z));

/** A 256×256 RGB Terrarium PNG whose height is f(x, y). */
function png(f: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(256 * (1 + 256 * 3));
  for (let y = 0; y < 256; y++) {
    raw[y * (1 + 768)] = 0;
    for (let x = 0; x < 256; x++) raw.set(terrariumRgb(f(x, y)), y * 769 + 1 + x * 3);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    return out; // CRC is not checked by our decoder
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 256);
  new DataView(ihdr.buffer).setUint32(4, 256);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('finale terrain', () => {
  it('boxes are square in km and the tile plan stays within its budget', () => {
    const b = terrainBox(45, 10, 12);
    expect((b.north - b.south) * 110.574).toBeCloseTo(24, 6);
    expect((b.east - b.west) * 111.32 * Math.cos((45 * Math.PI) / 180)).toBeCloseTo(24, 6);
    for (const lat of [0, 38.7, 60, 70]) {
      const p = tilePlan(terrainBox(lat, -9, 12), 53.6, 16);
      expect(p.n).toBeLessThanOrEqual(16);
      expect(p.z).toBeGreaterThanOrEqual(9);
    }
  });

  it('decodes Terrarium PNGs to heights', async () => {
    const h = await decodeTerrariumPng(png((x, y) => x - y * 0.5), inflate);
    expect(h[0]).toBeCloseTo(0, 2);
    expect(h[255]).toBeCloseTo(255, 2);
    expect(h[255 * 256]).toBeCloseTo(-127.5, 2);
  });

  it('streams a box: west land, east sea flattened to 0 m, filled from the coarse layer', async () => {
    // Land rising west of the box centre's longitude, sea (exactly 0 m, as SRTM leaves it) to the east; the coarse
    // zoom has real depths there.
    const fetchFn = async (u: string) => {
      const [z, x] = u.split('/').slice(-3).map(Number) as [number, number];
      return new Response(
        png((px) => {
          const lng = ((x + px / 256) / 2 ** z) * 360 - 180;
          if (lng < 5) return 40 + (5 - lng) * 200;
          return z >= 11 ? 0 : -30;
        }) as BlobPart,
      );
    };
    const r = await loadTerrain(43.3, 5, { fetch: fetchFn, inflate, cells: 96, url: (z, x, y) => `t/${z}/${x}/${y}` });
    const { hf } = r;
    expect(hf.nx).toBe(96);
    const east = hf.data[48 * 96 + 90]!;
    const west = hf.data[48 * 96 + 5]!;
    expect(west).toBeGreaterThan(40);
    expect(east).toBeLessThan(-5);
    const f = coastFacts(hf, 43.3, 5);
    expect(f.water).toBeGreaterThan(0.3);
    expect(f.towardLand).toBeGreaterThan(225);
    expect(f.towardLand).toBeLessThan(315);
  });

  it('keeps small flat land, despikes towers', () => {
    const nx = 64;
    const ny = 64;
    const data = new Float32Array(nx * ny).fill(12);
    for (let j = 20; j < 26; j++) for (let i = 20; i < 26; i++) data[j * nx + i] = 0; // a small flat field at 0 m
    data[40 * nx + 40] = 300;
    const hf: Heightfield = { nx, ny, bbox: { south: 0, north: 0.05, west: 0, east: 0.05 }, data };
    expect(despike(hf)).toBe(1);
    expect(data[40 * nx + 40]).toBeCloseTo(12, 6);
    expect(fillFlatWater(hf, null)).toBe(0);
    expect(data[22 * nx + 22]).toBe(0);
  });

  it('exaggeration stays between ×1.5 and ×3', () => {
    expect(exaggerationFor(5)).toBe(3);
    expect(exaggerationFor(1100)).toBe(1.5);
    expect(exaggerationFor(560)).toBe(2.5);
  });
});

describe('finale extremes', () => {
  it('finds highs and lows of a pure M2 tide to the minute and the millimetre', () => {
    const p = prepare({ id: 't', z0: 1, constituents: [{ name: 'M2', amplitude: 1.2, phase: 40, speed: 28.984104 }] });
    const t0 = Date.UTC(2026, 0, 1);
    const s = tideSeries(p, t0, t0 + 3 * 86400e3);
    expect(s.extremes.length).toBeGreaterThanOrEqual(10);
    for (const e of s.extremes) {
      // A true turning point (node factor f scales the 1.2 m): both sides a few minutes away lie on the same side.
      const side = e.high ? 1 : -1;
      for (const dt of [-300e3, 300e3]) expect(side * (e.h - predict(p, e.t + dt))).toBeGreaterThan(0);
      expect(Math.abs(e.h - 1)).toBeGreaterThan(1.1);
      // A turning point: the slope is ~0 there.
      expect(Math.abs(rateAt(p, e.t))).toBeLessThan(0.01);
    }
    const nx = nextExtremes(s, t0 + 3600e3);
    expect(nx.high && nx.low).toBeTruthy();
    expect(predict(p, nx.high!.t)).toBeCloseTo(nx.high!.h, 9);
  });
});
