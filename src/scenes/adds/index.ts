// Stage 8 · A machine that adds (HANDOFF §7 row 8). Kelvin's machine is built in front of you, in Thomson's order
// from the pen end: one crank and pulley, whose height is a sine wave (its trail is drawn beside it); then S2 and
// the wire, and the pen writes their sum, the spring–neap beat; then the other eight. When all ten are turning the
// frame, driving shafts and rolls of the full brass assembly close round them, and the machine draws San Francisco.
// Everything moves from src/script/adds.ts and the machine model; the rig (./rig.ts) holds the cranks in progress.

import { Box3, Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { LabelSet, type Side, type Tone } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import type { StationConstants } from '../../tides/predict.ts';
import {
  adds,
  addsState,
  ARRIVALS,
  ADDS_T0,
  DAY_MS,
  formatPeriod,
  periodHours,
  pretty,
  THOMSON_ORDER,
  throwFrac,
  WIRE_DAY,
  type AddsState,
} from '../../script/adds.ts';
import { ramp, smooth } from '../../time/tracks.ts';
import { createRig, type Rig, type RigFrame } from './rig.ts';

const params = {
  station: '/data/stations/9414290.json',
  /** The assembly's run: covers this stage and the next (stage 9 carries on to day 47). */
  span: 48 * DAY_MS,
  fov: 30,
  /** Azimuth (radians, + looks from the pen end) and elevation per framing: the lone crank, with its trail, two
   * cranks and the record, ten, the machine. */
  az: [0.32, 0.12, 0.13, 0.2, 0.3],
  el: [0.1, 0.06, 0.08, 0.11, 0.14],
  /** Swing of the final framing across its stretch of the stage. */
  swing: 0.1,
  /** Where the subject sits (NDC centre, lens-shifted so perspective stays centred) and how much of the frame it may
   * fill (NDC half-extents): right of the captions (bottom left) and under the dual clock (top right). */
  shift: { x: 0.25, y: 0.03 },
  fill: { x: 0.68, y: 0.64 },
  shiftPortrait: { x: 0, y: 0.06 },
  fillPortrait: { x: 0.94, y: 0.5 },
  /** The lone pulley's trail: a day and a half, drawn this wide (machine units). */
  trailDays: 1.5,
  trailWidth: 2.3,
  trailWidthPortrait: 1.5,
  /** Outline line gain, and its dip at the swap. */
  gain: 1.6,
  dip: 0.55,
};

type LabelId = 'throw' | 'angle' | 'gear' | 'sine' | 'period' | 'wire' | 'pen' | 'spring' | 'neap' | 'newest';
const LABELS: { id: LabelId; text: string; tone: Tone; side: Side; size?: 'sm' | 'md' }[] = [
  { id: 'throw', text: 'crank throw = amplitude', tone: 'warm', side: 'right' },
  { id: 'angle', text: 'crank angle = phase', tone: 'warm', side: 'left' },
  { id: 'gear', text: 'gear ratio = speed', tone: 'warm', side: 'left' },
  { id: 'sine', text: 'its height: a sine wave', tone: 'plain', side: 'above' },
  { id: 'period', text: 'one turn of the crank', tone: 'warm', side: 'above', size: 'sm' },
  { id: 'wire', text: 'one wire sums them', tone: 'plain', side: 'left' },
  { id: 'pen', text: 'the pen draws the tide', tone: 'plain', side: 'right' },
  { id: 'spring', text: 'spring tides', tone: 'warm', side: 'above', size: 'sm' },
  { id: 'neap', text: 'neap tides', tone: 'warm', side: 'above', size: 'sm' },
  { id: 'newest', text: '', tone: 'warm', side: 'left' },
];
const trailWidth = (portrait: boolean) => (portrait ? params.trailWidthPortrait : params.trailWidth);
const flip = (side: Side): Side => (side === 'left' ? 'right' : side === 'right' ? 'left' : side);

export default function makeAddsScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const overlay = new Scene();
  const cam = new OrbitRig(params.fov);
  let machine: BrassMachine;
  let rig: Rig;
  let outline: Outline;
  let n = 10;
  const labels = new LabelSet([
    ...LABELS.map((l) => ({ ...l })),
    ...LABELS.map((l) => ({ ...l, id: `${l.id}~`, side: flip(l.side) })),
    ...THOMSON_ORDER.map((name) => ({
      id: `n:${name}`,
      text: pretty(name),
      tone: 'mute' as const,
      side: 'center' as const,
      size: 'sm' as const,
    })),
    { id: 'wire^', text: 'one wire sums them', tone: 'plain', side: 'above' },
    { id: 'pen_', text: 'the pen draws the tide', tone: 'plain', side: 'below' },
    { id: 'newest^', text: '', tone: 'warm', side: 'above' },
  ]);
  const L = Object.fromEntries(LABELS.map((l) => [l.id, labels.index(l.id)])) as Record<LabelId, number>;
  const nameAt = THOMSON_ORDER.map((name) => labels.index(`n:${name}`));
  // Portrait variants on another side (a label's side is fixed when its element is made).
  const P = { wire: labels.index('wire^'), pen: labels.index('pen_'), newest: labels.index('newest^') };
  let newest = '';

  // Per-frame scratch (no allocation in update).
  const seat = new Float64Array(10);
  const set = new Float64Array(10);
  let days = 0;
  const setAt = (i: number, ms: number) => throwFrac(n - 1 - i, (ms - ADDS_T0) / DAY_MS);
  const frame: RigFrame = {
    ms: ADDS_T0,
    seat,
    set,
    setAt,
    wire: 0,
    paper: 0,
    recordFrom: ADDS_T0 + WIRE_DAY * DAY_MS,
    windowMs: DAY_MS,
    trailCrank: 9,
    trail: 0,
    trailMs: params.trailDays * DAY_MS,
    trailWidth: params.trailWidth,
    glow: 1,
    showThrow: 0,
    showAngle: 0,
    showPeriod: 0,
  };
  const boxes: Box3[] = [];
  const weights = new Float64Array(5);
  const size = { w: 1280, h: 720 };
  const boxesPortrait: Box3[] = [];
  const box = new Box3();
  let dist = 12;
  const v = new Vector3();
  const pa = new Vector3();
  const pb = new Vector3();
  const corner = new Vector3();

  const self: BlockScene = {
    id: 'adds',
    status: 'historical',
    statusNote: adds.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const station = await ctx.assets.json<StationConstants>(params.station);
      machine = createMachine(ctx, { machine: 'kelvin', station, t0: ADDS_T0, span: params.span });
      n = machine.model.cranks.length;
      frame.trailCrank = n - 1;
      rig = createRig(machine, ctx.quality?.detail ?? 1);
      scene.add(machine.solids, rig.solids);
      overlay.add(machine.overlay, rig.overlay);
      machine.solids.visible = false;
      machine.overlay.visible = false;

      // Framings: one crank and its trail; two cranks and the record; all ten; the full machine.
      const m = machine.model;
      const g = rig.geo;
      const m2 = m.cranks[n - 1]!;
      const s2 = m.cranks[n - 2]!;
      const top = m2.restY + m2.throw0 + g.flange;
      const lone = new Box3(
        new Vector3(m2.x - 0.75, g.shaftY(-1) - 0.12, -0.7),
        new Vector3(m2.x + 0.75, top + 0.2, 0.1),
      );
      boxes.push(
        lone,
        new Box3(
          new Vector3(m2.x - params.trailWidth - 0.15, g.shaftY(-1) - 0.12, -0.7),
          new Vector3(m2.x + 0.5, top + 0.2, 0.1),
        ),
        new Box3(
          new Vector3(s2.x - 0.55, g.shaftY(-1) - 0.12, -0.7),
          new Vector3(g.supplyX + 0.3, g.shaftY(1) + 0.12, 0.1),
        ),
        new Box3(
          new Vector3(m.cranks[0]!.x - 0.6, g.shaftY(-1) - 0.12, -0.7),
          new Vector3(g.supplyX + 0.3, g.shaftY(1) + 0.12, 0.1),
        ),
        new Box3(machine.bounds.min.clone(), machine.bounds.max.clone()),
      );
      // Portrait: the pen end (the last cranks and the record) fills the frame.
      const end = m.cranks[n - 4]!.x - 0.5;
      boxesPortrait.push(
        boxes[0]!.clone(),
        new Box3(
          new Vector3(m2.x - params.trailWidthPortrait - 0.15, g.shaftY(-1) - 0.12, -0.7),
          new Vector3(m2.x + 0.5, top + 0.2, 0.1),
        ),
        boxes[2]!.clone(),
        new Box3(
          new Vector3(end, g.shaftY(-1) - 0.12, -0.7),
          new Vector3(g.supplyX + 0.3, g.shaftY(1) + 0.12, 0.1),
        ),
        new Box3(new Vector3(end, machine.bounds.min.y, machine.bounds.min.z), machine.bounds.max.clone()),
      );

      outline = createOutline(renderer, scene, cam.camera, {
        resolutionScale: ctx.quality.renderScale,
        lineGain: params.gain,
      });
      self.update(0.5, 0, 0);
      machine.solids.visible = true;
      machine.overlay.visible = true;
      await outline.compile(overlay);
      self.update(0, 0, 0);
    },

    update(local: number, _dt: number, elapsed: number) {
      const s = addsState(local);
      days = s.days;
      const ms = ADDS_T0 + days * DAY_MS;
      machine.update(ms);

      // The swap: the rig hands over to the full assembly halfway through a short dip of the line gain.
      const swapped = s.swap >= 0.5;
      const bump = Math.sin(Math.PI * s.swap);
      outline.gain.value = params.gain * (1 - params.dip * bump * bump);
      machine.solids.visible = swapped;
      machine.overlay.visible = swapped;
      rig.solids.visible = !swapped;
      rig.overlay.visible = !swapped;
      machine.setGlow(1.35, 1, 2.2);

      for (let i = 0; i < n; i++) {
        const q = n - 1 - i;
        seat[i] = smooth(s.arrive[q]!);
        set[i] = throwFrac(q, days);
      }
      frame.ms = ms;
      frame.wire = s.wire;
      frame.paper = s.paper;
      frame.windowMs = s.window * DAY_MS;
      frame.trail = s.trail;
      frame.trailWidth = trailWidth(cam.camera.aspect < 1);
      frame.glow = 1;
      frame.showThrow = s.labels.throw;
      frame.showAngle = s.labels.angle;
      frame.showPeriod = s.labels.period;
      if (!swapped) rig.update(frame);
      highlight(s);

      // ── Camera ──
      const c = cam.camera;
      const portrait = c.aspect < 1;
      const bx = portrait ? boxesPortrait : boxes;
      const sc = s.cam;
      const w = weights;
      w[0] = (1 - sc.trail) * (1 - sc.two);
      w[1] = sc.trail * (1 - sc.two);
      w[2] = sc.two * (1 - sc.ten);
      w[3] = sc.ten * (1 - sc.full);
      w[4] = sc.full;
      box.min.set(0, 0, 0);
      box.max.set(0, 0, 0);
      let az = 0;
      let el = 0;
      for (let k = 0; k < 5; k++) {
        box.min.addScaledVector(bx[k]!.min, w[k]!);
        box.max.addScaledVector(bx[k]!.max, w[k]!);
        az += params.az[k]! * w[k]!;
        el += params.el[k]! * w[k]!;
      }
      az += params.swing * s.cam.full * (local - 0.9);
      if (portrait) az = Math.min(0.7, az * 1.8);
      const fill = portrait ? params.fillPortrait : params.fill;
      const shift = portrait ? params.shiftPortrait : params.shift;
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
        for (let k = 0; k < 8; k++) {
          corner
            .set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z)
            .project(c);
          mx = Math.max(mx, Math.abs(corner.x - shift.x));
          my = Math.max(my, Math.abs(corner.y - shift.y));
        }
        const kk = Math.max(mx / fill.x, my / fill.y);
        if (Math.abs(kk - 1) < 0.005) break;
        dist *= kk;
      }

      placeLabels(s, portrait, local);
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
      rig.dispose();
      outline.dispose();
      scene.clear();
      overlay.clear();
    },
  };

  /** The crank being installed glows hotter while it moves in and its pin slides out. */
  function highlight(s: AddsState) {
    let q = -1;
    for (let k = 1; k < THOMSON_ORDER.length; k++) {
      const a = s.arrive[k]!;
      if (a > 0 && (a < 1 || throwFrac(k, s.days) < 1)) q = k;
    }
    if (q < 0 && s.trail > 0.5) q = 0;
    if (q < 0) {
      rig.hot.value.set(-1, -1, -1, -1);
      return;
    }
    const h = rig.units[n - 1 - q]!.hot;
    rig.hot.value.set(h[0], h[1], h[2], h[3]);
  }

  function placeLabels(s: AddsState, portrait: boolean, local: number) {
    const c = cam.camera;
    const cssW = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const m = machine.model;
    const lb = s.labels;
    const put = (id: LabelId, p: Vector3, o: number) => {
      const i = L[id];
      const spec = labels.specs[i]!;
      if (o <= 0.001) {
        labels.hide(i);
        labels.hide(i + LABELS.length);
        return;
      }
      const px = ((pa.copy(p).project(c).x + 1) / 2) * cssW;
      const textW = spec.text.length * 6.6 + 14;
      const off =
        spec.side === 'left' ? px - textW < 6 : spec.side === 'right' ? px + textW > cssW - 6 : false;
      labels.place(off ? i + LABELS.length : i, p.x, p.y, p.z, c, o);
      labels.hide(off ? i : i + LABELS.length);
    };
    const swapped = s.swap >= 0.5;
    const u = rig.units[n - 1]!;
    const m2 = m.cranks[n - 1]!;
    const g = rig.geo;
    // Phase 1: the lone crank. Throw beside the disc (its radius glows), angle at the degree circle (its arc glows).
    // Portrait has no room on the right: the three stack down the left of the crank.
    const gr = rig.geo.guideTop + g.r;
    if (portrait) {
      put('throw', v.set(m2.x - g.Rc - 0.08, u.crankY - 0.1, -0.08), lb.throw);
      put('angle', v.set(m2.x - g.Rc - 0.08, u.crankY + 0.16, -0.165), lb.angle);
    } else {
      put('throw', v.set(m2.x + g.Rc + 0.08, u.crankY - 0.06, -0.08), lb.throw);
      put('angle', v.set(m2.x - g.Rc - 0.08, u.crankY + 0.06, -0.165), lb.angle);
    }
    put('gear', v.set(m2.x - g.Rc * 0.9, (u.ys[0]! + u.crankY) / 2 - 0.1, -0.3), lb.gear);
    put('sine', v.set(m2.x - trailWidth(portrait) * 0.62, m2.restY + m2.throw0 + 0.28, 0), lb.sine * s.trail);
    if (Number.isFinite(rig.bracketX))
      put('period', v.set(rig.bracketX, rig.bracketY + 0.02, 0.02), lb.period * s.trail);
    else put('period', v, 0);
    // Phase 2: wire and pen (portrait: above the first guide, and under the record).
    if (portrait) {
      put('wire', v, 0);
      put('pen', v, 0);
      labels.place(P.wire, m.cranks[n - 1]!.x + 2 * g.r, gr + 0.04, 0, c, lb.wire * s.wire);
      labels.place(P.pen, g.penX - 0.6, g.paperLo - 0.1, 0, c, lb.pen);
    } else {
      labels.hide(P.wire);
      labels.hide(P.pen);
      put(
        'wire',
        v.set(rig.anchorX, rig.anchorY + (m.cranks[n - 2]!.row > 0 ? -0.1 : 0.1), 0),
        lb.wire * s.wire,
      );
      if (swapped) machine.locate('pen', 0, v);
      else v.set(g.penX, rig.penY - 0.06, 0.05);
      put('pen', v, lb.pen);
    }
    // Spring and neap on the record: where M2 and S2 last pulled together, and against each other.
    beats(s, lb.beat);
    // The crank just added, named with its period.
    let q = 0;
    for (let k = 1; k < THOMSON_ORDER.length; k++) if (s.arrive[k]! > 0) q = k;
    const aq = ARRIVALS[q]!;
    const showNew = swapped
      ? 0
      : q === 0
        ? lb.first
        : Math.min(s.arrive[q]! * 2, 1) *
          (q === 1 ? 1 - lb.wire : 1 - ramp(local, aq.a1 + 0.03, aq.a1 + 0.05));
    {
      const name = THOMSON_ORDER[q]!;
      if (name !== newest) {
        newest = name;
        const text = `${pretty(name)} · ${formatPeriod(periodHours(name))}`;
        for (const i of [L.newest, L.newest + LABELS.length, P.newest]) labels.setText(i, text);
      }
      const ui = rig.units[n - 1 - q]!;
      const ck = m.cranks[n - 1 - q]!;
      // The newest crank is always the leftmost; in phase 1 the lone crank is named on its right (above in portrait).
      const side = q === 0 ? 1 : -1;
      const i = side > 0 ? L.newest + LABELS.length : L.newest;
      const o = side > 0 ? L.newest : L.newest + LABELS.length;
      const py = ui.pulley.position.y + ui.group.position.y;
      if (q === 0 && portrait) {
        labels.place(P.newest, ck.x, py + g.flange + 0.32, 0, c, showNew);
        labels.hide(i);
      } else {
        labels.place(i, ck.x + side * (g.flange + 0.04), py, ui.group.position.z, c, showNew);
        labels.hide(P.newest);
      }
      labels.hide(o);
    }

    // Names inside the pulleys, faded where a pulley is under ~24 px across.
    for (let k = 0; k < THOMSON_ORDER.length; k++) {
      const i = n - 1 - k;
      const ui = rig.units[i]!;
      if (swapped) machine.locate('pulley', i, v);
      else v.set(m.cranks[i]!.x, ui.pulley.position.y + ui.group.position.y, ui.group.position.z);
      pa.copy(v).project(c);
      pb.copy(v)
        .setX(v.x + g.r)
        .project(c);
      const px = Math.abs(pb.x - pa.x) * 0.5 * cssW;
      const o =
        (k === 0 ? Math.max(s.labels.names, s.cam.two) : smooth(s.arrive[k]!)) *
        Math.min(1, Math.max(0, (px - 12) / 6)) *
        0.85;
      labels.place(nameAt[k]!, v.x, v.y, v.z, c, o);
    }
  }

  /** Label the latest spring and neap on the paper (the envelope of M2 + S2 at its widest and narrowest). */
  function beats(s: AddsState, o: number) {
    const m = machine.model;
    const a = m.cranks[n - 1]!;
    const b = m.cranks[n - 2]!;
    if (o <= 0.001) {
      for (const id of ['spring', 'neap'] as const) {
        labels.hide(L[id]);
        labels.hide(L[id] + LABELS.length);
      }
      return;
    }
    const g = rig.geo;
    const now = ADDS_T0 + s.days * DAY_MS;
    const from = Math.max(frame.recordFrom, now - frame.windowMs);
    const dw = (b.train.speed - a.train.speed) / 3.6e6; // degrees per ms of S2 gaining on M2
    const d0 = a.theta0 - b.theta0; // Δ = θS2 − θM2 at t0 is −d0
    const W = g.penX - (g.takeX + 0.15);
    for (const [id, target] of [
      ['spring', 0],
      ['neap', 180],
    ] as const) {
      // Latest t ≤ now with θS2 − θM2 ≡ target (mod 360).
      const phaseNow = -d0 + dw * (now - ADDS_T0);
      const back = (((phaseNow - target) % 360) + 360) % 360;
      const t = now - back / dw;
      const x = g.penX - (W * (now - t)) / frame.windowMs;
      const env = 2 * (target === 0 ? a.throw0 + b.throw0 : Math.abs(a.throw0 - b.throw0));
      const ok = t >= from + 0.04 * frame.windowMs;
      labels.place(L[id], x, m.penRestY + env + 0.03, -0.02, cam.camera, ok ? o : 0);
      labels.hide(L[id] + LABELS.length);
    }
  }

  return self;
}
