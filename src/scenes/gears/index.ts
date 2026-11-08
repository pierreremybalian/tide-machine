// Stage 9 · Gears that keep astronomical time (HANDOFF §7 row 9, §9 drift ladder). Kelvin's machine carries on from
// stage 8; the camera goes round behind the crank discs to M2's gear train, labelled with its tooth counts. Then the
// machine dims and the drift ladder comes forward: one rung per crank of Old Brass Brains (SP-32 tooth counts), with
// Kelvin's ten beside them, each bead the crank's angle minus the sky's over a simulated year. Then every crank is
// reset, as it was before each port and year.

import { Box3, Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { createGlowPoints, type GlowPoints } from '../../shared/brass/lines.ts';
import { LabelSet, type LabelSpec } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import type { RGB } from '../../shared/gfx/palette.ts';
import type { StationConstants } from '../../tides/predict.ts';
import { DAY_MS, pretty } from '../../script/adds.ts';
import {
  closeTrain,
  driftMinutes,
  fmtDrift,
  gears,
  gearsState,
  GEARS_T0,
  LADDER_DEG,
  ladderRows,
  type GearsState,
  type LadderRow,
} from '../../script/gears.ts';
import { smooth } from '../../time/tracks.ts';
import { createSegments, type Segments } from './segments.ts';

const params = {
  station: '/data/stations/9414290.json',
  /** The same run as stage 8 (so the two frames match across the dissolve). */
  span: 48 * DAY_MS,
  fov: 30,
  full: { az: 0.31, el: 0.14 },
  /** Close-up: from the record's side, a little below, so the train under the disc reads wheel by wheel. */
  close: { az: 0.62, el: 0.0 },
  /** The close-up sits above the captions and left of the trains card; behind the ladder the machine moves to the
   * left and dims. Phones: the close-up between the card (top) and the captions (bottom). */
  closeFrame: { shift: { x: -0.26, y: 0.36 }, fill: { x: 0.36, y: 0.42 } },
  closeFramePortrait: { shift: { x: -0.3, y: -0.2 }, fill: { x: 0.6, y: 0.25 } },
  aside: { shift: { x: -0.42, y: 0.05 }, fill: { x: 0.44, y: 0.5 } },
  shift: { x: 0.25, y: 0.03 },
  fill: { x: 0.68, y: 0.64 },
  shiftPortrait: { x: 0, y: 0.06 },
  fillPortrait: { x: 0.94, y: 0.5 },
  /** The ladder's place on screen (NDC): rung span and the first and last rows. */
  ladder: { x0: 0.13, x1: 0.67, top: 0.5, bottom: -0.7 },
  ladderPortrait: { x0: -0.36, x1: 0.86, top: 0.48, bottom: -0.46 },
  /** Outline gain, and how far the machine dims behind the ladder. */
  gain: 1.6,
  dim: 0.86,
};

const SKY: RGB = [0.36, 0.72, 1.0];
const BRASS_BEAD: RGB = [1.0, 0.72, 0.36];
const KELVIN_BEAD: RGB = [0.9, 0.93, 1.0];
const RULE: RGB = [0.5, 0.52, 0.66];

/** Rows named on phones (the rest are unlabelled rungs). */
const PHONE_NAMES = new Set(['SA', 'MF', 'Q1', 'RHO', 'O1', 'K1', 'N2', 'M2', 'S2', 'K2', 'MN4', 'M4', 'M8']);
/** Rows whose year-end drift is written beside the bead. */
const NOTES = ['RHO', 'MN4', 'K2', 'K1', 'M2'];

export default function makeGearsScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const overlay = new Scene();
  const cam = new OrbitRig(params.fov);
  let machine: BrassMachine;
  let outline: Outline;
  let segs: Segments;
  let beadsObb: GlowPoints;
  let beadsKelvin: GlowPoints;
  const rows: LadderRow[] = ladderRows();
  const kelvinRows = rows.map((r, i) => (r.kelvin ? i : -1)).filter((i) => i >= 0);
  const train = closeTrain();

  // ── Labels ──
  const specs: LabelSpec[] = [
    ...train.pairs.flatMap(([a, b], k) => [
      { id: `t${k}a`, text: `${a} teeth`, tone: 'warm' as const, side: 'right' as const },
      {
        id: `t${k}b`,
        text: `${b} teeth`,
        tone: 'warm' as const,
        side: k === train.pairs.length - 1 ? ('right' as const) : ('left' as const),
      },
    ]),
    { id: 'shaft', text: 'driving shaft · one turn a day', tone: 'plain', side: 'right' },
    { id: 'crank', text: 'M2 crank', tone: 'plain', side: 'right' },
    { id: 'sky', text: 'the sky', tone: 'b', side: 'above', size: 'sm' },
    { id: 'behind', text: '← falls behind', tone: 'mute', side: 'above', size: 'sm' },
    { id: 'ahead', text: 'runs ahead →', tone: 'mute', side: 'above', size: 'sm' },
    { id: 'lo', text: `−${LADDER_DEG}°`, tone: 'mute', side: 'below', size: 'sm' },
    { id: 'hi', text: `+${LADDER_DEG}°`, tone: 'mute', side: 'below', size: 'sm' },
    { id: 'legendObb', text: '━ Old Brass Brains · SP-32 teeth', tone: 'warm', side: 'right', size: 'sm' },
    { id: 'legendKelvin', text: '━ Kelvin · our trains', tone: 'both', side: 'right', size: 'sm' },
    ...rows.map((r) => ({
      id: `r:${r.name}`,
      text: pretty(r.name),
      tone: (r.kelvin ? 'warm' : 'mute') as LabelSpec['tone'],
      side: 'left' as const,
      size: 'md' as const,
    })),
    ...NOTES.map((name) => {
      const r = rows.find((x) => x.name === name)!;
      const late = driftMinutes(r);
      const mins =
        Math.abs(late) < 0.1 ? `${Math.round(Math.abs(late) * 60)} s` : `${Math.abs(late).toFixed(1)} min`;
      return {
        id: `note:${name}`,
        text: `${fmtDrift(r.obb.driftPerYear)} · ${mins} ${late < 0 ? 'late' : 'early'}`,
        tone: 'warm' as const,
        side: 'right' as const,
        size: 'sm' as const,
      };
    }),
  ];
  const labels = new LabelSet(specs);
  const L = (id: string) => labels.index(id);
  const rowLabel = rows.map((r) => L(`r:${r.name}`));
  // Row names are md (not uppercased by CSS): ρ1, λ2, μ2, ν2 keep their case.

  // ── Geometry of M2's train (as laid out by the assembly) ──
  const lay = {
    x: 0,
    ys: [] as number[],
    z: [] as number[],
    radius: [] as number[],
    crankY: 0,
    Rc: 0,
    shaftY: 0,
  };
  const boxes = { full: new Box3(), close: new Box3() };
  const box = new Box3();
  const size = { w: 1280, h: 720 };
  let dist = 12;
  const v = new Vector3();
  const pa = new Vector3();
  const corner = new Vector3();
  const fwd = new Vector3();
  const ndc = { x0: 0, x1: 0, top: 0, bottom: 0 };
  const shift = { x: 0, y: 0 };
  const fill = { x: 0, y: 0 };

  const self: BlockScene = {
    id: 'gears',
    status: 'measured',
    statusNote: gears.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const station = await ctx.assets.json<StationConstants>(params.station);
      machine = createMachine(ctx, { machine: 'kelvin', station, t0: GEARS_T0, span: params.span });
      scene.add(machine.solids);
      overlay.add(machine.overlay);
      layoutTrain();
      boxes.full.copy(new Box3(machine.bounds.min, machine.bounds.max));
      boxes.close.set(
        new Vector3(lay.x - 0.42, lay.shaftY - 0.12, -0.7),
        new Vector3(lay.x + 0.42, lay.crankY + lay.Rc + 0.05, 0.0),
      );

      segs = createSegments(1 + rows.length + 8 + 2 * (rows.length + kelvinRows.length));
      beadsObb = createGlowPoints(rows.length, BRASS_BEAD, { radius: 0.004, intensity: 0.9 });
      beadsKelvin = createGlowPoints(kelvinRows.length, KELVIN_BEAD, { radius: 0.003, intensity: 0.7 });
      overlay.add(segs.mesh, beadsObb.mesh, beadsKelvin.mesh);

      outline = createOutline(renderer, scene, cam.camera, {
        resolutionScale: ctx.quality.renderScale,
        lineGain: params.gain,
      });
      self.update(0.6, 0, 0);
      await outline.compile(overlay);
      self.update(0, 0, 0);
    },

    update(local: number, _dt: number, elapsed: number) {
      const s = gearsState(local);
      machine.update(GEARS_T0 + s.days * DAY_MS);
      const k = smooth(s.close);
      const ld = smooth(s.ladder);
      // Phones have no room beside the ladder: the machine all but disappears behind it.
      const portraitNow = cam.camera.aspect < 1;
      outline.gain.value = params.gain * (1 - (portraitNow ? 0.95 : params.dim) * ld);
      const g = 1 - (portraitNow ? 0.97 : 0.85) * ld;
      machine.setGlow(1.35 * g, 1 * g, 2.2 * g);
      const parts = machine.crankParts[machine.model.cranks.length - 1]!;
      if (k > 0.05) machine.setHot(parts[2], parts[3], parts[4], parts[0]);
      else machine.setHot();

      // Camera: the full machine, round behind to M2's train, and back.
      const c = cam.camera;
      const portrait = c.aspect < 1;
      box.min.lerpVectors(boxes.full.min, boxes.close.min, k);
      box.max.lerpVectors(boxes.full.max, boxes.close.max, k);
      if (portrait && k < 0.5)
        box.min.x = Math.max(box.min.x, machine.model.cranks[machine.model.cranks.length - 4]!.x - 0.5);
      const az = params.full.az + (params.close.az - params.full.az) * k + (portrait ? 0.25 * (1 - k) : 0);
      const el = params.full.el + (params.close.el - params.full.el) * k;
      const sh = portrait ? params.shiftPortrait : params.shift;
      const fl = portrait ? params.fillPortrait : params.fill;
      const cf = portrait ? params.closeFramePortrait : params.closeFrame;
      const aside = portrait ? 0 : ld;
      shift.x = sh.x + (cf.shift.x - sh.x) * k + (params.aside.shift.x - sh.x) * aside;
      shift.y = sh.y + (cf.shift.y - sh.y) * k + (params.aside.shift.y - sh.y) * aside;
      fill.x = fl.x + (cf.fill.x - fl.x) * k + (params.aside.fill.x - fl.x) * aside;
      fill.y = fl.y + (cf.fill.y - fl.y) * k + (params.aside.fill.y - fl.y) * aside;
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

      placeTrainLabels(s, k);
      drawLadder(s, ld, portrait);
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
      outline.dispose();
      segs.dispose();
      beadsObb.dispose();
      beadsKelvin.dispose();
      scene.clear();
      overlay.clear();
    },
  };

  /** Where the assembly puts M2's arbors and gears (same proportions as src/shared/brass/assembly.ts). */
  function layoutTrain() {
    const m = machine.model;
    const n = m.cranks.length;
    const r = m.cranks[0]!.radius;
    let maxThrow = 0;
    for (const ck of m.cranks) maxThrow = Math.max(maxThrow, ck.throw0);
    const Rc = Math.min(1.8 * r, Math.max(0.6 * r, maxThrow + 0.35 * r));
    const flange = 1.16 * r;
    const crankY = (i: number) =>
      m.cranks[i]!.restY + m.cranks[i]!.row * (flange + Rc + m.cranks[i]!.throw0 + 0.06 + 0.075);
    let down = Infinity;
    for (let i = 0; i < n; i++) if (m.cranks[i]!.row < 0) down = Math.min(down, crankY(i) - 0.95);
    const i = n - 1;
    const ck = m.cranks[i]!;
    if (ck.row !== -1) throw new Error('expected M2 in the lower row');
    const ky = crankY(i);
    const pairs = ck.train.pairs;
    const T = pairs.reduce((sum, [a, b]) => sum + a + b, 0);
    const D = Math.abs(down - ky);
    let module = (2 * D) / T;
    let maxTeeth = 0;
    for (const [a, b] of pairs) maxTeeth = Math.max(maxTeeth, a, b);
    let idler = 0;
    if ((module * maxTeeth) / 2 > 1.85 * r) {
      const mm = (2 * 1.85 * r) / maxTeeth;
      idler = Math.max(12, Math.round(((2 * D) / mm - T) / 2));
      module = (2 * D) / (T + 2 * idler);
    }
    const ys = [down];
    let yy = down;
    pairs.forEach(([a, b], q) => {
      yy += (module * (a + b + (q === 0 ? 2 * idler : 0))) / 2;
      ys.push(yy);
    });
    ys[ys.length - 1] = ky;
    const ns = pairs.length;
    lay.x = ck.x;
    lay.ys = ys;
    lay.crankY = ky;
    lay.Rc = Rc;
    lay.shaftY = down;
    // Stage q: driver on arbor q, driven on arbor q + 1, both at z = −0.3 − 0.09 (ns − 1 − q).
    lay.z = pairs.map((_, q) => -0.3 - 0.09 * (ns - 1 - q));
    lay.radius = pairs.flatMap(([a, b]) => [(a * module) / 2, (b * module) / 2]);
  }

  function placeTrainLabels(s: GearsState, k: number) {
    const c = cam.camera;
    const o = s.labels.teeth * (k > 0.6 ? 1 : 0);
    // Drivers labelled on the right of their wheels, driven wheels on the left (the crank's own wheel sits behind
    // its disc, so its label goes beside the disc).
    const last = train.pairs.length - 1;
    train.pairs.forEach((_, q) => {
      const z = lay.z[q]!;
      labels.place(L(`t${q}a`), lay.x + lay.radius[2 * q]! + 0.02, lay.ys[q]!, z, c, o);
      if (q === last)
        labels.place(L(`t${q}b`), lay.x + lay.Rc + 0.06, lay.crankY + lay.Rc * 0.2, -0.14, c, o);
      else labels.place(L(`t${q}b`), lay.x - lay.radius[2 * q + 1]! - 0.02, lay.ys[q + 1]!, z, c, o);
    });
    labels.place(
      L('shaft'),
      lay.x + lay.radius[0]! + 0.02,
      lay.shaftY - 0.1,
      lay.z[0]!,
      c,
      s.labels.shaft * (k > 0.6 ? 1 : 0),
    );
    labels.place(
      L('crank'),
      lay.x + lay.Rc + 0.06,
      lay.crankY + lay.Rc * 0.55,
      -0.14,
      c,
      s.labels.crank * (k > 0.6 ? 1 : 0),
    );
  }

  /** NDC → world, on a plane a fixed distance in front of the camera (overlays draw without depth). */
  function world(nx: number, ny: number, out: Vector3): Vector3 {
    const c = cam.camera;
    out.set(nx, ny, 0.5).unproject(c);
    out.sub(c.position);
    c.getWorldDirection(fwd);
    const t = 1.5 / Math.max(1e-6, out.dot(fwd));
    return out.multiplyScalar(t).add(c.position);
  }

  function drawLadder(s: GearsState, ld: number, portrait: boolean) {
    const c = cam.camera;
    const box2 = portrait ? params.ladderPortrait : params.ladder;
    Object.assign(ndc, box2);
    const nr = rows.length;
    const cx = (ndc.x0 + ndc.x1) / 2;
    const hw = (ndc.x1 - ndc.x0) / 2;
    const rowY = (i: number) => ndc.top + ((ndc.bottom - ndc.top) * i) / (nr - 1);
    const dy = (ndc.bottom - ndc.top) / (nr - 1);
    // A pixel at the plane, for widths.
    const px = (2 * 1.5 * Math.tan((params.fov * Math.PI) / 360)) / Math.max(1, size.h);
    const on = ld > 0.002;
    segs.mesh.visible = on;
    beadsObb.mesh.visible = on;
    beadsKelvin.mesh.visible = on;
    if (!on) {
      for (const i of rowLabel) labels.hide(i);
      for (const id of [
        'sky',
        'behind',
        'ahead',
        'lo',
        'hi',
        'legendObb',
        'legendKelvin',
        ...NOTES.map((n) => `note:${n}`),
      ])
        labels.hide(L(id));
      return;
    }
    let q = 0;
    world(cx, ndc.top - dy * 1.2, pa);
    world(cx, ndc.bottom + dy * 0.8, v);
    segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, SKY, 1.5 * ld, 1.1 * px);
    // Rungs, and scale ticks at ±½ and ±1 above the first row and below the last.
    for (let i = 0; i < nr; i++) {
      const y = rowY(i);
      world(ndc.x0, y, pa);
      world(ndc.x1, y, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, RULE, (rows[i]!.kelvin ? 0.42 : 0.3) * ld, 0.5 * px);
    }
    for (const f of [-1, -0.5, 0.5, 1]) {
      const x = cx + f * hw;
      world(x, ndc.top - dy * 0.6, pa);
      world(x, ndc.top - dy * 1.2, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, RULE, 0.6 * ld, 0.6 * px);
      world(x, ndc.bottom + dy * 0.6, pa);
      world(x, ndc.bottom + dy * 1.2, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, RULE, 0.6 * ld, 0.6 * px);
    }
    // Bars and beads: drift so far (gear angle minus the sky's), in degrees, ±LADDER_DEG across the rung.
    for (let i = 0; i < nr; i++) {
      const r = rows[i]!;
      const y = rowY(i);
      const d = Math.max(-1.05, Math.min(1.05, (r.obb.driftPerYear * s.drift) / LADDER_DEG));
      world(cx, y, pa);
      world(cx + d * hw, y, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, BRASS_BEAD, 1.1 * ld, 1.5 * px);
      beadsObb.set(i, v.x, v.y, v.z, ld);
      world(cx + d * hw, y - dy * 0.32, pa);
      world(cx + d * hw, y + dy * 0.32, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, BRASS_BEAD, 2.2 * ld, 1.3 * px);
    }
    kelvinRows.forEach((i, j) => {
      const r = rows[i]!;
      const y = rowY(i) + dy * 0.42;
      const d = (r.kelvin!.driftPerYear * s.drift) / LADDER_DEG;
      world(cx, y, pa);
      world(cx + d * hw, y, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, KELVIN_BEAD, 0.9 * ld, 1.0 * px);
      beadsKelvin.set(j, v.x, v.y, v.z, 0.8 * ld);
      world(cx + d * hw, y - dy * 0.2, pa);
      world(cx + d * hw, y + dy * 0.2, v);
      segs.set(q++, pa.x, pa.y, pa.z, v.x, v.y, v.z, KELVIN_BEAD, 1.8 * ld, 1.0 * px);
    });
    segs.commit();
    beadsObb.commit();
    beadsKelvin.commit();

    // Labels: row names, the sky, the scale, a legend, and the biggest drifts at the end of the year.
    const lr = s.labels.rows * ld;
    rows.forEach((r, i) => {
      world(ndc.x0 - 0.012, rowY(i), v);
      labels.place(
        rowLabel[i]!,
        v.x,
        v.y,
        v.z,
        c,
        portrait && !PHONE_NAMES.has(r.name) ? 0 : lr * (r.kelvin ? 0.95 : 0.75),
      );
    });
    const top = ndc.top - dy * 1.25;
    world(cx, top, v);
    labels.place(L('sky'), v.x, v.y, v.z, c, s.labels.sky * ld);
    world(cx - hw * 0.62, top, v);
    labels.place(L('behind'), v.x, v.y, v.z, c, lr);
    world(cx + hw * 0.62, top, v);
    labels.place(L('ahead'), v.x, v.y, v.z, c, lr);
    world(cx - hw, ndc.bottom + dy * 1.3, v);
    labels.place(L('lo'), v.x, v.y, v.z, c, lr);
    world(cx + hw, ndc.bottom + dy * 1.3, v);
    labels.place(L('hi'), v.x, v.y, v.z, c, lr);
    // Legend under the scale.
    world(ndc.x0 + hw * 0.25, ndc.bottom + dy * 2.6, v);
    labels.place(L('legendObb'), v.x, v.y, v.z, c, lr);
    world(ndc.x0 + hw * 0.25, ndc.bottom + dy * 3.9, v);
    labels.place(L('legendKelvin'), v.x, v.y, v.z, c, lr);
    for (const name of NOTES) {
      const i = rows.findIndex((r) => r.name === name);
      const r = rows[i]!;
      world(ndc.x1 + 0.01, rowY(i), v);
      labels.place(L(`note:${name}`), v.x, v.y, v.z, c, s.labels.notes * ld * (portrait ? 0 : 1));
      void r;
    }
  }

  return self;
}
