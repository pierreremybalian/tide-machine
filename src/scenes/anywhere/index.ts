// Stage 13 · Any coast on Earth (HANDOFF §10). The finale's view, driven by src/finale/ui/state.ts:
//  - the globe (src/scenes/anywhere/globe.ts): NOAA's stations, EOT20's tide tint, the Sun's day and night; the
//    reader turns it (the UI writes $globe) and picks a point (bridge.pick, a ray against the sphere);
//  - on a choice, the camera flies down to the place while the controller fetches the tide constants and the
//    terrain; then a quick dip through black into the live coast (src/shared/water) built from the streamed tiles,
//    its water at the predicted level for now (or the scrubbed machine time), with a bead and a label at the shore;
//  - Old Brass Brains set to the place's constants drawing the week, in the slot the place card reserves for it
//    ($layout.slot), through the brass outline pass.
// Every level is predict() from the place's constants (via the coast's tide field and the machine's mechanism).

import { Mesh, MeshBasicNodeMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import { uniform, vec4 } from 'three/tsl';
import type { BlockScene, RenderContext } from '../types.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { coastSourceFrom } from '../../shared/water/data.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { createGlowLine, createGlowPoints, type GlowLine, type GlowPoints } from '../../shared/brass/lines.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import { sunPosition } from '../../coast/sun.ts';
import { Eot20 } from '../../finale/eot20.ts';
import { loadStationList } from '../../finale/noaa.ts';
import { $reducedMotion } from '../../state/store.ts';
import { smooth } from '../../time/tracks.ts';
import { anywhere, anywhereState } from '../../script/anywhere.ts';
import { $coastStatus, $coastView, $crankMs, $finale, $globe, $hover, $layout, $toolOn, WEEK_MS, bridge, type Rect, type Spot } from '../../finale/ui/state.ts';
import { SUGGESTED } from '../../finale/ui/suggested.ts';
import { createGlobe, latLngFromUnit, unitFromLatLng, type Globe } from './globe.ts';

const params = {
  fov: 30,
  /** Camera distance (globe radii from the centre) when flown down to a place. */
  flyDist: 1.32,
  /** Seconds for the dip through black between globe and coast. */
  dip: 0.9,
  /** Coast orbit: elevation (radians) and distance (km). */
  coast: { el: 0.52, dist: 15, fov: 34 },
  /** Fixed light when it is night at the place (degrees). */
  nightSun: { azimuth: 235, elevation: 18 },
  machine: { az: 0.3, el: 0.1, fov: 30, fill: { x: 1.1, y: 0.9 } },
};

const D2R = Math.PI / 180;
const fmtLevel = (m: number) => `${m < 0 ? '−' : '+'}${Math.abs(m).toFixed(2)} m`;

export default function makeAnywhereScene(): BlockScene {
  let renderer: WebGPURenderer;
  let ctxRef: RenderContext;
  const globeScene = new Scene();
  const gCam = new PerspectiveCamera(params.fov, 1, 0.01, 40);
  let globe: Globe | null = null;
  const coastScene = new Scene();
  const cRig = new OrbitRig(params.coast.fov);
  let coast: Coast | null = null;
  let coastKey = '';
  let building = '';
  let bead: GlowPoints;
  let beam: GlowLine;
  const mScene = new Scene();
  const mOverlay = new Scene();
  const mRig = new OrbitRig(params.machine.fov);
  let machine: BrassMachine | null = null;
  let machineKey = '';
  let mDist = 10;
  let outline: Outline;
  // A full-screen black quad for the dip between views.
  const fadeScene = new Scene();
  const fadeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fadeOpacity = uniform(0);
  const fadeMat = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
  fadeMat.colorNode = vec4(0, 0, 0, 1);
  fadeMat.opacityNode = fadeOpacity;
  const fadeQuad = new Mesh(new PlaneGeometry(2, 2), fadeMat);
  fadeScene.add(fadeQuad);

  const labels = new LabelSet([
    ...SUGGESTED.map((p) => ({ id: `s-${p.id}`, text: p.name, tone: 'plain' as const, side: 'right' as const, size: 'sm' as const })),
    { id: 'here', text: '', tone: 'warm', side: 'above', size: 'md' },
    { id: 'station', text: '', tone: 'b', side: 'right', size: 'sm' },
  ]);
  const Lhere = labels.index('here');
  const Lstation = labels.index('station');
  const Lplaces = SUGGESTED.map((p) => labels.index(`s-${p.id}`));

  let W = 1280;
  let H = 720;
  let dpr = 1;
  // View state (smoothed toward the stores).
  const view = { lat: 24, lng: -38, dist: 4.6 };
  let spin = 0;
  let cross = 0; // 0 globe … 1 coast
  let rev = 0;
  let lastHere = '';
  const unsubs: (() => void)[] = [];
  const v = new Vector3();
  const v2 = new Vector3();
  const corner = new Vector3();
  const ndc = new Vector3();
  let free: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const order = new Int32Array(SUGGESTED.length);

  /** Camera sees what a camera of the rect's shape would, centred in the rect (see src/scenes/crank). */
  function offsetFor(cam: PerspectiveCamera, r: Rect) {
    const pw = Math.max(1, r.w * W);
    const ph = Math.max(1, r.h * H);
    cam.aspect = pw / ph;
    cam.setViewOffset(pw, ph, -r.x * W, -r.y * H, W, H);
    cam.updateProjectionMatrix();
    return ph;
  }

  function placeGlobeCamera(lat: number, lng: number, d: number) {
    // Narrow views pull back so the globe fits across as well as up and down.
    const aspect = (free.w * W) / Math.max(1, free.h * H);
    const dist = aspect < 1 ? 1 + (d - 1) * Math.pow(aspect, -0.8) : d;
    unitFromLatLng(Math.max(-82, Math.min(82, lat)), lng, v).multiplyScalar(dist);
    gCam.position.copy(v);
    gCam.up.set(0, 1, 0);
    gCam.lookAt(0, 0, 0);
    gCam.near = Math.max(0.005, (dist - 1) * 0.3);
    gCam.far = dist + 2;
    const ph = offsetFor(gCam, free);
    gCam.updateMatrixWorld();
    globe?.setCamera(gCam, ph);
  }

  /** Ray from a screen point (fractions, top-left) through the globe camera to the unit sphere. */
  function pick(fx: number, fy: number): { lat: number; lng: number } | null {
    if (!globe || cross > 0.5) return null;
    gCam.updateMatrixWorld();
    ndc.set(fx * 2 - 1, 1 - fy * 2, 0.5).unproject(gCam);
    const o = gCam.position;
    const d = v2.copy(ndc).sub(o).normalize();
    const b = o.dot(d);
    const c = o.lengthSq() - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    return latLngFromUnit(v.copy(o).addScaledVector(d, t));
  }

  async function buildCoast(spot: Spot) {
    if (!spot.terrain || building === spot.key) return;
    building = spot.key;
    $coastStatus.set({ key: spot.key, status: 'building' });
    try {
      const s = spot.source;
      const station = {
        id: s.id,
        name: s.station?.name ?? 'EOT20',
        label: s.station?.name ?? 'EOT20',
        lat: s.at.lat,
        lng: s.at.lng,
        z0: s.datumLabel === 'MLLW' ? s.z0 : null,
        // The tiles' heights are near mean sea level (geoid) on land and charted depths at sea: tide about MSL.
        mslNavd88: 0,
        constituents: s.constants,
      };
      const t = spot.terrain;
      const src = coastSourceFrom(`finale:${spot.key}`, spot.place.name, t.hf, [station]);
      const towardLand = t.facts.towardLand;
      const c = await createCoast(ctxRef, {
        source: src,
        exaggeration: t.exaggeration,
        waves: { swellToward: towardLand, swellPeriod: 10, windToward: towardLand + 15 },
        sun: params.nightSun,
        focusLatLng: { lat: t.facts.target.lat, lng: t.facts.target.lng, radius: 6, gain: 4 },
        // Salt ponds and levees are San Francisco Bay's; on live tiles flat lidar water would be mistaken for them.
        bake: { tidal: { pondMinCells: 1e9, leveeProminence: 1e6, depression: 1e6 } },
      });
      if (building !== spot.key || $finale.get().spot?.key !== spot.key) {
        c.dispose();
        return;
      }
      c.uniforms.resolution.value.set(W, H);
      // A 24 km box: the SF-sized edge fade (8 km) would fog most of it.
      c.uniforms.edgeFade.value = 2.2;
      c.uniforms.vignette.value = 0.9;
      c.update(Date.now(), 0);
      await renderer.compileAsync(c.object, cRig.camera);
      if ($finale.get().spot?.key !== spot.key) {
        c.dispose();
        return;
      }
      if (coast) {
        coastScene.remove(coast.object);
        coast.dispose();
      }
      coast = c;
      coastKey = spot.key;
      coastScene.add(c.object);
      $coastStatus.set({ key: spot.key, status: 'ready' });
    } catch (err) {
      console.error('[anywhere] coast failed', err);
      if (building === spot.key) $coastStatus.set({ key: spot.key, status: 'failed' });
    } finally {
      if (building === spot.key) building = '';
      rev++;
    }
  }

  function buildMachine(spot: Spot) {
    if (machine) {
      mScene.remove(machine.solids);
      mOverlay.remove(machine.overlay);
      machine.dispose();
      machine = null;
    }
    machineKey = spot.key;
    const s = spot.source;
    machine = createMachine(ctxRef, { machine: 'obb', station: { id: s.id, z0: s.z0, constituents: s.constants }, t0: spot.weekT0, span: WEEK_MS });
    mScene.add(machine.solids);
    mOverlay.add(machine.overlay);
    const fp = machine.crankParts[machine.featured]!;
    machine.setHot(fp[0], fp[1], fp[2]);
    void outline.compile(mOverlay);
  }

  function dropCoast() {
    if (coast) {
      coastScene.remove(coast.object);
      coast.dispose();
      coast = null;
    }
    coastKey = '';
  }

  const self: BlockScene = {
    id: 'anywhere',
    status: 'measured',
    statusNote: anywhere.note,
    labels,
    revision: () => rev,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      ctxRef = ctx;
      const [model, list] = await Promise.all([Eot20.load(), loadStationList().catch(() => [])]);
      const ov = await model.overview();
      globe = createGlobe(ov, list, SUGGESTED);
      globeScene.add(...globe.meshes);
      const g = $globe.get();
      Object.assign(view, g);
      bead = createGlowPoints(1, [1.0, 0.8, 0.45], { radius: 0.06, intensity: 2.4 });
      beam = createGlowLine(2, [1.0, 0.82, 0.55], { width: 0.03, intensity: 1.1 });
      coastScene.add(bead.mesh, beam.mesh);
      outline = createOutline(renderer, mScene, mRig.camera, { resolutionScale: ctx.quality.renderScale });
      bridge.pick = pick;
      const bump = () => {
        rev++;
      };
      for (const st of [$finale, $globe, $coastView, $crankMs, $layout, $hover, $toolOn, $coastStatus]) unsubs.push((st as { subscribe(f: () => void): () => void }).subscribe(bump));
      placeGlobeCamera(view.lat, view.lng, view.dist);
      await renderer.compileAsync(globeScene, gCam);
    },

    update(local, dt, elapsed) {
      if (!globe) return;
      const reduced = $reducedMotion.get();
      const a = anywhereState(local);
      const f = $finale.get();
      const spot = f.spot;
      const lay = $layout.get();
      free = lay.free;
      const now = Date.now();
      const ms = spot ? Math.min(spot.weekT0 + WEEK_MS, Math.max(spot.weekT0, $crankMs.get() ?? now)) : now;

      // Builds for the current spot.
      if (spot && spot.terrain && coastKey !== spot.key && building !== spot.key) void buildCoast(spot);
      if (!spot && coast && cross < 0.01) dropCoast();
      if (spot && machineKey !== spot.key) buildMachine(spot);
      if (!spot && machine && cross < 0.01) {
        mScene.remove(machine.solids);
        mOverlay.remove(machine.overlay);
        machine.dispose();
        machine = null;
        machineKey = '';
      }

      // ── Globe camera: the reader's view, or down to the place.
      const target = f.target;
      const flying = !!target && (f.phase === 'locating' || f.phase === 'ready');
      const g = $globe.get();
      if (!$toolOn.get() && !flying) spin += a.spin * dt * 57.3;
      else if (spin !== 0) {
        // The reader takes over from where the intro spin left the globe.
        $globe.set({ ...g, lng: g.lng + spin });
        spin = 0;
      }
      const want = flying ? { lat: target.lat, lng: target.lng, dist: params.flyDist } : { lat: g.lat, lng: g.lng + spin, dist: g.dist };
      const k = reduced ? 1 : 1 - Math.exp(-dt * (flying ? 3.2 : 9));
      const dl = ((((want.lng - view.lng) % 360) + 540) % 360) - 180;
      view.lng += dl * k;
      view.lat += (want.lat - view.lat) * k;
      view.dist += (want.dist - view.dist) * (reduced ? 1 : 1 - Math.exp(-dt * (flying ? 2.6 : 6)));
      placeGlobeCamera(view.lat, view.lng, view.dist);
      globe.tint.value = Math.max(a.tint, a.tool);
      globe.stations.value = Math.max(a.stations, a.tool);
      globe.time.value = elapsed;
      // Subsolar point → sun direction in the globe's frame.
      sunDir(now, v);
      globe.sun.value.copy(v);
      const hv = $hover.get();
      if (hv && !flying) {
        unitFromLatLng(hv.lat, hv.lng, globe.hover.value);
        globe.hoverOn.value = 1;
      } else globe.hoverOn.value = 0;
      if (target) {
        unitFromLatLng(target.lat, target.lng, globe.pick.value);
        globe.pickOn.value = 1;
      } else globe.pickOn.value = 0;
      // Suggested places' labels on the visible side, skipping any that would crowd one already placed.
      unitFromLatLng(view.lat, view.lng, v2);
      let placed = 0;
      SUGGESTED.forEach((p, i) => {
        unitFromLatLng(p.lat, p.lng, v);
        const facing = v.dot(v2);
        const o = (1 - cross) * a.tool * Math.max(0, Math.min(1, (facing - 0.35) / 0.2)) * (flying ? 0 : 0.85);
        v.multiplyScalar(1.01);
        labels.place(Lplaces[i]!, v.x, v.y, v.z, gCam, o);
        const st = labels.state[Lplaces[i]!]!;
        for (let j = 0; j < placed; j++) {
          const q = labels.state[Lplaces[order[j]!]!]!;
          if (q.opacity > 0 && Math.abs(q.x - st.x) * W < 110 && Math.abs(q.y - st.y) * H < 18) st.opacity = 0;
        }
        if (st.opacity > 0) order[placed++] = i;
      });

      // ── Dip between globe and coast.
      const wantCoast = f.phase === 'ready' && !!coast && coastKey === spot?.key && view.dist < params.flyDist + 0.6;
      const step = reduced ? 1 : dt / params.dip;
      cross = wantCoast ? Math.min(1, cross + step) : Math.max(0, cross - step);
      fadeOpacity.value = smooth(1 - Math.abs(2 * cross - 1));

      // ── Coast.
      if (coast && spot?.terrain) {
        coast.update(ms, elapsed);
        const t = spot.terrain;
        const sun = sunPosition(ms, t.facts.target.lat, t.facts.target.lng);
        if (sun.elevation > 6) coast.setSun(sun.azimuth, Math.min(sun.elevation, 55));
        else coast.setSun(params.nightSun.azimuth, params.nightSun.elevation);
        const p = coast.projection;
        const cv = $coastView.get();
        const tx = p.x(t.facts.target.lng);
        const tz = p.z(t.facts.target.lat);
        const lv = coast.levelAt(tx, tz);
        const dist = params.coast.dist * cv.zoom;
        const az = -t.facts.towardLand * D2R + cv.az;
        const el = Math.max(0.12, Math.min(1.35, params.coast.el + cv.el));
        const cam = cRig.camera;
        cam.clearViewOffset();
        cam.aspect = Math.max(0.3, (free.w * W) / Math.max(1, free.h * H));
        cRig.drift = reduced ? 0 : 1;
        cRig.apply({ az, el, dist, tx, tt: coast.y(lv), ty: tz, fov: params.coast.fov }, elapsed);
        const d = dist * cRig.fit();
        cam.near = Math.max(0.01, d * 0.02);
        cam.far = d * 6 + 40;
        offsetFor(cam, free);
        coast.uniforms.hazeStart.value = d * 0.9;
        coast.uniforms.hazeDensity.value = 0.9 / (d + 10);
        // The shore bead and its beam at the place; the label reads the place card's number (the source's datum).
        const y = coast.y(lv);
        bead.set(0, tx, y + 0.004, tz, cross);
        bead.commit();
        beam.set(0, tx, y, tz);
        beam.set(1, tx, y + d * 0.07, tz);
        beam.commit(2);
        beam.intensity.value = 1.0 * cross;
        const st = coast.field.stations[0];
        const shown = st && st.z0 !== null ? lv - st.offset + st.z0 : lv - (st?.offset ?? 0);
        const text = `${spot.place.name} ${fmtLevel(shown)}`;
        if (text !== lastHere) {
          lastHere = text;
          labels.setText(Lhere, text);
        }
        labels.place(Lhere, tx, y + d * 0.075, tz, cam, cross);
        // The NOAA station, when it is not at the place itself.
        if (spot.source.kind === 'measured' && spot.source.station && spot.source.distanceKm > 0.8) {
          const sx = p.x(spot.source.at.lng);
          const sz = p.z(spot.source.at.lat);
          labels.setText(Lstation, `NOAA ${spot.source.station.name}`);
          labels.place(Lstation, sx, coast.y(Math.max(coast.heightAt(sx, sz), coast.levelAt(sx, sz))) + 0.02, sz, cam, cross * 0.85);
        } else labels.hide(Lstation);
      } else {
        labels.hide(Lhere);
        labels.hide(Lstation);
      }

      // ── Machine in its slot.
      if (machine && spot) {
        machine.update(ms);
        const slot = lay.slot;
        if (slot) {
          const b = machine.bounds;
          const cam = mRig.camera;
          cam.clearViewOffset();
          cam.aspect = Math.max(0.3, (slot.w * W) / Math.max(1, slot.h * H));
          const mp = params.machine;
          for (let it = 0; it < 4; it++) {
            mRig.apply({ az: mp.az, el: mp.el, dist: mDist / mRig.fit(), tx: b.centre.x, tt: b.centre.y, ty: b.centre.z }, elapsed);
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld();
            let mx = 0;
            let my = 0;
            for (let c = 0; c < 8; c++) {
              corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).project(cam);
              mx = Math.max(mx, Math.abs(corner.x));
              my = Math.max(my, Math.abs(corner.y));
            }
            const fit = Math.max(mx / mp.fill.x, my / mp.fill.y);
            if (Math.abs(fit - 1) < 0.01) break;
            mDist *= fit;
          }
          cam.near = Math.max(0.05, mDist * 0.05);
          cam.far = mDist * 6 + 20;
          offsetFor(cam, slot);
        }
      }
    },

    render(target: RenderTarget) {
      const TW = target.width;
      const TH = target.height;
      renderer.setRenderTarget(target);
      if (cross < 0.5 || !coast) renderer.render(globeScene, gCam);
      else renderer.render(coastScene, cRig.camera);
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      if (fadeOpacity.value > 0.002) renderer.render(fadeScene, fadeCam);
      // The machine, inside the visible part of its slot in the place card.
      const lay = $layout.get();
      const clip = lay.clip;
      if (machine && lay.slot && clip && clip.w > 0.01 && clip.h > 0.01 && $finale.get().phase === 'ready') {
        target.scissor.set(Math.round(clip.x * TW), Math.round(clip.y * TH), Math.max(1, Math.round(clip.w * TW)), Math.max(1, Math.round(clip.h * TH)));
        renderer.setScissorTest(true);
        outline.render(target, mOverlay);
        renderer.setScissorTest(false);
        target.scissor.set(0, 0, TW, TH);
      }
      renderer.autoClear = auto;
    },

    resize(width: number, height: number, d: number) {
      W = width;
      H = height;
      dpr = d;
      outline?.setSize(width, height, dpr);
      coast?.uniforms.resolution.value.set(width, height);
    },

    dispose() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      if (bridge.pick === pick) bridge.pick = null;
      globe?.dispose();
      globe = null;
      dropCoast();
      building = '';
      if (machine) machine.dispose();
      machine = null;
      machineKey = '';
      outline?.dispose();
      bead?.dispose();
      beam?.dispose();
      fadeQuad.geometry.dispose();
      fadeMat.dispose();
      globeScene.clear();
      coastScene.clear();
      mScene.clear();
      mOverlay.clear();
      $coastStatus.set(null);
    },
  };
  return self;
}

/** Unit vector to the Sun in the globe's frame (x = cos φ sin λ, y = sin φ, z = cos φ cos λ): the subsolar point. */
function sunDir(ms: number, out: Vector3): Vector3 {
  const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400e3;
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const lng = (ra / D2R / 15 - gmst) * 15;
  return unitFromLatLng(dec / D2R, ((lng % 360) + 540) % 360 - 180, out);
}
