// Stages 2, 5, 6 and 7 (moon, sun, rhythms, apart): the numbers on screen against the tide core and the data files.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyse } from '../../tides/analysis.ts';
import { astro } from '../../tides/astro.ts';
import { CONSTITUENTS, speed } from '../../tides/constituents.ts';
import { equilibriumHeight, MOON_BULGE_M } from '../../tides/equilibrium.ts';
import { prepare, predict, termHeight } from '../../tides/predict.ts';
import { readouts, stageNote } from '../index.ts';
import {
  earthAngle,
  LUNAR_DAY_H,
  MOON_RATE,
  moonAngle,
  moonState,
  SF as SF_POS,
  sfFromMoon,
  sfHeight,
  TURN_START_H,
} from '../moon.ts';
import {
  arms,
  PERIOD_M2_H,
  skyEvents,
  SPRING_NEAP_H,
  sunCurves,
  sunState,
  TERM_M2,
  TERM_S2,
  TIDE_AGE_H,
  T0,
} from '../sun.ts';
import {
  axisOf,
  BEATS,
  LINES,
  NOAA_COUNT,
  prettyName,
  rhythmsState,
  SF_CONSTANTS,
  VIEWS,
} from '../rhythms.ts';
import { apartState, FIT, FIT_RMS, FIT_Z0, RECORD, ROWS, SURGE, WINDOW } from '../apart.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, DATA), 'utf8')) as T;
const station = load<{ constituents: { name: string; amplitude: number; phase: number }[] }>(
  'stations/9414290.json',
);
const year = load<{ start: string; stepMinutes: number; values: (number | null)[] }>('sf-year.json');
const dPhase = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('San Francisco constants (rhythms)', () => {
  it('equal the station file, every nonzero constituent, sorted by height', () => {
    const nonzero = station.constituents.filter((c) => c.amplitude > 0);
    expect(SF_CONSTANTS.length).toBe(nonzero.length);
    for (const c of nonzero) {
      const row = SF_CONSTANTS.find((r) => r[0] === c.name);
      expect(row, c.name).toBeDefined();
      expect(row![1]).toBe(c.amplitude);
      expect(row![2]).toBe(c.phase);
    }
    for (let i = 1; i < SF_CONSTANTS.length; i++)
      expect(SF_CONSTANTS[i]![1]).toBeLessThanOrEqual(SF_CONSTANTS[i - 1]![1]);
    expect(NOAA_COUNT).toBe(CONSTITUENTS.length);
  });

  it('spectrum lines carry the core speeds; M2 is 12 h 25 min, K1 a sidereal day, Sa a year', () => {
    const l = (n: string) => LINES.find((x) => x.name === n)!;
    expect(l('M2').period).toBeCloseTo(12.4206, 3);
    expect(l('K1').period).toBeCloseTo(23.9345, 3);
    expect(l('SA').period / 24).toBeCloseTo(365.26, 1);
    expect(prettyName('LAM2')).toBe('λ2');
    for (const x of LINES) expect(x.speed).toBeCloseTo(speed(x.c), 9);
  });

  it('every line sits inside the overview, and each family view contains its focus lines', () => {
    for (const x of LINES) expect(Math.abs(axisOf(x.speed) - VIEWS.all.centre)).toBeLessThan(VIEWS.all.half);
    for (const b of BEATS) {
      const v = VIEWS[b.view];
      for (const n of b.focus)
        expect(Math.abs(axisOf(LINES.find((x) => x.name === n)!.speed) - v.centre), n).toBeLessThan(
          v.half * 0.8,
        );
    }
    expect(rhythmsState(0.3).beat).toBe(1);
    expect(rhythmsState(0.95).table).toBe(1);
  });
});

