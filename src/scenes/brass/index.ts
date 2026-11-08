// Stage 10 · Old Brass Brains (HANDOFF §7 row 10). The US Coast and Geodetic Survey's Tide Predicting Machine
// No. 2, set for San Francisco: a wide view, a camera tour along its 37 pulleys from the chain's fixed end (Sa) to
// the pen end (M2), a stop at the record, and a calm pull back. Components, chain order and tooth counts from SP-32
// via src/tides/machine.ts; the layout is the brass kit's schematic one.

import { Box3, Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { createGlowPoints, type GlowPoints } from '../../shared/brass/lines.ts';
import { LabelSet, type LabelSpec } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import type { StationConstants } from '../../tides/predict.ts';
import { OBB_37 } from '../../tides/machine.ts';
import { DAY_MS } from '../../script/adds.ts';
import { brass, brassState, BRASS_T0, type BrassState } from '../../script/brass.ts';
import { smooth } from '../../time/tracks.ts';

const params = {
  station: '/data/stations/9414290.json',
  span: 10 * DAY_MS,
  fov: 30,
  /** Opening and closing views (azimuth, elevation), the tour (looking ahead along the chain), the record. */
  wide: { az: 0.62, el: 0.14 },
  end: { az: 0.38, el: 0.1 },
  tour: { az: -0.24, el: 0.12 },
  record: { az: 0.22, el: 0.06 },
  /** Pulleys either side of the focus kept in frame on the tour. */
  window: 7,
  shift: { x: 0.04, y: 0.16 },
  fill: { x: 0.98, y: 0.42 },
  /** The whole machine (long and low) fits above the captions across most of the width. */
  wideShift: { x: 0.1, y: 0.2 },
  wideFill: { x: 0.86, y: 0.4 },
  shiftPortrait: { x: 0, y: 0.06 },
  fillPortrait: { x: 0.94, y: 0.48 },
};

export default function makeBrassScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const overlay = new Scene();
  const cam = new OrbitRig(params.fov);
  let machine: BrassMachine;
  let outline: Outline;
  let spot: GlowPoints;
  const specs: LabelSpec[] = [
    // NOAA's ids (small labels are set in capitals, where ρ1 would read as P1).
    ...OBB_37.map((name) => ({
      id: `n:${name}`,
      text: name === 'RHO' ? 'RHO1' : name,
      tone: 'mute' as const,
      side: 'center' as const,
      size: 'sm' as const,
    })),
    { id: 'chain', text: 'one chain sums all 37', tone: 'plain', side: 'right' },
    { id: 'pen', text: 'the pen draws the tide', tone: 'plain', side: 'right' },
  ];
  const labels = new LabelSet(specs);
  const L = (id: string) => labels.index(id);
  const names = OBB_37.map((n) => L(`n:${n}`));
  const boxes = { wide: new Box3(), record: new Box3(), tour: new Box3(), end: new Box3() };
  const box = new Box3();
  const size = { w: 1280, h: 720 };
  let dist = 14;
  const v = new Vector3();
  const pa = new Vector3();
  const pb = new Vector3();
  const corner = new Vector3();
  const shift = { x: 0, y: 0 };
  const fill = { x: 0, y: 0 };

  const self: BlockScene = {
    id: 'brass',
    status: 'historical',
    statusNote: brass.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const station = await ctx.assets.json<StationConstants>(params.station);
      machine = createMachine(ctx, { machine: 'obb', station, t0: BRASS_T0, span: params.span });
      scene.add(machine.solids);
      overlay.add(machine.overlay);
      spot = createGlowPoints(1, [1.0, 0.78, 0.5], { radius: 0.34, intensity: 0.32 });
      // A wide soft glow is mostly faint fragments, which WebGL2 has drawn as a grey disc: WebGPU only.
      if (ctx.quality.backend === 'webgpu') overlay.add(spot.mesh);
      const b = machine.bounds;
      boxes.wide.set(b.min.clone(), b.max.clone());
      boxes.end.set(b.min.clone(), b.max.clone());
      // The record: the last cranks, the guides, the pen and the paper.
      const m = machine.model;
      const last = m.cranks[m.cranks.length - 1]!;
      machine.locate('paper', 0, v);
      boxes.record.set(new Vector3(last.x - 0.9, -1.9, -0.6), new Vector3(b.max.x, b.max.y - 0.3, 0.2));
      outline = createOutline(renderer, scene, cam.camera, { resolutionScale: ctx.quality.renderScale });
      self.update(0.5, 0, 0);
      await outline.compile(overlay);
      self.update(0, 0, 0);
    },

    update(local: number, _dt: number, elapsed: number) {
      const s = brassState(local);
      machine.update(BRASS_T0 + s.days * DAY_MS);
      const m = machine.model;
      const n = m.cranks.length;
      // The focus pulley's crank glows a little hotter.
      const fp = machine.crankParts[s.focus]!;
      if (s.tourIn > 0.5 && s.tourOut < 0.5) machine.setHot(fp[0], fp[1], fp[2]);
      else machine.setHot();
      // Close to the brass the frame fills with lines: soften them so the lit crank and the HUD read.
      const near = smooth(s.tourIn) * (1 - smooth(s.tourOut));
      outline.gain.value = 1.6 * (1 - 0.5 * near);
      machine.setGlow(1.35 * (1 - 0.2 * near), 1, 2.2 * (1 - 0.3 * near));
      // A soft light on the pulley in front of the camera.
      machine.locate('pulley', s.focus, v);
      spot.set(0, v.x, v.y, v.z + 0.06, near);
      spot.commit();

      // Tour box: a few pulleys either side of the focus, the two rows and their cranks.
      const r = m.cranks[0]!.radius;
      const fx = m.cranks[0]!.x + 2 * r * Math.min(n - 1, Math.max(0, s.tour));
      boxes.tour.set(
        v.set(fx - params.window * 2 * r, -1.05, -0.2),
        pa.set(fx + params.window * 2 * r, 1.05, 0.1),
      );

      const c = cam.camera;
      const portrait = c.aspect < 1;
      // Phones: the long machine would be a sliver, so the wide views keep its pen end (the last cranks and the
      // record) instead.
      const crop = portrait ? m.cranks[Math.max(0, n - 14)]!.x - 0.4 : machine.bounds.min.x;
      boxes.wide.min.x = crop;
      boxes.end.min.x = crop;
      // Blend: wide → tour → record → end.
      const ti = smooth(s.tourIn);
      const to = smooth(s.tourOut);
      const we = smooth(s.wide);
      lerpBox(box, boxes.wide, boxes.tour, ti);
      lerpBox(box, box, boxes.record, to);
      lerpBox(box, box, boxes.end, we);
      let az = params.wide.az + (params.tour.az - params.wide.az) * ti;
      az += (params.record.az - az) * to;
      az += (params.end.az - az) * we;
      let el = params.wide.el + (params.tour.el - params.wide.el) * ti;
      el += (params.record.el - el) * to;
      el += (params.end.el - el) * we;
      if (portrait) az *= 0.6;
      // Wide at the ends (the whole machine across the frame), right of the captions while touring.
      const wideness = Math.max(1 - ti, we);
      const sh = portrait ? params.shiftPortrait : params.shift;
      const fl = portrait ? params.fillPortrait : params.fill;
      shift.x = portrait ? sh.x : sh.x + (params.wideShift.x - sh.x) * wideness;
      shift.y = portrait ? sh.y : sh.y + (params.wideShift.y - sh.y) * wideness;
      fill.x = portrait ? fl.x : fl.x + (params.wideFill.x - fl.x) * wideness;
      fill.y = portrait ? fl.y : fl.y + (params.wideFill.y - fl.y) * wideness;
      c.setViewOffset(size.w, size.h, (-shift.x * size.w) / 2, (shift.y * size.h) / 2, size.w, size.h);
      box.getCenter(v);
      const tx = v.x;
      const ty = v.y;
      const tz = v.z;
      for (let it = 0; it < 5; it++) {
        cam.apply({ az, el, dist: dist / cam.fit(), tx, tt: ty, ty: tz }, elapsed);
        c.updateMatrixWorld();
        let mx = 0;
        let my = 0;
        for (let q = 0; q < 8; q++) {
          corner
            .set(q & 1 ? box.max.x : box.min.x, q & 2 ? box.max.y : box.min.y, q & 4 ? box.max.z : box.min.z)
            .project(c);
          mx = Math.max(mx, Math.abs(corner.x - shift.x));
          my = Math.max(my, Math.abs(corner.y - shift.y));
        }
        const kk = Math.max(mx / fill.x, my / fill.y);
        if (Math.abs(kk - 1) < 0.005) break;
        dist *= kk;
      }
      placeLabels(s, local);
    },

    render(target: RenderTarget) {
      outline.render(target, overlay);
    },

    resize(width: number, height: number, dpr: number) {
      size.w = width;
      size.h = height;
      cam.resize(width, height);
      outline?.setSize(width, height, dpr);
    },

    dispose() {
      machine.dispose();
      spot.dispose();
      outline.dispose();
      scene.clear();
      overlay.clear();
    },
  };

  function lerpBox(out: Box3, a: Box3, b: Box3, t: number) {
    out.min.lerpVectors(a.min, b.min, t);
    out.max.lerpVectors(a.max, b.max, t);
  }

  function placeLabels(s: BrassState, local: number) {
    const c = cam.camera;
    const m = machine.model;
    const cssW = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const r = machine.pulleyRadius;
    // Names inside the pulleys, faded where a pulley is under ~28 px across.
    for (let i = 0; i < m.cranks.length; i++) {
      machine.locate('pulley', i, v);
      pa.copy(v).project(c);
      pb.copy(v)
        .setX(v.x + r)
        .project(c);
      const px = Math.abs(pb.x - pa.x) * 0.5 * cssW;
      // On the tour only the pulleys around the focus are named (the card names the one in front).
      const touring = s.tourIn > 0.5 && s.tourOut < 0.5;
      const near = touring ? (i === s.focus ? 1 : 0) : 0.75;
      labels.place(
        names[i]!,
        v.x,
        v.y,
        v.z,
        c,
        s.labels.names * near * Math.min(1, Math.max(0, (px - 14) / 6)),
      );
    }
    const i = s.focus;
    // The chain, a little ahead of the focus.
    machine.locate('run', Math.min(m.cranks.length - 2, i + 1), v);
    labels.place(L('chain'), v.x + 0.02, v.y, v.z, c, s.labels.chain);
    machine.locate('pen', 0, v);
    labels.place(L('pen'), v.x + 0.05, v.y, v.z, c, s.labels.record);
    void local;
  }

  return self;
}
