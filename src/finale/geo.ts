// Small spherical helpers for the finale's data layer. Pure.

/** Mean Earth radius, km (IUGG). */
export const EARTH_KM = 6371.0088;
const D2R = Math.PI / 180;

/** Great-circle distance between two points, km (haversine). */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLng = (lng2 - lng1) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Longitude wrapped into [−180, 180). */
export function wrapLng(lng: number): number {
  if (lng >= -180 && lng < 180) return lng; // exact when already in range
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Latitude clamped into [−90, 90]. */
export function clampLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat));
}

/** Degrees in [0, 360). */
export function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed smallest difference a − b in degrees, in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = mod360(a - b);
  return d > 180 ? d - 360 : d;
}
