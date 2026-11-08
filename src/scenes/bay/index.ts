// Stage 4 · Into the bay (HANDOFF §7 row 4). The king tide of 23 December 2026 enters through the Golden Gate. First
// the waves at Ocean Beach, which feel the bottom (the coast renderer's eikonal phases: crests slow, shorten, bend
// toward the shore and break where the height reaches 0.78 of the depth). Then the tide itself, a wave hundreds of
// kilometres long: the water of 35 NOAA stations, interpolated, coloured by its height above local mean sea level,
// with contour lines every 10 cm; high water reaches the South Bay late and high, Suisun later and lower (numbers in
// src/script/bay.ts). Finally the flats south of the Dumbarton Bridge drain and flood.

import { Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { createMarkers, type Markers } from '../../shared/water/markers.ts';
import { applyShot, shotAt, type Shot, type ShotKey } from '../../shared/water/shots.ts';
import { OrbitRig, type RigPose } from '../../shared/gfx/rig.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { windowed } from '../../time/tracks.ts';
import { EXAGGERATION, GAUGES, bay, bayState } from '../../script/bay.ts';

const params = {
  /** Fixed early-afternoon winter light (the stage's clock runs through the night). */
  sun: { azimuth: 228, elevation: 24 },
  sunColor: [2.75, 2.45, 2.05] as const,
  focus: { lat: 37.66, lng: -122.3, radius: 36, gain: 1.4 },
  /** Field overlay: colour full at ±1.4 m about local mean sea level; contours every 10 cm. */
  fieldRange: 1.4,
  fieldStep: 0.1,
  /** A big winter swell at Ocean Beach (significant height offshore, m); the coast renderer shoals and breaks it. */
  swellHeight: 3.4,
  marker: { size: 9, key: 15 },
  high: [0.55, 0.95, 1.0] as const,
  low: [0.12, 0.3, 0.85] as const,
};

const SHOTS: ShotKey[] = [
  // From the Pacific, looking east through the Golden Gate.
  [0.0, { lat: 37.785, lng: -122.42, az: -1.3, el: 0.2, dist: 27 }],
  [0.1, { lat: 37.78, lng: -122.45, az: -1.25, el: 0.24, dist: 20 }],
  // Ocean Beach: the swell feels the bottom.
  [0.17, { lat: 37.752, lng: -122.512, az: -1.0, el: 0.3, dist: 3.0 }],
  [0.29, { lat: 37.76, lng: -122.513, az: -1.2, el: 0.33, dist: 3.6 }],
  // Up over the whole bay: the tide arrives.
  [0.37, { lat: 37.74, lng: -122.3, az: 0.06, el: 0.9, dist: 92 }],
  [0.62, { lat: 37.74, lng: -122.29, az: 0.14, el: 0.92, dist: 90 }],
  // The flats south of the Dumbarton Bridge, on the ebb.
  [0.69, { lat: 37.5, lng: -122.09, az: 0.55, el: 0.5, dist: 16 }],
  [0.83, { lat: 37.49, lng: -122.08, az: 0.4, el: 0.46, dist: 13 }],
  // The whole bay again as the flood returns.
  [0.93, { lat: 37.74, lng: -122.32, az: 0.1, el: 0.94, dist: 94 }],
  [1.0, { lat: 37.74, lng: -122.32, az: 0.12, el: 0.95, dist: 93 }],
];

const PLACES = [
  { id: 'gate', text: 'Golden Gate', lat: 37.8105, lng: -122.4776, on: [0.02, 0.14], tone: 'plain' },
  { id: 'beach', text: 'Ocean Beach', lat: 37.758, lng: -122.508, on: [0.15, 0.31], tone: 'plain' },
  { id: 'south', text: 'South Bay', lat: 37.6, lng: -122.22, on: [0.36, 0.64], tone: 'plain' },
  { id: 'pablo', text: 'San Pablo Bay', lat: 38.075, lng: -122.39, on: [0.36, 0.64], tone: 'plain' },
  { id: 'suisun', text: 'Suisun Bay', lat: 38.085, lng: -122.0, on: [0.36, 0.64], tone: 'plain' },
  { id: 'flats', text: 'tidal flats', lat: 37.488, lng: -122.07, on: [0.68, 0.86], tone: 'warm' },
] as const;

export default function bayScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(34);
  const pose: RigPose = { az: 0, el: 0, dist: 10, tx: 0, tt: 0, ty: 0, fov: 34 };
  const shot: Shot = { ...SHOTS[0]![1] };
  let coast: Coast | null = null;
  let markers: Markers | null = null;
  /** Field index of each key gauge, and whether a field station is one. */
  let keyIdx: number[] = [];
  const keyRev = new Float64Array(GAUGES.length).fill(NaN);

  const labels = new LabelSet([
    ...PLACES.map((p) => ({ id: p.id, text: p.text, tone: p.tone, side: 'center' as const, size: 'md' as const })),
    ...GAUGES.map((g) => ({ id: `g${g.id}`, text: g.name, tone: 'b' as const, side: 'right' as const, size: 'md' as const })),
  ]);
  const placeIdx = PLACES.map((p) => labels.index(p.id));
  const gaugeLabel = GAUGES.map((g) => labels.index(`g${g.id}`));

  return {
    id: 'bay',
    status: 'measured',
    statusNote: bay.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      coast = await createCoast(ctx, {
        region: 'sf',
        exaggeration: EXAGGERATION,
        sun: params.sun,
        meshCells: Math.round(820 * ctx.quality.detail),
        focusLatLng: params.focus,
      });
      coast.sky.sunColor.value.set(...params.sunColor);
      const u = coast.uniforms;
      u.fieldRange.value = params.fieldRange;
      u.fieldStep.value = params.fieldStep;
      u.bandHeight.value.x = params.swellHeight;
      scene.add(coast.object);
      const st = coast.field.stations;
      keyIdx = GAUGES.map((g) => st.findIndex((s) => s.id === g.id));
      markers = createMarkers(
        st.map((s, i) => ({ x: s.x, y: 0, z: s.z, color: params.low, size: keyIdx.includes(i) ? params.marker.key : params.marker.size, intensity: 0, ring: keyIdx.includes(i) ? 0.5 : 0 })),
        ctx.globals.uElapsed,
      );
      scene.add(markers.object);
      coast.update(bayState(0).ms, 0);
      await renderer.compileAsync(scene, rig.camera);
    },
    update(local, _dt, elapsed) {
      if (!coast || !markers) return;
      const s = bayState(local);
      coast.update(s.ms, elapsed);
      const u = coast.uniforms;
      u.fieldTint.value = s.tint;
      u.shoreLine.value = 0.14 * windowed(local, 0.66, 0.9, 0.04, 0.05);
      applyShot(rig, coast, shotAt(SHOTS, local, shot), pose, elapsed);
      const cam = rig.camera;

      // Every station: a point at its water level, bright above local mean sea level, deep blue below.
      const st = coast.field.stations;
      const lv = coast.stationLevels;
      const hi = params.high;
      const lo = params.low;
      for (let i = 0; i < st.length; i++) {
        const an = Math.max(-1, Math.min(1, (lv[i]! - st[i]!.offset) / params.fieldRange));
        const w = (an + 1) / 2;
        markers.setPos(i, st[i]!.x, coast.y(lv[i]!), st[i]!.z);
        markers.setColor(i, lo[0] + (hi[0] - lo[0]) * w, lo[1] + (hi[1] - lo[1]) * w, lo[2] + (hi[2] - lo[2]) * w);
        markers.setIntensity(i, s.gauges * (0.55 + 0.9 * Math.abs(an)));
      }
      markers.update(cam);
      markers.commit();

      // Key gauges: name and reading above MLLW (the tide-table datum), as in the HUD card.
      GAUGES.forEach((g, k) => {
        const j = keyIdx[k]!;
        const f = st[j];
        if (!f) return labels.hide(gaugeLabel[k]!);
        const r = Math.round((lv[j]! - f.offset + (f.z0 ?? 0)) * 100) / 100;
        if (r !== keyRev[k]) {
          keyRev[k] = r;
          labels.setText(gaugeLabel[k]!, `${g.name} ${r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)} m`);
        }
        labels.place(gaugeLabel[k]!, f.x, coast!.y(lv[j]!), f.z, cam, s.gauges * windowed(local, 0.3, 0.66, 0.04, 0.04) + s.gauges * windowed(local, 0.9, 1.01, 0.04, 0));
      });
      const p = coast.projection;
      PLACES.forEach((pl, k) => {
        const o = windowed(local, pl.on[0], pl.on[1], 0.03, 0.03);
        if (o <= 0) return labels.hide(placeIdx[k]!);
        const x = p.x(pl.lng);
        const z = p.z(pl.lat);
        labels.place(placeIdx[k]!, x, coast!.y(Math.max(coast!.heightAt(x, z), coast!.levelAt(x, z))), z, cam, 0.85 * o);
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
