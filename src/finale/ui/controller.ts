// The finale's data flow (HANDOFF §10): a place → its tide source (NOAA station ≤ 25 km, else EOT20) → the week's
// predictions and turning points → the terrain around it → the live gauge, if there is one. Each step publishes to
// src/finale/ui/state.ts; a newer choice cancels an older one. Browser-only (fetch, history), no rendering.

import { prepare } from '../../tides/predict.ts';
import { asStationConstants, tideSource, TideSourceError } from '../source.ts';
import { loadPlaces, type Place } from '../places.ts';
import { distanceKm } from '../geo.ts';
import { coastFacts, exaggerationFor, loadTerrain, TerrainError } from '../terrain.ts';
import { fetchObserved, fetchStationTide, toDatum } from '../noaa.ts';
import { tideSeries } from '../extremes.ts';
import { $coastView, $crankMs, $finale, $globe, WEEK_LEAD_MS, WEEK_MS, type PlaceRequest, type Spot } from './state.ts';
import { SUGGESTED } from './suggested.ts';

let seq = 0;
let ctl: AbortController | null = null;

const HOUR = 3600e3;

/** "37.81° N, 122.47° W" */
export function formatLatLng(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;
}

/** Places nearest a point (the bundled list plus the suggestions), for "try instead" buttons. */
export async function nearestPlaces(lat: number, lng: number, n = 3): Promise<Place[]> {
  const list = await loadPlaces().catch(() => [] as Place[]);
  const all: Place[] = [...SUGGESTED.map((s) => ({ name: s.name, country: s.sub, lat: s.lat, lng: s.lng })), ...list];
  return all
    .map((p) => ({ p, d: distanceKm(lat, lng, p.lat, p.lng) }))
    .sort((a, b) => a.d - b.d)
    .filter((x, i, arr) => arr.findIndex((y) => y.p.name === x.p.name) === i)
    .slice(0, n)
    .map((x) => x.p);
}

/** A name for a clicked point: "near Lisbon" when a listed place is within 60 km. */
export async function describePoint(lat: number, lng: number): Promise<PlaceRequest> {
  const [near] = await nearestPlaces(lat, lng, 1);
  const d = near ? distanceKm(lat, lng, near.lat, near.lng) : Infinity;
  return { lat, lng, name: formatLatLng(lat, lng), sub: near && d < 60 ? `near ${near.name}${near.country ? `, ${near.country}` : ''}` : '' };
}

function setUrl(req: PlaceRequest | null) {
  if (typeof history === 'undefined') return;
  const u = new URL(location.href);
  if (req) {
    u.searchParams.set('lat', req.lat.toFixed(4));
    u.searchParams.set('lng', req.lng.toFixed(4));
    if (req.name && !/°/.test(req.name)) u.searchParams.set('name', req.name);
    else u.searchParams.delete('name');
  } else {
    u.searchParams.delete('lat');
    u.searchParams.delete('lng');
    u.searchParams.delete('name');
  }
  history.replaceState(history.state, '', u);
}

export function placeFromUrl(): PlaceRequest | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const lat = Number(q.get('lat'));
  const lng = Number(q.get('lng'));
  if (!q.has('lat') || !q.has('lng') || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return null;
  const name = q.get('name')?.slice(0, 80) ?? '';
  const known = SUGGESTED.find((s) => s.name === name);
  return { lat, lng, name: name || formatLatLng(lat, lng), sub: known?.sub ?? '' };
}

/** Choose a place: everything downstream follows from the stores. */
export async function selectPlace(req: PlaceRequest): Promise<void> {
  const my = ++seq;
  ctl?.abort();
  ctl = new AbortController();
  const signal = ctl.signal;
  const stale = () => my !== seq;
  $crankMs.set(null);
  $coastView.set({ az: 0, el: 0, zoom: 1 });
  setUrl(req);
  $finale.set({ phase: 'locating', target: req, spot: null, step: 'Finding the tide here…', error: null });

  let source;
  try {
    source = await tideSource(req.lat, req.lng, { timeoutMs: 9000 });
  } catch (err) {
    if (stale()) return;
    const inland = err instanceof TideSourceError && err.reason === 'inland';
    const suggestions = await nearestPlaces(req.lat, req.lng);
    if (stale()) return;
    const message = inland
      ? 'That point is inland: there is no sea within 30 km to have a tide. Try a spot on the coast, or one of these:'
      : `No tide data could be loaded (${(err as Error).message}). If you are offline, the places below will work once you are back:`;
    $finale.set({ phase: 'error', target: req, spot: null, step: '', error: { message, suggestions } });
    return;
  }
  if (stale()) return;

  const prepared = prepare(asStationConstants(source));
  const now = Date.now();
  const weekT0 = Math.floor(now / HOUR) * HOUR - WEEK_LEAD_MS;
  const series = tideSeries(prepared, weekT0 - 12 * HOUR, weekT0 + WEEK_MS + 12 * HOUR);
  const key = `${my}:${source.id}:${req.lat.toFixed(4)},${req.lng.toFixed(4)}`;
  const base: Spot = { key, place: req, source, prepared, weekT0, series, terrain: null, terrainError: null, observed: null };
  $finale.set({ phase: 'locating', target: req, spot: base, step: 'Streaming the terrain…', error: null });

  // Terrain around the point; if the box holds no sea (a click far up a valley), centre it on the tide source.
  let terrain: Spot['terrain'] = null;
  let terrainError: string | null = null;
  try {
    let res = await loadTerrain(req.lat, req.lng, { signal });
    let facts = coastFacts(res.hf, req.lat, req.lng);
    if (facts.water < 0.01 && distanceKm(req.lat, req.lng, source.at.lat, source.at.lng) > 3) {
      res = await loadTerrain(source.at.lat, source.at.lng, { signal });
      facts = coastFacts(res.hf, source.at.lat, source.at.lng);
    }
    terrain = { hf: res.hf, facts, exaggeration: exaggerationFor(facts.reliefP99), zoom: res.zoom, tiles: res.tiles };
  } catch (err) {
    if (signal.aborted || stale()) return;
    terrainError = err instanceof TerrainError ? err.message : `terrain failed (${(err as Error).message})`;
  }
  if (stale()) return;
  const spot: Spot = { ...base, terrain, terrainError };
  $finale.set({ phase: 'ready', target: req, spot, step: terrain ? 'Building the coast…' : '', error: null });

  // The live gauge, where NOAA has one: in the same datum as the prediction.
  const st = source.station;
  if (source.kind === 'measured' && st?.live) {
    const [obs, tide] = await Promise.all([fetchObserved(source.id, { hours: 30 }), fetchStationTide(source.id).catch(() => null)]);
    if (stale() || !obs) return;
    const observed = obs.datum === source.datumLabel ? obs : tide ? toDatum(obs, tide.datums, source.datumLabel) : null;
    if (!observed) return;
    const cur = $finale.get();
    if (cur.spot?.key === key) $finale.set({ ...cur, spot: { ...cur.spot, observed } });
  }
}

/** Back to the globe, looking at the place just left. */
export function backToGlobe(): void {
  seq++;
  ctl?.abort();
  const t = $finale.get().target;
  if (t) $globe.set({ lat: Math.max(-70, Math.min(70, t.lat)), lng: t.lng, dist: 3.4 });
  $crankMs.set(null);
  setUrl(null);
  $finale.set({ phase: 'globe', target: null, spot: null, step: '', error: null });
}
