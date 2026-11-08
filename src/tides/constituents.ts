// NOAA's 37 standard tidal constituents: equilibrium arguments (extended Doodson numbers on the spanning set
// τ, s, h, p, N, p′, 90°), node factors f and phase corrections u (Schureman 1958, SP-98). Pure.

import { D2R, SPEED, type Astro } from './astro.ts';

/** Coefficients on [τ, s, h, p, N, p′, 90°]. */
export type Coef = readonly [number, number, number, number, number, number, number];

export type Family = 'long' | 'diurnal' | 'semidiurnal' | 'terdiurnal' | 'shallow';

export interface Constituent {
  name: string;
  coef: Coef;
  family: Family;
  /** Phase correction u (degrees). */
  u(a: Astro): number;
  /** Node factor f. */
  f(a: Astro): number;
  /** One line: what produces this rhythm. */
  about: string;
}

const sin = (d: number) => Math.sin(d * D2R);
const cos = (d: number) => Math.cos(d * D2R);
const tan = (d: number) => Math.tan(d * D2R);

// ── Node factors (Schureman table 2 and equations 73–235) ──────────────────────────────────────────────────
const fM2 = (a: Astro) => cos(a.I / 2) ** 4 / (cos(a.omega / 2) ** 4 * cos(a.i / 2) ** 4);
const fO1 = (a: Astro) => (sin(a.I) * cos(a.I / 2) ** 2) / (sin(a.omega) * cos(a.omega / 2) ** 2 * cos(a.i / 2) ** 4);
const fJ1 = (a: Astro) => sin(2 * a.I) / (sin(2 * a.omega) * (1 - 1.5 * sin(a.i) ** 2));
const fOO1 = (a: Astro) => (sin(a.I) * sin(a.I / 2) ** 2) / (sin(a.omega) * sin(a.omega / 2) ** 2 * cos(a.i / 2) ** 4);
const fMm = (a: Astro) => (2 / 3 - sin(a.I) ** 2) / ((2 / 3 - sin(a.omega) ** 2) * (1 - 1.5 * sin(a.i) ** 2));
const fMf = (a: Astro) => sin(a.I) ** 2 / (sin(a.omega) ** 2 * cos(a.i / 2) ** 4);
const fK1 = (a: Astro) =>
  Math.sqrt(0.2523 * sin(2 * a.I) ** 2 + 0.1689 * sin(2 * a.I) * cos(a.nu) + 0.0283) /
  (0.5023 * sin(2 * a.omega) * (1 - 1.5 * sin(a.i) ** 2) + 0.1681);
const fK2 = (a: Astro) =>
  Math.sqrt(0.2523 * sin(a.I) ** 4 + 0.0367 * sin(a.I) ** 2 * cos(2 * a.nu) + 0.0013) /
  (0.5023 * sin(a.omega) ** 2 * (1 - 1.5 * sin(a.i) ** 2) + 0.0365);
const fL2 = (a: Astro) => fM2(a) * Math.sqrt(1 - 12 * tan(a.I / 2) ** 2 * cos(2 * a.P) + 36 * tan(a.I / 2) ** 4);
const one = () => 1;

const uM2 = (a: Astro) => 2 * a.xi - 2 * a.nu;
const uO1 = (a: Astro) => 2 * a.xi - a.nu;
const uJ1 = (a: Astro) => -a.nu;
const uOO1 = (a: Astro) => -2 * a.xi - a.nu;
const uMf = (a: Astro) => -2 * a.xi;
const uK1 = (a: Astro) => -a.nup;
const uK2 = (a: Astro) => -2 * a.nupp;
const zero = () => 0;

type Def = [name: string, coef: Coef, family: Family, u: (a: Astro) => number, f: (a: Astro) => number, about: string];

