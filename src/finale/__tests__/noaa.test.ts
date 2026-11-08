import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  clearNoaaCache,
  datumFor,
  fetchObserved,
  fetchStationTide,
  nearestStation,
  parseDatums,
  parseHarcon,
  parseStationList,
  toDatum,
} from '../noaa.ts';
import type { FetchLike } from '../eot20.ts';

const fx = (f: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${f}`, import.meta.url), 'utf8')) as unknown;
const DATA = new URL('../../../public/data/', import.meta.url);
const bundled = () =>
  parseStationList(JSON.parse(readFileSync(new URL('noaa-harcon-stations.json', DATA), 'utf8')));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A fetch that answers from a route table and records what was asked. */
function fakeFetch(routes: [RegExp, () => Response | Promise<Response>][]) {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    for (const [re, res] of routes) if (re.test(url)) return res();
    throw new TypeError('Failed to fetch');
  };
  return { f, calls };
}

afterEach(() => clearNoaaCache());

describe('bundled NOAA harmonic stations', () => {
  const list = bundled();
  it('has NOAA’s ~1,374 harmonic stations with coordinates', () => {
    expect(list.length).toBeGreaterThan(1300);
    expect(list.every((s) => Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180)).toBe(true);
    expect(list.filter((s) => s.live).length).toBeGreaterThan(150);
  });
  it('finds the nearest station without a request', () => {
    const sf = nearestStation(list, 37.8063, -122.4659)!;
    expect(sf.station.id).toBe('9414290');
    expect(sf.station.live).toBe(true);
    expect(sf.distanceKm).toBeLessThan(0.1);
    const battery = nearestStation(list, 40.7006, -74.0142)!;
    expect(battery.station.id).toBe('8518750');
  });
});

describe('NOAA API parsing (real responses for San Francisco, 9414290)', () => {
  it('harmonic constants: phase_GMT, metres, zero amplitudes dropped', () => {
    const h = parseHarcon(fx('9414290-harcon.json'));
    const m2 = h.find((c) => c.name === 'M2')!;
    expect(m2).toEqual({ name: 'M2', amplitude: 0.576, phase: 208.2, speed: 28.984104 });
    expect(h.every((c) => c.amplitude > 0)).toBe(true);
  });
  it('datums give z0 = MSL − MLLW, else mean sea level', () => {
    const d = parseDatums(fx('9414290-datums.json'));
    expect(datumFor(d)).toEqual({ z0: 0.951, datumLabel: 'MLLW' });
    expect(datumFor({ MSL: 2.1 })).toEqual({ z0: 0, datumLabel: 'MSL' });
    expect(datumFor(parseDatums({ datums: null }))).toEqual({ z0: 0, datumLabel: 'MSL' });
  });
});

describe('NOAA fetches fail gracefully', () => {
  it('a station’s constants and datums (two requests, memoised)', async () => {
    const { f, calls } = fakeFetch([
      [/harcon\.json/, () => json(fx('9414290-harcon.json'))],
      [/datums\.json/, () => json(fx('9414290-datums.json'))],
    ]);
    const t = await fetchStationTide('9414290', { fetch: f });
    expect(t.z0).toBe(0.951);
    expect(t.datumLabel).toBe('MLLW');
    await fetchStationTide('9414290', { fetch: f });
    expect(calls.length).toBe(2);
  });
  it('missing datums: predicts relative to MSL instead of failing', async () => {
    const { f } = fakeFetch([
      [/harcon\.json/, () => json(fx('9414290-harcon.json'))],
      [/datums\.json/, () => json({ error: { message: 'No datums' } })],
    ]);
    const t = await fetchStationTide('9414290', { fetch: f });
    expect(t).toMatchObject({ z0: 0, datumLabel: 'MSL' });
  });
  it('no harmonic constants or no network: rejects with a NoaaError', async () => {
    const { f } = fakeFetch([[/harcon\.json/, () => json({ error: { message: 'Station not found' } })]]);
    await expect(fetchStationTide('0000000', { fetch: f })).rejects.toMatchObject({
      name: 'NoaaError',
      kind: 'api',
    });
    await expect(fetchStationTide('0000001', { fetch: fakeFetch([]).f })).rejects.toMatchObject({
      kind: 'network',
    });
    const slow: FetchLike = (_u, i) =>
      new Promise((_res, rej) =>
        i?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
      );
    await expect(fetchStationTide('0000002', { fetch: slow, timeoutMs: 20 })).rejects.toThrow(/in time/);
  });
  it('observed water level: MLLW, else MSL, else null', async () => {
    const ok = fakeFetch([[/datum=MLLW/, () => json(fx('9414290-water-level.json'))]]);
    const o = (await fetchObserved('9414290', { fetch: ok.f, hours: 1 }))!;
    expect(o.datum).toBe('MLLW');
    expect(o.points.length).toBeGreaterThan(5);
    expect(o.latest.t).toBe(o.points[o.points.length - 1]!.t);
    expect(new Date(o.points[0]!.t).toISOString()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
    expect(ok.calls[0]).toMatch(/product=water_level&range=1&station=9414290&datum=MLLW/);

    const msl = fakeFetch([
      [/datum=MLLW/, () => json({ error: { message: 'The supported Datums are: MSL' } })],
      [/datum=MSL/, () => json(fx('9414290-water-level.json'))],
    ]);
    const m = (await fetchObserved('9414290', { fetch: msl.f }))!;
    expect(m.datum).toBe('MSL');
    const datums = parseDatums(fx('9414290-datums.json'));
    const back = toDatum(m, datums, 'MLLW')!;
    expect(back.latest.v - m.latest.v).toBeCloseTo(0.951, 6);

    const none = fakeFetch([[/datagetter/, () => json({ error: { message: 'No data was found.' } })]]);
    expect(await fetchObserved('1611347', { fetch: none.f })).toBeNull();
    expect(none.calls.length).toBe(2);
    expect(await fetchObserved('1611347', { fetch: fakeFetch([]).f })).toBeNull();
    expect(await fetchObserved('1611347', { fetch: fakeFetch([[/./, () => json({}, 503)]]).f })).toBeNull();
  });
});
