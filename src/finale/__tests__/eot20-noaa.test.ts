// EOT20 (modelled) against NOAA (measured): harmonic constants near three gauges, and a month of predictions
// against NOAA's official hourly predictions. These numbers are the finale's stated "modelled" accuracy
// (DECISIONS.md, Finale data).
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { decodeTile, encodeTile, Eot20, tileName, type Eot20Index, type Harmonic } from '../eot20.ts';
import { angleDiff } from '../geo.ts';
import { prepare, predict, type StationConstants } from '../../tides/predict.ts';
import { offlineFetch, readJson } from './helpers.ts';

type Station = StationConstants & { label: string; lat: number; lng: number };
const station = (id: string) => readJson<Station>(`stations/${id}.json`);
const EOT = ['M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'P1', 'Q1', 'M4'];

let eot: Eot20;
beforeAll(async () => {
  eot = await Eot20.load({ fetch: offlineFetch() });
});

describe('EOT20 tiles on disk', () => {
  const dir = new URL('../../../public/data/eot20/', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as Eot20Index;
  it('index lists exactly the tile files, all decodable 81×81 1/8° tiles with the nine constituents', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin') && f !== 'overview.bin');
    expect(files.map((f) => f.slice(0, -4)).sort()).toEqual([...index.tiles].sort());
    expect(readdirSync(dir).filter((f) => !f.endsWith('.bin'))).toEqual(['index.json']);
    expect(index.constituents).toEqual(EOT);
    expect(index.licence).toMatch(/CC BY 4\.0/);
    for (const f of files.filter((_, i) => i % 25 === 0)) {
      const t = decodeTile(readFileSync(new URL(f, dir)));
      expect(t).toMatchObject({ names: EOT, step: 0.125, rows: 81, cols: 81, thin: 2 });
      expect(f.slice(0, -4)).toBe(tileName(t.lat0, t.lng0));
      // The TypeScript encoder writes the Python's bytes (thinning flags aside: the Python decides them).
      const bytes = readFileSync(new URL(f, dir));
      const n = 81 * 81;
      const again = encodeTile({
        ...t,
        thin: undefined,
        amplitude: t.names.map((_, k) =>
          Array.from({ length: n }, (_, i) => (t.ocean[i]! < 0 ? NaN : t.amp[k]![t.ocean[i]!]! / 1000)),
        ),
        phase: t.names.map((_, k) =>
          Array.from({ length: n }, (_, i) => (t.ocean[i]! < 0 ? 0 : t.pha[k]![t.ocean[i]!]! / 100)),
        ),
      });
      again[20] = bytes[20]!;
      again[21] = bytes[21]!;
      expect(Buffer.from(again).equals(bytes)).toBe(true);
    }
    const o = decodeTile(readFileSync(new URL('overview.bin', dir)));
    expect(o).toMatchObject({
      lat0: -90,
      lng0: -180,
      step: 0.5,
      rows: 361,
      cols: 721,
      names: ['M2', 'S2', 'K1', 'O1'],
    });
  });
});

/**
 * Open-water points next to the gauges (Honolulu's gauge is inside the harbour, San Francisco's in the Golden
 * Gate strait, The Battery's at the tip of Manhattan: none resolvable on a 1/8° grid), and Atlantic City (ocean
 * pier) as an open-coast control. Tolerances per constituent: [amplitude m, phase degrees]. Semidiurnal
 * phases at the three gauges lag the open water by 14–30° (the wave takes time to get in); K1 barely does.
 */
const NEAR: { id: string; at: [number, number]; tol: Record<'M2' | 'K1', [number, number]> }[] = [
  // Honolulu: 4 km off the harbour mouth.
  { id: '1612340', at: [21.27, -157.87], tol: { M2: [0.015, 16], K1: [0.015, 3] } },
  // San Francisco: outside the Golden Gate.
  { id: '9414290', at: [37.79, -122.56], tol: { M2: [0.03, 16], K1: [0.015, 5] } },
  // The Battery: Lower New York Bay, by Sandy Hook, 25 km seaward.
  { id: '8518750', at: [40.5, -73.95], tol: { M2: [0.05, 32], K1: [0.015, 12] } },
  // Atlantic City: the gauge is on an ocean pier; EOT20 at the gauge itself.
  { id: '8534720', at: [39.355, -74.418], tol: { M2: [0.02, 3], K1: [0.015, 3] } },
];

describe('EOT20 vs NOAA harmonic constants (M2, K1)', () => {
  for (const { id, at, tol } of NEAR) {
    const label = Object.entries(tol)
      .map(([n, [a, p]]) => `${n} |ΔH| < ${a * 100} cm, |Δκ| < ${p}°`)
      .join('; ');
    it(`${station(id).label}: ${label}`, async () => {
      const s = (await eot.at(at[0], at[1]))!;
      expect(s).not.toBeNull();
      const noaa = station(id).constituents;
      const rows: string[] = [];
      const worst = { M2: [0, 0], K1: [0, 0] } as Record<string, [number, number]>;
      for (const n of ['M2', 'S2', 'N2', 'K1', 'O1']) {
        const e = s.constituents.find((c) => c.name === n)!;
        const k = noaa.find((c) => c.name === n)!;
        const dA = e.amplitude - k.amplitude;
        const dP = angleDiff(e.phase, k.phase);
        rows.push(
          `${n} EOT20 ${(e.amplitude * 100).toFixed(1)} cm ${e.phase.toFixed(1)}° | NOAA ${(k.amplitude * 100).toFixed(1)} cm ${k.phase.toFixed(1)}° | Δ ${(dA * 100).toFixed(1)} cm ${dP.toFixed(1)}°`,
        );
        if (n in worst) worst[n] = [dA, dP];
      }
      console.log(`${station(id).label} (EOT20 ${s.method} at ${at.join(', ')}):\n  ${rows.join('\n  ')}`);
      for (const [n, [dA, dP]] of Object.entries(worst)) {
        expect(Math.abs(dA), n).toBeLessThan(tol[n as 'M2' | 'K1'][0]);
        expect(Math.abs(dP), n).toBeLessThan(tol[n as 'M2' | 'K1'][1]);
      }
    });
  }
});

/**
 * Error (cm) of a prediction against one NOAA validation month (hourly, MLLW): RMS about the monthly mean
 * (the tide itself), the mean offset (EOT20 has no seasonal Sa/Ssa and no datum), and the total RMS.
 */
function errorCm(constituents: readonly Harmonic[], z0: number, file: string) {
  const v = readJson<{ start: string; values: number[] }>(`validation/${file}`);
  const p = prepare({ id: file, z0, constituents });
  const t0 = Date.parse(v.start);
  const d = v.values.map((mm, i) => predict(p, t0 + i * 3600e3) * 1000 - mm);
  const bias = d.reduce((a, x) => a + x, 0) / d.length;
  const rms = Math.sqrt(d.reduce((a, x) => a + (x - bias) ** 2, 0) / d.length);
  const total = Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length);
  return { rms: rms / 10, bias: bias / 10, total: total / 10 };
}