const BASE: Def[] = [
  ['SA', [0, 0, 1, 0, 0, 0, 0], 'long', zero, one, 'The yearly cycle: seasons warm, expand and push the sea.'],
  ['SSA', [0, 0, 2, 0, 0, 0, 0], 'long', zero, one, 'The half-yearly cycle of the Sun’s declination.'],
  ['MM', [0, 1, 0, -1, 0, 0, 0], 'long', zero, fMm, 'The Moon’s distance over its 27.6-day orbit.'],
  ['MF', [0, 2, 0, 0, 0, 0, 0], 'long', uMf, fMf, 'The Moon’s declination, twice a month.'],
  ['2Q1', [1, -3, 0, 2, 0, 0, 1], 'diurnal', uO1, fO1, 'A minor diurnal term from the Moon’s elliptical orbit.'],
  ['Q1', [1, -2, 0, 1, 0, 0, 1], 'diurnal', uO1, fO1, 'Larger elliptical lunar diurnal.'],
  ['RHO', [1, -2, 2, -1, 0, 0, 1], 'diurnal', uO1, fO1, 'Evectional lunar diurnal: the Sun stretching the Moon’s orbit.'],
  ['O1', [1, -1, 0, 0, 0, 0, 1], 'diurnal', uO1, fO1, 'Lunar diurnal: the Moon’s tilt makes one daily high stronger.'],
  ['P1', [1, 1, -2, 0, 0, 0, 1], 'diurnal', zero, one, 'Solar diurnal: the Sun’s tilt.'],
  ['S1', [1, 1, -1, 0, 0, 0, 0], 'diurnal', zero, one, 'Solar day: mostly weather and sea breezes, not gravity.'],
  ['K1', [1, 1, 0, 0, 0, 0, -1], 'diurnal', uK1, fK1, 'Lunisolar diurnal: Moon and Sun both off the equator.'],
  ['J1', [1, 2, 0, -1, 0, 0, -1], 'diurnal', uJ1, fJ1, 'Smaller elliptical lunar diurnal.'],
  ['OO1', [1, 3, 0, 0, 0, 0, -1], 'diurnal', uOO1, fOO1, 'Lunar diurnal, second order.'],
  ['2N2', [2, -2, 0, 2, 0, 0, 0], 'semidiurnal', uM2, fM2, 'Second-order elliptical lunar.'],
  ['MU2', [2, -2, 2, 0, 0, 0, 0], 'semidiurnal', uM2, fM2, 'Variational: the Sun distorting the Moon’s orbit.'],
  ['N2', [2, -1, 0, 1, 0, 0, 0], 'semidiurnal', uM2, fM2, 'Larger elliptical lunar: the Moon nearer or farther.'],
  ['NU2', [2, -1, 2, -1, 0, 0, 0], 'semidiurnal', uM2, fM2, 'Larger evectional lunar.'],
  ['M2', [2, 0, 0, 0, 0, 0, 0], 'semidiurnal', uM2, fM2, 'Principal lunar: the Moon’s two bulges, twice per lunar day.'],
  ['LAM2', [2, 1, -2, 1, 0, 0, 2], 'semidiurnal', uM2, fM2, 'Smaller evectional lunar.'],
  // NOAA's predictions match with M2's u and Schureman's f for L2 (dropping his R term halves the residual at
  // large-tide ports; DECISIONS.md).
  ['L2', [2, 1, 0, -1, 0, 0, 2], 'semidiurnal', uM2, fL2, 'Smaller elliptical lunar.'],
  ['T2', [2, 2, -3, 0, 0, 1, 0], 'semidiurnal', zero, one, 'Larger elliptical solar: Earth nearer the Sun in January.'],
  ['S2', [2, 2, -2, 0, 0, 0, 0], 'semidiurnal', zero, one, 'Principal solar: the Sun’s two bulges, twice a day.'],
  ['R2', [2, 2, -1, 0, 0, -1, 2], 'semidiurnal', zero, one, 'Smaller elliptical solar.'],
  ['K2', [2, 2, 0, 0, 0, 0, 0], 'semidiurnal', uK2, fK2, 'Lunisolar semidiurnal: declinations of Moon and Sun.'],
  ['M3', [3, 0, 0, 0, 0, 0, 0], 'terdiurnal', (a) => 1.5 * uM2(a), (a) => fM2(a) ** 1.5, 'Lunar terdiurnal: the Moon’s third-order pull.'],
];

