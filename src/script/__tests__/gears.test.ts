import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { closeTrain, driftMinutes, gearsState, ladderRows, SF_GEAR_ERROR_MM, worstObb } from '../gears.ts';
import { readouts } from '../index.ts';
import { createMachineModel, OBB_37 } from '../../tides/machine.ts';
import type { StationConstants } from '../../tides/predict.ts';

const SF = JSON.parse(
  readFileSync(new URL('../../../public/data/stations/9414290.json', import.meta.url), 'utf8'),
) as StationConstants;
const T0 = Date.parse('2025-06-01T00:00Z');

/** Largest change in SF's predicted tide over a year from gearing alone (angles geared vs true, f and u frozen). */
function gearError(id: 'kelvin' | 'obb'): number {
  const m = createMachineModel(SF, id, { t0: T0 });
  let mx = 0;
  for (let h = 0; h <= 8766; h += 0.5) {
    let d = 0;
    for (const c of m.cranks) {
      const a = ((c.theta0 + c.train.speed * h) * Math.PI) / 180;
      const b = ((c.theta0 + c.trueSpeed * h) * Math.PI) / 180;
      d += c.f0 * c.H * (Math.cos(a) - Math.cos(b));
    }
    mx = Math.max(mx, Math.abs(d));
  }
  return mx * 1000;
}

describe('gears script', () => {
  it('the ladder has all 37 of Old Brass Brains’ cranks in order of speed, with Kelvin’s ten', () => {
    const rows = ladderRows();
    expect(rows.length).toBe(37);
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(OBB_37));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.speed).toBeGreaterThan(rows[i - 1]!.speed);
    expect(rows.filter((r) => r.kelvin).length).toBe(10);
    for (const r of rows) expect(r.obb.source).toBe(r.name === 'M1' ? 'approximation' : 'documented');
  });

  it('the close-up train is Kelvin’s M2 (our approximation), 176/169 × 154/83', () => {
    const t = closeTrain();
    expect(t.pairs).toEqual([
      [176, 169],
      [154, 83],
    ]);
    expect(t.source).toBe('approximation');
    expect(Math.abs(t.driftPerYear)).toBeLessThan(0.03);
  });

  it('ρ1 is the worst SP-32 train: 0.75° a year, 3.4 minutes', () => {
    const w = worstObb();
    expect(w.name).toBe('RHO');
    expect(w.obb.driftPerYear).toBeCloseTo(-0.754, 3);
    expect(driftMinutes(w)).toBeCloseTo(-3.36, 2);
  });

  it('the stated effect at San Francisco matches the computation', () => {
    const obb = gearError('obb');
    const kelvin = gearError('kelvin');
    expect(Math.abs(obb - SF_GEAR_ERROR_MM.obb)).toBeLessThan(0.1);
    expect(Math.abs(kelvin - SF_GEAR_ERROR_MM.kelvin)).toBeLessThan(0.1);
  });

  it('runs a year, then resets', () => {
    expect(gearsState(0.4).drift).toBe(0);
    expect(gearsState(0.8).drift).toBe(1);
    expect(gearsState(0.95).drift).toBe(0);
    expect(readouts('gears', 0.3)[1]!.value).toBe('×1.9322736');
    expect(readouts('gears', 0.8)[0]!.value).toBe('day 365 of 365');
    expect(readouts('gears', 0.95)[0]!.value).toBe('reset for next year');
  });
});
