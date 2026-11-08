import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { BY_NAME, CONSTITUENTS, speed } from '../constituents.ts';
import { prepare, predict, type StationConstants } from '../predict.ts';
import { analyse } from '../analysis.ts';
import { MOON_BULGE_M, SUN_BULGE_M, SUN_TO_MOON } from '../equilibrium.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, DATA), 'utf8')) as T;
const station = (id: string) => load<StationConstants & { label: string }>(`stations/${id}.json`);

function compare(id: string, file: string) {
  const v = load<{ start: string; values: number[] }>(`validation/${file}`);
  const p = prepare(station(id));
  const t0 = Date.parse(v.start);
  let se = 0;
  let mx = 0;
  v.values.forEach((mm, i) => {
    const d = predict(p, t0 + i * 3600e3) * 1000 - mm;
    se += d * d;
    mx = Math.max(mx, Math.abs(d));
  });
  return { rmsCm: Math.sqrt(se / v.values.length) / 10, maxCm: mx / 10, skipped: p.skipped };
}

describe('constituents', () => {
  it('has NOAA’s 37 standard constituents', () => expect(CONSTITUENTS.length).toBe(37));
  it('speeds match NOAA’s to 1e-5 degrees per hour', () => {
    for (const k of station('9414290').constituents) {
      const c = BY_NAME.get(k.name)!;
      expect(Math.abs(speed(c) - k.speed)).toBeLessThan(1e-5);
    }
  });
  it('spring–neap period from M2 and S2 is 14.765 days', () => {
    const d = 360 / (speed(BY_NAME.get('S2')!) - speed(BY_NAME.get('M2')!)) / 24;
    expect(d).toBeCloseTo(14.765, 3);
  });
});

describe('prediction matches NOAA’s official predictions', () => {
  const files = readdirSync(new URL('validation/', DATA)).filter((f) => f.endsWith('.json'));
  it('San Francisco and The Battery: RMS < 1 cm, max < 3 cm', () => {
    for (const f of files.filter((f) => f.startsWith('9414290') || f.startsWith('8518750'))) {
      const r = compare(f.slice(0, 7), f);
      expect(r.rmsCm, f).toBeLessThan(1);
      expect(r.maxCm, f).toBeLessThan(3);
    }
  });
  it('every finale port: RMS < 2 cm, max < 6 cm, nothing skipped', () => {
    for (const f of files) {
      const r = compare(f.slice(0, 7), f);
      expect(r.skipped, f).toEqual([]);
      expect(r.rmsCm, f).toBeLessThan(2);
      expect(r.maxCm, f).toBeLessThan(6);
    }
  });
});

describe('equilibrium tide', () => {
  it('Moon ≈ 0.36 m, Sun ≈ 0.16 m, ratio ≈ 0.46', () => {
    expect(MOON_BULGE_M).toBeCloseTo(0.357, 2);
    expect(SUN_BULGE_M).toBeCloseTo(0.164, 2);
    expect(SUN_TO_MOON).toBeCloseTo(0.46, 2);
  });
});

describe('harmonic analysis', () => {
  it('a year of San Francisco data recovers NOAA’s main constants', () => {
    const y = load<{ start: string; stepMinutes: number; values: (number | null)[] }>('sf-year.json');
    const names = station('9414290').constituents.map((c) => c.name).filter((n) => n !== 'SA' && n !== 'SSA');
    const fit = analyse(y.values.map((v) => (v === null ? null : v / 1000)), Date.parse(y.start), y.stepMinutes, names);
    const noaa = Object.fromEntries(station('9414290').constituents.map((c) => [c.name, c]));
    for (const n of ['M2', 'K1', 'O1', 'S2', 'N2']) {
      const got = fit.constituents.find((c) => c.name === n)!;
      expect(Math.abs(got.amplitude - noaa[n]!.amplitude), n).toBeLessThan(0.015);
      const dph = Math.abs(((got.phase - noaa[n]!.phase + 540) % 360) - 180);
      expect(dph, n).toBeLessThan(3);
    }
  });
});
