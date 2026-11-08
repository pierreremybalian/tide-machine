import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GAUGE, STEP_MINUTES, WEEK_HOURS, WEEK_MM, WEEK_START, breathe, breatheState, observedAt, weekHours } from '../breathe.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'));

describe('breathe', () => {
  const week = read('sf-week.json') as { station: string; start: string; stepMinutes: number; values: number[] };
  it('carries the observed week exactly (public/data/sf-week.json)', () => {
    expect(week.station).toBe(GAUGE.id);
    expect(Date.parse(week.start)).toBe(WEEK_START);
    expect(week.stepMinutes).toBe(STEP_MINUTES);
    expect(WEEK_MM).toEqual(week.values);
    expect(WEEK_HOURS).toBeCloseTo(167.9, 1);
  });
  it('the gauge position matches the station file', () => {
    const st = read(`stations/${GAUGE.id}.json`);
    expect(st.lat).toBeCloseTo(GAUGE.lat, 5);
    expect(st.lng).toBeCloseTo(GAUGE.lng, 5);
  });
  it('reads the gauge at its samples and between them', () => {
    expect(observedAt(WEEK_START)).toBeCloseTo(WEEK_MM[0]! / 1000, 9);
    const t = WEEK_START + 100 * STEP_MINUTES * 60e3;
    expect(observedAt(t)).toBeCloseTo(WEEK_MM[100]! / 1000, 9);
    expect(observedAt(t + 3 * 60e3)).toBeCloseTo((WEEK_MM[100]! + WEEK_MM[101]!) / 2000, 9);
  });
  it('plays the whole week, forward only', () => {
    expect(weekHours(0)).toBe(0);
    expect(weekHours(1)).toBeCloseTo(WEEK_HOURS, 9);
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.01) {
      const h = weekHours(l);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
  it('readouts show Pacific time and the gauge', () => {
    const rows = breathe.readouts(0.5);
    expect(rows[0]!.value).toMatch(/PDT$/);
    expect(rows[1]!.value).toBe(`${breatheState(0.5).level.toFixed(2)} m`);
  });
});
