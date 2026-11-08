// Sun position (pure): NOAA's low-precision solar algorithm (≈ 0.01° over 1950–2050), enough for lighting.

const D2R = Math.PI / 180;

export interface SunPosition {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon (no refraction). */
  elevation: number;
}

export function sunPosition(ms: number, lat: number, lng: number): SunPosition {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * D2R) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * D2R) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * D2R) * 0.000289;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * D2R);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * T) * D2R);
  const decl = Math.asin(Math.sin(eps * D2R) * Math.sin(lambda * D2R));
  const y = Math.tan((eps / 2) * D2R) ** 2;
  const eqt =
    (4 / D2R) *
    (y * Math.sin(2 * L0 * D2R) -
      2 * e * Math.sin(M * D2R) +
      4 * e * y * Math.sin(M * D2R) * Math.cos(2 * L0 * D2R) -
      0.5 * y * y * Math.sin(4 * L0 * D2R) -
      1.25 * e * e * Math.sin(2 * M * D2R));
  const minutes = ((ms / 60000) % 1440 + 1440) % 1440;
  const tst = (minutes + eqt + 4 * lng + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * D2R;
  const phi = lat * D2R;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / D2R + 180;
  return { azimuth: (az + 360) % 360, elevation: 90 - zen / D2R };
}

/** Unit vector toward the sun in world axes (x east, y up, z south). */
export function sunVector(p: SunPosition, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const az = p.azimuth * D2R;
  const el = p.elevation * D2R;
  out[0] = Math.cos(el) * Math.sin(az);
  out[1] = Math.sin(el);
  out[2] = -Math.cos(el) * Math.cos(az);
  return out;
}
