// Shared state of the finale (HANDOFF §3: the finale reads `$place` and `$crank` from its own UI panel). The UI
// controller (src/finale/ui/controller.ts) writes the chosen place and its data; the scene (src/scenes/anywhere)
// reads them and reports back what it has built. No DOM, no three: both sides import this.

import { atom } from 'nanostores';
import type { Heightfield } from '../../coast/heightfield.ts';
import type { Prepared } from '../../tides/predict.ts';
import type { TideSource } from '../source.ts';
import type { Place } from '../places.ts';
import type { CoastFacts } from '../terrain.ts';
import type { Observed } from '../noaa.ts';
import type { TideSeries } from '../extremes.ts';

export interface PlaceRequest {
  lat: number;
  lng: number;
  /** What the reader picked ("Lisbon", "37.81° N, 122.47° W"). */
  name: string;
  /** Country, or "near …". */
  sub: string;
}

export interface Spot {
  /** Unique per selection (cache key for the coast bake). */
  key: string;
  place: PlaceRequest;
  source: TideSource;
  /** predict() input with z0 = the source's datum offset (MLLW for NOAA stations, 0 = mean sea level for EOT20). */
  prepared: Prepared;
  /** The machine's week: [weekT0, weekT0 + WEEK_MS). */
  weekT0: number;
  series: TideSeries;
  terrain: { hf: Heightfield; facts: CoastFacts; exaggeration: number; zoom: number; tiles: number } | null;
  terrainError: string | null;
  observed: Observed | null;
}

export type Phase = 'globe' | 'locating' | 'ready' | 'error';

export interface FinaleState {
  phase: Phase;
  /** The place being located or shown. */
  target: PlaceRequest | null;
  spot: Spot | null;
  /** What the loader is doing (for the status line). */
  step: string;
  error: { message: string; suggestions: Place[] } | null;
}

export const WEEK_MS = 7 * 86400e3;
/** The week starts this long before "now" so the paper already carries a trace. */
export const WEEK_LEAD_MS = 36 * 3600e3;

export const $finale = atom<FinaleState>({ phase: 'globe', target: null, spot: null, step: '', error: null });

/** The globe's view: the point under the camera (degrees) and the camera distance (globe radii from the centre). */
export const $globe = atom({ lat: 24, lng: -38, dist: 4.6 });

/** Orbit around the coast: azimuth and elevation offsets (radians) and a zoom factor, driven by drags. */
export const $coastView = atom({ az: 0, el: 0, zoom: 1 });

/** Machine time chosen with the week scrubber (ms UTC), or null for live "now". */
export const $crankMs = atom<number | null>(null);

/** What the scene has built for the current spot. */
export const $coastStatus = atom<{ key: string; status: 'building' | 'ready' | 'failed' } | null>(null);

/** Rectangles in fractions of the viewport (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen layout published by the UI: where the machine is drawn (slot) and the part of it that is visible (clip),
 * and the fractions of the screen covered by the panels, so the scene centres the globe or the coast in what is left.
 */
export const $layout = atom<{ slot: Rect | null; clip: Rect | null; free: Rect }>({ slot: null, clip: null, free: { x: 0, y: 0, w: 1, h: 1 } });

/** Pointer over the globe (degrees), for the reticle; null when away or on touch. */
export const $hover = atom<{ lat: number; lng: number } | null>(null);

/** The tool is live (the reader has reached it); the scene stops its intro motion. */
export const $toolOn = atom(false);

/** Set by the scene while it is loaded: screen point (fractions, top-left) → the globe's latitude/longitude, or null. */
export const bridge: { pick: ((fx: number, fy: number) => { lat: number; lng: number } | null) | null } = { pick: null };
