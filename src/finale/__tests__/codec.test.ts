import { describe, expect, it } from 'vitest';
import {
  decodeTile,
  encodeTile,
  interpolateTile,
  nodeConstants,
  sampleAt,
  tileFor,
  tileName,
  tileOrigin,
  tilesNear,
  type Eot20Tile,
  type TileInput,
} from '../eot20.ts';
import { angleDiff, distanceKm, wrapLng } from '../geo.ts';
import { fold, parseLatLng, searchPlaces, type Place } from '../places.ts';

const NAMES = ['M2', 'K1'];

/** A synthetic 81×81 tile at 1/8°: amplitude and phase vary smoothly; `land(r, c)` marks land nodes. */
function synth(lat0: number, lng0: number, land: (r: number, c: number) => boolean = () => false): TileInput {
  const rows = 81;
  const cols = 81;
  const amplitude = NAMES.map(() => new Float64Array(rows * cols));
  const phase = NAMES.map(() => new Float64Array(rows * cols));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      NAMES.forEach((_, k) => {
        amplitude[k]![i] = land(r, c) ? NaN : 0.2 + 0.01 * r + 0.003 * c + 0.1 * k;
        phase[k]![i] = (350 + 0.9 * c + 0.4 * r + 37 * k) % 360; // wraps through 0°
      });
    }
  return { lat0, lng0, step: 1 / 8, rows, cols, names: NAMES, amplitude, phase };
}

const get = (tiles: Record<string, Eot20Tile>) => (n: string) => tiles[n] ?? null;

describe('tile addressing', () => {
  it('names tiles by their south-west corner', () => {
    expect(tileName(30, -130)).toBe('n30w130');
    expect(tileName(-10, 0)).toBe('s10e000');
    expect(tileName(0, 170)).toBe('n00e170');
    expect(tileFor(37.8, -122.5)).toBe('n30w130');
    expect(tileFor(-33.9, 151.2)).toBe('s40e150');
    expect(tileFor(0, 0)).toBe('n00e000');
    expect(tileFor(-0.01, -0.01)).toBe('s10w010');
    expect(tileOrigin(90, 180)).toEqual({ lat0: 80, lng0: -180 });
    expect(tileFor(10, 190)).toBe('n10w170');
  });
  it('lists the tiles around a point, across the antimeridian', () => {
    expect(tilesNear(35, -125, 10)).toEqual(['n30w130']);
    const t = tilesNear(-0.05, 179.95, 30).sort();
    expect(t).toEqual(['n00e170', 'n00w180', 's10e170', 's10w180']);
  });
});

describe('tile codec', () => {
  it('encode → decode round-trips within quantisation (1 mm, 0.01°)', () => {
    const input = synth(30, -130, (r, c) => r > 60 && c > 50);
    const bytes = encodeTile(input);
    const t = decodeTile(bytes);
    expect(t).toMatchObject({ lat0: 30, lng0: -130, step: 0.125, rows: 81, cols: 81, names: NAMES });
    expect(t.count).toBe(81 * 81 - 20 * 30);
    for (let r = 0; r < 81; r++)
      for (let c = 0; c < 81; c++) {
        const k = nodeConstants(t, r, c);
        const i = r * 81 + c;
        if (r > 60 && c > 50) {
          expect(k).toBeNull();
          continue;
        }
        k!.forEach((h, j) => {
          expect(Math.abs(h.amplitude - input.amplitude[j]![i]!)).toBeLessThanOrEqual(0.0005 + 1e-9);
          expect(Math.abs(angleDiff(h.phase, input.phase[j]![i]!))).toBeLessThanOrEqual(0.005 + 1e-6);
        });
      }
    // Re-encoding the decoded tile gives identical bytes.
    const again = encodeTile({
      ...input,
      amplitude: NAMES.map((_, k) =>
        Array.from({ length: 81 * 81 }, (_, i) => (t.ocean[i]! < 0 ? NaN : t.amp[k]![t.ocean[i]!]! / 1000)),
      ),
      phase: NAMES.map((_, k) =>
        Array.from({ length: 81 * 81 }, (_, i) => (t.ocean[i]! < 0 ? 0 : t.pha[k]![t.ocean[i]!]! / 100)),
      ),
    });
    expect(again).toEqual(bytes);
  });
  it('decodes from an unaligned view and rejects corrupt input', () => {
    const bytes = encodeTile(synth(0, 0));
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    expect(decodeTile(shifted.subarray(1)).count).toBe(81 * 81);
    // A Node Buffer (whose slice() is a view) decodes to the same values as a fresh ArrayBuffer.
    const big = Buffer.concat([Buffer.alloc(7), Buffer.from(bytes)]).subarray(7);
    expect(decodeTile(big).amp).toEqual(decodeTile(bytes.slice().buffer).amp);
    expect(() => decodeTile(bytes.slice(0, bytes.length - 2))).toThrow(/size/);
    const bad = bytes.slice();
    bad[0] = 0x58;
    expect(() => decodeTile(bad)).toThrow(/magic/);
  });
});

