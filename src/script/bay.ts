// Stage 4 · Into the bay (HANDOFF §7 row 4). Pure: shared by the scene, the narration and the HUD.
//
// The tide enters through the Golden Gate on 23 December 2026, a king tide. The scene's water is the 35 NOAA stations
// inside the bay, interpolated (src/coast/tidefield.ts); this module carries five of them (NOAA's harmonic constants,
// checked against public/data/bay/sf-stations.json in the tests) to compute what the stage says in numbers: when
// high water reaches each, how far the water rises and falls, and how fast waves and the tide travel at a depth.

import { prepare, predict, type Prepared } from '../tides/predict.ts';
import { linear, ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

type Cons = readonly (readonly [name: string, amplitude: number, phase: number])[];

export interface Gauge {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Mean sea level above MLLW (m). */
  z0: number;
  prepared: Prepared;
}

const gauge = (id: string, name: string, lat: number, lng: number, z0: number, cons: Cons): Gauge => ({
  id,
  name,
  lat,
  lng,
  z0,
  prepared: prepare({ id, z0, constituents: cons.map(([n, amplitude, phase]) => ({ name: n, amplitude, phase, speed: 0 })) }),
});

// NOAA CO-OPS harmonic constants (amplitude m, Greenwich phase lag °), mean sea level above MLLW.
export const GOLDEN_GATE = gauge('9414290', 'Golden Gate', 37.806305, -122.46589, 0.951, [['M2', 0.576, 208.2], ['S2', 0.137, 216.2], ['N2', 0.122, 183.2], ['K1', 0.37, 225.4], ['M4', 0.022, 136.8], ['O1', 0.23, 208.4], ['M6', 0.002, 7.3], ['MK3', 0.018, 124.1], ['MN4', 0.008, 112], ['NU2', 0.026, 189.9], ['MU2', 0.007, 100.2], ['2N2', 0.013, 153.3], ['OO1', 0.012, 260], ['LAM2', 0.007, 214.3], ['S1', 0.007, 282.6], ['M1', 0.011, 237.5], ['J1', 0.019, 244.3], ['SSA', 0.03, 272.3], ['SA', 0.044, 200.2], ['MF', 0.015, 153.1], ['RHO', 0.009, 200], ['Q1', 0.041, 202.4], ['T2', 0.009, 204.6], ['R2', 0.001, 126.8], ['2Q1', 0.006, 208.6], ['P1', 0.114, 222.1], ['2SM2', 0.003, 37.3], ['M3', 0.003, 37.6], ['L2', 0.018, 229.6], ['2MK3', 0.014, 92.2], ['K2', 0.04, 206], ['M8', 0.001, 108.5], ['MS4', 0.01, 149]]);
export const REDWOOD_CITY = gauge('9414523', 'Redwood City', 37.506813, -122.21191, 1.342, [['M2', 0.885, 237.2], ['S2', 0.201, 254.8], ['N2', 0.179, 216.8], ['K1', 0.404, 240], ['M4', 0.02, 316.8], ['O1', 0.238, 224.5], ['M6', 0.01, 43.9], ['MK3', 0.019, 73.1], ['S4', 0.001, 84.6], ['MN4', 0.009, 300.2], ['NU2', 0.041, 216.4], ['S6', 0.001, 344], ['MU2', 0.021, 353.2], ['2N2', 0.018, 199.9], ['OO1', 0.013, 288.1], ['LAM2', 0.018, 215.3], ['S1', 0.016, 223.8], ['M1', 0.016, 272.8], ['J1', 0.02, 276], ['SSA', 0.022, 265.9], ['SA', 0.055, 181.7], ['MF', 0.018, 149.6], ['RHO', 0.009, 222.6], ['Q1', 0.044, 222.1], ['T2', 0.01, 222.6], ['R2', 0.007, 58.6], ['2Q1', 0.006, 217.8], ['P1', 0.126, 239.3], ['2SM2', 0.008, 57.8], ['M3', 0.005, 127.9], ['L2', 0.049, 233.6], ['2MK3', 0.036, 60.2], ['K2', 0.064, 239.1], ['M8', 0.001, 88.5], ['MS4', 0.011, 343.4]]);
export const COYOTE_CREEK = gauge('9414575', 'Coyote Creek', 37.465, -122.023, 1.483, [['M2', 0.953, 250.1], ['S2', 0.213, 273.8], ['N2', 0.191, 232.7], ['K1', 0.397, 246.9], ['M4', 0.049, 1.6], ['O1', 0.225, 232.8], ['M6', 0.021, 44.1], ['MK3', 0.029, 66.8], ['S4', 0.003, 96.4], ['MN4', 0.022, 342.8], ['NU2', 0.046, 227.1], ['S6', 0.001, 322.6], ['MU2', 0.039, 357.2], ['2N2', 0.018, 220.2], ['OO1', 0.011, 307.7], ['LAM2', 0.025, 224.2], ['S1', 0.031, 214.9], ['M1', 0.018, 283.5], ['J1', 0.018, 300.3], ['SSA', 0.03, 272.3], ['SA', 0.044, 200.2], ['RHO', 0.008, 227], ['Q1', 0.041, 235.1], ['T2', 0.012, 229], ['R2', 0.009, 43.9], ['2Q1', 0.004, 246.5], ['P1', 0.122, 246.1], ['2SM2', 0.011, 68.9], ['M3', 0.011, 146.7], ['L2', 0.066, 241.2], ['2MK3', 0.049, 68], ['K2', 0.067, 254.3], ['M8', 0.006, 96.2], ['MS4', 0.028, 24.3]]);
export const PORT_CHICAGO = gauge('9415144', 'Port Chicago', 38.056, -122.0395, 0.781, [['M2', 0.496, 283.2], ['S2', 0.097, 298.1], ['N2', 0.093, 258.8], ['K1', 0.275, 271], ['M4', 0.011, 125], ['O1', 0.158, 255.4], ['M6', 0.011, 250.4], ['MK3', 0.032, 128.8], ['S4', 0.001, 189.7], ['MN4', 0.004, 104], ['NU2', 0.024, 268.3], ['MU2', 0.021, 90.5], ['2N2', 0.008, 236.6], ['OO1', 0.007, 328.5], ['LAM2', 0.013, 279.2], ['S1', 0.013, 298.3], ['M1', 0.008, 350.5], ['J1', 0.004, 349.9], ['MM', 0.016, 34.4], ['SSA', 0.042, 264.8], ['SA', 0.027, 144.6], ['MSF', 0.03, 18.1], ['MF', 0.041, 184.3], ['RHO', 0.008, 247.7], ['Q1', 0.025, 263.4], ['T2', 0.006, 265.1], ['R2', 0.003, 172.7], ['2Q1', 0.003, 264.9], ['P1', 0.079, 269.9], ['2SM2', 0.005, 123], ['M3', 0.007, 210.1], ['L2', 0.033, 298.9], ['2MK3', 0.042, 118.6], ['K2', 0.046, 287.8], ['M8', 0.001, 57.3], ['MS4', 0.008, 150.8]]);
export const MALLARD_ISLAND = gauge('9415112', 'Mallard Island', 38.0433, -121.918, 0.707, [['M2', 0.435, 302.2], ['S2', 0.084, 317.4], ['N2', 0.083, 277.1], ['K1', 0.259, 282.8], ['M4', 0.014, 142.5], ['O1', 0.155, 267.2], ['M6', 0.01, 279.7], ['MK3', 0.028, 156.4], ['MN4', 0.004, 132], ['NU2', 0.022, 288.4], ['MU2', 0.021, 104.9], ['OO1', 0.008, 354.3], ['LAM2', 0.012, 285], ['S1', 0.011, 306.3], ['M1', 0.018, 8], ['SSA', 0.042, 264.8], ['SA', 0.027, 144.6], ['RHO', 0.006, 263.3], ['Q1', 0.025, 277.6], ['T2', 0.005, 298], ['2Q1', 0.005, 215.8], ['P1', 0.069, 283], ['2SM2', 0.005, 117.2], ['M3', 0.004, 216.4], ['L2', 0.027, 300.4], ['2MK3', 0.043, 142.9], ['K2', 0.041, 306.7], ['MS4', 0.008, 158.3]]);

/** Gauges in the order the stage compares them: the mouth, the South Bay, its far end, the delta side. */
export const GAUGES: readonly Gauge[] = [GOLDEN_GATE, REDWOOD_CITY, COYOTE_CREEK, PORT_CHICAGO, MALLARD_ISLAND];

/** Vertical exaggeration of relief and water in the scene (stated in the note). */
export const EXAGGERATION = 3;

/** The stage's clock starts at 6:00 AM PST on 23 December 2026. */
export const DAY_START = Date.UTC(2026, 11, 23, 14);

/** Hours after DAY_START: calm, slow at Ocean Beach, the flood tide over the bay, the ebb on the flats, the next flood. */
export const dayHours = track(
  [
    [0, 0],
    [0.12, 0.5],
    [0.3, 2],
    [0.65, 9],
    [0.86, 14.5],
    [1, 17],
  ],
  linear,
);

/** Predicted level at a gauge (m above MLLW). */
export function levelAt(g: Gauge, ms: number): number {
  return predict(g.prepared, ms);
}

export interface Extreme {
  ms: number;
  level: number;
}

/** High (kind 1) or low (−1) water: the first turning point after `fromMs`, to the minute. */
export function nextExtreme(g: Gauge, fromMs: number, kind: 1 | -1): Extreme {
  const step = 60e3;
  let prev = levelAt(g, fromMs - step);
  let cur = levelAt(g, fromMs);
  for (let t = fromMs; t < fromMs + 30 * 3600e3; t += step) {
    const next = levelAt(g, t + step);
    if (kind === 1 ? cur > prev && cur >= next : cur < prev && cur <= next) return { ms: t, level: cur };
    prev = cur;
    cur = next;
  }
  throw new Error(`no ${kind > 0 ? 'high' : 'low'} water at ${g.name}`);
}

export interface Arrival {
  gauge: Gauge;
  high: Extreme;
  low: Extreme;
  /** High minus the following low (m). */
  range: number;
  /** Minutes after the Golden Gate's high water. */
  lagMin: number;
  /** Range relative to the Golden Gate's. */
  ratio: number;
}

/** The morning's higher high water and the afternoon's lower low at each gauge (computed from the constants). */
export const ARRIVALS: readonly Arrival[] = (() => {
  const from = DAY_START + 2 * 3600e3;
  const rows = GAUGES.map((g) => {
    const high = nextExtreme(g, from, 1);
    const low = nextExtreme(g, high.ms + 3600e3, -1);
    return { gauge: g, high, low, range: high.level - low.level };
  });
  const gg = rows[0]!;
  return rows.map((r) => ({ ...r, lagMin: Math.round((r.high.ms - gg.high.ms) / 60e3), ratio: r.range / gg.range }));
})();

const G = 9.81;

/** Wavelength (m) and phase speed (m/s) of a wave of period T (s) in water of depth h (m): ω² = g k tanh(k h). */
export function dispersion(T: number, h: number): { length: number; speed: number } {
  const w = (2 * Math.PI) / T;
  const k0 = (w * w) / G;
  // Eckart's approximation, then Newton on g k tanh(k h) − ω² = 0.
  let k = k0 / Math.sqrt(Math.tanh(k0 * h));
  for (let i = 0; i < 20; i++) {
    const th = Math.tanh(k * h);
    const f = G * k * th - w * w;
    const df = G * th + G * k * h * (1 - th * th);
    k -= f / df;
  }
  return { length: (2 * Math.PI) / k, speed: w / k };
}

/** Speed (m/s) of a long wave, such as the tide, in water of depth h (m): c = √(g h). */
export const longWaveSpeed = (h: number) => Math.sqrt(G * h);

/** The swell the scene shows at Ocean Beach (period, s), as the coast renderer's swell band. */
export const SWELL_PERIOD = 11;
export const SWELL = [10000, 20, 10, 5].map((h) => ({ depth: h, ...dispersion(SWELL_PERIOD, h) }));

export function bayState(local: number) {
  const hours = dayHours(local);
  const ms = DAY_START + hours * 3600e3;
  return {
    hours,
    ms,
    /** Ocean Beach: waves feel the bottom (HUD card). */
    beach: windowed(local, 0.13, 0.32, 0.03, 0.03),
    /** Tide-field colour and contours on the water. */
    tint: windowed(local, 0.31, 0.72, 0.05, 0.06),
    /** Station markers with live readouts. */
    gauges: ramp(local, 0.3, 0.36),
    /** High-water times and ranges (HUD card). */
    card: windowed(local, 0.36, 1.01, 0.04, 0),
  };
}

const PST = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });

/** Metres with a true minus sign. */
export const metres = (v: number, d = 2) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} m`;

/** "9:47 AM" in Pacific time (PST in December). */
export const pacificTime = (ms: number) => PST.format(ms);

export const bay = registerStage('bay', {
  note: `Water from 35 NOAA tide stations inside the bay, interpolated between them; a king tide on 23 December 2026, about 17 hours over this stage. Relief and water ×${EXAGGERATION}; waves at true scale, a 3.4 m winter swell.`,
  readouts(local) {
    const s = bayState(local);
    const rows: Readout[] = [{ label: 'Dec 23, 2026', value: `${pacificTime(s.ms)} PST`, tone: 'plain' }];
    if (s.beach > 0.5) {
      rows.push({ label: '11 s swell, deep water', value: `${Math.round(SWELL[0]!.length)} m crest to crest`, tone: 'b' });
    } else {
      rows.push({ label: 'Golden Gate', value: metres(levelAt(GOLDEN_GATE, s.ms)), tone: 'b' });
      rows.push({ label: 'Redwood City', value: metres(levelAt(REDWOOD_CITY, s.ms)), tone: 'warm' });
    }
    return rows;
  },
});
