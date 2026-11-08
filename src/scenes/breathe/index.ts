// Stage 1 · The sea breathes (HANDOFF §7 row 1). San Francisco Bay on real terrain and bathymetry; the water follows
// a real week of the Golden Gate gauge (NOAA 9414290, src/script/breathe.ts). The 35 in-bay stations give the shape
// of the water (src/coast/tidefield.ts); the whole bay is lifted by the gauge's departure from its prediction, so
// the water at the gauge is exactly the observation. The camera opens across the bay into a June evening sun behind
// the Golden Gate, settles on the gauge, glides south to the flats that drain and flood, and rises to the whole bay.

import { Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { createMarkers, type Markers } from '../../shared/water/markers.ts';
import { applyShot, shotAt, type Shot, type ShotKey } from '../../shared/water/shots.ts';
import { OrbitRig, type RigPose } from '../../shared/gfx/rig.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { smooth, windowed } from '../../time/tracks.ts';
import { EXAGGERATION, GAUGE, breathe, breatheState } from '../../script/breathe.ts';

const params = {
  /**
   * Fixed light, not the clock (a week of real nights would black out half the stage): a low June evening sun behind
   * the camera for the opening, rising to an afternoon light over the flats.
   */
  sunKeys: [
    [0, 262, 9],
    [0.2, 258, 12],
    [0.42, 236, 26],
    [1, 232, 30],
  ] as const,
  sunLow: [2.8, 1.9, 1.15] as const,
  sunHigh: [2.9, 2.6, 2.2] as const,
  sky: { zenith: [0.06, 0.1, 0.2] as const, horizon: [0.36, 0.31, 0.28] as const },
  /** Mesh density packed over the bay (the flats close-up needs it). */
  focus: { lat: 37.68, lng: -122.3, radius: 32, gain: 1.6 },
  marker: { color: [0.35, 0.85, 1.0] as const, size: 18 },
};

/** Camera path through the stage (lat/lng of the target, orbit az/el in radians, distance in km). */
const SHOTS: ShotKey[] = [
  // From the Pacific through the Golden Gate into the bay, the evening sun behind the camera.
  [0.0, { lat: 37.79, lng: -122.36, az: -1.3, el: 0.17, dist: 30 }],
  [0.12, { lat: 37.795, lng: -122.38, az: -1.27, el: 0.17, dist: 27 }],
  // Down to the gauge at the Presidio, seen from above the city with the strait and Marin behind.
  [0.24, { lat: 37.81, lng: -122.462, az: 0.3, el: 0.62, dist: 8 }],
  [0.34, { lat: 37.81, lng: -122.464, az: 0.42, el: 0.56, dist: 7 }],
  // Lift and drift south over the Central Bay.
  [0.43, { lat: 37.66, lng: -122.27, az: 0.4, el: 0.5, dist: 26 }],
  // The South Bay flats from the south, the sun on the left.
  [0.51, { lat: 37.5, lng: -122.09, az: 0.55, el: 0.5, dist: 16 }],
  [0.66, { lat: 37.49, lng: -122.08, az: 0.42, el: 0.46, dist: 13 }],
  [0.75, { lat: 37.5, lng: -122.09, az: 0.36, el: 0.5, dist: 15 }],
  // Up to the whole bay, north at the top.
  [0.88, { lat: 37.77, lng: -122.36, az: 0.1, el: 0.98, dist: 98 }],
  [1.0, { lat: 37.77, lng: -122.37, az: 0.14, el: 1.0, dist: 96 }],
];

// The page's hero title covers this stage's first ~17 %: no place labels under it.
const PLACES = [
  { id: 'gate', text: 'Golden Gate', lat: 37.8105, lng: -122.4776, on: [0.16, 0.42] },
  { id: 'sf', text: 'San Francisco', lat: 37.765, lng: -122.43, on: [0.16, 0.27] },
  { id: 'pacific', text: 'Pacific Ocean', lat: 37.7, lng: -122.65, on: [0.84, 1.01] },
  { id: 'south', text: 'South Bay', lat: 37.6, lng: -122.2, on: [0.84, 1.01] },
  { id: 'flats', text: 'tidal flats', lat: 37.488, lng: -122.07, on: [0.5, 0.78] },
  { id: 'pablo', text: 'San Pablo Bay', lat: 38.06, lng: -122.37, on: [0.84, 1.01] },
] as const;

/** Sun direction and colour along the stage (warmer when low). */
function setLight(coast: Coast, local: number) {
  const k = params.sunKeys;
  let i = 1;
  while (i < k.length - 1 && k[i]![0] < local) i++;
  const [l0, a0, e0] = k[i - 1]!;
  const [l1, a1, e1] = k[i]!;
  const t = smooth(Math.min(Math.max((local - l0) / (l1 - l0), 0), 1));
  const el = e0 + (e1 - e0) * t;
  coast.setSun(a0 + (a1 - a0) * t, el);
  const w = Math.min(Math.max((el - 9) / 18, 0), 1);
  const lo = params.sunLow;
  const hi = params.sunHigh;
  coast.sky.sunColor.value.set(lo[0] + (hi[0] - lo[0]) * w, lo[1] + (hi[1] - lo[1]) * w, lo[2] + (hi[2] - lo[2]) * w);
}

export default function breatheScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(34);
  const pose: RigPose = { az: 0, el: 0, dist: 10, tx: 0, tt: 0, ty: 0, fov: 34 };
  const shot: Shot = { ...SHOTS[0]![1] };
  let coast: Coast | null = null;
  let markers: Markers | null = null;
  let gaugeIdx = -1;
  let lastReading = NaN;

  const labels = new LabelSet([
    ...PLACES.map((p) => ({ id: p.id, text: p.text, tone: p.id === 'flats' ? ('warm' as const) : ('plain' as const), side: 'center' as const, size: 'md' as const })),
    { id: 'gauge', text: 'Golden Gate gauge', tone: 'b', side: 'right', size: 'md' },
  ]);
  const placeIdx = PLACES.map((p) => labels.index(p.id));
  const gaugeLabel = labels.index('gauge');

  return {
    id: 'breathe',
    status: 'measured',
    statusNote: breathe.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      coast = await createCoast(ctx, {
        region: 'sf',
        exaggeration: EXAGGERATION,
        sun: { azimuth: params.sunKeys[0][1], elevation: params.sunKeys[0][2] },
        meshCells: Math.round(820 * ctx.quality.detail),
        focusLatLng: params.focus,
      });
      coast.sky.zenith.value.set(...params.sky.zenith);
      coast.sky.horizon.value.set(...params.sky.horizon);
      scene.add(coast.object);
      gaugeIdx = coast.field.stations.findIndex((s) => s.id === GAUGE.id);
      const p = coast.projection;
      markers = createMarkers([{ x: p.x(GAUGE.lng), y: 0, z: p.z(GAUGE.lat), color: params.marker.color, size: params.marker.size, intensity: 0, ring: 0.6 }], ctx.globals.uElapsed);
      scene.add(markers.object);
      coast.update(breatheState(0).ms, 0);
      await renderer.compileAsync(scene, rig.camera);
    },
    update(local, _dt, elapsed) {
      if (!coast || !markers) return;
      const s = breatheState(local);
      coast.update(s.ms, elapsed);
      // Lift the bay by the gauge's departure from its prediction: the water at the gauge is the observation.
      const st = coast.field.stations[gaugeIdx]!;
      const lv = coast.stationLevels[gaugeIdx]!;
      const predicted = lv - st.offset + (st.z0 ?? 0);
      const u = coast.uniforms;
      u.levelOffset.value = s.level - predicted;
      u.shoreLine.value = 0.16 * s.shore;

      setLight(coast, local);
      applyShot(rig, coast, shotAt(SHOTS, local, shot), pose, elapsed);
      const cam = rig.camera;
      const water = coast.y(lv + u.levelOffset.value);
      markers.setPos(0, st.x, water, st.z);
      markers.setIntensity(0, 1.6 * s.gauge);
      markers.update(cam);
      markers.commit();

      const reading = Math.round(s.level * 100) / 100;
      if (reading !== lastReading) {
        lastReading = reading;
        labels.setText(gaugeLabel, `Golden Gate gauge ${reading < 0 ? '−' : ''}${Math.abs(reading).toFixed(2)} m`);
      }
      labels.place(gaugeLabel, st.x, water, st.z, cam, s.gauge * (1 - windowed(local, 0.42, 0.86, 0.03, 0.03)));
      const p = coast.projection;
      PLACES.forEach((pl, k) => {
        const x = p.x(pl.lng);
        const z = p.z(pl.lat);
        const o = windowed(local, pl.on[0], pl.on[1], 0.04, 0.04);
        if (o <= 0) return labels.hide(placeIdx[k]!);
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
