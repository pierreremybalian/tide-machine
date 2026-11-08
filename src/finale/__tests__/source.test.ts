import { beforeAll, describe, expect, it } from 'vitest';
import { Eot20 } from '../eot20.ts';
import { clearNoaaCache, loadStationList, type HarconStation } from '../noaa.ts';
import { asStationConstants, tideSource, TideSourceError } from '../source.ts';
import { prepare, predict } from '../../tides/predict.ts';
import { offlineFetch } from './helpers.ts';

let eot: Eot20;
let stations: HarconStation[];

beforeAll(async () => {
  eot = await Eot20.load({ fetch: offlineFetch() });
  stations = await loadStationList({ fetch: offlineFetch() });
});

describe('tideSource', () => {
  it('near San Francisco: the NOAA station (measured, above MLLW)', async () => {
    clearNoaaCache();
    const s = await tideSource(37.81, -122.48, { fetch: offlineFetch(), stations, eot20: eot });
    expect(s.kind).toBe('measured');
    expect(s.station?.id).toBe('9414290');
    expect(s.distanceKm).toBeLessThan(25);
    expect(s).toMatchObject({ datumLabel: 'MLLW', z0: 0.951 });
    expect(s.constants.find((c) => c.name === 'M2')?.amplitude).toBe(0.576);
    expect(s.note).toMatch(/^Measured: NOAA/);
    // Ready for the predictor.
    const h = predict(prepare(asStationConstants(s)), Date.UTC(2026, 0, 1));
    expect(h).toBeGreaterThan(-0.5);
    expect(h).toBeLessThan(2.5);
  });

  it('mid-Atlantic: EOT20 (modelled, relative to mean sea level)', async () => {
    const s = await tideSource(30, -40, { fetch: offlineFetch(), stations, eot20: eot });
    expect(s.kind).toBe('modelled');
    expect(s.station).toBeUndefined();
    expect(s).toMatchObject({ datumLabel: 'MSL', z0: 0, distanceKm: 0, model: { method: 'bilinear' } });
    expect(s.constants.map((c) => c.name)).toEqual(['M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'P1', 'Q1', 'M4']);
    expect(s.note).toMatch(/mean sea level/);
  });

  it('near Lisbon: EOT20, with a plausible semidiurnal tide (M2 ≈ 1 m)', async () => {
    const s = await tideSource(38.69, -9.42, { fetch: offlineFetch(), stations, eot20: eot });
    expect(s.kind).toBe('modelled');
    const m2 = s.constants.find((c) => c.name === 'M2')!;
    expect(m2.amplitude).toBeGreaterThan(0.85);
    expect(m2.amplitude).toBeLessThan(1.3);
  });

  it('a US coast more than 25 km from any NOAA harmonic station: EOT20', async () => {
    // Open water off Cape Mendocino, CA.
    const s = await tideSource(40.3, -124.6, { fetch: offlineFetch(), stations, eot20: eot });
    expect(s.kind).toBe('modelled');
  });

  it('NOAA down: falls back to EOT20 and says so', async () => {
    clearNoaaCache();
    const s = await tideSource(37.81, -122.48, {
      fetch: offlineFetch({ noaaDown: true }),
      stations,
      eot20: eot,
    });
    expect(s.kind).toBe('modelled');
    expect(s.note).toMatch(/could not be reached/);
  });

  it('far inland: rejects with reason "inland"', async () => {
    const err = await tideSource(48.85, 2.35, { fetch: offlineFetch(), stations, eot20: eot }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TideSourceError);
    expect((err as TideSourceError).reason).toBe('inland');
  });

  it('loads its own station list and model through fetch', async () => {
    clearNoaaCache();
    const f = offlineFetch();
    const s = await tideSource(-33.86, 151.3, { fetch: f, eot20BaseUrl: '/data/eot20/' }); // off Sydney
    expect(s.kind).toBe('modelled');
    expect(f.calls).toContain('/data/noaa-harcon-stations.json');
    expect(f.calls).toContain('/data/eot20/index.json');
    expect(f.calls.filter((u) => u.endsWith('.bin')).length).toBeLessThanOrEqual(4);
  });
});
