import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { brassState, TEN_VS_37, tourAt } from '../brass.ts';
import { readouts } from '../index.ts';
import { createMachineModel, OBB_37, penSeries } from '../../tides/machine.ts';
import type { StationConstants } from '../../tides/predict.ts';

const SF = JSON.parse(
  readFileSync(new URL('../../../public/data/stations/9414290.json', import.meta.url), 'utf8'),
) as StationConstants;
const T0 = Date.parse('2025-06-01T00:00Z');

describe('brass script', () => {
  it('the tour runs from the chain’s fixed end (Sa) to the pen end (M2), never backwards', () => {
    expect(OBB_37[brassState(0.22).focus]).toBe('SA');
    expect(OBB_37[brassState(0.68).focus]).toBe('M2');
    let prev = -1;
    for (let l = 0; l <= 1; l += 0.005) {
      const t = tourAt(l);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('the stated 10-vs-37 difference matches the machines at San Francisco (a year, hourly)', () => {
    const k = createMachineModel(SF, 'kelvin', { t0: T0 });
    const o = createMachineModel(SF, 'obb', { t0: T0 });
    const n = 24 * 365;
    const a = penSeries(k, 'ideal', T0, 60, n);
    const b = penSeries(o, 'ideal', T0, 60, n);
    let s = 0;
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i]! - b[i]!;
      s += d * d;
      mx = Math.max(mx, Math.abs(d));
    }
    expect(Math.sqrt(s / n) * 100).toBeCloseTo(TEN_VS_37.rmsCm, 1);
    expect(Math.round(mx * 100)).toBe(TEN_VS_37.maxCm);
  });

  it('readouts carry the documented figures', () => {
    const all = [0.05, 0.4, 0.8].flatMap((l) => readouts('brass', l).map((r) => r.value)).join(' | ');
    for (const f of ['129¼ × 74¼ × 24 in', 'about 2,500 lb', '1912–1965', '7–12 h', '6.5 cm RMS'])
      expect(all).toContain(f);
  });
});
