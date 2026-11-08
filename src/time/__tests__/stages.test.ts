import { describe, expect, it } from 'vitest';
import { STAGES, STAGE_STARTS, progressToStage, stageToProgress } from '../stages.ts';
import { ramp, track, windowed } from '../tracks.ts';

describe('stages', () => {
  it('has 13 stages with unique ids and increasing starts', () => {
    expect(STAGES.length).toBe(13);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(13);
    for (let i = 1; i < STAGE_STARTS.length; i++) expect(STAGE_STARTS[i]!).toBeGreaterThan(STAGE_STARTS[i - 1]!);
    expect(STAGE_STARTS.at(-1)).toBe(1);
  });
  it('progress ↔ stage round-trips', () => {
    for (let k = 0; k <= 1000; k++) {
      const p = k / 1000;
      const sp = progressToStage(p);
      expect(stageToProgress(sp.index, sp.local)).toBeCloseTo(p, 12);
    }
  });
  it('is monotonic', () => {
    let last = -1;
    for (let k = 0; k <= 2000; k++) {
      const sp = progressToStage(k / 2000);
      const v = sp.index + sp.local;
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe('tracks', () => {
  it('hits keys and holds outside', () => {
    const f = track([
      [0.2, 1],
      [0.5, 3],
      [0.8, -1],
    ]);
    expect(f(0)).toBe(1);
    expect(f(0.2)).toBe(1);
    expect(f(0.5)).toBe(3);
    expect(f(0.8)).toBe(-1);
    expect(f(1)).toBe(-1);
    expect(f(0.35)).toBeCloseTo(2, 10);
  });
  it('rejects unsorted keys', () => {
    expect(() =>
      track([
        [0.5, 0],
        [0.2, 1],
      ]),
    ).toThrow();
  });
  it('windows and ramps', () => {
    expect(windowed(0.1, 0.2, 0.6)).toBe(0);
    expect(windowed(0.4, 0.2, 0.6)).toBe(1);
    expect(windowed(0.7, 0.2, 0.6)).toBe(0);
    expect(ramp(0.5, 0.2, 0.8)).toBeCloseTo(0.5, 10);
  });
});
