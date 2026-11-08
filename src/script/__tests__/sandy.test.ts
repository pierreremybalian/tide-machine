import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BATTERY, OBS_MM, OBS_START, PEAK, PREDICTED_HIGH, STEP_MINUTES, dayHours, predictedAt, sandy, sandyState } from '../sandy.ts';
import { prepare, predict } from '../../tides/predict.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'));

describe('sandy', () => {
  const s = read('sandy.json') as { station: string; start: string; stepMinutes: number; observed: number[]; predicted: number[] };
  const i0 = (OBS_START - Date.parse(s.start)) / (STEP_MINUTES * 60e3);
  it('carries NOAA’s observed record exactly (public/data/sandy.json)', () => {
    expect(s.station).toBe(BATTERY.id);
    expect(Number.isInteger(i0)).toBe(true);
    expect(OBS_MM).toEqual(s.observed.slice(i0, i0 + OBS_MM.length));
  });
  it('our prediction matches NOAA’s 2012 prediction within 1 cm', () => {
    for (let k = 0; k < OBS_MM.length; k++) {
      const ms = OBS_START + k * STEP_MINUTES * 60e3;
      expect(Math.abs(predictedAt(ms) - s.predicted[i0 + k]! / 1000)).toBeLessThan(0.01);
    }
  });
  it('constants match the harbor field’s (public/data/bay/nyc-stations.json)', () => {
    const st = read('bay/nyc-stations.json').stations.find((x: { id: string }) => x.id === BATTERY.id);
    const p = prepare({ id: st.id, z0: st.z0, constituents: st.constituents });
    for (let t = OBS_START; t < OBS_START + 72 * 3600e3; t += 3600e3) expect(predictedAt(t)).toBeCloseTo(predict(p, t), 9);
  });
  it('the peak: 4.28 m above MLLW at 9:24 PM EDT on 29 October, 2.84 m above the prediction', () => {
    expect(PEAK.observed).toBeCloseTo(4.284, 3);
    expect(PEAK.ms).toBe(Date.UTC(2012, 9, 30, 1, 24));
    expect(PEAK.predicted).toBeCloseTo(1.44, 1);
    expect(PEAK.surge).toBeCloseTo(2.84, 1);
    expect(PREDICTED_HIGH.level).toBeCloseTo(1.48, 1);
  });
  it('the stage reaches the peak, reveals the real water, and runs forward', () => {
    const at = sandyState(0.58);
    expect(at.ms).toBe(PEAK.ms);
    expect(at.real).toBe(1);
    expect(sandyState(0.2).real).toBe(0);
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.01) {
      expect(dayHours(l)).toBeGreaterThanOrEqual(prev);
      prev = dayHours(l);
    }
    expect(sandy.readouts(0.58).map((r) => r.value)).toEqual(['9:24 PM EDT', '1.45 m', '4.28 m', '+2.84 m']);
  });
});