/**
 * EOT20 at open coasts against NOAA's official predictions (January and July 2026), with NOAA's own constants
 * for the same nine constituents as a baseline: the gap between the two is the model's share of the error,
 * the rest is the 28 minor constituents EOT20 does not carry. `max` bounds the RMS about the monthly mean.
 */
const OPEN_COAST: { id: string; at?: [number, number]; max: number }[] = [
  { id: '1612340', at: [21.27, -157.87], max: 5 }, // Honolulu, just off the harbour
  { id: '8534720', max: 6 }, // Atlantic City (ocean pier)
  { id: '9410170', max: 8 }, // San Diego (bay entrance)
  { id: '9435380', max: 12 }, // South Beach, Newport, OR (mouth of Yaquina Bay)
  { id: '8724580', max: 10 }, // Key West (harbour)
];

describe('EOT20 prediction vs NOAA’s official predictions for a month', () => {
  for (const { id, at, max } of OPEN_COAST) {
    it(`${station(id).label}: RMS < ${max} cm`, async () => {
      const st = station(id);
      const s = (await eot.at(...(at ?? [st.lat, st.lng])))!;
      expect(s).not.toBeNull();
      for (const month of ['01', '07']) {
        const file = `${id}-2026-${month}.json`;
        // EOT20 has no datum: add NOAA's MSL above MLLW so both sit on MLLW.
        const model = errorCm(s.constituents, st.z0, file);
        const nine = errorCm(
          st.constituents.filter((c) => EOT.includes(c.name)),
          st.z0,
          file,
        );
        console.log(
          `${st.label} 2026-${month}: EOT20 RMS ${model.rms.toFixed(1)} cm, mean offset ${model.bias.toFixed(1)}, total ${model.total.toFixed(1)}; NOAA's own nine ${nine.rms.toFixed(1)} cm (EOT20 ${s.method})`,
        );
        expect(model.rms, month).toBeLessThan(max);
      }
    });
  }
});
