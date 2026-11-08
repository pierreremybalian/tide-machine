// Lab · San Francisco Bay (dev): the coast renderer on real terrain and bathymetry, with the water at the level the
// 35 NOAA stations predict. local 0–1 spans two days of the December 2026 king tides (two tidal cycles a day; range
// 3.5 m at Redwood City): the South Bay and San Pablo Bay flats drain and flood. Low water ≈ local 0.30 and 0.80,
// high water ≈ 0.15 and 0.65. Dev URL: &cam=overview|hero|gate|beach|south|flats|pablo|suisun (see shared/water/lab.ts).

import { createCoastLab } from '../../shared/water/lab.ts';

const params = {
  exaggeration: 3,
  /** local 0 → 2026-12-23 04:00 PST, the start of two days of king tides (SF range 2.76 m). */
  startMs: Date.UTC(2026, 11, 23, 12, 0),
  spanHours: 48,
  /** Fixed mid-afternoon winter light (degrees) unless &sun=real. */
  sun: { azimuth: 250, elevation: 20 },
};

export default () =>
  createCoastLab({
    id: '_bay',
    region: 'sf',
    status: 'measured',
    statusNote: `Real terrain and bathymetry; water from 35 NOAA tide stations, interpolated. Relief ×${params.exaggeration}; waves at true scale.`,
    exaggeration: params.exaggeration,
    startMs: params.startMs,
    spanHours: params.spanHours,
    sun: params.sun,
    sunSite: { lat: 37.8, lng: -122.4 },
    timeZone: 'America/Los_Angeles',
    zoneLabel: 'PST',
    cameras: {
      overview: { lat: 37.79, lng: -122.3, az: 0.3, el: 0.92, dist: 112 },
      hero: { lat: 37.8, lng: -122.4, az: 1.2, el: 0.42, dist: 46 },
      gate: { lat: 37.812, lng: -122.49, az: 2.2, el: 0.42, dist: 9, exag: 2 },
      beach: { lat: 37.755, lng: -122.512, az: -1.05, el: 0.33, dist: 3.2, exag: 2 },
      south: { lat: 37.53, lng: -122.12, az: 0.1, el: 0.62, dist: 30 },
      flats: { lat: 37.585, lng: -122.16, az: 0.9, el: 0.38, dist: 6, exag: 2 },
      pablo: { lat: 38.06, lng: -122.37, az: 0.6, el: 0.6, dist: 26 },
      suisun: { lat: 38.07, lng: -122.03, az: 0.3, el: 0.62, dist: 26 },
    },
    defaultCamera: 'overview',
    places: [
      { id: 'gate', text: 'Golden Gate', lat: 37.8105, lng: -122.4776 },
      { id: 'south', text: 'South Bay', lat: 37.56, lng: -122.17 },
      { id: 'pablo', text: 'San Pablo Bay', lat: 38.06, lng: -122.37 },
      { id: 'suisun', text: 'Suisun Bay', lat: 38.075, lng: -122.03 },
      { id: 'pacific', text: 'Pacific Ocean', lat: 37.62, lng: -122.66 },
    ],
    // San Francisco (Fort Point), Alameda, Redwood City, Coyote Creek, Richmond, Port Chicago.
    stations: ['9414290', '9414750', '9414523', '9414575', '9414863', '9415144'],
  });
