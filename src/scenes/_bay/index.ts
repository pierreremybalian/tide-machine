// Lab · San Francisco Bay (dev): the coast renderer on real terrain and bathymetry, with the water at the level the
// 35 NOAA stations predict. local 0–1 spans two days of the December 2026 king tides (two tidal cycles a day): the
// South Bay and San Pablo Bay flats drain and flood. URL (dev): &cam=overview|gate|beach|south|flats|pablo|suisun
// &exag=3 &sun=real|<az>,<el> &waves=<strength>.

import { Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { OrbitRig, type RigPose } from '../../shared/gfx/rig.ts';
import { LabelSet, type LabelSpec } from '../../shared/gfx/labels.ts';
import { sunPosition } from '../../coast/sun.ts';
import { backdrop } from '../../shared/water/sky.ts';

const params = {
  region: 'sf',
  exaggeration: 3,
  /** local 0 → 2026-12-23 04:00 PST, the start of two days of king tides (SF range 2.76 m). */
  startMs: Date.UTC(2026, 11, 23, 12, 0),
  spanHours: 48,
  /** Fixed early-afternoon winter light (az, el in degrees) unless &sun=real. */
  sun: { azimuth: 238, elevation: 27 },
  /** Camera presets: target lat/lng, azimuth (rad, 0 = camera south of target), elevation (rad), distance (km). */
  cameras: {
    overview: { lat: 37.79, lng: -122.3, az: 0.3, el: 0.92, dist: 112, fov: 34 },
    hero: { lat: 37.8, lng: -122.4, az: 1.2, el: 0.42, dist: 46, fov: 34 },
    gate: { lat: 37.812, lng: -122.49, az: 2.2, el: 0.42, dist: 9, fov: 34 },
    beach: { lat: 37.755, lng: -122.512, az: -1.05, el: 0.33, dist: 3.2, fov: 34 },
    south: { lat: 37.53, lng: -122.12, az: 0.1, el: 0.62, dist: 30, fov: 34 },
    flats: { lat: 37.585, lng: -122.16, az: 0.9, el: 0.38, dist: 6, fov: 34 },
    pablo: { lat: 38.06, lng: -122.37, az: 0.6, el: 0.6, dist: 26, fov: 34 },
    suisun: { lat: 38.07, lng: -122.03, az: 0.3, el: 0.62, dist: 26, fov: 34 },
  },
};
type CamName = keyof typeof params.cameras;

const PLACES: { id: string; text: string; lat: number; lng: number }[] = [
  { id: 'gate', text: 'Golden Gate', lat: 37.8105, lng: -122.4776 },
  { id: 'south', text: 'South Bay', lat: 37.56, lng: -122.17 },
  { id: 'pablo', text: 'San Pablo Bay', lat: 38.06, lng: -122.37 },
  { id: 'suisun', text: 'Suisun Bay', lat: 38.075, lng: -122.03 },
  { id: 'pacific', text: 'Pacific Ocean', lat: 37.62, lng: -122.66 },
];
const STATIONS = ['9414290', '9414750', '9414523', '9414575', '9414863', '9415144'];

function urlParams(): URLSearchParams {
  return typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
}

export default function bayLab(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(34);
  let coast: Coast | null = null;
  const q = urlParams();
  const camName = ((q.get('cam') ?? 'overview') in params.cameras ? q.get('cam') ?? 'overview' : 'overview') as CamName;
  const cam = params.cameras[camName];
  const sunMode = q.get('sun') ?? '';
  const pose: RigPose = { az: cam.az, el: cam.el, dist: cam.dist, tx: 0, tt: 0, ty: 0, fov: cam.fov };
  let stationIdx: number[] = [];
  const stationRev = new Float64Array(STATIONS.length).fill(NaN);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let lastClock = '';

  const specs: LabelSpec[] = [
    ...PLACES.map((p) => ({ id: p.id, text: p.text, tone: 'plain' as const, side: 'center' as const, size: 'md' as const })),
    ...STATIONS.map((id) => ({ id: `st${id}`, text: id, tone: 'b' as const, side: 'right' as const, size: 'md' as const })),
    { id: 'clock', text: '', tone: 'mute', side: 'right', size: 'sm' },
  ];
  const labels = new LabelSet(specs);
  const L = { clock: labels.index('clock') };

  const self: BlockScene = {
    id: '_bay',
    status: 'measured',
    statusNote: `Real terrain and bathymetry; water from 35 NOAA tide stations, interpolated. Relief ×${params.exaggeration}; waves at true scale.`,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      scene.backgroundNode = backdrop();
      const exag = Number(q.get('exag') ?? params.exaggeration);
      let sun = params.sun;
      if (sunMode && sunMode !== 'real') {
        const [az, el] = sunMode.split(',').map(Number);
        if (Number.isFinite(az) && Number.isFinite(el)) sun = { azimuth: az!, elevation: el! };
      }
      // Close-up presets pack mesh vertices around the target (the full bay keeps a uniform grid).
      const focus = cam.dist < 40 ? { lat: cam.lat, lng: cam.lng, radius: cam.dist * 1.2 } : null;
      coast = await createCoast(ctx, { region: params.region, exaggeration: exag, sun, focusLatLng: focus ?? undefined });
      if (q.get('waves')) coast.uniforms.waveStrength.value = Number(q.get('waves'));
      if (q.get('debug')) coast.uniforms.debug.value = Number(q.get('debug'));
      if (q.get('foam')) coast.uniforms.foam.value = Number(q.get('foam'));
      scene.add(coast.object);
      const p = coast.projection;
      pose.tx = p.x(cam.lng);
      pose.ty = p.z(cam.lat);
      stationIdx = STATIONS.map((id) => coast!.field.stations.findIndex((s) => s.id === id));
      STATIONS.forEach((_, i) => {
        const s = coast!.field.stations[stationIdx[i]!];
        if (s) labels.setText(labels.index(`st${STATIONS[i]}`), s.label);
      });
      coast.update(params.startMs, 0);
      await renderer.compileAsync(scene, rig.camera);
    },
    update(local, _dt, elapsed) {
      if (!coast) return;
      const ms = params.startMs + local * params.spanHours * 3600e3;
      coast.update(ms, elapsed);
      if (sunMode === 'real') {
        const s = sunPosition(ms, 37.8, -122.4);
        coast.setSun(s.azimuth, Math.max(s.elevation, -4));
      }
      pose.tt = coast.y(1);
      rig.apply(pose, elapsed);
      const c = rig.camera;
      c.near = Math.max(0.005, pose.dist * rig.fit() * 0.02);
      c.far = pose.dist * rig.fit() * 6 + 60;
      c.updateProjectionMatrix();
      coast.uniforms.hazeStart.value = pose.dist * rig.fit() * 0.9;
      coast.uniforms.hazeDensity.value = 0.9 / (pose.dist * rig.fit() + 10);

      const p = coast.projection;
      for (const pl of PLACES) {
        const i = labels.index(pl.id);
        const x = p.x(pl.lng);
        const z = p.z(pl.lat);
        labels.place(i, x, coast.y(Math.max(coast.heightAt(x, z), coast.levelAt(x, z))) + 0.2, z, c, camName === 'overview' ? 0.9 : 0.75);
      }
      STATIONS.forEach((id, k) => {
        const i = labels.index(`st${id}`);
        const j = stationIdx[k]!;
        const s = coast!.field.stations[j];
        if (!s) return labels.hide(i);
        const lv = coast!.stationLevels[j]!;
        // Readout in the tide-table datum (above MLLW) where NOAA publishes it, else relative to mean sea level.
        const shown = s.z0 !== null ? lv - s.offset + s.z0 : lv - s.offset;
        const r = Math.round(shown * 100) / 100;
        if (r !== stationRev[k]) {
          stationRev[k] = r;
          labels.setText(i, `${s.label} ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} m`);
        }
        labels.place(i, s.x, coast!.y(lv), s.z, c, 0.85);
      });
      const clock = `${fmt.format(ms)} PST · relief ×${coast.uniforms.exaggeration.value}`;
      if (clock !== lastClock) {
        lastClock = clock;
        labels.setText(L.clock, clock);
      }
      labels.placeScreen(L.clock, 0.03, 0.95, 0.8);
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
      coast?.dispose();
      coast = null;
    },
  };
  return self;
}
