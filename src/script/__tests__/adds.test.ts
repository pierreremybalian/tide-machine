import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addsState,
  ARRIVALS,
  formatPeriod,
  machineDays,
  periodHours,
  SWAP,
  THOMSON_ORDER,
  throwFrac,
  windowDays,
  WIRE_DAY,
} from '../adds.ts';
import { readouts } from '../index.ts';
import { createMachineModel, KELVIN_1872, machineAt, createMachineState } from '../../tides/machine.ts';
import type { StationConstants } from '../../tides/predict.ts';

const SF = JSON.parse(
  readFileSync(new URL('../../../public/data/stations/9414290.json', import.meta.url), 'utf8'),
) as StationConstants;
const T0 = Date.parse('2025-06-01T00:00Z');

describe('adds script', () => {
  it('adds the ten in Thomson’s order from the pen end', () => {
    expect(THOMSON_ORDER).toEqual(['M2', 'S2', 'N2', 'K1', 'O1', 'K2', 'L2', 'P1', 'M4', 'MS4']);
    expect([...THOMSON_ORDER].reverse()).toEqual([...KELVIN_1872]);
  });

  it('machine time only moves forward and starts calm', () => {
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.002) {
      const d = machineDays(l);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(machineDays(0.12)).toBeLessThan(0.5);
  });

  it('arrivals are ordered, and each pin is set before the next crank arrives', () => {
    for (let q = 2; q < ARRIVALS.length; q++) {
      expect(ARRIVALS[q]!.a0).toBeGreaterThanOrEqual(ARRIVALS[q - 1]!.a1);
      expect(ARRIVALS[q]!.d0).toBeGreaterThanOrEqual(ARRIVALS[q - 1]!.d1 - 1e-9);
    }
    expect(throwFrac(0, -100)).toBe(1);
    expect(throwFrac(1, ARRIVALS[1]!.d0)).toBe(0);
    expect(throwFrac(1, ARRIVALS[1]!.d1)).toBe(1);
  });

  it('the record starts once both of the first two pins are set', () => {
    expect(WIRE_DAY).toBeGreaterThanOrEqual(ARRIVALS[1]!.d1 - 1e-9);
  });

  it('at the swap the paper shows 2.5 days and every crank has been set for all of them', () => {
    const ls = SWAP[0];
    expect(windowDays(ls)).toBeCloseTo(2.5, 9);
    const last = ARRIVALS.at(-1)!;
    expect(machineDays(ls) - 2.5).toBeGreaterThanOrEqual(last.d1);
    const s = addsState(SWAP[1]);
    expect(s.seated).toBe(10);
  });

  it('shows a fortnightly beat: at least two spring–neap cycles on the paper before the ten arrive', () => {
    const before = ARRIVALS[2]!.a0;
    expect(machineDays(before) - WIRE_DAY).toBeGreaterThan(2 * 14.77 - 1);
    expect(windowDays(before)).toBeGreaterThan(25);
  });

  it('formats periods', () => {
    expect(formatPeriod(periodHours('M2'))).toBe('12 h 25 min');
    expect(formatPeriod(periodHours('S2'))).toBe('12 h');
    expect(formatPeriod(periodHours('K1'))).toBe('23 h 56 min');
  });

  it('readouts count pulleys and name what is summed', () => {
    expect(readouts('adds', 0.2)[0]!.value).toBe('1 of 10');
    expect(readouts('adds', 0.5)[1]!.value).toBe('M2 + S2');
    expect(readouts('adds', 0.95)[0]!.value).toBe('10 of 10');
    expect(readouts('adds', 0.95).at(-1)!.value).toContain('2,200');
  });

  it('the rig’s pen rule (rest + 2 Σ throw cos θ) is the machine’s pen', () => {
    const m = createMachineModel(SF, 'kelvin', { t0: T0, scale: 0.399, penOffset: 2.6 });
    const st = createMachineState(m);
    for (const h of [0, 7.3, 50, 400]) {
      const ms = T0 + h * 3.6e6;
      machineAt(m, ms, 'geared', st);
      let s = 0;
      for (const ck of m.cranks)
        s += ck.throw0 * Math.cos(((ck.theta0 + ck.train.speed * h) * Math.PI) / 180);
      expect(Math.abs(m.penRestY + 2 * s - st.penY)).toBeLessThan(1e-9);
    }
  });
});
