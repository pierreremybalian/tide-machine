// Stage 11 · Turn the crank (HANDOFF §7 row 11). Old Brass Brains, set to San Francisco, beside the bay: scroll turns
// the crank, the pen draws the week, and the bay's water stands where the 35 in-bay stations put it at the same
// machine instant. The pen's height and the Golden Gate's water level are the same number. NOAA's official hourly
// prediction is laid on the paper as dots; the HUD card and the dual clock give the largest difference (computed in
// src/script/crank.ts).
//
// Layout: the machine renders full frame through the outline pass with a view offset that centres it in its panel;
// the bay renders into the other panel (scissored). Landscape: machine left, bay right. Portrait: bay above, machine
// below (the HUD card draws the matching divider).

import { Group, Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { createGlowLine, createGlowPoints, type GlowLine, type GlowPoints } from '../../shared/brass/lines.ts';
import { createCoast, type Coast } from '../../shared/water/coast.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import { smooth } from '../../time/tracks.ts';
import { CRANK_SPAN, CRANK_T0, HOUR_MS, NOAA_WEEK, SF, WEEK_H, crank, crankState, type CrankState } from '../../script/crank.ts';

const params = {
  exaggeration: 3,
  /** Fixed mid-afternoon winter light (degrees): a week of real day and night would black out half the scroll. */
  sun: { azimuth: 238, elevation: 21 },
  /** Bay camera: from the Pacific, looking east through the Golden Gate into the Central Bay. */
  bay: { lat: 37.795, lng: -122.405, az: -1.28, el: 0.36, dist: 30, fov: 34 },
  bayPortrait: { lat: 37.8, lng: -122.42, az: -1.3, el: 0.42, dist: 34 },
  fortPoint: { lat: SF.lat, lng: SF.lng },
  /** Machine orbit (radians; + looks from the pen end), slow swing over the stage, and how much of its panel it fills. */
  machine: { az: 0.5, swing: 0.16, el: 0.13, fov: 30, fillAlone: { x: 0.8, y: 0.74 } },
  /** In the diptych the machine's camera closes in on the pen end (wire, last pulleys, paper and pen). */
  machineClose: { az: 0.62, fill: { x: 2.1, y: 0.82 } },
  machinePortrait: { az: 0.75, fill: { x: 2.5, y: 0.8 } },
  /** Bay panel share of the screen in the diptych (landscape width / portrait height). */
  share: { landscape: 0.5, portrait: 0.47 },
  /** Portrait: share of the space below the bay the machine is framed in (the caption owns the rest). */
  portraitMachineHeight: 0.64,
  /** NOAA dots on the paper. */
  dot: { radius: 0.012, colour: [0.35, 0.82, 1.0] as const, intensity: 1.0, brightness: 0.42 },
};

const LABELS = [
  { id: 'pen', text: 'pen', tone: 'warm', side: 'right', size: 'md' },
  { id: 'gate', text: 'Golden Gate', tone: 'warm', side: 'above', size: 'md' },
  { id: 'pacific', text: 'Pacific Ocean', tone: 'plain', side: 'center', size: 'sm' },
  { id: 'bay', text: 'San Francisco Bay', tone: 'plain', side: 'center', size: 'sm' },
  { id: 'oakland', text: 'Oakland', tone: 'mute', side: 'center', size: 'sm' },
  { id: 'sausalito', text: 'Sausalito', tone: 'mute', side: 'center', size: 'sm' },
] as const;
type LabelId = (typeof LABELS)[number]['id'];

const PLACES: Record<'pacific' | 'bay' | 'oakland' | 'sausalito', { lat: number; lng: number }> = {
  pacific: { lat: 37.74, lng: -122.6 },
  bay: { lat: 37.72, lng: -122.3 },
  oakland: { lat: 37.805, lng: -122.255 },
  sausalito: { lat: 37.858, lng: -122.487 },
};

const metres = (m: number) => `${m < 0 ? '−' : '+'}${Math.abs(m).toFixed(2)} m`;

export default function makeCrankScene(): BlockScene {
  let renderer: WebGPURenderer;
  const machineScene = new Scene();
  const overlay = new Scene();
  const bayScene = new Scene();
  const mRig = new OrbitRig(params.machine.fov);
  const bRig = new OrbitRig(params.bay.fov);
  let machine: BrassMachine;
  let outline: Outline;
  let coast: Coast | null = null;
  let dots: GlowPoints;
  let gateDot: GlowPoints;
  let beam: GlowLine;
  const dotGroup = new Group();
  const labels = new LabelSet(LABELS.map((l) => ({ ...l })));
  const L = Object.fromEntries(LABELS.map((l) => [l.id, labels.index(l.id)])) as Record<LabelId, number>;
  let W = 1280;
  let H = 720;
  let state: CrankState = crankState(0);
  let mDist = 10;
  let gateX = 0;
  let gateZ = 0;
  let lastPen = NaN;
  let lastGate = NaN;
  // Paper geometry, derived from the machine's spots (see deriveFeed).
  let penX = 0;
  let feed = 0;
  let paperZ = 0;
  let paperLeft = 0;
  const v = new Vector3();
  const corner = new Vector3();
  // Panels (fractions, top-left origin) of the machine and the bay for the current split.
  const mPanel = { x: 0, y: 0, w: 1, h: 1 };
  const bPanel = { x: 1, y: 0, w: 0, h: 1 };

  const portrait = () => W < H;

  /** Hide a label whose anchor falls outside its panel (with a margin for the text, as a fraction of the screen). */
  function clip(i: number, p: typeof mPanel, margin = 0.02) {
    const st = labels.state[i]!;
    if (st.x < p.x + margin || st.x > p.x + p.w - margin || st.y < p.y + margin || st.y > p.y + p.h - margin) st.opacity = 0;
  }

  /** Panels for split k (0: machine alone, 1: diptych). */
  function layout(k: number) {
    if (portrait()) {
      // The machine keeps clear of the caption at the bottom of a phone screen.
      const s = params.share.portrait * k;
      Object.assign(bPanel, { x: 0, y: 0, w: 1, h: s });
      Object.assign(mPanel, { x: 0, y: s, w: 1, h: (1 - s) * params.portraitMachineHeight });
    } else {
      const s = params.share.landscape * k;
      Object.assign(mPanel, { x: 0, y: 0, w: 1 - s, h: 1 });
      Object.assign(bPanel, { x: 1 - s, y: 0, w: s, h: 1 });
    }
  }

  /**
   * Render full frame but see what a camera of the panel's shape sees, inside the panel: the panel is the camera's
   * "full" image and the screen a window around it (three's setViewOffset, origin top-left).
   */
  function offsetFor(rig: OrbitRig, p: typeof mPanel) {
    const cam = rig.camera;
    const pw = Math.max(1, p.w * W);
    const ph = Math.max(1, p.h * H);
    cam.aspect = pw / ph;
    cam.setViewOffset(pw, ph, -p.x * W, -p.y * H, W, H);
  }

  // Where the paper's points sit: the brass assembly lays its trace in a group at x = penX − feed·(t − t0), with
  // feed = (penX − takeX − takeR) / 2.5 days and y = the pen's height for that instant (src/shared/brass/assembly.ts).
  function deriveFeed() {
    machine.locate('pen', 0, v);
    penX = v.x;
    machine.locate('paper', 0, v);
    const takeX = 2 * v.x - penX;
    paperZ = v.z + 0.012;
    const TAKE_R = 0.15;
    feed = (penX - (takeX + TAKE_R)) / (2.5 * 86400e3);
    paperLeft = takeX + TAKE_R * 0.6 + 0.2;
  }

  const self: BlockScene = {
    id: 'crank',
    status: 'measured',
    statusNote: crank.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      machine = createMachine(ctx, { machine: 'obb', station: SF, t0: CRANK_T0, span: CRANK_SPAN });
      machineScene.add(machine.solids);
      overlay.add(machine.overlay);
      const fp = machine.crankParts[machine.featured]!;
      machine.setHot(fp[0], fp[1], fp[2]);
      deriveFeed();
      dots = createGlowPoints(WEEK_H + 1, params.dot.colour, { radius: params.dot.radius, intensity: params.dot.intensity });
      dotGroup.add(dots.mesh);
      overlay.add(dotGroup);

      coast = await createCoast(ctx, {
        region: 'sf',
        exaggeration: params.exaggeration,
        sun: params.sun,
        focusLatLng: { lat: params.bay.lat, lng: params.bay.lng, radius: 18, gain: 3 },
      });
      bayScene.add(coast.object);
      const p = coast.projection;
      gateX = p.x(params.fortPoint.lng);
      gateZ = p.z(params.fortPoint.lat);
      gateDot = createGlowPoints(1, [1.0, 0.78, 0.42], { radius: 0.12, intensity: 2.4 });
      beam = createGlowLine(2, [1.0, 0.8, 0.5], { width: 0.035, intensity: 1.2 });
      bayScene.add(gateDot.mesh, beam.mesh);
      coast.update(CRANK_T0, 0);

      outline = createOutline(renderer, machineScene, mRig.camera, { resolutionScale: ctx.quality.renderScale });
      self.update(0.5, 0, 0);
      await outline.compile(overlay);
      await renderer.compileAsync(bayScene, bRig.camera);
    },

    update(local, _dt, elapsed) {
      state = crankState(local);
      const s = state;
      const ms = s.ms;
      machine.update(ms);
      const k = smooth(s.split);
      layout(k);

      // ── Machine: frame it in its panel (fit the bounds' projected corners), then centre the panel by view offset.
      const b = machine.bounds;
      const cam = mRig.camera;
      const panelAspect = (mPanel.w * W) / (mPanel.h * H);
      const tall = portrait();
      const mp = params.machine;
      const close = tall ? params.machinePortrait : params.machineClose;
      const az = mp.az + (close.az - mp.az) * k + mp.swing * (local - 0.5);
      const fill = { x: mp.fillAlone.x + (close.fill.x - mp.fillAlone.x) * k, y: mp.fillAlone.y + (close.fill.y - mp.fillAlone.y) * k };
      const runX = machine.locate('run', machine.model.cranks.length - 1, v).x;
      const tx = b.centre.x + (runX - b.centre.x) * k;
      cam.clearViewOffset();
      cam.aspect = panelAspect;
      for (let it = 0; it < 4; it++) {
        mRig.apply({ az, el: mp.el, dist: mDist / mRig.fit(), tx, tt: b.centre.y, ty: b.centre.z }, elapsed);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        let mx = 0;
        let my = 0;
        for (let c = 0; c < 8; c++) {
          corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).project(cam);
          mx = Math.max(mx, Math.abs(corner.x));
          my = Math.max(my, Math.abs(corner.y));
        }
        const f = Math.max(mx / fill.x, my / fill.y);
        if (Math.abs(f - 1) < 0.01) break;
        mDist *= f;
      }
      offsetFor(mRig, mPanel);
      cam.updateProjectionMatrix();
      cam.near = Math.max(0.05, mDist * 0.05);
      cam.far = mDist * 6 + 20;
      cam.updateProjectionMatrix();

      // NOAA's hourly points on the paper: x moves with the feed, y is the pen height for that hour's value.
      const m = machine.model;
      const noaaOn = s.noaaOn;
      for (let h = 0; h <= WEEK_H; h++) {
        const t = CRANK_T0 + h * HOUR_MS;
        const x = penX - feed * (ms - t);
        const y = m.penRestY + 2 * m.scale * (NOAA_WEEK[h]! - m.z0);
        const vis = t <= ms + 1 && x > paperLeft ? params.dot.brightness * noaaOn * Math.min(1, (x - paperLeft) / 0.25) : 0;
        dots.set(h, x, y, paperZ, vis);
      }
      dots.commit();
      machine.setGlow(1.35, 1.25 + 0.35 * s.turning, 2.2);

      // ── Bay.
      if (coast) {
        coast.update(ms, elapsed);
        const bc = tall && portrait() ? { ...params.bay, ...params.bayPortrait } : params.bay;
        const bp = coast.projection;
        const bCam = bRig.camera;
        bCam.clearViewOffset();
        bCam.aspect = Math.max(0.2, (bPanel.w * W) / Math.max(1, bPanel.h * H));
        bRig.apply({ az: bc.az + 0.05 * (local - 0.5), el: bc.el, dist: bc.dist, tx: bp.x(bc.lng), tt: coast.y(1), ty: bp.z(bc.lat), fov: params.bay.fov }, elapsed);
        const d = bc.dist * bRig.fit();
        bCam.near = Math.max(0.01, d * 0.02);
        bCam.far = d * 6 + 60;
        offsetFor(bRig, bPanel);
        bCam.updateProjectionMatrix();
        coast.uniforms.hazeStart.value = d * 0.9;
        coast.uniforms.hazeDensity.value = 0.9 / (d + 10);
        // The Golden Gate gauge: a bead on the water at Fort Point and a thin beam above it.
        const lv = coast.levelAt(gateX, gateZ);
        const y = coast.y(lv);
        gateDot.set(0, gateX, y + 0.01, gateZ, k * s.link);
        gateDot.commit();
        beam.set(0, gateX, y, gateZ);
        beam.set(1, gateX, y + 1.6, gateZ);
        beam.commit(2);
        beam.intensity.value = 1.1 * k * s.link;
        // Labels in the bay (the gauge reads above MLLW, like the pen: NAVD88 level − offset + z0).
        const st = coast.field.stations.find((x) => x.id === SF.id);
        const gate = st ? lv - st.offset + (st.z0 ?? 0) : lv;
        const rg = Math.round(gate * 100);
        if (rg !== lastGate) {
          lastGate = rg;
          labels.setText(L.gate, `Golden Gate ${metres(rg / 100)}`);
        }
        const o = k * s.link;
        labels.place(L.gate, gateX, y + 1.7, gateZ, bCam, o);
        clip(L.gate, bPanel);
        for (const id of ['pacific', 'bay', 'oakland', 'sausalito'] as const) {
          const pl = PLACES[id];
          const px = bp.x(pl.lng);
          const pz = bp.z(pl.lat);
          labels.place(L[id], px, coast.y(Math.max(coast.heightAt(px, pz), coast.levelAt(px, pz))) + 0.05, pz, bCam, k * (id === 'pacific' || id === 'bay' ? 0.8 : 0.6));
          clip(L[id], bPanel, 0.07);
        }
      }

      // ── Machine labels.
      const pen = machine.state.height;
      const rp = Math.round(pen * 100);
      if (rp !== lastPen) {
        lastPen = rp;
        labels.setText(L.pen, `pen ${metres(rp / 100)}`);
      }
      machine.locate('pen', 0, v);
      labels.place(L.pen, v.x + 0.08, v.y, v.z, cam, 0.35 + 0.65 * s.link);
      clip(L.pen, mPanel);
    },

    render(target: RenderTarget) {
      // Machine: full frame through the outline pass (its camera carries the view offset).
      outline.render(target, overlay);
      if (!coast || bPanel.w * bPanel.h < 1e-3) return;
      const TW = target.width;
      const TH = target.height;
      const x = Math.round(bPanel.x * TW);
      const y = Math.round(bPanel.y * TH);
      const w = Math.max(1, Math.round(bPanel.w * TW));
      const h = Math.max(1, Math.round(bPanel.h * TH));
      // No clear: the outline composite left depth cleared, and the coast's backdrop covers its panel.
      renderer.setRenderTarget(target);
      target.scissor.set(x, y, w, h);
      renderer.setScissorTest(true);
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(bayScene, bRig.camera);
      renderer.autoClear = auto;
      renderer.setScissorTest(false);
      target.scissor.set(0, 0, TW, TH);
    },

    resize(width: number, height: number, dpr: number) {
      W = width;
      H = height;
      outline?.setSize(width, height, dpr);
      coast?.uniforms.resolution.value.set(width, height);
    },

    dispose() {
      machine?.dispose();
      outline?.dispose();
      dots?.dispose();
      gateDot?.dispose();
      beam?.dispose();
      coast?.dispose();
      coast = null;
      machineScene.clear();
      overlay.clear();
      bayScene.clear();
    },
  };
  return self;
}
