import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bestTrain,
  createMachineModel,
  createMachineState,
  DEFAULT_TEETH,
  gearTrain,
  HOURS_PER_YEAR,
  KELVIN_1872,
  machineAt,
  OBB_37,
  OBB_SHAFT_SPEED,
  OBB_TRAINS,
  penSeries,
  type MachineModel,
} from '../machine.ts';
import { BY_NAME, speed } from '../constituents.ts';
import { prepare, predictSeries, type StationConstants } from '../predict.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const SF = JSON.parse(readFileSync(new URL('stations/9414290.json', DATA), 'utf8')) as StationConstants;
const T0 = Date.parse('2025-06-01T00:00Z'); // the SF week (public/data/sf-week.json)
const WEEK = 7 * 240; // 6-minute steps

function maxDiff(a: Float64Array, b: Float64Array) {
  let mx = 0;
  for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i]! - b[i]!));
  return mx;
}

function rms(a: Float64Array, b: Float64Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s / a.length);
}

describe('gear trains', () => {
  it('best approximations stay within the tooth limits and multiply out to their ratio', () => {
    for (const name of OBB_37) {
      const g = gearTrain(speed(BY_NAME.get(name)!));
      expect(g.pairs.length).toBeLessThanOrEqual(DEFAULT_TEETH.stages);
      for (const [a, b] of g.pairs) {
        for (const t of [a, b]) {
          expect(Number.isInteger(t), name).toBe(true);
          expect(t).toBeGreaterThanOrEqual(DEFAULT_TEETH.min);
          expect(t).toBeLessThanOrEqual(DEFAULT_TEETH.max);
        }
      }
      expect(g.ratio).toBeCloseTo(g.pairs.reduce((r, [a, b]) => (r * a) / b, 1), 15);
      expect(g.driftPerYear).toBeCloseTo(g.error * HOURS_PER_YEAR, 9);
    }
  });
  it('solar constituents are exact on a day shaft; M2 is within 1e-6 relative', () => {
    for (const n of ['S1', 'S2', 'S4', 'S6']) expect(gearTrain(speed(BY_NAME.get(n)!)).source).toBe('exact');
    const m2 = gearTrain(speed(BY_NAME.get('M2')!));
    expect(Math.abs(m2.ratio / m2.target - 1)).toBeLessThan(1e-6);
  });
  it('the search is exhaustive: no single-stage ratio beats it', () => {
    const target = speed(BY_NAME.get('M2')!) / 15;
    const best = bestTrain(target);
    for (let q = 10; q <= 200; q++)
      for (let p = 10; p <= 200; p++) expect(Math.abs(p / q - target)).toBeGreaterThanOrEqual(Math.abs(best.ratio - target) - 1e-15);
  });
  it('slow terms off a fast shaft get a worm first', () => {
    const sa = gearTrain(speed(BY_NAME.get('SA')!), OBB_SHAFT_SPEED);
    expect(sa.pairs[0]![0]).toBe(1);
    expect(Math.abs(sa.driftPerYear)).toBeLessThan(0.5);
  });
  it('Old Brass Brains: SP-32’s tooth counts give SP-32’s gear speeds', () => {
    // Table C, "speed of gear" column (degrees per dial hour).
    const sp32: Record<string, number> = { M2: 28.9841017, K1: 15.0410959, O1: 13.9430363, SA: 0.0410738, MN4: 57.423756, RHO: 13.4714286 };
    for (const [n, v] of Object.entries(sp32)) {
      const g = gearTrain(speed(BY_NAME.get(n)!), OBB_SHAFT_SPEED, DEFAULT_TEETH, OBB_TRAINS[n]);
      expect(g.source).toBe('documented');
      expect(g.speed, n).toBeCloseTo(v, 6);
    }
  });
  it('reports the drift per year of every crank (Old Brass Brains, documented trains)', () => {
    const m = createMachineModel(SF, 'obb', { t0: T0 });
    const rows = m.cranks.map((c) => ({
      name: c.name,
      teeth: c.train.pairs.map(([a, b]) => `${a === 1 ? 'worm' : a}/${b}`).join(' × '),
      source: c.train.source,
      'drift °/yr': Number(c.train.driftPerYear.toFixed(3)),
    }));
    console.info('Old Brass Brains gear drift per year (30°/h shafts; SP-32 Table C except M1)');
    console.table(rows);
    for (const c of m.cranks) expect(Math.abs(c.train.driftPerYear), c.name).toBeLessThan(1);
    expect(m.cranks.filter((c) => c.train.source === 'documented').length).toBe(36);
  });
});