describe('interpolation', () => {
  const t = decodeTile(encodeTile(synth(30, -130, (r, c) => r >= 40 && c >= 40)));
  it('at a grid node equals the node', () => {
    for (const [r, c] of [
      [0, 0],
      [10, 17],
      [39, 80],
      [80, 0],
    ] as const) {
      const s = interpolateTile(t, 30 + r / 8, -130 + c / 8)!;
      const n = nodeConstants(t, r, c)!;
      expect(s.method).toBe('bilinear');
      s.constituents.forEach((h, k) => {
        expect(h.amplitude).toBeCloseTo(n[k]!.amplitude, 9);
        expect(Math.abs(angleDiff(h.phase, n[k]!.phase))).toBeLessThan(1e-7);
      });
    }
  });
  it('interpolates H·e^{iκ}: across 0°/360° the phase stays near 0°, not 180°', () => {
    // Columns 11 and 12 of row 0 have M2 phases 359.9° and 0.8°.
    const s = interpolateTile(t, 30, -130 + 11.5 / 8)!;
    const m2 = s.constituents.find((h) => h.name === 'M2')!;
    expect(Math.abs(angleDiff(m2.phase, 0.35))).toBeLessThan(0.01);
  });
  it('drops land corners and renormalises', () => {
    const s = interpolateTile(t, 30 + 39.5 / 8, -130 + 39.5 / 8)!; // one corner (40, 40) is land
    expect(s.method).toBe('partial');
    const s2 = interpolateTile(t, 30 + 45.5 / 8, -130 + 45.5 / 8); // all land
    expect(s2).toBeNull();
  });
  it('falls back to the nearest ocean node within the search radius, across tiles', () => {
    // Land everywhere in this tile except its west edge; the point is 3 cells east of it.
    const a = decodeTile(encodeTile(synth(30, -130, (_r, c) => c > 0)));
    const lat = 35;
    const lng = -130 + 3 / 8;
    const s = sampleAt(get({ n30w130: a }), lat, lng, { searchKm: 50 })!;
    expect(s.method).toBe('nearest');
    expect(s.lng).toBeCloseTo(-130, 9);
    expect(s.distanceKm).toBeCloseTo(distanceKm(lat, lng, 35, -130), 6);
    expect(sampleAt(get({ n30w130: a }), lat, lng, { searchKm: 20 })).toBeNull();
    // The nearest ocean may be in the neighbouring tile.
    const b = decodeTile(encodeTile(synth(30, -130, () => true)));
    const w = decodeTile(encodeTile(synth(30, -140)));
    const n = sampleAt(get({ n30w130: b, n30w140: w }), lat, -130 + 1 / 16, { searchKm: 30 })!;
    expect(n.method).toBe('nearest');
    expect(wrapLng(n.lng)).toBeCloseTo(-130, 9);
  });
});