const BY_BASE = new Map(BASE.map((d) => [d[0], d]));

/** Shallow-water and compound constituents: sums of base constituents (Σ kᵢ). */
const COMPOUND: [name: string, members: [string, number][], family: Family, about: string][] = [
  // NOAA's M1 (14.4966939°/h) has the speed of N2 − O1, and matches NOAA's predictions only as that compound
  // (NO1); Schureman's own M1 node factors leave a 1–2 cm diurnal residual (DECISIONS.md).
  ['M1', [['N2', 1], ['O1', -1]], 'diurnal', 'Smaller lunar diurnal (NOAA’s M1, equivalent to N2 − O1).'],
  ['MSF', [['S2', 1], ['M2', -1]], 'long', 'Spring–neap modulation of mean level: S2 beating against M2.'],
  ['2SM2', [['S2', 2], ['M2', -1]], 'shallow', 'Shallow-water interaction of S2 and M2.'],
  ['MK3', [['M2', 1], ['K1', 1]], 'shallow', 'Shallow-water interaction of M2 and K1.'],
  ['2MK3', [['M2', 2], ['K1', -1]], 'shallow', 'Shallow-water interaction of M2 and K1.'],
  ['MN4', [['M2', 1], ['N2', 1]], 'shallow', 'Shallow-water interaction of M2 and N2.'],
  ['M4', [['M2', 2]], 'shallow', 'Shallow-water overtide of M2: friction in shallow water distorts the wave.'],
  ['MS4', [['M2', 1], ['S2', 1]], 'shallow', 'Shallow-water interaction of M2 and S2.'],
  ['S4', [['S2', 2]], 'shallow', 'Shallow-water overtide of S2.'],
  ['M6', [['M2', 3]], 'shallow', 'Shallow-water overtide of M2, third harmonic.'],
  ['S6', [['S2', 3]], 'shallow', 'Shallow-water overtide of S2, third harmonic.'],
  ['M8', [['M2', 4]], 'shallow', 'Shallow-water overtide of M2, fourth harmonic.'],
];

function make(d: Def): Constituent {
  return { name: d[0], coef: d[1], family: d[2], u: d[3], f: d[4], about: d[5] };
}

function compound(name: string, members: [string, number][], family: Family, about: string): Constituent {
  const parts = members.map(([n, k]) => [make(BY_BASE.get(n)!), k] as const);
  const coef = [0, 0, 0, 0, 0, 0, 0] as number[];
  for (const [c, k] of parts) for (let j = 0; j < 7; j++) coef[j]! += k * c.coef[j]!;
  return {
    name,
    coef: coef as unknown as Coef,
    family,
    about,
    u: (a) => parts.reduce((acc, [c, k]) => acc + k * c.u(a), 0),
    f: (a) => parts.reduce((acc, [c, k]) => acc * c.f(a) ** Math.abs(k), 1),
  };
}

export const CONSTITUENTS: readonly Constituent[] = [...BASE.map(make), ...COMPOUND.map((c) => compound(...c))];
export const BY_NAME: ReadonlyMap<string, Constituent> = new Map(CONSTITUENTS.map((c) => [c.name, c]));

/** Speed in degrees per hour, from the coefficients and the mean motions. */
export function speed(c: Constituent): number {
  const [kt, ks, kh, kp, kn, kpp] = c.coef;
  return kt * SPEED.tau + ks * SPEED.s + kh * SPEED.h + kp * SPEED.p + kn * SPEED.N + kpp * SPEED.pp;
}

/** Period in hours. */
export function period(c: Constituent): number {
  return 360 / speed(c);
}

/** Equilibrium argument V (degrees) at the astronomical state a. */
export function V(c: Constituent, a: Astro): number {
  const [kt, ks, kh, kp, kn, kpp, k90] = c.coef;
  return kt * a.tau + ks * a.s + kh * a.h + kp * a.p + kn * a.N + kpp * a.pp + k90 * 90;
}
