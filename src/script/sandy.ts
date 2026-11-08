// Stage 12 · When the sea disagrees (HANDOFF §7 row 12). Pure: shared by the scene, the narration and the HUD.
//
// The Battery, New York (NOAA 8518750), 28–31 October 2012. The prediction is our harmonic sum with NOAA's constants
// for the Battery (within 1 cm of NOAA's own 2012 prediction in public/data/sandy.json, tested); the observation is
// NOAA's verified six-minute record. Their difference is the storm surge: the weather. The scene shows the harbor's
// water at the predicted tide and adds the surge at the Battery to every level (the coast's levelOffset uniform).

import { prepare, predict } from '../tides/predict.ts';
import { linear, ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

type Cons = readonly (readonly [name: string, amplitude: number, phase: number])[];

/** NOAA CO-OPS harmonic constants for The Battery (amplitude m, Greenwich phase lag °); MSL is 0.783 m above MLLW. */
const BATTERY_CONS: Cons = [['M2', 0.671, 18.2], ['S2', 0.128, 42.9], ['N2', 0.156, 0.5], ['K1', 0.103, 178.5], ['M4', 0.024, 264.1], ['O1', 0.051, 176.3], ['M6', 0.023, 150.4], ['MK3', 0.008, 69.5], ['S4', 0.011, 20.8], ['MN4', 0.011, 265.9], ['NU2', 0.026, 359.7], ['S6', 0.001, 272], ['MU2', 0.023, 10], ['2N2', 0.022, 347.7], ['OO1', 0.003, 209.5], ['LAM2', 0.008, 10.5], ['S1', 0.013, 132.1], ['M1', 0.004, 247.4], ['J1', 0.004, 196.6], ['SSA', 0.032, 55.3], ['SA', 0.094, 144.6], ['RHO', 0.002, 143.9], ['Q1', 0.011, 196.6], ['T2', 0.012, 32.4], ['R2', 0.002, 299.9], ['2Q1', 0.004, 234.6], ['P1', 0.033, 178.8], ['2SM2', 0.002, 357.9], ['M3', 0.01, 66.1], ['L2', 0.023, 21], ['2MK3', 0.006, 44.7], ['K2', 0.036, 44.5], ['M8', 0.002, 332.2], ['MS4', 0.015, 258.9]];

export const BATTERY = {
  id: '8518750',
  name: 'The Battery',
  lat: 40.700554,
  lng: -74.01417,
  prepared: prepare({ id: '8518750', z0: 0.783, constituents: BATTERY_CONS.map(([name, amplitude, phase]) => ({ name, amplitude, phase, speed: 0 })) }),
} as const;

/** Vertical exaggeration of relief and water in the scene (stated in the note). */
export const EXAGGERATION = 3;

/** Observed series: 28 Oct 2012 00:00 EDT (04:00 UTC), every 6 minutes, mm above MLLW. */
export const OBS_START = Date.UTC(2012, 9, 28, 4);
export const STEP_MINUTES = 6;
export const OBS_MM: readonly number[] = [
    709, 691, 673, 658, 646, 639, 616, 601, 584, 570, 552, 541, 530, 530, 529, 521, 519, 524, 528, 527, 529, 532, 550, 580,
    607, 626, 644, 665, 690, 725, 758, 795, 836, 873, 915, 953, 1002, 1045, 1094, 1139, 1185, 1224, 1262, 1298, 1336, 1376, 1420, 1461,
    1498, 1529, 1558, 1598, 1635, 1672, 1703, 1730, 1754, 1777, 1809, 1833, 1851, 1863, 1880, 1906, 1932, 1936, 1942, 1956, 1955, 1977, 1989, 1999,
    2011, 2020, 2031, 2048, 2050, 2059, 2068, 2074, 2077, 2080, 2075, 2074, 2081, 2081, 2057, 2045, 2038, 2026, 2014, 2000, 1984, 1966, 1948, 1914,
    1888, 1870, 1840, 1805, 1784, 1759, 1729, 1702, 1675, 1632, 1594, 1554, 1514, 1473, 1431, 1389, 1357, 1329, 1304, 1273, 1248, 1215, 1189, 1162,
    1134, 1106, 1077, 1045, 1023, 999, 976, 949, 922, 896, 880, 861, 839, 820, 795, 769, 744, 730, 715, 701, 690, 684, 682, 677,
    674, 672, 679, 694, 713, 735, 770, 802, 837, 868, 896, 929, 965, 989, 1015, 1044, 1080, 1110, 1131, 1172, 1204, 1240, 1272, 1310,
    1344, 1386, 1434, 1478, 1524, 1562, 1602, 1642, 1678, 1713, 1749, 1782, 1806, 1818, 1852, 1895, 1925, 1949, 1964, 1979, 2005, 2026, 2066, 2092,
    2110, 2146, 2166, 2199, 2217, 2228, 2237, 2248, 2254, 2263, 2260, 2273, 2276, 2278, 2278, 2272, 2275, 2262, 2255, 2243, 2228, 2207, 2184, 2160,
    2135, 2108, 2082, 2062, 2037, 2014, 1986, 1954, 1924, 1888, 1849, 1825, 1798, 1769, 1731, 1694, 1662, 1630, 1601, 1570, 1534, 1502, 1472, 1445,
    1416, 1383, 1352, 1319, 1297, 1274, 1257, 1236, 1211, 1187, 1175, 1167, 1151, 1136, 1117, 1103, 1090, 1075, 1061, 1041, 1022, 1019, 1008, 1005,
    994, 980, 971, 965, 967, 970, 983, 995, 1004, 1013, 1026, 1040, 1055, 1080, 1111, 1147, 1175, 1204, 1239, 1274, 1319, 1360, 1392, 1420,
    1454, 1487, 1519, 1557, 1597, 1632, 1675, 1727, 1777, 1818, 1863, 1903, 1944, 1985, 2029, 2078, 2126, 2194, 2233, 2265, 2298, 2328, 2355, 2376,
    2404, 2433, 2469, 2486, 2503, 2544, 2576, 2610, 2627, 2642, 2645, 2650, 2670, 2678, 2670, 2684, 2698, 2708, 2713, 2727, 2727, 2726, 2726, 2716,
    2705, 2677, 2649, 2642, 2629, 2618, 2596, 2580, 2563, 2544, 2523, 2496, 2479, 2447, 2412, 2394, 2364, 2328, 2295, 2256, 2222, 2183, 2141, 2106,
    2083, 2048, 2024, 2000, 1981, 1947, 1920, 1896, 1878, 1853, 1818, 1804, 1781, 1751, 1726, 1706, 1680, 1666, 1652, 1638, 1628, 1618, 1615, 1616,
    1618, 1621, 1625, 1653, 1668, 1698, 1720, 1751, 1780, 1834, 1880, 1921, 1968, 1999, 2033, 2060, 2108, 2159, 2200, 2240, 2295, 2330, 2385, 2436,
    2475, 2521, 2547, 2582, 2614, 2660, 2702, 2741, 2783, 2833, 2875, 2922, 2966, 3002, 3066, 3115, 3152, 3203, 3254, 3296, 3356, 3413, 3469, 3518,
    3583, 3663, 3730, 3805, 3869, 3935, 3991, 4024, 4056, 4072, 4093, 4118, 4136, 4153, 4178, 4211, 4233, 4253, 4263, 4275, 4279, 4281, 4284, 4254,
    4233, 4206, 4179, 4137, 4105, 4056, 4009, 3967, 3914, 3855, 3784, 3724, 3660, 3581, 3491, 3404, 3324, 3229, 3130, 3026, 2940, 2843, 2748, 2655,
    2571, 2475, 2394, 2335, 2284, 2215, 2173, 2115, 2065, 2013, 1970, 1926, 1885, 1841, 1800, 1774, 1735, 1698, 1632, 1586, 1547, 1507, 1463, 1424,
    1382, 1345, 1313, 1281, 1243, 1207, 1180, 1156, 1144, 1123, 1107, 1100, 1099, 1108, 1118, 1131, 1156, 1179, 1217, 1234, 1261, 1281, 1312, 1343,
    1380, 1421, 1465, 1514, 1563, 1610, 1659, 1698, 1740, 1790, 1828, 1863, 1893, 1912, 1950, 1981, 1993, 2017, 2041, 2057, 2073, 2092, 2111, 2126,
    2146, 2156, 2161, 2161, 2163, 2169, 2169, 2178, 2180, 2180, 2183, 2181, 2179, 2186, 2197, 2220, 2232, 2236, 2227, 2213, 2206, 2212, 2212, 2211,
    2211, 2225, 2242, 2250, 2258, 2269, 2280, 2277, 2263, 2255, 2238, 2210, 2175, 2138, 2097, 2071, 2040, 2016, 1989, 1953, 1913, 1883, 1850, 1823,
    1778, 1720, 1672, 1612, 1573, 1531, 1492, 1444, 1400, 1353, 1307, 1252, 1207, 1162, 1123, 1086, 1044, 1017, 984, 942, 902, 863, 830, 796,
    760, 727, 703, 673, 643, 609, 576, 557, 538, 516, 503, 490, 481, 476, 469, 464, 460, 459, 463, 466, 465, 479, 499, 518,
    549, 587, 616, 649, 689, 734, 785, 833, 880, 928, 976, 1026, 1080, 1131, 1189, 1244, 1295, 1342, 1387, 1436, 1488, 1532, 1565, 1603,
    1640, 1676, 1700, 1733, 1756, 1776, 1790, 1807, 1824, 1828, 1836, 1837, 1846, 1853, 1855, 1854, 1851, 1851, 1852, 1859, 1859, 1858, 1858, 1850,
    1844, 1833, 1828, 1821, 1808, 1794, 1779, 1761, 1739, 1717, 1697, 1677, 1650, 1623, 1596, 1564, 1533, 1499, 1463, 1429, 1401, 1372, 1339, 1304,
    1278,
];

export const OBS_END = OBS_START + (OBS_MM.length - 1) * STEP_MINUTES * 60e3;

/** Observed level at the Battery (m above MLLW), linear between samples, held at the ends. */
export function observedAt(ms: number): number {
  const f = Math.min(Math.max((ms - OBS_START) / (STEP_MINUTES * 60e3), 0), OBS_MM.length - 1);
  const i = Math.min(Math.floor(f), OBS_MM.length - 2);
  const t = f - i;
  return (OBS_MM[i]! * (1 - t) + OBS_MM[i + 1]! * t) / 1000;
}

/** Predicted tide at the Battery (m above MLLW): the Moon and the Sun, nothing else. */
export const predictedAt = (ms: number) => predict(BATTERY.prepared, ms);

/** Storm surge (m): observed minus predicted. */
export const surgeAt = (ms: number) => observedAt(ms) - predictedAt(ms);

/** The highest water of the record, and the prediction for that moment. */
export const PEAK = (() => {
  let i = 0;
  OBS_MM.forEach((v, k) => {
    if (v > OBS_MM[i]!) i = k;
  });
  const ms = OBS_START + i * STEP_MINUTES * 60e3;
  const observed = OBS_MM[i]! / 1000;
  const predicted = predictedAt(ms);
  return { ms, observed, predicted, surge: observed - predicted };
})();

/** The predicted high water that evening (the tide tables' number). */
export const PREDICTED_HIGH = (() => {
  let best = { ms: 0, level: -Infinity };
  for (let t = PEAK.ms - 3 * 3600e3; t <= PEAK.ms + 3 * 3600e3; t += 60e3) {
    const v = predictedAt(t);
    if (v > best.level) best = { ms: t, level: v };
  }
  return best;
})();

/** The stage's clock: hours after 8:00 AM EDT on 29 October 2012. */
export const DAY_START = Date.UTC(2012, 9, 29, 12);

/**
 * Calm, then the tide tables' day to the evening; the clock nearly stops while the real water is revealed, runs on to
 * the peak, lingers there, and the water falls back through the night.
 */
export const dayHours = track(
  [
    [0, 0],
    [0.12, 0.8],
    [0.3, 10.5],
    [0.4, 10.75],
    [0.58, (PEAK.ms - DAY_START) / 3600e3],
    [0.72, (PEAK.ms - DAY_START) / 3600e3 + 0.5],
    [0.9, 20],
    [1, 21],
  ],
  linear,
);

export function sandyState(local: number) {
  const hours = dayHours(local);
  const ms = DAY_START + hours * 3600e3;
  const predicted = predictedAt(ms);
  const observed = observedAt(ms);
  /** 0 = the water shows the prediction only, 1 = the real water (prediction + surge). */
  const real = ramp(local, 0.31, 0.4);
  return {
    hours,
    ms,
    predicted,
    observed,
    surge: observed - predicted,
    real,
    /** Level shown at the Battery (m above MLLW). */
    shown: predicted + real * (observed - predicted),
    /** The predicted shoreline and the surge water marked on the map. */
    mark: ramp(local, 0.36, 0.44) * (1 - ramp(local, 0.93, 1)),
    /** The HUD chart (prediction from the start; the observation once revealed). */
    card: windowed(local, 0.14, 1.01, 0.04, 0),
  };
}

const EDT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const EDT_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

/** "Mon, Oct 29" and "9:24 PM" at New York (EDT in October 2012). */
export function eastern(ms: number): { day: string; time: string } {
  return { day: EDT.format(ms), time: EDT_TIME.format(ms) };
}

const m = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} m`;

export const sandy = registerStage('sandy', {
  note: `Predicted tide from NOAA’s constants for the Battery; observed water from NOAA’s Battery gauge, 29–30 October 2012; the gap (the surge) is added across the harbor. About 21 hours over this stage. Relief and water ×${EXAGGERATION}; waves illustrative.`,
  readouts(local) {
    const s = sandyState(local);
    const t = eastern(s.ms);
    const rows: Readout[] = [
      { label: t.day, value: `${t.time} EDT`, tone: 'plain' },
      { label: 'Predicted', value: m(s.predicted), tone: 'warm' },
    ];
    if (s.real > 0.5) {
      rows.push({ label: 'Observed', value: m(s.observed), tone: 'b' });
      rows.push({ label: 'Surge', value: `${s.surge >= 0 ? '+' : ''}${m(s.surge)}`, tone: 'a' });
    }
    return rows;
  },
});
