// NOAA CO-OPS client for the finale (US government data, public domain; both APIs send
// Access-Control-Allow-Origin: *). Nearest harmonic station from a bundled list (no request), the station's
// harmonic constants and datums, and the live observed water level. Pure: injectable fetch, no DOM.

import { distanceKm } from './geo.ts';
import type { FetchLike, Harmonic } from './eot20.ts';

export const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';
export const DATAGETTER = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
/** NOAA asks API users to identify themselves with `application=`. */
export const APPLICATION = 'tide-machine_explainer';
/** The bundled copy of NOAA's harmonic-station list (scripts/fetch-places.ts). */
export const STATIONS_URL = '/data/noaa-harcon-stations.json';
export const NOAA_STATIONS_URL = `${MDAPI}/stations.json?type=harcon`;

export interface HarconStation {
  id: string;
  name: string;
  state: string;
  lat: number;
  lng: number;
  /** NOAA lists a real-time water-level gauge here (observations may still be missing). */
  live: boolean;
}

export type Datum = 'MLLW' | 'MSL';

export interface StationTide {
  id: string;
  /** Mean sea level above the datum, m: the constant term for predict(). */
  z0: number;
  datumLabel: Datum;
  /** NOAA's datums relative to station datum, m (empty if NOAA lists none). */
  datums: Record<string, number>;
  constituents: Harmonic[];
}

export interface Observation {
  /** ms UTC */
  t: number;
  /** m above `datum` */
  v: number;
}

export interface Observed {
  station: string;
  datum: Datum;
  points: Observation[];
  latest: Observation;
}

export interface NoaaOptions {
  fetch?: FetchLike;
  /** Per request, ms. Default 10 s. */
  timeoutMs?: number;
}

export class NoaaError extends Error {
  readonly kind: 'network' | 'http' | 'api' | 'data';
  constructor(message: string, kind: NoaaError['kind']) {
    super(message);
    this.name = 'NoaaError';
    this.kind = kind;
  }
}

const defaultFetch: FetchLike = (u, i) => fetch(u, i);

/** GET JSON with a timeout; NOAA reports API errors as HTTP 200 with { error: { message } }. */
async function getJson(url: string, opts: NoaaOptions = {}): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  let r: Response;
  try {
    r = await (opts.fetch ?? defaultFetch)(url, { signal: ctl.signal });
  } catch (err) {
    throw new NoaaError(
      ctl.signal.aborted ? 'NOAA did not answer in time' : `NOAA unreachable (${(err as Error).message})`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new NoaaError(`NOAA HTTP ${r.status}`, 'http');
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    throw new NoaaError('NOAA sent something other than JSON', 'data');
  }
  if (!body || typeof body !== 'object') throw new NoaaError('NOAA sent an empty response', 'data');
  const e = (body as { error?: { message?: string } }).error;
  if (e) throw new NoaaError(e.message ?? 'NOAA API error', 'api');
  return body as Record<string, unknown>;
}

const num = (x: unknown) =>
  typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;

// ── Station list ────────────────────────────────────────────────────────────────────────────────────────────

