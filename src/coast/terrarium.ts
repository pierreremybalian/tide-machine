// AWS Open Data terrain tiles, Terrarium encoding (pure; worker-safe).
// height (m) = R·256 + G + B/256 − 32768. Sources blended by the tile builders include USGS NED/3DEP (land, NAVD88),
// NOAA Coastal Relief Model and ETOPO1/GEBCO (bathymetry), SRTM and others; attribution in DECISIONS.md.

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TILE = 256;

export const terrariumUrl = (z: number, x: number, y: number) =>
  TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Height in metres from one Terrarium pixel. */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** Inverse (for tests and synthetic tiles): the RGB that encodes h to 1/256 m. */
export function terrariumRgb(h: number): [number, number, number] {
  const v = Math.round((h + 32768) * 256);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Decode a whole RGBA tile into heights (m). */
export function decodeTerrarium(rgba: Uint8Array, out = new Float32Array(rgba.length / 4)): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = terrariumHeight(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
  return out;
}

// ── Web Mercator tile maths ──

/** Fractional tile x for a longitude at zoom z. */
export const lngToTileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;

/** Fractional tile y for a latitude at zoom z. */
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export const tileXToLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Ground size of one pixel (m) at a latitude and zoom. */
export const pixelMetres = (lat: number, z: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

/** Smallest zoom whose pixels are at most `metres` at this latitude. */
export function zoomFor(lat: number, metres: number): number {
  for (let z = 0; z <= 15; z++) if (pixelMetres(lat, z) <= metres) return z;
  return 15;
}
