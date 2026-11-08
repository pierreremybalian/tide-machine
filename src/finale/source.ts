// The finale's tide source for any point on Earth (HANDOFF §10.3): a NOAA harmonic station within 25 km
// (measured), else EOT20 at the point (modelled). Returns constants ready for src/tides/predict.ts. Pure.

import type { StationConstants } from '../tides/predict.ts';
import { DEFAULT_SEARCH_KM, Eot20, type FetchLike, type Harmonic } from './eot20.ts';
import { fetchStationTide, loadStationList, nearestStation, type Datum, type HarconStation } from './noaa.ts';

export const NOAA_RADIUS_KM = 25;

export interface TideSource {
  kind: 'measured' | 'modelled';
  /** NOAA station id, or 'eot20:lat,lng' of the sample point. */
  id: string;
  station?: HarconStation;
  /** Amplitude (m), Greenwich phase lag κ (degrees), speed (degrees per hour). */
  constants: Harmonic[];
  /** Mean sea level above the datum, m (0 for EOT20: it has no chart datum). */
  z0: number;
  datumLabel: Datum;
  /** From the requested point to where the constants apply (the station or the EOT20 sample), km. */
  distanceKm: number;
  /** Where the constants apply. */
  at: { lat: number; lng: number };
  /** One or two sentences for the place card: what the numbers are and how far to trust them. */
  note: string;
  /** EOT20 details when modelled: how the point was sampled and the grid spacing (degrees). */
  model?: { method: 'bilinear' | 'partial' | 'nearest'; step: number };
}

export interface TideSourceOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Preloaded station list / EOT20 loader (else fetched from /data and memoised). */
  stations?: readonly HarconStation[] | Promise<readonly HarconStation[]>;
  eot20?: Eot20 | Promise<Eot20>;
  eot20BaseUrl?: string;
  /** Default 25 km. */
  noaaRadiusKm?: number;
  /** How far EOT20 may look for an ocean node from a point on land, km. Default 30. */
  searchKm?: number;
}

export class TideSourceError extends Error {
  readonly reason: 'inland' | 'unavailable';
  constructor(message: string, reason: TideSourceError['reason']) {
    super(message);
    this.name = 'TideSourceError';
    this.reason = reason;
  }
}

let defaultEot20: Promise<Eot20> | undefined;

function eot20(opts: TideSourceOptions): Promise<Eot20> {
  if (opts.eot20) return Promise.resolve(opts.eot20);
  if (opts.fetch || opts.eot20BaseUrl) return Eot20.load({ fetch: opts.fetch, baseUrl: opts.eot20BaseUrl });
  defaultEot20 ??= Eot20.load();
  defaultEot20.catch(() => (defaultEot20 = undefined));
  return defaultEot20;
}

const km = (d: number) => (d < 10 ? d.toFixed(1) : Math.round(d).toString());
const gridLabel = (step: number) => (step === 0.125 ? '1/8°' : step === 0.25 ? '1/4°' : `${step}°`);

/** Best tide constants for (lat, lng). Rejects with TideSourceError only when neither source can serve it. */
export async function tideSource(
  lat: number,
  lng: number,
  opts: TideSourceOptions = {},
): Promise<TideSource> {
  const noaaOpts = { fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  let unavailable = '';

  // 1. Measured: the nearest NOAA harmonic station, if within the radius.
  const list = await Promise.resolve(opts.stations ?? loadStationList(noaaOpts)).catch(() => null);
  const near = list && nearestStation(list, lat, lng);
  if (near && near.distanceKm <= (opts.noaaRadiusKm ?? NOAA_RADIUS_KM)) {
    const s = near.station;
    try {
      const t = await fetchStationTide(s.id, noaaOpts);
      const datum =
        t.datumLabel === 'MLLW'
          ? 'Heights are above mean lower low water (MLLW), the US chart datum.'
          : 'Heights are relative to mean sea level (NOAA lists no MLLW datum for this station).';
      return {
        kind: 'measured',
        id: s.id,
        station: s,
        constants: t.constituents,
        z0: t.z0,
        datumLabel: t.datumLabel,
        distanceKm: near.distanceKm,
        at: { lat: s.lat, lng: s.lng },
        note: `Measured: NOAA's harmonic constants for ${s.name}${s.state ? `, ${s.state}` : ''} (station ${s.id}), ${km(near.distanceKm)} km away, derived from the gauge's own records. ${datum}`,
      };
    } catch (err) {
      unavailable = `NOAA station ${s.name} (${km(near.distanceKm)} km away) could not be reached (${(err as Error).message})`;
    }
  }

  // 2. Modelled: EOT20 at the point (bilinear on its grid), or at the nearest ocean node.
  const searchKm = opts.searchKm ?? DEFAULT_SEARCH_KM;
  let model: Eot20;
  try {
    model = await eot20(opts);
  } catch (err) {
    throw new TideSourceError(`No tide data available right now (${(err as Error).message}).`, 'unavailable');
  }
  let s;
  try {
    s = await model.at(lat, lng, { searchKm });
  } catch (err) {
    throw new TideSourceError(`No tide data available right now (${(err as Error).message}).`, 'unavailable');
  }
  if (!s)
    throw new TideSourceError(
      `No ocean within ${searchKm} km of this point: pick a spot nearer the coast.`,
      'inland',
    );
  const where =
    s.method === 'nearest'
      ? `at the nearest ocean point in its ${gridLabel(s.step)} grid, ${km(s.distanceKm)} km away`
      : `interpolated on its ${gridLabel(s.step)} grid`;
  return {
    kind: 'modelled',
    id: `eot20:${s.lat.toFixed(3)},${s.lng.toFixed(3)}`,
    constants: s.constituents,
    z0: 0,
    datumLabel: 'MSL',
    distanceKm: s.distanceKm,
    at: { lat: s.lat, lng: s.lng },
    model: { method: s.method, step: s.step },
    note:
      `Modelled: ${unavailable || `no NOAA tide gauge within ${opts.noaaRadiusKm ?? NOAA_RADIUS_KM} km`}, so these are the EOT20 global ocean tide model's ${s.constituents.length} main constituents (satellite altimetry, Hart-Davis et al. 2021, CC BY 4.0), ${where}. ` +
      'Heights are relative to mean sea level: the model has no chart datum. Expect errors of several centimetres on open coasts and more inside bays and estuaries, which a global grid cannot resolve.',
  };
}

/** The shape src/tides/predict.ts prepare() takes. */
export function asStationConstants(s: TideSource): StationConstants {
  return { id: s.id, z0: s.z0, constituents: s.constants };
}
