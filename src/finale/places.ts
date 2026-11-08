// Geocode-free place search for the finale: a bundled list of coastal places (public/data/places.json, built
// by scripts/fetch-places.ts from Natural Earth, public domain) plus typed coordinates. Pure.

import type { FetchLike } from './eot20.ts';
import { wrapLng } from './geo.ts';

export const PLACES_URL = '/data/places.json';

export interface Place {
  name: string;
  country: string;
  lat: number;
  lng: number;
}

/** places.json: { source, licence, fields: ['name', 'country', 'lat', 'lng'], places: [[…]] }. */
export function parsePlaces(json: unknown): Place[] {
  const rows = (json as { places?: unknown[] })?.places;
  if (!Array.isArray(rows)) throw new Error('places: no list');
  return rows.flatMap((r) => {
    if (!Array.isArray(r)) return [];
    const [name, country, lat, lng] = r as [unknown, unknown, unknown, unknown];
    return typeof name === 'string' && typeof lat === 'number' && typeof lng === 'number'
      ? [{ name, country: String(country ?? ''), lat, lng }]
      : [];
  });
}

let cached: Promise<Place[]> | undefined;

export function loadPlaces(opts: { fetch?: FetchLike; url?: string } = {}): Promise<Place[]> {
  const go = async () => {
    const r = await (opts.fetch ?? ((u: string) => fetch(u)))(opts.url ?? PLACES_URL);
    if (!r.ok) throw new Error(`places: HTTP ${r.status}`);
    return parsePlaces(await r.json());
  };
  if (opts.fetch || opts.url) return go();
  cached ??= go();
  cached.catch(() => (cached = undefined));
  return cached;
}

/** Lowercase, accents stripped, punctuation to spaces: "São Tomé" → "sao tome". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Places matching a query, best first: exact name, name prefix, word prefix, then substring; ties keep the
 * list's order (largest places first). "name, country" narrows by country.
 */
export function searchPlaces(places: readonly Place[], query: string, limit = 8): Place[] {
  const [rawName = '', rawCountry = ''] = query.split(',');
  const q = fold(rawName);
  const qc = fold(rawCountry);
  if (!q) return [];
  const scored: { p: Place; s: number; i: number }[] = [];
  places.forEach((p, i) => {
    const n = fold(p.name);
    if (qc && !fold(p.country).startsWith(qc)) return;
    let s = 0;
    if (n === q) s = 4;
    else if (n.startsWith(q)) s = 3;
    else if (n.split(' ').some((w) => w.startsWith(q))) s = 2;
    else if (n.includes(q)) s = 1;
    else if (!qc && fold(p.country) === q) s = 0.5;
    if (s) scored.push({ p, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.p);
}

/** "37.81, -122.47", "37.81 -122.47" or "37.81N 122.47W" → a point; null if it is not coordinates. */
export function parseLatLng(query: string): { lat: number; lng: number } | null {
  const m = query
    .trim()
    .match(/^([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/);
  if (!m) return null;
  let lat = Number(m[1]);
  let lng = Number(m[3]);
  if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /w/i.test(m[4])) lng = -Math.abs(lng);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return null;
  return { lat, lng: wrapLng(lng) };
}
