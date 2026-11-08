import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARRIVALS, GAUGES, SWELL, dayHours, dispersion, levelAt, longWaveSpeed } from '../bay.ts';
import { prepare, predict } from '../../tides/predict.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'));

describe('bay', () => {
  const doc = read('bay/sf-stations.json') as {
    stations: { id: string; lat: number; lng: number; z0: number; constituents: { name: string; amplitude: number; phase: number; speed: number }[] }[];
  };
  it('constants match NOAA’s for the 35-station field (public/data/bay/sf-stations.json)', () => {
    for (const g of GAUGES) {
      const st = doc.stations.find((s) => s.id === g.id)!;
      expect(st, g.id).toBeTruthy();
      expect(st.z0).toBe(g.z0);
      expect(st.lat).toBeCloseTo(g.lat, 5);
      expect(st.lng).toBeCloseTo(g.lng, 5);
      const p = prepare({ id: st.id, z0: st.z0, constituents: st.constituents });
      for (let t = Date.UTC(2026, 11, 23); t < Date.UTC(2026, 11, 24); t += 3600e3) expect(levelAt(g, t)).toBeCloseTo(predict(p, t), 9);
    }
  });
  it('high water arrives late in the South Bay and later still in Suisun; the South Bay range grows, Suisun’s shrinks', () => {
    const [gg, rwc, coy, pc, mi] = ARRIVALS;
    expect(gg!.lagMin).toBe(0);
    expect(rwc!.lagMin).toBeGreaterThan(45);
    expect(coy!.lagMin).toBeGreaterThan(rwc!.lagMin);
    expect(pc!.lagMin).toBeGreaterThan(coy!.lagMin);
    expect(mi!.lagMin).toBeGreaterThan(pc!.lagMin);
    expect(rwc!.ratio).toBeGreaterThan(1.2);
    expect(coy!.ratio).toBeGreaterThan(rwc!.ratio);
    expect(pc!.ratio).toBeLessThan(0.8);
    expect(gg!.range).toBeGreaterThan(2.5); // a king tide
  });
  it('dispersion: deep water L = gT²/2π, shallow water c → √(gh)', () => {
    expect(dispersion(11, 1e4).length).toBeCloseTo((9.81 * 121) / (2 * Math.PI), 6);
    expect(dispersion(600, 10).speed).toBeCloseTo(longWaveSpeed(10), 2);
    expect(SWELL[0]!.length).toBeGreaterThan(SWELL[2]!.length);
    expect(longWaveSpeed(4000) * 3.6).toBeCloseTo(713, 0);
  });
  it('the clock only runs forward', () => {
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.01) {
      expect(dayHours(l)).toBeGreaterThanOrEqual(prev);
      prev = dayHours(l);
    }
  });
});
