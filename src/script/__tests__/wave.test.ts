import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CREST_MS, DELAY_H, M2_PERIOD_H, WEST_COAST, fmtDelay, m2Argument, nextCrest, wave, waveState } from '../wave.ts';
import { prepare, predict } from '../../tides/predict.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'));

describe('wave', () => {
  it('M2 constants and positions match the NOAA station files', () => {
    for (const s of WEST_COAST) {
      const st = read(`stations/${s.id}.json`);
      const m2 = st.constituents.find((c: { name: string }) => c.name === 'M2');
      expect(m2.amplitude).toBe(s.amp);
      expect(m2.phase).toBe(s.kappa);
      expect(st.lat).toBeCloseTo(s.lat, 5);
      expect(st.lng).toBeCloseTo(s.lng, 5);
    }
  });
  it('high water runs north: San Diego, Los Angeles, San Francisco, Newport, Seattle', () => {
    for (let i = 1; i < WEST_COAST.length; i++) {
      expect(DELAY_H[i]!).toBeGreaterThan(DELAY_H[i - 1]!);
      expect(CREST_MS[i]!).toBeGreaterThan(CREST_MS[i - 1]!);
      // Crest times agree with the phase-lag delays to a minute (u drifts slowly).
      expect(Math.abs((CREST_MS[i]! - CREST_MS[0]!) / 3600e3 - DELAY_H[i]!)).toBeLessThan(1 / 60);
    }
    expect(DELAY_H[2]!).toBeCloseTo(2.24, 2); // San Francisco
    expect(DELAY_H[4]!).toBeCloseTo(7.85, 2); // Seattle
  });
  it('each crest time is an M2 maximum at that station (predict.ts, M2 only)', () => {
    WEST_COAST.forEach((s, i) => {
      const p = prepare({ id: s.id, z0: 0, constituents: [{ name: 'M2', amplitude: s.amp, phase: s.kappa, speed: 0 }] });
      const t = CREST_MS[i]!;
      expect(predict(p, t)).toBeGreaterThan(s.amp * 0.9); // f·H, with the node factor f ≈ 0.96 in 2025
      expect(predict(p, t)).toBeGreaterThan(predict(p, t - 120e3));
      expect(predict(p, t)).toBeGreaterThan(predict(p, t + 120e3));
    });
  });
  it('nextCrest lands one M2 period apart', () => {
    const a = nextCrest(100, Date.UTC(2026, 0, 1));
    const b = nextCrest(100, a + 60e3);
    expect((b - a) / 3600e3).toBeCloseTo(M2_PERIOD_H, 1);
    let d = m2Argument(a) - 100;
    d -= Math.round(d / 360) * 360;
    expect(Math.abs(d)).toBeLessThan(0.01);
  });
  it('readouts follow the sweep', () => {
    expect(waveState(0.6).passed).toBe(-1);
    expect(waveState(0.95).passed).toBe(4);
    expect(wave.readouts(0.95)[1]!.value).toBe(`Seattle +${fmtDelay(DELAY_H[4]!)}`);
    expect(fmtDelay(2.2333)).toBe('2 h 14 min');
  });
});
