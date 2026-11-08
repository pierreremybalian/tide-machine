// Stage 2 · The Moon pulls unevenly (the equilibrium tide). Pure script shared by the scene, the HUD and the narration.
// Newton's picture: the Moon pulls the near side of Earth harder than the centre and the centre harder than the far
// side; take away the pull every part shares and what is left stretches Earth along the line to the Moon. An ocean
// that kept up would stand in two bulges (heights from src/tides/equilibrium.ts), and Earth turns beneath them, so a
// place passes two highs per lunar day. Rates come from the astronomical speeds (src/tides/astro.ts): Earth turns
// once a sidereal day, the Moon moves along its orbit, and M2's speed gives the lunar day of 24 h 50 min.

import { SPEED } from '../tides/astro.ts';
import { BY_NAME, speed } from '../tides/constituents.ts';
import { equilibriumHeight, MOON_BULGE_M, SUN_BULGE_M } from '../tides/equilibrium.ts';
import { ramp, track, windowed } from '../time/tracks.ts';
import { registerStage, type Readout } from './index.ts';

/** Lunar day (hours): two turns of M2. */
export const LUNAR_DAY_H = 720 / speed(BY_NAME.get('M2')!);
/** Earth's rotation relative to the stars and the Moon's motion along its orbit, degrees per hour. */
export const EARTH_RATE = 15 + SPEED.h;
export const MOON_RATE = SPEED.s;
/** How far the Moon moves along its orbit in one lunar day (degrees, relative to the stars). */
export const MOON_STEP_DEG = MOON_RATE * LUNAR_DAY_H;

/** Drawing scales (stated in the note). */
export const BULGE_EXAGGERATION = 1e6;
export const EARTH_RADIUS_M = 6.371e6;
/** The Moon is drawn this many Earth radii away (really about 60). */
export const MOON_DIST_R = 6;
export const MOON_REAL_DIST_R = 384400 / 6371;

export const SF = { lat: 37.806, lng: -122.466 };

/** Moon's direction at t = 0 (degrees, counterclockwise seen from above the north pole; 180 = to the left). */
export const MOON_ANGLE0 = 180;
/** Hours on the clock when Earth starts turning in earnest, and San Francisco's angle from the Moon then. */
export const TURN_START_H = 1;
const SF_START_DEG = 135;

/** Hours since the start of the stage. Slow drift, then one lunar day and a little more. */
export const moonHours = track([
  [0, 0],
  [0.52, TURN_START_H],
  [0.83, TURN_START_H + LUNAR_DAY_H],
  [1, TURN_START_H + LUNAR_DAY_H + 1.5],
]);

/** Angle of the Moon (degrees) at hour t. */
export function moonAngle(t: number): number {
  return MOON_ANGLE0 + MOON_RATE * t;
}

/** Earth's rotation (degrees): San Francisco's world angle is earthAngle(t) + SF.lng. */
export function earthAngle(t: number): number {
  return SF_START_DEG + moonAngle(TURN_START_H) - SF.lng + EARTH_RATE * (t - TURN_START_H);
}

/** San Francisco's angle east of the sub-lunar meridian (degrees, −180…180). */
export function sfFromMoon(t: number): number {
  const d = earthAngle(t) + SF.lng - moonAngle(t);
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Equilibrium height (m) at San Francisco with the Moon over the equator. */
export function sfHeight(t: number): number {
  const cosTheta = Math.cos((SF.lat * Math.PI) / 180) * Math.cos((sfFromMoon(t) * Math.PI) / 180);
  return equilibriumHeight(MOON_BULGE_M, Math.acos(Math.max(-1, Math.min(1, cosTheta))));
}

export interface MoonState {
  hours: number;
  /** 0 → 1: arrows of the Moon's pull on each part of Earth. */
  pull: number;
  /** 0 → 1: the pull every part shares (on Earth's centre) is taken away; what is left is the tidal stretch. */
  subtract: number;
  /** 0 → 1: the ocean rises into the two bulges. */
  bulge: number;
  /** 0–1: San Francisco marked; its gauge and the chart card. */
  sf: number;
  /** 0–1: the arc the Moon has moved since the first high. */
  catchUp: number;
  /** 0 → 1: the closing wide view. */
  pullBack: number;
  /** 0–1: labels of the bulge heights. */
  heights: number;
}

export function moonState(local: number): MoonState {
  return {
    hours: moonHours(local),
    pull: windowed(local, 0.12, 0.45, 0.04, 0.06),
    subtract: ramp(local, 0.26, 0.33),
    bulge: ramp(local, 0.38, 0.47),
    sf: ramp(local, 0.5, 0.55),
    catchUp: windowed(local, 0.71, 0.9, 0.03, 0.05),
    pullBack: ramp(local, 0.86, 0.97),
    heights: windowed(local, 0.42, 0.62, 0.03, 0.05) + windowed(local, 0.87, 1.01, 0.04, 0.001),
  };
}

export function hm(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export const moon = registerStage('moon', {
  note: 'The bulge heights are computed (Newton’s equilibrium tide) but drawn a million times higher; the Moon is drawn 6 Earth radii away instead of 60 and over the equator; the arrows show the shape of the pull, not its size. Time runs through one lunar day.',
  readouts(local) {
    const s = moonState(local);
    const rows: Readout[] = [];
    if (s.bulge < 0.5)
      rows.push({
        label: 'Earth to Moon',
        value: `${MOON_REAL_DIST_R.toFixed(0)} Earth radii`,
        tone: 'plain',
      });
    if (s.bulge >= 0.5)
      rows.push({
        label: 'Moon’s bulges',
        value: `+${MOON_BULGE_M.toFixed(2)} m / −${(MOON_BULGE_M / 2).toFixed(2)} m`,
        tone: 'b',
      });
    if (s.sf > 0.5) {
      const t = s.hours - TURN_START_H;
      rows.push({ label: 'Clock', value: hm(Math.max(0, t)), tone: 'mute' });
      const h = sfHeight(s.hours);
      rows.push({
        label: 'San Francisco',
        value: `${h >= 0 ? '+' : '−'}${Math.abs(h).toFixed(2)} m`,
        tone: 'a',
      });
    }
    if (s.catchUp > 0.5 || s.pullBack > 0.5)
      rows.push({ label: 'Lunar day', value: hm(LUNAR_DAY_H), tone: 'plain' });
    if (s.pullBack > 0.5)
      rows.push({ label: 'Sun’s bulges', value: `+${SUN_BULGE_M.toFixed(2)} m`, tone: 'warm' });
    return rows;
  },
});