describe('thinned tiles (1/8° near land, 1/4° lattice in open ocean)', () => {
  // Land in the north-west corner; nodes more than 4 nodes from it are kept only on the even lattice.
  const input = { ...synth(30, -130, (r, c) => r >= 70 && c <= 10), thin: { margin: 4 } };
  const t = decodeTile(encodeTile(input));
  const full = decodeTile(encodeTile(synth(30, -130, (r, c) => r >= 70 && c <= 10)));
  it('stores every ocean node near land and only the even lattice far from it', () => {
    expect(t.thin).toBe(2);
    expect(nodeConstants(t, 20, 41)).toBeNull(); // open ocean, odd column: thinned
    expect(nodeConstants(t, 20, 40)).not.toBeNull(); // even lattice
    expect(nodeConstants(t, 67, 13)).not.toBeNull(); // within 4 nodes of land
    expect(t.count).toBeLessThan(full.count / 2);
  });
  it('open ocean: bilinear on the 1/4° lattice, equal to the stored nodes on it', () => {
    const s = interpolateTile(t, 30 + 20 / 8, -130 + 41 / 8)!;
    expect(s).toMatchObject({ method: 'bilinear', step: 0.25 });
    // The synthetic field is bilinear in (r, c) for amplitude, so 1/4° reproduces 1/8° to quantisation.
    const ref = nodeConstants(full, 20, 41)!;
    expect(Math.abs(s.constituents[0]!.amplitude - ref[0]!.amplitude)).toBeLessThan(0.002);
    const node = interpolateTile(t, 30 + 20 / 8, -130 + 40 / 8)!;
    expect(node).toMatchObject({ method: 'bilinear', step: 0.125 });
  });
  it('near land: native 1/8°, land corners dropped', () => {
    expect(interpolateTile(t, 30 + 66.5 / 8, -130 + 12.5 / 8)).toMatchObject({
      method: 'bilinear',
      step: 0.125,
    });
    expect(interpolateTile(t, 30 + 69.5 / 8, -130 + 10.5 / 8)).toMatchObject({
      method: 'partial',
      step: 0.125,
    });
  });
});

describe('place search', () => {
  const places: Place[] = [
    { name: 'São Paulo', country: 'Brazil', lat: -23.55, lng: -46.63 },
    { name: 'San Francisco', country: 'United States', lat: 37.77, lng: -122.42 },
    { name: 'Santos', country: 'Brazil', lat: -23.95, lng: -46.33 },
    { name: 'Port Said', country: 'Egypt', lat: 31.26, lng: 32.3 },
    { name: 'Saïda', country: 'Lebanon', lat: 33.56, lng: 35.37 },
  ];
  it('folds accents and ranks prefix matches first', () => {
    expect(fold('São Tomé')).toBe('sao tome');
    expect(searchPlaces(places, 'sao').map((p) => p.name)).toEqual(['São Paulo']);
    expect(searchPlaces(places, 'san').map((p) => p.name)).toEqual(['San Francisco', 'Santos']);
    expect(searchPlaces(places, 'said').map((p) => p.name)).toEqual(['Saïda', 'Port Said']);
    expect(searchPlaces(places, 'santos, bra').map((p) => p.name)).toEqual(['Santos']);
    expect(searchPlaces(places, 'brazil').length).toBe(2);
    expect(searchPlaces(places, '  ')).toEqual([]);
  });
  it('parses typed coordinates', () => {
    expect(parseLatLng('37.81, -122.47')).toEqual({ lat: 37.81, lng: -122.47 });
    expect(parseLatLng('37.81N 122.47W')).toEqual({ lat: 37.81, lng: -122.47 });
    expect(parseLatLng('33.9 S, 151.2 E')).toEqual({ lat: -33.9, lng: 151.2 });
    expect(parseLatLng('91, 0')).toBeNull();
    expect(parseLatLng('Lisbon')).toBeNull();
  });
});
