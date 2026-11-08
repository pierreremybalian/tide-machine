// Stage 3 · The bulge is a wave (HANDOFF §7 row 3). The ocean cannot keep up with the Moon: the M2 tide from EOT20
// (src/scenes/wave/globe.ts) travels as a wave that wheels around amphidromic points, where there is almost no tide.
// Over the Pacific the crest (high water now) sweeps round them as the M2 argument advances; then the camera comes
// down to the West Coast and high water reaches San Diego, Los Angeles, San Francisco, Newport and Seattle in turn,
// at the times NOAA's M2 phase lags give (src/script/wave.ts). The globe's crest and the markers share one clock.

import { PerspectiveCamera, Scene, Vector3, type Mesh, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { Eot20 } from '../../finale/eot20.ts';
import { createBackdropMesh } from '../../shared/water/sky.ts';
import { createMarkers, type Markers } from '../../shared/water/markers.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { smoother, windowed } from '../../time/tracks.ts';
import { DELAY_H, WEST_COAST, fmtDelay, wave, waveState } from '../../script/wave.ts';
import { amphidromes, createGlobe, loadPatch, onSphere, type Globe } from './globe.ts';

interface View {
  /** Camera position: latitude, longitude (degrees) and distance from the centre (globe radii). */
  lat: number;
  lng: number;
  dist: number;
  /** What it looks at: a surface point lifted toward the centre (r = 0 is the centre). */
  tLat: number;
  tLng: number;
  tR: number;
}

const params = {
  fov: 30,
  /** EOT20 at its native 1/8° over the West Coast (the overview is 1/2°). */
  patch: { south: 20, west: -140, north: 60, east: -110 },
  station: { color: [0.55, 0.92, 1.0] as const, size: 12, flare: 30 },
  amphi: { color: [1.0, 0.72, 0.4] as const, size: 10 },
};

/** Camera path (local → view). */
const VIEWS: readonly (readonly [number, View])[] = [
  [0.0, { lat: 10, lng: -162, dist: 4.7, tLat: 10, tLng: -162, tR: 0 }],
  [0.12, { lat: 12, lng: -158, dist: 4.5, tLat: 12, tLng: -158, tR: 0 }],
  [0.46, { lat: 16, lng: -146, dist: 4.1, tLat: 16, tLng: -146, tR: 0 }],
  [0.6, { lat: 27, lng: -133, dist: 1.95, tLat: 40, tLng: -122, tR: 0.8 }],
  [0.9, { lat: 28, lng: -131.5, dist: 1.85, tLat: 40.5, tLng: -122.5, tR: 0.84 }],
  [1.0, { lat: 28.5, lng: -131, dist: 1.85, tLat: 40.5, tLng: -122.5, tR: 0.84 }],
];

function viewAt(local: number, out: View): View {
  const n = VIEWS.length;
  if (local <= VIEWS[0]![0]) return Object.assign(out, VIEWS[0]![1]);
  if (local >= VIEWS[n - 1]![0]) return Object.assign(out, VIEWS[n - 1]![1]);
  let i = 1;
  while (VIEWS[i]![0] < local) i++;
  const [l0, a] = VIEWS[i - 1]!;
  const [l1, b] = VIEWS[i]!;
  const s = smoother((local - l0) / (l1 - l0));
  const lerp = (x: number, y: number) => x + (y - x) * s;
  out.lat = lerp(a.lat, b.lat);
  out.lng = lerp(a.lng, b.lng);
  out.dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist)));
  out.tLat = lerp(a.tLat, b.tLat);
  out.tLng = lerp(a.tLng, b.tLng);
  out.tR = lerp(a.tR, b.tR);
  return out;
}

