// Coast lab scene factory (dev scenes _bay and _harbor; also a template for the coast stages): a coast with the
// water at the predicted level for a time driven by `local`, an orbit rig with named camera presets, place labels
// and station readouts. Dev URL parameters: &cam=<preset> &exag=<×> &sun=real|<az>,<el> &waves=<0–2> &foam=<0–1>
// &debug=1|2|3 (wave travel times, wave amplitudes, wet/depth).

import { Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext, Status } from '../../scenes/types.ts';
import { createCoast, type Coast, type CoastWaves } from './coast.ts';
import { OrbitRig, type RigPose } from '../gfx/rig.ts';
import { LabelSet, type LabelSpec } from '../gfx/labels.ts';
import { sunPosition } from '../../coast/sun.ts';

export interface LabCamera {
  lat: number;
  lng: number;
  /** Radians; 0 puts the camera south of the target looking north. */
  az: number;
  /** Radians above the horizon. */
  el: number;
  /** km. */
  dist: number;
  fov?: number;
  /** Vertical exaggeration for this view (default: the lab's). */
  exag?: number;
}

export interface CoastLabConfig {
  id: string;
  region: string;
  status: Status;
  statusNote: string;
  exaggeration: number;
  /** local 0 → startMs; local 1 → startMs + spanHours. */
  startMs: number;
  spanHours: number;
  /** Fixed light (degrees) unless &sun=real. */
  sun: { azimuth: number; elevation: number };
  /** Where the real sun is computed for &sun=real. */
  sunSite: { lat: number; lng: number };
  timeZone: string;
  zoneLabel: string;
  waves?: Partial<CoastWaves>;
  bandHeight?: [number, number, number];
  cameras: Record<string, LabCamera>;
  defaultCamera: string;
  places: { id: string; text: string; lat: number; lng: number }[];
  stations: string[];
  /** World-space vignette start (fraction of the half-extent) and edge fade (km). */
  vignette?: number;
  edgeFade?: number;
}

function urlParams(): URLSearchParams {
  return typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
}

export function createCoastLab(cfg: CoastLabConfig): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(cfg.cameras[cfg.defaultCamera]?.fov ?? 34);
  let coast: Coast | null = null;
  const q = urlParams();
  const camName = q.get('cam') && cfg.cameras[q.get('cam')!] ? q.get('cam')! : cfg.defaultCamera;
  const cam = cfg.cameras[camName]!;
  const sunMode = q.get('sun') ?? '';
  const pose: RigPose = { az: cam.az, el: cam.el, dist: cam.dist, tx: 0, tt: 0, ty: 0, fov: cam.fov ?? 34 };
  let stationIdx: number[] = [];
  const stationRev = new Float64Array(cfg.stations.length).fill(NaN);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let lastClock = '';
  const overview = cam.dist > 50;

  const specs: LabelSpec[] = [
    ...cfg.places.map((p) => ({ id: `pl-${p.id}`, text: p.text, tone: 'plain' as const, side: 'center' as const, size: 'md' as const })),
    ...cfg.stations.map((id) => ({ id: `st-${id}`, text: id, tone: 'b' as const, side: 'right' as const, size: 'md' as const })),
    { id: 'clock', text: '', tone: 'mute', side: 'right', size: 'sm' },
  ];
  const labels = new LabelSet(specs);
  const clockIdx = labels.index('clock');
  const placeIdx = cfg.places.map((p) => labels.index(`pl-${p.id}`));
  const stationLabelIdx = cfg.stations.map((id) => labels.index(`st-${id}`));

  return {
    id: cfg.id,
    status: cfg.status,
    statusNote: cfg.statusNote,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const exag = Number(q.get('exag') ?? cam.exag ?? cfg.exaggeration);
      let sun = cfg.sun;
      if (sunMode && sunMode !== 'real') {
        const [az, el] = sunMode.split(',').map(Number);
        if (Number.isFinite(az) && Number.isFinite(el)) sun = { azimuth: az!, elevation: el! };
      }
      // Close-up presets pack mesh vertices around the target (the full region keeps a uniform grid).
      const focus = cam.dist < 40 ? { lat: cam.lat, lng: cam.lng, radius: cam.dist * 1.2 } : undefined;
      coast = await createCoast(ctx, { region: cfg.region, exaggeration: exag, sun, focusLatLng: focus, waves: cfg.waves });
      const u = coast.uniforms;
      if (cfg.bandHeight) u.bandHeight.value.set(...cfg.bandHeight);
      if (cfg.vignette !== undefined) u.vignette.value = cfg.vignette;
      if (cfg.edgeFade !== undefined) u.edgeFade.value = cfg.edgeFade;
      if (q.get('waves')) u.waveStrength.value = Number(q.get('waves'));
      if (q.get('debug')) u.debug.value = Number(q.get('debug'));
      if (q.get('foam')) u.foam.value = Number(q.get('foam'));
      scene.add(coast.object);
      const p = coast.projection;
      pose.tx = p.x(cam.lng);
      pose.ty = p.z(cam.lat);
      stationIdx = cfg.stations.map((id) => coast!.field.stations.findIndex((s) => s.id === id));
      cfg.stations.forEach((_, i) => {
        const s = coast!.field.stations[stationIdx[i]!];
        if (s) labels.setText(stationLabelIdx[i]!, s.label);
      });
      coast.update(cfg.startMs, 0);
      await renderer.compileAsync(scene, rig.camera);
    },
    update(local, _dt, elapsed) {
      if (!coast) return;
      const ms = cfg.startMs + local * cfg.spanHours * 3600e3;
      coast.update(ms, elapsed);
      if (sunMode === 'real') {
        const s = sunPosition(ms, cfg.sunSite.lat, cfg.sunSite.lng);
        coast.setSun(s.azimuth, Math.max(s.elevation, -4));
      }
      pose.tt = coast.y(1);
      rig.apply(pose, elapsed);
      const c = rig.camera;
      const d = pose.dist * rig.fit();
      c.near = Math.max(0.005, d * 0.02);
      c.far = d * 6 + 60;
      c.updateProjectionMatrix();
      coast.uniforms.hazeStart.value = d * 0.9;
      coast.uniforms.hazeDensity.value = 0.9 / (d + 10);

      const p = coast.projection;
      cfg.places.forEach((pl, k) => {
        const x = p.x(pl.lng);
        const z = p.z(pl.lat);
        labels.place(placeIdx[k]!, x, coast!.y(Math.max(coast!.heightAt(x, z), coast!.levelAt(x, z))) + 0.05 * d * 0.02, z, c, overview ? 0.9 : 0.75);
      });
      cfg.stations.forEach((_, k) => {
        const i = stationLabelIdx[k]!;
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
      const clock = `${fmt.format(ms)} ${cfg.zoneLabel} · levels above MLLW · relief ×${coast.uniforms.exaggeration.value}`;
      if (clock !== lastClock) {
        lastClock = clock;
        labels.setText(clockIdx, clock);
      }
      labels.placeScreen(clockIdx, 0.03, 0.95, 0.8);
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
}