describe('moon: the equilibrium tide', () => {
  it('the lunar day is 24 h 50 min, and Earth catches up with the Moon once per lunar day', () => {
    expect(LUNAR_DAY_H).toBeCloseTo(24.8412, 3);
    expect(Math.floor((LUNAR_DAY_H % 1) * 60)).toBe(50);
    // San Francisco returns to the same angle from the Moon after one lunar day.
    for (const t of [3, 10, 17])
      expect(dPhase(sfFromMoon(t + LUNAR_DAY_H), sfFromMoon(t))).toBeLessThan(1e-6);
    expect(moonAngle(LUNAR_DAY_H) - moonAngle(0)).toBeCloseTo(MOON_RATE * LUNAR_DAY_H, 9);
    expect(earthAngle(TURN_START_H) + SF_POS.lng - moonAngle(TURN_START_H)).toBeCloseTo(135, 6);
  });

  it('San Francisco passes two equal highs and two lows per lunar day, from equilibrium.ts', () => {
    const hs: number[] = [];
    for (let i = 0; i <= 2000; i++) hs.push(sfHeight(TURN_START_H + (LUNAR_DAY_H * i) / 2000));
    let highs = 0;
    let lows = 0;
    for (let i = 1; i < hs.length - 1; i++) {
      if (hs[i]! > hs[i - 1]! && hs[i]! >= hs[i + 1]!) highs++;
      if (hs[i]! < hs[i - 1]! && hs[i]! <= hs[i + 1]!) lows++;
    }
    expect(highs).toBe(2);
    expect(lows).toBe(2);
    const lat = (SF_POS.lat * Math.PI) / 180;
    expect(Math.max(...hs)).toBeCloseTo(equilibriumHeight(MOON_BULGE_M, lat), 4);
    expect(Math.min(...hs)).toBeCloseTo(-MOON_BULGE_M / 2, 4);
    // The Moon's semidiurnal equilibrium amplitude at San Francisco's latitude, against NOAA's M2 (stage text: "more
    // than three times").
    const amp = 0.75 * MOON_BULGE_M * Math.cos(lat) ** 2;
    expect(0.576 / amp).toBeGreaterThan(3);
    expect(0.576 / amp).toBeLessThan(4);
  });

  it('beats run in order and the readouts follow the scene', () => {
    expect(moonState(0.2).pull).toBeGreaterThan(0.9);
    expect(moonState(0.5).bulge).toBe(1);
    expect(readouts('moon', 0.6).some((r) => r.label === 'San Francisco')).toBe(true);
    expect(readouts('moon', 0.8).find((r) => r.label === 'Lunar day')!.value).toBe('24 h 50 min');
    expect(stageNote('moon')).toMatch(/million/);
  });
});

describe('sun: M2 and S2', () => {
  it('spring–neap cycle of 14.77 days and an 8-hour age of the tide at San Francisco', () => {
    expect(SPRING_NEAP_H / 24).toBeCloseTo(14.765, 2);
    expect(TIDE_AGE_H).toBeCloseTo(7.87, 2);
    expect(PERIOD_M2_H).toBeCloseTo(12.4206, 3);
  });

  it('arms are exactly the predictor’s terms: tip height = termHeight(M2) + termHeight(S2) = predict() with just those two', () => {
    const p = prepare({
      id: 'sf',
      z0: 0,
      constituents: [
        { name: 'M2', amplitude: 0.576, phase: 208.2, speed: 0 },
        { name: 'S2', amplitude: 0.137, phase: 216.2, speed: 0 },
      ],
    });
    for (const h of [0, 7.3, 50, 333.3, 700]) {
      const r = arms(h);
      const a = astro(T0 + h * 3600e3);
      const tip = r.fm2 * Math.cos((r.m2 * Math.PI) / 180) + r.fs2 * Math.cos((r.s2 * Math.PI) / 180);
      expect(tip).toBeCloseTo(termHeight(TERM_M2, a) + termHeight(TERM_S2, a), 12);
      expect(tip).toBeCloseTo(predict(p, T0 + h * 3600e3), 12);
    }
  });

  it('springs follow new and full moon by the age of the tide; neaps follow the quarters', () => {
    const ev = skyEvents();
    expect(ev.filter((e) => e.kind === 'spring').length).toBe(2);
    expect(ev.filter((e) => e.kind === 'neap').length).toBe(2);
    const after = (kind: string, then: string) => {
      const a = ev.filter((e) => e.kind === kind);
      const b = ev.filter((e) => e.kind === then);
      return a.map((x) => (b.find((y) => y.hours > x.hours)?.hours ?? NaN) - x.hours).filter(Number.isFinite);
    };
    for (const lag of [...after('new', 'spring'), ...after('full', 'spring')])
      expect(Math.abs(lag - TIDE_AGE_H)).toBeLessThan(0.75);
    for (const lag of [...after('first', 'neap'), ...after('last', 'neap')])
      expect(Math.abs(lag - TIDE_AGE_H)).toBeLessThan(0.75);
    const c = sunCurves(1);
    const env = Array.from(c.env);
    expect(Math.max(...env)).toBeLessThan(0.576 + 0.137);
    expect(Math.min(...env)).toBeGreaterThan(0.576 * 0.9 - 0.137 - 0.01);
    expect(sunState(0.95).hours).toBe(720);
  });
});