export default function waveScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 16 / 9, 0.01, 50);
  const view: View = { ...VIEWS[0]![1] };
  const target = new Vector3();
  let globe: Globe | null = null;
  let backdrop: Mesh | null = null;
  let stations: Markers | null = null;
  let amphi: Markers | null = null;
  let amphiPts: { lat: number; lng: number }[] = [];
  const tmp = new Vector3();

  const labels = new LabelSet([
    ...WEST_COAST.map((s) => ({ id: s.id, text: s.name, tone: 'b' as const, side: 'right' as const, size: 'md' as const })),
    { id: 'amphi', text: 'amphidromic point: almost no tide', tone: 'warm', side: 'right', size: 'sm' },
    { id: 'pacific', text: 'Pacific Ocean', tone: 'plain', side: 'center', size: 'md' },
  ]);
  const stationLabel = WEST_COAST.map((s) => labels.index(s.id));
  const amphiLabel = labels.index('amphi');
  const pacificLabel = labels.index('pacific');
  const labelText = WEST_COAST.map(() => '');
  /** The amphidrome labelled: the open-ocean one nearest the north-east Pacific. */
  let labelled = -1;

  /** Hidden when on the far side of the globe. */
  function facing(x: number, y: number, z: number): number {
    tmp.set(x, y, z);
    const d = tmp.dot(camera.position) / camera.position.length();
    return Math.min(1, Math.max(0, (d - 0.15) / 0.2));
  }

  return {
    id: 'wave',
    status: 'measured',
    statusNote: wave.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const eot = await Eot20.load();
      const [ov, patch] = await Promise.all([eot.overview(), loadPatch(eot, params.patch.south, params.patch.west, params.patch.north, params.patch.east)]);
      globe = createGlobe(ov, patch, Math.round(192 * Math.max(0.75, ctx.quality.detail)));
      scene.add(globe.mesh);
      backdrop = createBackdropMesh();
      scene.add(backdrop);
      stations = createMarkers(
        WEST_COAST.map((s) => {
          const [x, y, z] = onSphere(s.lat, s.lng, 1.003);
          return { x, y, z, color: params.station.color, size: params.station.size, intensity: 0, ring: 0 };
        }),
        ctx.globals.uElapsed,
      );
      scene.add(stations.object);
      amphiPts = amphidromes(ov);
      let best = Infinity;
      amphiPts.forEach((a, i) => {
        const d = Math.hypot(a.lat - 28, a.lng + 138);
        if (d < best) {
          best = d;
          labelled = i;
        }
      });
      amphi = createMarkers(
        amphiPts.map((a) => {
          const [x, y, z] = onSphere(a.lat, a.lng, 1.002);
          return { x, y, z, color: params.amphi.color, size: params.amphi.size, intensity: 0, ring: 0.8 };
        }),
        ctx.globals.uElapsed,
      );
      scene.add(amphi.object);
      await renderer.compileAsync(scene, camera);
    },
    update(local, _dt, elapsed) {
      if (!globe || !stations || !amphi) return;
      const s = waveState(local);
      globe.arg.value = s.arg;
      globe.lines.value = s.lines;
      globe.crest.value = s.crest;

      // Camera with a slow idle drift.
      viewAt(local, view);
      const drift = Math.sin(elapsed * 0.05) * 1.2;
      const [cx, cy, cz] = onSphere(view.lat, view.lng + drift, view.dist);
      const [tx, ty, tz] = onSphere(view.tLat, view.tLng, view.tR);
      camera.position.set(cx, cy, cz);
      target.set(tx, ty, tz);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.near = Math.max(0.01, (view.dist - 1) * 0.3);
      camera.far = view.dist + 2;
      camera.updateProjectionMatrix();

      // West Coast: markers flare as the crest passes; labels give the delay after San Diego once reached.
      WEST_COAST.forEach((st, i) => {
        const f = s.flare[i]!;
        stations!.setIntensity(i, s.coast * (0.7 + 1.6 * f));
        stations!.setSize(i, params.station.size + params.station.flare * f);
        stations!.setRing(i, f);
        const text = i > 0 && s.passed >= i ? `${st.name} +${fmtDelay(DELAY_H[i]!)}` : st.name;
        if (text !== labelText[i]) {
          labelText[i] = text;
          labels.setText(stationLabel[i]!, text);
        }
        const [x, y, z] = onSphere(st.lat, st.lng, 1.003);
        labels.place(stationLabel[i]!, x, y, z, camera, s.coast * facing(x, y, z) * (s.passed >= i ? 1 : 0.6));
      });
      stations.update(camera);
      stations.commit();
      amphiPts.forEach((a, i) => amphi!.setIntensity(i, 1.2 * s.amphi));
      amphi.update(camera);
      amphi.commit();
      if (labelled >= 0) {
        const a = amphiPts[labelled]!;
        const [x, y, z] = onSphere(a.lat, a.lng, 1.002);
        labels.place(amphiLabel, x, y, z, camera, s.amphi * facing(x, y, z));
      } else labels.hide(amphiLabel);
      const [px, py, pz] = onSphere(5, -150, 1.0);
      labels.place(pacificLabel, px, py, pz, camera, 0.7 * windowed(local, 0.02, 0.5, 0.04, 0.05) * facing(px, py, pz));
    },
    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    resize(width: number, height: number) {
      camera.aspect = width / height;
      // Portrait: pull back so the globe still fits.
      camera.fov = width >= height ? params.fov : Math.min(70, params.fov * Math.pow(height / width, 0.85));
      camera.updateProjectionMatrix();
    },
    dispose() {
      globe?.dispose();
      stations?.dispose();
      amphi?.dispose();
      if (backdrop) {
        backdrop.geometry.dispose();
        (backdrop.material as { dispose(): void }).dispose();
      }
      globe = null;
      stations = null;
      amphi = null;
      backdrop = null;
    },
  };
}