describe('the wire adds', () => {
  it('pen displacement = 2 Σ throw·cos θ from the tangent geometry (the factor of two)', () => {
    for (const id of ['kelvin', 'obb'] as const) {
      const m = createMachineModel(SF, id, { t0: T0 });
      const st = createMachineState(m);
      for (let h = 0; h < 48; h += 1.7) {
        machineAt(m, T0 + h * 3.6e6, 'geared', st);
        let sum = 0;
        for (let i = 0; i < m.cranks.length; i++) sum += st.throw[i]! * Math.cos((st.angle[i]! * Math.PI) / 180);
        expect(Math.abs(st.penDisplacement - 2 * sum)).toBeLessThan(1e-12);
      }
    }
  });
  it('every straight run is vertical and every pulley wraps half a turn', () => {
    const m = createMachineModel(SF, 'obb', { t0: T0 });
    const st = machineAt(m, T0 + 5 * 3.6e6, 'geared', createMachineState(m));
    for (let k = 1; k <= m.cranks.length; k++) {
      expect(Math.abs(st.outX[k - 1]! - st.inX[k]!)).toBeLessThan(1e-12);
      expect(Math.abs(Math.abs(st.arcSweep[k]!) - Math.PI)).toBeLessThan(1e-12);
    }
  });
});

describe('the pen draws the tide (San Francisco, one week)', () => {
  const check = (m: MachineModel) => {
    const ref = predictSeries(prepare(SF, m.spec.constituents), T0, 6, WEEK);
    return { ideal: maxDiff(penSeries(m, 'ideal', T0, 6, WEEK), ref), geared: maxDiff(penSeries(m, 'geared', T0, 6, WEEK), ref) };
  };
  it('with exact speeds and node factors, the pen equals predict() to 1e-9 m', () => {
    for (const id of ['kelvin', 'obb'] as const) expect(check(createMachineModel(SF, id, { t0: T0 })).ideal).toBeLessThan(1e-9);
  });
  it('with the gear trains and settings frozen at the start, within 1 mm', () => {
    for (const id of ['kelvin', 'obb'] as const) {
      const r = check(createMachineModel(SF, id, { t0: T0 }));
      console.info(`${id}: geared machine vs predict() over the week, max ${(r.geared * 1000).toFixed(3)} mm`);
      expect(r.geared).toBeLessThan(1e-3);
    }
  });
  it('Kelvin’s first machine carried the pulley on the crank: the runs tilt and the sum bends (reported)', () => {
    const m = createMachineModel(SF, 'kelvin', { t0: T0, linkage: 'crank' });
    const ref = predictSeries(prepare(SF, m.spec.constituents), T0, 6, WEEK);
    const pen = penSeries(m, 'ideal', T0, 6, WEEK);
    console.info(`kelvin, pulley on the crank pin (no slide): max ${(maxDiff(pen, ref) * 100).toFixed(1)} cm, RMS ${(rms(pen, ref) * 100).toFixed(1)} cm`);
    expect(maxDiff(pen, ref)).toBeGreaterThan(1e-3);
    expect(maxDiff(pen, ref)).toBeLessThan(0.15);
  });
  it('Old Brass Brains is predict(): all 37, nothing skipped', () => {
    const m = createMachineModel(SF, 'obb', { t0: T0 });
    expect(m.cranks.length).toBe(37);
    expect(new Set(OBB_37).size).toBe(37);
    const full = predictSeries(prepare(SF), T0, 6, WEEK);
    expect(maxDiff(penSeries(m, 'ideal', T0, 6, WEEK), full)).toBeLessThan(1e-9);
  });
});

describe('Kelvin’s ten vs the full thirty-seven', () => {
  it('differ by a few centimetres RMS at San Francisco over a year', () => {
    expect(KELVIN_1872.length).toBe(10);
    const k = createMachineModel(SF, 'kelvin', { t0: T0 });
    const o = createMachineModel(SF, 'obb', { t0: T0 });
    const n = 24 * 365;
    const a = penSeries(k, 'ideal', T0, 60, n);
    const b = penSeries(o, 'ideal', T0, 60, n);
    const r = rms(a, b);
    console.info(`Kelvin 10 vs Old Brass Brains 37 at San Francisco, one year hourly: RMS ${(r * 100).toFixed(2)} cm, max ${(maxDiff(a, b) * 100).toFixed(1)} cm`);
    expect(r).toBeGreaterThan(0.01);
    expect(r).toBeLessThan(0.15);
  });
});
