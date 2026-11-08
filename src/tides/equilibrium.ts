// The equilibrium tide (Newton): the shape the ocean would take if it responded instantly to the Moon's and Sun's
// differential pull. Bulge height above the mean surface = (m/M)(R/d)³R (two-thirds of the bulge-to-trough range).
// Real oceans respond dynamically (basins, coasts, resonance), which is why each port needs measured constants. Pure.

const R_EARTH = 6.371e6;
const MOON_EARTH_MASS = 0.0123000371; // IAU
const SUN_EARTH_MASS = 332946.0487; // IAU
const MOON_DIST = 3.844e8; // mean, m
const SUN_DIST = 1.495978707e11; // 1 au, m

/** Height of the equilibrium bulge above the mean surface, m. */
export function bulgeHeight(massRatio: number, distanceM: number, radiusM = R_EARTH): number {
  return massRatio * (radiusM / distanceM) ** 3 * radiusM;
}

export const MOON_BULGE_M = bulgeHeight(MOON_EARTH_MASS, MOON_DIST);
export const SUN_BULGE_M = bulgeHeight(SUN_EARTH_MASS, SUN_DIST);
/** Sun's tidal effect relative to the Moon's (≈ 0.46). */
export const SUN_TO_MOON = SUN_BULGE_M / MOON_BULGE_M;

/** Equilibrium surface height (m) at angle θ from the sub-body point: H(3cos²θ − 1)/2, so +H under the body. */
export function equilibriumHeight(bulgeM: number, thetaRad: number): number {
  return (bulgeM * (3 * Math.cos(thetaRad) ** 2 - 1)) / 2;
}
