// Astronomical arguments for tide prediction (Schureman 1958, SP-98; mean elements from Meeus). Pure. Degrees.
// The spanning set for equilibrium arguments is (τ, s, h, p, N, p′, 90°), with τ = T + h − s the mean lunar time
// (T = hour angle of the mean Sun at Greenwich).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const mod360 = (x: number) => ((x % 360) + 360) % 360;
const poly = (c: readonly number[], T: number) => c.reduce((acc, k, i) => acc + k * T ** i, 0);

/** Mean elements as polynomials in Julian centuries from J2000 (degrees). */
const S = [218.3164591, 481267.88134236, -0.0013268, 1 / 538841, -1 / 65194000]; // Moon's mean longitude
const H = [280.46645, 36000.7697489, 0.00030322222, 0.00000002, -0.00000000654]; // Sun's mean longitude
const P = [83.353243, 4069.0137111, -0.0103238, -1 / 80053, 1 / 18999000]; // Lunar perigee
const N = [125.04452, -1934.136261, 0.0020708, 1 / 450000]; // Longitude of the Moon's ascending node
const PP = [282.93734098, 1.71945766667, 0.00045688888, -0.000000017778, -0.0000000003334]; // Solar perigee
const OMEGA = [23.43929111, -46.815 / 3600, -0.00059 / 3600, 0.001813 / 3600]; // Obliquity of the ecliptic
const INC = 5.145; // Inclination of the Moon's orbit to the ecliptic

export interface Astro {
  tau: number;
  s: number;
  h: number;
  p: number;
  N: number;
  pp: number;
  /** Obliquity ω, Moon's inclination i, and Schureman's I, ξ, ν, ν′, 2ν″, P (all degrees). */
  omega: number;
  i: number;
  I: number;
  xi: number;
  nu: number;
  nup: number;
  nupp: number;
  P: number;
}

/** Julian Day (UT) of a JS timestamp in ms. */
export function julianDay(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

/** Speeds (degrees per hour) of the spanning set, from the polynomials at J2000. */
export const SPEED = {
  s: S[1]! / (36525 * 24),
  h: H[1]! / (36525 * 24),
  p: P[1]! / (36525 * 24),
  N: N[1]! / (36525 * 24),
  pp: PP[1]! / (36525 * 24),
  get tau() {
    return 15 + this.h - this.s;
  },
};

export function astro(ms: number, out?: Astro): Astro {
  const jd = julianDay(ms);
  const T = (jd - 2451545.0) / 36525;
  const s = mod360(poly(S, T));
  const h = mod360(poly(H, T));
  const p = mod360(poly(P, T));
  const n = mod360(poly(N, T));
  const pp = mod360(poly(PP, T));
  const omega = poly(OMEGA, T);
  const hour = (jd - Math.floor(jd)) * 360; // 180° at 0h UT: hour angle of the mean Sun
  const tau = mod360(hour + h - s);

  // Schureman's I, ξ, ν (equations for the Moon's orbit relative to the equator).
  const Nr = n * D2R;
  const ir = INC * D2R;
  const wr = omega * D2R;
  const cosI = Math.cos(ir) * Math.cos(wr) - Math.sin(ir) * Math.sin(wr) * Math.cos(Nr);
  const I = Math.acos(cosI);
  const e1 = Math.atan((Math.cos(0.5 * (wr - ir)) / Math.cos(0.5 * (wr + ir))) * Math.tan(0.5 * Nr)) - 0.5 * Nr;
  const e2 = Math.atan((Math.sin(0.5 * (wr - ir)) / Math.sin(0.5 * (wr + ir))) * Math.tan(0.5 * Nr)) - 0.5 * Nr;
  const xi = -(e1 + e2);
  const nu = e1 - e2;
  // ν′ and 2ν″ (Schureman 224, 232) with the solar coefficients 0.3347 and 0.0727.
  const nup = Math.atan((Math.sin(2 * I) * Math.sin(nu)) / (Math.sin(2 * I) * Math.cos(nu) + 0.3347));
  const nupp = 0.5 * Math.atan((Math.sin(I) ** 2 * Math.sin(2 * nu)) / (Math.sin(I) ** 2 * Math.cos(2 * nu) + 0.0727));
  const o = out ?? ({} as Astro);
  o.tau = tau;
  o.s = s;
  o.h = h;
  o.p = p;
  o.N = n;
  o.pp = pp;
  o.omega = omega;
  o.i = INC;
  o.I = I * R2D;
  o.xi = xi * R2D;
  o.nu = nu * R2D;
  o.nup = nup * R2D;
  o.nupp = nupp * R2D;
  o.P = mod360(p - xi * R2D);
  return o;
}

export { D2R, R2D, mod360 };
