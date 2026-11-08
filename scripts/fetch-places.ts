// Builds the finale's lookup lists (run after scripts/eot20_tiles.py):
//   node scripts/fetch-places.ts
// 1. public/data/noaa-harcon-stations.json: NOAA CO-OPS's harmonic stations (public domain) as compact rows
//    [id, name, state, lat, lng, live], so finding the nearest station needs no request. live = 1 when NOAA also
//    lists the station as a real-time water-level gauge.
// 2. public/data/places.json: ~300 well-known coastal places for the finale's search box, from Natural Earth
//    10m populated places (public domain), kept when ≤ 20 km from the Natural Earth 10m coastline and when the
//    EOT20 tiles have ocean within 30 km (so every listed place resolves to a tide).
// Downloads go to scripts/cache/ (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeTile, sampleAt, tilesNear, type Eot20Index, type Eot20Tile } from '../src/finale/eot20.ts';

const root = new URL('../', import.meta.url);
const cache = new URL('scripts/cache/naturalearth/', root);
const out = (p: string) => new URL(`public/data/${p}`, root);
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';
const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json';
const COAST_KM = 20;
const TARGET = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function cached(file: string, url: string): Promise<Json> {
  mkdirSync(cache, { recursive: true });
  const path = new URL(file, cache);
  if (!existsSync(path)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ── NOAA harmonic stations ──────────────────────────────────────────────────────────────────────────────────

/** NOAA mixes "San Francisco" and "PORT ALLEN, HANAPEPE BAY": title-case the all-caps ones. */
function tidyName(n: string): string {
  const s = n.trim().replace(/\s+/g, ' ');
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

const harcon = await fetch(`${MDAPI}?type=harcon`).then((r) => r.json());
const wl = await fetch(`${MDAPI}?type=waterlevels`).then((r) => r.json());
const live = new Set<string>(wl.stations.map((s: Json) => s.id));
const stations = (harcon.stations as Json[])
  .map((s) => [
    String(s.id),
    tidyName(String(s.name)),
    String(s.state ?? ''),
    +Number(s.lat).toFixed(5),
    +Number(s.lng).toFixed(5),
    live.has(s.id) ? 1 : 0,
  ])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
writeFileSync(
  out('noaa-harcon-stations.json'),
  JSON.stringify({
    source: 'NOAA CO-OPS Metadata API, stations.json?type=harcon (live flag from type=waterlevels)',
    url: `${MDAPI}?type=harcon`,
    licence: 'US government work, public domain',
    fetched: new Date().toISOString().slice(0, 10),
    fields: ['id', 'name', 'state', 'lat', 'lng', 'live'],
    stations,
  }),
);
console.log(
  `noaa-harcon-stations.json: ${stations.length} stations (${stations.filter((s) => s[5]).length} live gauges)`,
);

// ── Coastline index ─────────────────────────────────────────────────────────────────────────────────────────

const coast = await cached('ne_10m_coastline.geojson', `${NE}/ne_10m_coastline.geojson`);
const CELL = 0.5;
const buckets = new Map<number, number[]>(); // cell → segment indices
const seg: number[] = []; // lat1, lng1, lat2, lng2
const key = (i: number, j: number) => i * 1000 + j;
for (const f of coast.features as Json[]) {
  const lines: number[][][] =
    f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const line of lines)
    for (let k = 1; k < line.length; k++) {
      const [lng1, lat1] = line[k - 1]!;
      const [lng2, lat2] = line[k]!;
      const s = seg.length / 4;
      seg.push(lat1!, lng1!, lat2!, lng2!);
      for (
        let i = Math.floor(Math.min(lat1!, lat2!) / CELL);
        i <= Math.floor(Math.max(lat1!, lat2!) / CELL);
        i++
      )
        for (
          let j = Math.floor(Math.min(lng1!, lng2!) / CELL);
          j <= Math.floor(Math.max(lng1!, lng2!) / CELL);
          j++
        ) {
          const b = buckets.get(key(i, j));
          if (b) b.push(s);
          else buckets.set(key(i, j), [s]);
        }
    }
}

/** Distance from a point to the coastline, km (local equirectangular projection; exact enough below 50 km). */
function coastKm(lat: number, lng: number): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const dLat = 0.3;
  const dLng = Math.min(180, 0.3 / Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  let best = Infinity;
  for (let i = Math.floor((lat - dLat) / CELL); i <= Math.floor((lat + dLat) / CELL); i++)
    for (let j = Math.floor((lng - dLng) / CELL); j <= Math.floor((lng + dLng) / CELL); j++)
      for (const s of buckets.get(key(i, j)) ?? []) {
        const ax = (seg[4 * s + 1]! - lng) * kx;
        const ay = (seg[4 * s]! - lat) * ky;
        const bx = (seg[4 * s + 3]! - lng) * kx;
        const by = (seg[4 * s + 2]! - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
  return best;
}

// ── EOT20 check ─────────────────────────────────────────────────────────────────────────────────────────────

const eotDir = new URL('public/data/eot20/', root);
const index: Eot20Index = JSON.parse(readFileSync(new URL('index.json', eotDir), 'utf8'));
const tiles = new Map<string, Eot20Tile | null>();
const listed = new Set(index.tiles);
const getTile = (n: string) => {
  if (!tiles.has(n))
    tiles.set(n, listed.has(n) ? decodeTile(readFileSync(new URL(`${n}.bin`, eotDir))) : null);
  return tiles.get(n)!;
};
const hasOcean = (lat: number, lng: number) => {
  for (const n of tilesNear(lat, lng, 30)) getTile(n);
  return sampleAt(getTile, lat, lng, { searchKm: 30, only: ['M2'] }) !== null;
};

// ── Places ──────────────────────────────────────────────────────────────────────────────────────────────────

const COUNTRY: Record<string, string> = {
  'United States of America': 'United States',
  'United Republic of Tanzania': 'Tanzania',
  'Democratic Republic of the Congo': 'DR Congo',
  'Republic of the Congo': 'Congo',
};
/** Within 20 km of the sea but in a landlocked country. */
const LANDLOCKED = new Set(['San Marino', 'Vatican', 'Liechtenstein', 'Andorra']);
/** Famous for their tides; kept if Natural Earth has them and they pass the coastal checks. */
const NOTABLE: [string, string][] = [
  ['Saint John', 'Canada'],
  ['Halifax', 'Canada'],
  ['Brest', 'France'],
  ['Bristol', 'United Kingdom'],
  ['Liverpool', 'United Kingdom'],
  ['Anchorage', 'United States'],
  ['Juneau', 'United States'],
  ['Honolulu', 'United States'],
  ['San Francisco', 'United States'],
  ['Broome', 'Australia'],
  ['Darwin', 'Australia'],
  ['Incheon', 'South Korea'],
  ['Bhavnagar', 'India'],
  ['Río Gallegos', 'Argentina'],
  ['Ushuaia', 'Argentina'],
  ['Venice', 'Italy'],
  ['Reykjavík', 'Iceland'],
];

interface Cand {
  name: string;
  country: string;
  lat: number;
  lng: number;
  pop: number;
  capital: boolean;
  km: number;
}

const pp = await cached(
  'ne_10m_populated_places_simple.geojson',
  `${NE}/ne_10m_populated_places_simple.geojson`,
);
const seen = new Set<string>();
const cands: Cand[] = [];
for (const f of pp.features as Json[]) {
  const p = f.properties;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  const country = COUNTRY[p.adm0name] ?? String(p.adm0name);
  const name = String(p.name).replace(/\s+/g, ' ').trim();
  if (LANDLOCKED.has(country)) continue;
  const id = `${name}|${country}`;
  if (seen.has(id)) continue;
  const km = coastKm(lat, lng);
  if (km > COAST_KM || !hasOcean(lat, lng)) continue;
  seen.add(id);
  cands.push({ name, country, lat, lng, pop: Number(p.pop_max) || 0, capital: p.adm0cap === 1, km });
}
cands.sort((a, b) => b.pop - a.pop);
console.log(
  `${pp.features.length} Natural Earth places, ${cands.length} coastal (≤ ${COAST_KM} km, EOT20 ocean ≤ 30 km)`,
);

const chosen = new Set<Cand>();
const perCountry = new Map<string, number>();
const take = (c: Cand) => {
  if (chosen.has(c)) return;
  chosen.add(c);
  perCountry.set(c.country, (perCountry.get(c.country) ?? 0) + 1);
};
// Every coastal country's largest coastal place, every coastal capital, the famous tides; then the largest
// remaining places, at most CAP per country so the list stays worldwide.
for (const c of cands) if (!perCountry.has(c.country) && c.pop >= 50_000) take(c);
for (const c of cands) if (c.capital) take(c);
for (const [n, k] of NOTABLE) {
  const c = cands.find((x) => x.name === n && x.country === k);
  if (c) take(c);
  else console.warn(`notable place not found or not coastal: ${n}, ${k}`);
}
const CAP = 8;
for (const c of cands) {
  if (chosen.size >= TARGET) break;
  if ((perCountry.get(c.country) ?? 0) < (c.country === 'United States' ? 2 * CAP : CAP)) take(c);
}

const places = [...chosen].sort((a, b) => b.pop - a.pop);
writeFileSync(
  out('places.json'),
  JSON.stringify({
    source:
      'Natural Earth 10m populated places (v5.1.2), kept when within 20 km of the Natural Earth 10m coastline and within 30 km of an EOT20 ocean node; ordered by population',
    url: 'https://www.naturalearthdata.com/',
    licence: 'Public domain (Natural Earth)',
    fields: ['name', 'country', 'lat', 'lng'],
    places: places.map((p) => [p.name, p.country, +p.lat.toFixed(4), +p.lng.toFixed(4)]),
  }),
);
console.log(
  `places.json: ${places.length} places in ${new Set(places.map((p) => p.country)).size} countries`,
);
