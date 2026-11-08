// Stage 12 · When the sea disagrees (HANDOFF §7 row 12). Lower Manhattan and New York Harbor on real terrain, 29–30
// October 2012. The harbor's water first stands at the predicted tide (NOAA's harbor stations, interpolated); then the
// storm surge measured at the Battery (observed − predicted, src/script/sandy.ts) is added to every level through the
// coast's levelOffset, and the water climbs out of the harbor into the streets. A brass line marks the shore the tide
// tables expected; the water beyond it, the flood the Moon and the Sun did not make, is tinted.

import { Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { createMarkers, type Markers } from '../../shared/water/markers.ts';
import { applyShot, shotAt, type Shot, type ShotKey } from '../../shared/water/shots.ts';
import { OrbitRig, type RigPose } from '../../shared/gfx/rig.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { ramp, windowed } from '../../time/tracks.ts';
import { BATTERY, EXAGGERATION, sandy, sandyState } from '../../script/sandy.ts';

const params = {
  /** A dim, overcast evening light (fixed; the storm's real night would show nothing). */
  sun: { azimuth: 236, elevation: 14 },
  sunColor: [1.9, 1.82, 1.85] as const,
  sky: { zenith: [0.05, 0.065, 0.09] as const, horizon: [0.24, 0.25, 0.27] as const },
  ambientLand: [0.3, 0.32, 0.38] as const,
  /** The flood front (the real waterline) in amber, the predicted shore in brass. */
  front: [1.0, 0.5, 0.16] as const,
  predictedLine: [0.95, 0.72, 0.36] as const,
  surgeTint: [0.25, 0.7, 1.0] as const,
  /** Storm sea: wind from the southeast, a swell through the Narrows; heights illustrative. */
  waves: { swellToward: 345, swellPeriod: 9, windToward: 315 },
  bandHeight: [0.5, 0.9, 0.38] as const,
  calmBand: [0.3, 0.32, 0.16] as const,
  focus: { lat: 40.705, lng: -74.01, radius: 7, gain: 3 },
  marker: { color: [0.35, 0.85, 1.0] as const, size: 18 },
};

const SHOTS: ShotKey[] = [
  // The harbor from over the Upper Bay, Manhattan ahead.
  [0.0, { lat: 40.7, lng: -74.02, az: 0.38, el: 0.62, dist: 21 }],
  [0.12, { lat: 40.702, lng: -74.02, az: 0.42, el: 0.6, dist: 19 }],
  // In toward the Battery from the southeast.
  [0.3, { lat: 40.706, lng: -74.012, az: 0.62, el: 0.47, dist: 6.5 }],
  [0.4, { lat: 40.707, lng: -74.011, az: 0.66, el: 0.45, dist: 5.8 }],
  // The peak: Lower Manhattan close.
  [0.58, { lat: 40.709, lng: -74.008, az: 0.8, el: 0.44, dist: 4.3 }],
  [0.72, { lat: 40.712, lng: -74.0, az: 1.05, el: 0.46, dist: 4.6 }],
  // Back out over the harbor: Hoboken, Red Hook, the river shores.
  [0.88, { lat: 40.703, lng: -74.02, az: 0.42, el: 0.66, dist: 15 }],
  [1.0, { lat: 40.702, lng: -74.02, az: 0.38, el: 0.68, dist: 16 }],
];

const PLACES = [
  { id: 'manhattan', text: 'Lower Manhattan', lat: 40.714, lng: -74.004, on: [0.02, 1.01] },
  { id: 'hudson', text: 'Hudson River', lat: 40.74, lng: -74.016, on: [0.02, 0.3] },
  { id: 'east', text: 'East River', lat: 40.703, lng: -73.99, on: [0.02, 0.3] },
  { id: 'upper', text: 'Upper Bay', lat: 40.668, lng: -74.05, on: [0.02, 0.3] },
  { id: 'jersey', text: 'Jersey City', lat: 40.718, lng: -74.055, on: [0.86, 1.01] },
  { id: 'hoboken', text: 'Hoboken', lat: 40.745, lng: -74.035, on: [0.86, 1.01] },
  { id: 'redhook', text: 'Red Hook', lat: 40.676, lng: -74.01, on: [0.86, 1.01] },
] as const;

export default function sandyScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(34);
  const pose: RigPose = { az: 0, el: 0, dist: 10, tx: 0, tt: 0, ty: 0, fov: 34 };
  const shot: Shot = { ...SHOTS[0]![1] };
  let coast: Coast | null = null;
  let markers: Markers | null = null;
  let gaugeIdx = -1;
  let lastText = '';

  const labels = new LabelSet([
    ...PLACES.map((p) => ({ id: p.id, text: p.text, tone: 'plain' as const, side: 'center' as const, size: 'md' as const })),
    { id: 'gauge', text: 'The Battery', tone: 'b', side: 'left', size: 'md' },
  ]);
  const placeIdx = PLACES.map((p) => labels.index(p.id));
  const gaugeLabel = labels.index('gauge');

  return {
    id: 'sandy',
    status: 'measured',
    statusNote: sandy.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      coast = await createCoast(ctx, {
        region: 'nyc',
        exaggeration: EXAGGERATION,
        sun: params.sun,
        waves: params.waves,
        meshCells: Math.round(760 * ctx.quality.detail),
        focusLatLng: params.focus,
      });
      const u = coast.uniforms;
      coast.sky.sunColor.value.set(...params.sunColor);
      coast.sky.zenith.value.set(...params.sky.zenith);
      coast.sky.horizon.value.set(...params.sky.horizon);
      u.ambientLand.value.set(...params.ambientLand);
      u.shoreColor.value.set(...params.front);
      u.surgeLine.value.set(...params.predictedLine);
      u.surgeTint.value.set(...params.surgeTint);
      u.vignette.value = 1.1;
      u.edgeFade.value = 1.5;
      scene.add(coast.object);
      gaugeIdx = coast.field.stations.findIndex((s) => s.id === BATTERY.id);
      const st = coast.field.stations[gaugeIdx]!;
      markers = createMarkers([{ x: st.x, y: 0, z: st.z, color: params.marker.color, size: params.marker.size, intensity: 0, ring: 0.6 }], ctx.globals.uElapsed);
      scene.add(markers.object);
      coast.update(sandyState(0).ms, 0);
      await renderer.compileAsync(scene, rig.camera);
    },
    update(local, _dt, elapsed) {
      if (!coast || !markers) return;
      const s = sandyState(local);
      coast.update(s.ms, elapsed);
      const u = coast.uniforms;
      // The surge measured at the Battery, added to every level once the real water is shown.
      u.levelOffset.value = s.real * s.surge;
      u.surgeMark.value = s.mark;
      u.shoreLine.value = 0.8 * s.mark * Math.min(1, Math.max(0, (s.surge * s.real - 0.3) / 0.6));
      // The storm's sea builds with the reveal.
      const b = params.bandHeight;
      const c = params.calmBand;
      const storm = ramp(local, 0.3, 0.45) * (1 - 0.5 * ramp(local, 0.8, 1));
      u.bandHeight.value.set(c[0] + (b[0] - c[0]) * storm, c[1] + (b[1] - c[1]) * storm, c[2] + (b[2] - c[2]) * storm);
      u.gusts.value = 0.6 + 0.4 * storm;
      applyShot(rig, coast, shotAt(SHOTS, local, shot), pose, elapsed);
      const cam = rig.camera;

      const st = coast.field.stations[gaugeIdx]!;
      const lv = coast.stationLevels[gaugeIdx]!;
      const water = coast.y(lv + u.levelOffset.value);
      markers.setPos(0, st.x, water, st.z);
      markers.setIntensity(0, 1.6 * ramp(local, 0.1, 0.18));
      markers.update(cam);
      markers.commit();
      const text = `The Battery ${s.shown.toFixed(2)} m`;
      if (text !== lastText) {
        lastText = text;
        labels.setText(gaugeLabel, text);
      }
      labels.place(gaugeLabel, st.x, water, st.z, cam, ramp(local, 0.1, 0.18) * (1 - windowed(local, 0.84, 1.01, 0.03, 0)));
      const p = coast.projection;
      PLACES.forEach((pl, k) => {
        const o = windowed(local, pl.on[0], pl.on[1], 0.03, 0.03);
        if (o <= 0) return labels.hide(placeIdx[k]!);
        const x = p.x(pl.lng);
        const z = p.z(pl.lat);
        labels.place(placeIdx[k]!, x, coast!.y(Math.max(coast!.heightAt(x, z), coast!.levelAt(x, z))), z, cam, 0.8 * o);
      });
    },
    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, rig.camera);
    },
    resize(width: number, height: number) {
      rig.resize(width, height);
      coast?.uniforms.resolution.value.set(width, height);
    },
    dispose() {
      markers?.dispose();
      coast?.dispose();
      markers = null;
      coast = null;
    },
  };
}
