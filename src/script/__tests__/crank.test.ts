import { describe, expect, it } from 'vitest';
import { prepare, predict } from '../../tides/predict.ts';
import { CRANK_T0, HOUR_MS, MAX_DIFF, NOAA_WEEK, PEN_WEEK, SF, WEEK_H, crankReadings, crankState, noaaAt, penAt } from '../crank.ts';
import { readouts } from '../index.ts';

describe('crank', () => {
  it('reads NOAA’s week from the validation month (2026-01-01 00:00 PST onward)', () => {
    expect(NOAA_WEEK.length).toBe(WEEK_H + 1);
    // public/data/validation/9414290-2026-01.json starts at 00:00 UTC; PST midnight is index 8 (−0.352 m).
    expect(NOAA_WEEK[0]).toBeCloseTo(1.249, 3);
  });

  it('the pen is predict() to well under a millimetre, and NOAA within ~2 cm', () => {
    const p = prepare(SF);
    let worst = 0;
    for (let h = 0; h <= WEEK_H; h++) worst = Math.max(worst, Math.abs(PEN_WEEK[h]! - predict(p, CRANK_T0 + h * HOUR_MS)));
    expect(worst).toBeLessThan(0.0008);
    expect(MAX_DIFF.m).toBeGreaterThan(0.005);
    expect(MAX_DIFF.m).toBeLessThan(0.025);
    expect(MAX_DIFF.rms).toBeLessThan(0.012);
  });

  it('interpolates NOAA’s hourly values to a few millimetres (checked on predict())', () => {
    const p = prepare(SF);
    // Same scheme on our own hourly predictions, compared with the exact value at half hours.
    for (const h of [10.5, 37.5, 90.25, 150.75]) {
      expect(Math.abs(penAt(h) - predict(p, CRANK_T0 + h * HOUR_MS))).toBeLessThan(0.004);
    }
    expect(noaaAt(12)).toBeCloseTo(NOAA_WEEK[12]!, 9);
  });

  it('turns the crank through the week and reports the computed difference', () => {
    expect(crankState(0).hours).toBe(0);
    expect(crankState(1).hours).toBe(WEEK_H);
    expect(crankState(0.34).hours).toBeCloseTo(24, 6);
    const r = crankReadings(0.7);
    expect(Math.abs(r.penM - r.noaaM)).toBeLessThan(0.03);
    const rows = readouts('crank', 0.95);
    expect(rows.map((x) => x.label)).toContain('Machine vs NOAA, max');
    expect(rows.find((x) => x.label === 'Machine vs NOAA, max')!.value).toBe(`${(MAX_DIFF.m * 100).toFixed(1)} cm`);
    expect(readouts('crank', 0.2)[0]!.value).toMatch(/PST$/);
  });
});