/** Accepts the bundled compact list ({ fields, stations: [[id, name, state, lat, lng, live]] }) or NOAA's own. */
export function parseStationList(json: unknown): HarconStation[] {
  const j = json as { fields?: string[]; stations?: unknown[] };
  if (!Array.isArray(j?.stations)) throw new NoaaError('station list: no stations', 'data');
  const out: HarconStation[] = [];
  for (const s of j.stations) {
    if (Array.isArray(s)) {
      const [id, name, state, lat, lng, live] = s as [string, string, string, number, number, number];
      out.push({
        id: String(id),
        name: String(name),
        state: String(state ?? ''),
        lat: num(lat),
        lng: num(lng),
        live: live === 1,
      });
    } else if (s && typeof s === 'object') {
      const o = s as Record<string, unknown>;
      out.push({
        id: String(o.id),
        name: String(o.name),
        state: String(o.state ?? ''),
        lat: num(o.lat),
        lng: num(o.lng),
        live: false,
      });
    }
  }
  return out.filter((s) => /^\d{7}$/.test(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

const lists = new Map<string, Promise<HarconStation[]>>();

/** The bundled list (no NOAA request); falls back to NOAA's live list if the bundle is missing. Memoised. */
export function loadStationList(opts: NoaaOptions & { url?: string } = {}): Promise<HarconStation[]> {
  const url = opts.url ?? STATIONS_URL;
  let p = lists.get(url);
  if (!p) {
    p = getJson(url, opts)
      .catch(() => getJson(NOAA_STATIONS_URL, opts))
      .then(parseStationList);
    p.catch(() => lists.delete(url));
    lists.set(url, p);
  }
  return p;
}

/** The harmonic station nearest to (lat, lng), with its great-circle distance. */
export function nearestStation(
  list: readonly HarconStation[],
  lat: number,
  lng: number,
): { station: HarconStation; distanceKm: number } | null {
  let best: { station: HarconStation; distanceKm: number } | null = null;
  for (const s of list) {
    const d = distanceKm(lat, lng, s.lat, s.lng);
    if (!best || d < best.distanceKm) best = { station: s, distanceKm: d };
  }
  return best;
}

// ── Constants and datums ────────────────────────────────────────────────────────────────────────────────────

/** Harmonic constants (m, Greenwich phase lag κ in degrees, degrees per hour); zero amplitudes dropped. */
export async function fetchHarcon(id: string, opts: NoaaOptions = {}): Promise<Harmonic[]> {
  const j = await getJson(`${MDAPI}/stations/${id}/harcon.json?units=metric`, opts);
  return parseHarcon(j);
}

export function parseHarcon(j: unknown): Harmonic[] {
  const list = (j as { HarmonicConstituents?: Record<string, unknown>[] })?.HarmonicConstituents;
  if (!Array.isArray(list) || !list.length)
    throw new NoaaError('NOAA lists no harmonic constants for this station', 'data');
  const out = list
    .map((c) => ({
      name: String(c.name),
      amplitude: num(c.amplitude),
      phase: num(c.phase_GMT),
      speed: num(c.speed),
    }))
    .filter((c) => c.amplitude > 0 && Number.isFinite(c.phase) && Number.isFinite(c.speed));
  if (!out.length) throw new NoaaError('NOAA lists no harmonic constants for this station', 'data');
  return out;
}

/** Datums relative to station datum, m. Missing datums are simply absent (an empty object if none). */
export async function fetchDatums(id: string, opts: NoaaOptions = {}): Promise<Record<string, number>> {
  const j = await getJson(`${MDAPI}/stations/${id}/datums.json?units=metric`, opts);
  return parseDatums(j);
}

export function parseDatums(j: unknown): Record<string, number> {
  const list = (j as { datums?: { name?: unknown; value?: unknown }[] | null })?.datums;
  const out: Record<string, number> = {};
  if (Array.isArray(list))
    for (const d of list)
      if (typeof d.name === 'string' && Number.isFinite(num(d.value))) out[d.name] = num(d.value);
  return out;
}

/** Predict above MLLW when NOAA gives both MSL and MLLW; otherwise relative to mean sea level. */
export function datumFor(datums: Record<string, number>): { z0: number; datumLabel: Datum } {
  const { MSL, MLLW } = datums;
  if (MSL !== undefined && MLLW !== undefined)
    return { z0: Math.round((MSL - MLLW) * 1000) / 1000, datumLabel: 'MLLW' };
  return { z0: 0, datumLabel: 'MSL' };
}

const tides = new Map<string, Promise<StationTide>>();

/** Constants + datums for one station (two requests in parallel; memoised; a missing datum list is not fatal). */
export function fetchStationTide(id: string, opts: NoaaOptions = {}): Promise<StationTide> {
  let p = tides.get(id);
  if (!p) {
    p = Promise.all([
      fetchHarcon(id, opts),
      fetchDatums(id, opts).catch(() => ({}) as Record<string, number>),
    ]).then(([constituents, datums]) => ({ id, ...datumFor(datums), datums, constituents }));
    p.catch(() => tides.delete(id));
    tides.set(id, p);
  }
  return p;
}

// ── Observed water level ────────────────────────────────────────────────────────────────────────────────────

/** NOAA's 'YYYY-MM-DD HH:MM' in GMT → ms UTC. */
export const parseNoaaTime = (t: string) => Date.parse(`${t.replace(' ', 'T')}:00Z`);

export function parseObserved(id: string, datum: Datum, j: unknown): Observed | null {
  const rows = (j as { data?: { t?: string; v?: string }[] })?.data;
  if (!Array.isArray(rows)) return null;
  const points: Observation[] = [];
  for (const r of rows) {
    const t = typeof r.t === 'string' ? parseNoaaTime(r.t) : NaN;
    const v = num(r.v);
    if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  const latest = points[points.length - 1];
  return latest ? { station: id, datum, points, latest } : null;
}

/**
 * Observed water level (6-minute, preliminary) over the last `hours` (or only the latest value with
 * hours = 0), relative to MLLW, or to MSL where the station has no MLLW. null when there is no live data
 * (no gauge, gauge down, network failure): the observed overlay is optional, so this never throws.
 */
export async function fetchObserved(
  id: string,
  opts: NoaaOptions & { hours?: number; datum?: Datum } = {},
): Promise<Observed | null> {
  const hours = opts.hours ?? 24;
  const when = hours > 0 ? `range=${Math.ceil(hours)}` : 'date=latest';
  const datums: Datum[] = opts.datum === 'MSL' ? ['MSL'] : ['MLLW', 'MSL'];
  for (const datum of datums) {
    try {
      const j = await getJson(
        `${DATAGETTER}?product=water_level&${when}&station=${id}&datum=${datum}&time_zone=gmt&units=metric&format=json&application=${APPLICATION}`,
        opts,
      );
      const o = parseObserved(id, datum, j);
      if (o && hours === 0) return { ...o, points: [o.latest] };
      if (o) return o;
    } catch (err) {
      // An API error may mean "no such datum here": try the next one. Anything else: no observations.
      if (!(err instanceof NoaaError && err.kind === 'api')) return null;
    }
  }
  return null;
}

/** Re-expresses observations in another datum using the station's datums (null if they do not allow it). */
export function toDatum(o: Observed, datums: Record<string, number>, to: Datum): Observed | null {
  if (o.datum === to) return o;
  const { MSL, MLLW } = datums;
  if (MSL === undefined || MLLW === undefined) return null;
  const shift = o.datum === 'MSL' ? MSL - MLLW : MLLW - MSL; // MSL → MLLW adds (MSL − MLLW)
  const points = o.points.map((p) => ({ t: p.t, v: p.v + shift }));
  return { station: o.station, datum: to, points, latest: points[points.length - 1]! };
}

/** Forget memoised lists and stations (tests). */
export function clearNoaaCache() {
  lists.clear();
  tides.clear();
}
