// Lab · New York Harbor (dev): Lower Manhattan, the Upper Bay, the Hudson and the East River on real terrain, with
// the water from NOAA's harbor stations, interpolated. local 0–1 spans the same two December 2026 days as _bay
// (spring tides; range ≈ 2 m at The Battery). The harbor's bathymetry is rebuilt from coarser tiles (DECISIONS.md).
// Dev URL: &cam=overview|battery|eastriver|hudson (see shared/water/lab.ts).

import { createCoastLab } from '../../shared/water/lab.ts';

const params = {
  exaggeration: 3,
  /** local 0 → 2026-12-23 04:00 EST. */
  startMs: Date.UTC(2026, 11, 23, 9, 0),
  spanHours: 48,
  sun: { azimuth: 205, elevation: 24 },
};

export default () =>
  createCoastLab({
    id: '_harbor',
    region: 'nyc',
    status: 'measured',
    statusNote: `Real terrain; harbor depths from coarse soundings; water from NOAA harbor stations, interpolated. Relief ×${params.exaggeration}.`,
    exaggeration: params.exaggeration,
    startMs: params.startMs,
    spanHours: params.spanHours,
    sun: params.sun,
    sunSite: { lat: 40.7, lng: -74.0 },
    timeZone: 'America/New_York',
    zoneLabel: 'EST',
    // Swell is mostly kept out by the Narrows; a little comes in from the south-southeast. Wind from the west-southwest.
    waves: { swellToward: 345, swellPeriod: 9, windToward: 70 },
    bandHeight: [0.3, 0.32, 0.16],
    vignette: 1.1,
    edgeFade: 1.5,
    cameras: {
      overview: { lat: 40.695, lng: -74.02, az: 0.25, el: 0.85, dist: 24 },
      battery: { lat: 40.703, lng: -74.016, az: 0.75, el: 0.45, dist: 3.6, exag: 2 },
      eastriver: { lat: 40.715, lng: -73.975, az: 1.35, el: 0.5, dist: 4.5 },
      hudson: { lat: 40.73, lng: -74.02, az: -1.2, el: 0.4, dist: 6 },
    },
    defaultCamera: 'overview',
    places: [
      { id: 'manhattan', text: 'Lower Manhattan', lat: 40.712, lng: -74.006 },
      { id: 'hudson', text: 'Hudson River', lat: 40.745, lng: -74.018 },
      { id: 'east', text: 'East River', lat: 40.735, lng: -73.969 },
      { id: 'upper', text: 'Upper Bay', lat: 40.665, lng: -74.05 },
      { id: 'governors', text: 'Governors Island', lat: 40.689, lng: -74.016 },
      { id: 'brooklyn', text: 'Brooklyn', lat: 40.68, lng: -73.96 },
      { id: 'jersey', text: 'Jersey City', lat: 40.718, lng: -74.065 },
    ],
    // The Battery, Brooklyn Bridge, Williamsburg Bridge, Queensboro Bridge, Horns Hook.
    stations: ['8518750', '8517847', '8518699', '8518687', '8518668'],
  });