describe('apart: harmonic analysis of 2025', () => {
  const values = year.values.map((v) => (v === null ? null : v / 1000));
  const fit = analyse(
    values,
    Date.parse(year.start),
    year.stepMinutes,
    FIT.map((r) => r[0]),
  );

  it('the precomputed fit is what analyse() gives on public/data/sf-year.json', () => {
    expect(Date.parse(year.start)).toBe(RECORD.start);
    expect(values.length).toBe(RECORD.hours);
    expect(fit.z0).toBeCloseTo(FIT_Z0, 4);
    expect(Math.abs(fit.rms - FIT_RMS)).toBeLessThan(0.0005);
    for (const [name, H, kappa] of FIT) {
      const got = fit.constituents.find((c) => c.name === name)!;
      expect(Math.abs(got.amplitude - H), name).toBeLessThan(0.00006);
      if (H > 0.001) expect(dPhase(got.phase, kappa), name).toBeLessThan(0.06);
    }
    expect(FIT.map((r) => r[0])).not.toContain('SA');
    expect(FIT.map((r) => r[0])).not.toContain('SSA');
  });

  it('the rows are the eight largest, and the big ones land within 1.5 cm and 3° of NOAA', () => {
    expect([...ROWS]).toEqual(FIT.slice(0, 8).map((r) => r[0]));
    for (const n of ['M2', 'K1', 'O1', 'S2', 'N2', 'P1']) {
      const ours = FIT.find((r) => r[0] === n)!;
      const noaa = station.constituents.find((c) => c.name === n)!;
      expect(Math.abs(ours[1] - noaa.amplitude), n).toBeLessThan(0.015);
      expect(dPhase(ours[2], noaa.phase), n).toBeLessThan(3);
    }
  });

  it('the largest hourly residual is the stated surge, in the December window', () => {
    const p = prepare({
      id: 'fit',
      z0: FIT_Z0,
      constituents: FIT.map(([name, amplitude, phase]) => ({ name, amplitude, phase, speed: 0 })),
    });
    let best = { r: -Infinity, h: 0 };
    values.forEach((v, h) => {
      if (v === null) return;
      const r = v - predict(p, RECORD.start + h * 3600e3);
      if (r > best.r) best = { r, h };
    });
    expect(best.h).toBe(SURGE.hours);
    expect(best.r).toBeCloseTo(SURGE.metres, 2);
    expect(SURGE.hours).toBeGreaterThan(WINDOW.from);
    expect(new Date(RECORD.start + WINDOW.from * 3600e3).toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });

  it('beats run in order', () => {
    const s = apartState(0.5);
    expect(s.zoom).toBe(1);
    expect(s.seen[0]).toBe(1);
    expect(apartState(0.9).table).toBe(1);
    expect(readouts('apart', 0.6).some((r) => r.value.startsWith('0.568 m'))).toBe(true);
  });
});
