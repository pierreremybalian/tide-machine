// The machine under construction (stage 8). createMachine() builds Kelvin's machine whole; this stage needs it one
// crank at a time, with the wire threading only the pulleys already in place. So the rig rebuilds each crank's
// moving parts (pulley, slide and yoke, crank disc and pin, gear train) with the same proportions and at the same
// places as src/shared/brass/assembly.ts, from the same model, plus the wire, guides, pen and paper. When all ten
// are in, the full assembly (frame, driving shafts, rolls) replaces the rig with every part where it already was.
//
// The wire runs vertically between neighbouring pulleys, so each pulley that moves by δ moves the pen by 2δ: the
// pen here is penRestY + 2 Σ (set fraction · throw · cos θ) over the cranks in place, which is what machineAt()
// computes for the whole machine (tested there against the wire's tangent geometry).

import { Group, Matrix4, Mesh, type BufferGeometry, type Object3D } from 'three/webgpu';
import type { BrassMachine } from '../../shared/brass/assembly.ts';
import {
  box,
  circle,
  cylinder,
  extrude,
  gear,
  GeoBuilder,
  revolve,
  rod,
  roundRect,
  type V2,
} from '../../shared/brass/geometry.ts';
import {
  createBrassMaterial,
  createHot,
  type BrassMaterial,
  type BrassStyle,
  type Vec4U,
} from '../../shared/brass/material.ts';
import {
  createGlowLine,
  createGlowPoints,
  type GlowLine,
  type GlowPoints,
} from '../../shared/brass/lines.ts';
import type { RGB } from '../../shared/gfx/palette.ts';

// Styles and colours as in the assembly, so the swap is invisible where parts coincide.
const STYLES = {
  frame: { line: 0.42, fill: 0.55 },
  shaft: { line: 0.55, fill: 0.7 },
  gear: { line: 0.62, fill: 0.8 },
  crank: { line: 1.0, fill: 1.0 },
  pulley: { line: 1.15, fill: 1.1 },
  pen: { line: 1.2, fill: 1.2 },
  paper: { line: 0.75, fill: 2.2, tint: [0.62, 0.52, 0.36] as RGB },
} satisfies Record<string, BrassStyle>;
type StyleName = keyof typeof STYLES;

export const WIRE_COLOUR: RGB = [1.0, 0.86, 0.62];
export const TRACE_COLOUR: RGB = [1.0, 0.8, 0.45];
const PIN_COLOUR: RGB = [1.0, 0.72, 0.36];
const RULE_COLOUR: RGB = [0.62, 0.42, 0.18];
const ARC = 12;
const WORM_TEETH = 12;
const TRACE_N = 720;
const TRAIL_N = 360;
const DAY_MS = 86400e3;

export interface Unit {
  /** Everything that belongs to this crank (moved in as one). */
  group: Group;
  pulley: Mesh;
  slide: Mesh;
  disc: Group;
  pin: Mesh;
  block: Mesh;
  /** Part ids for highlighting: pulley, slide, disc, pin. */
  hot: [number, number, number, number];
  arbors: (Mesh | null)[];
  idler: Mesh | null;
  pairs: (readonly [number, number])[];
  idlerTeeth: number;
  angle: Float64Array;
  /** Arbor y positions from the driving shaft (0) to the crank. */
  ys: number[];
  crankY: number;
}

export interface RigFrame {
  /** Machine time, ms. */
  ms: number;
  /** Per crank (model index): 0–1 seated (moves in from behind), and the fraction of its throw set. */
  seat: ArrayLike<number>;
  set: ArrayLike<number>;
  /** Fraction of the throw set at machine time t (ms), for the record. */
  setAt: (crank: number, ms: number) => number;
  /** 0–1 the wire, guides and pen; the paper. */
  wire: number;
  paper: number;
  /** Record: start (ms; nothing before), window (ms of paper across the flat band). */
  recordFrom: number;
  windowMs: number;
  /** The lone pulley's trail: which crank, its opacity, its time window (ms) and width (machine units). */
  trailCrank: number;
  trail: number;
  trailMs: number;
  trailWidth: number;
  /** Overall brightness of the rig's luminous parts (0 when the assembly has taken over). */
  glow: number;
  /** Indicators on the trail crank: its throw (a glowing radius), its angle (an arc on the degree circle), and the
   * period of its wave (a bracket over the trail between two crests). */
  showThrow: number;
  showAngle: number;
  showPeriod: number;
}

export interface Rig {
  solids: Group;
  overlay: Group;
  units: Unit[];
  hot: Vec4U;
  /** World positions used for framing and labels. */
  geo: {
    r: number;
    Rc: number;
    flange: number;
    penX: number;
    takeX: number;
    supplyX: number;
    paperLo: number;
    paperHi: number;
    shaftY: (row: number) => number;
    guideTop: number;
  };
  /** Pen height now (world y), the wire's fixed end, and the period bracket's middle (world). */
  penY: number;
  anchorX: number;
  anchorY: number;
  bracketX: number;
  bracketY: number;
  update(f: RigFrame): void;
  /** Pen height (world y) at machine time ms with the cranks in place then. */
  penAt(ms: number, setAt: RigFrame['setAt']): number;
  dispose(): void;
}

export function createRig(machine: BrassMachine, detail: number): Rig {
  const model = machine.model;
  const n = model.cranks.length;
  const r = model.cranks[0]!.radius;
  const hot = createHot();
  const mats = {} as Record<StyleName, BrassMaterial>;
  for (const k of Object.keys(STYLES) as StyleName[]) mats[k] = createBrassMaterial(STYLES[k], hot);
  const geos: BufferGeometry[] = [];
  const solids = new Group();
  const overlay = new Group();
  let nextId = 1;
  const id = () => nextId++;
  const mesh = (b: GeoBuilder, style: StyleName, parent: Object3D): Mesh => {
    const g = b.build();
    geos.push(g);
    const m = new Mesh(g, mats[style].material);
    m.frustumCulled = false;
    parent.add(m);
    return m;
  };
  const M = new Matrix4();
  const at = (x: number, y: number, z: number) => M.makeTranslation(x, y, z);

  // ── Proportions (as in the assembly) ─────────────────────────────────────────────────────────────────────────
  let maxThrow = 0;
  for (const ck of model.cranks) maxThrow = Math.max(maxThrow, ck.throw0);
  const Rc = Math.min(1.8 * r, Math.max(0.6 * r, maxThrow + 0.35 * r));
  const flange = r * 1.16;
  const Z = {
    slide: -0.065,
    yoke: -0.08,
    disc: -0.14,
    ring: -0.165,
    gear: -0.3,
    gearStep: -0.09,
    shaft: -0.62,
  };
  const yokeHalfH = 0.075;
  const yokeHalfW = Rc + 0.03;
  const crankY = (i: number) => {
    const ck = model.cranks[i]!;
    return ck.restY + ck.row * (flange + Rc + ck.throw0 + 0.06 + yokeHalfH);
  };
  const driveGap = 0.95;
  const rowShaftY = { up: -Infinity, down: Infinity };
  for (let i = 0; i < n; i++) {
    const y = crankY(i);
    if (model.cranks[i]!.row > 0) rowShaftY.up = Math.max(rowShaftY.up, y + driveGap);
    else rowShaftY.down = Math.min(rowShaftY.down, y - driveGap);
  }
  const shaftY = (row: number) => (row > 0 ? rowShaftY.up : rowShaftY.down);

  const pulleyProfile: V2[] = [
    [0.035, 0.03],
    [flange, 0.03],
    [flange, 0.018],
    [r, 0.006],
    [r, -0.006],
    [flange, -0.018],
    [flange, -0.03],
    [0.035, -0.03],
  ];

  // ── Per crank ─────────────────────────────────────────────────────────────────────────────────────────────────
  const units: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const ck = model.cranks[i]!;
    const row = ck.row;
    const ky = crankY(i);
    const group = new Group();
    solids.add(group);
    const stat = { frame: new GeoBuilder(), shaft: new GeoBuilder() };

    const pid = id();
    const pulley = mesh(
      revolve(pulleyProfile, 40, pid).append(box(r * 0.62, 0, 0.032, 0.014, 0.01, 0.004, pid)),
      'pulley',
      group,
    );
    pulley.position.set(ck.x, ck.restY, 0);

    const sid = id();
    const yokeY = row * (flange + Rc + ck.throw0 + 0.06 + yokeHalfH);
    const sb = new GeoBuilder();
    sb.append(cylinder(0.02, Z.slide - 0.012, 0.04, 12, sid));
    const stripTop = yokeY - row * yokeHalfH;
    sb.append(box(0, stripTop / 2, Z.slide, 0.018, Math.abs(stripTop) / 2, 0.008, sid));
    const outer = roundRect(0, yokeY, yokeHalfW, yokeHalfH, 0.02);
    const slot = roundRect(0, yokeY, yokeHalfW - 0.03, 0.026, 0.012).reverse();
    sb.append(extrude(outer, [slot], Z.yoke - 0.01, Z.yoke + 0.01, sid));
    const slide = mesh(sb, 'crank', group);
    slide.position.set(ck.x, ck.restY, 0);

    const gid = id();
    const gy0 = ck.restY + Math.min(0, stripTop) - ck.throw0 - 0.02;
    const gy1 = ck.restY + Math.max(0, stripTop) + ck.throw0 + 0.02;
    for (const sx of [-1, 1])
      stat.frame.append(
        box(ck.x + sx * 0.032, (gy0 + gy1) / 2, Z.slide, 0.008, (gy1 - gy0) / 2 + 0.01, 0.012, gid),
      );

    // Crank disc with its radial slot; the pin is separate so it can slide out to its throw.
    const did = id();
    const discOuter = circle(Rc, 48);
    const slotHole = roundRect(0, Rc * 0.55 + 0.02, 0.016, Rc * 0.45, 0.014).reverse();
    const db = extrude(discOuter, [slotHole], Z.disc - 0.015, Z.disc + 0.015, did);
    db.append(cylinder(0.045, Z.disc - 0.02, Z.disc + 0.03, 16, did));
    db.append(box(0, -Rc * 0.62, Z.disc + 0.017, 0.006, Rc * 0.3, 0.003, did));
    const disc = new Group();
    disc.position.set(ck.x, ky, 0);
    group.add(disc);
    const spin = new Group(); // rotated by π on the lower row, as the assembly does
    if (row < 0) spin.rotation.z = Math.PI;
    disc.add(spin);
    mesh(db, 'crank', spin);
    const pinId = id();
    const pin = mesh(cylinder(0.014, Z.disc, Z.yoke + 0.012, 12, pinId), 'crank', spin);
    pin.position.set(0, ck.throw0, 0);

    const bid = id();
    const block = mesh(box(0, 0, Z.yoke, 0.03, 0.022, 0.012, bid), 'crank', group);

    const rid = id();
    const ring = extrude(
      circle(Rc + 0.05, 64),
      [circle(Rc + 0.018, 64).reverse()],
      Z.ring - 0.004,
      Z.ring + 0.004,
      rid,
    );
    for (let t = 0; t < 36; t++) {
      const a = (t / 36) * Math.PI * 2;
      const long = t % 9 === 0 ? 0.03 : t % 3 === 0 ? 0.02 : 0.012;
      const rr = Rc + 0.05 + long / 2;
      ring.append(
        box(0, 0, 0, long / 2, 0.003, 0.004, rid),
        new Matrix4().makeRotationZ(a).setPosition(rr * Math.cos(a), rr * Math.sin(a), Z.ring),
      );
    }
    stat.frame.append(ring, at(ck.x, ky, 0));
    stat.shaft.append(cylinder(0.022, Z.shaft + 0.03, Z.disc, 12, id()), at(ck.x, ky, 0));

    // Gear train from the driving shaft (arbor 0) to the crank (last arbor), laid out as in the assembly.
    const pairs = ck.train.pairs.map(([a, b]) => [a, b] as const);
    const eff = (t: number) => (t === 1 ? WORM_TEETH : t);
    const T = pairs.reduce((s, [a, b]) => s + eff(a) + eff(b), 0);
    const D = Math.abs(shaftY(row) - ky);
    const maxR = 1.85 * r;
    let module = (2 * D) / T;
    let maxTeeth = 0;
    for (const [a, b] of pairs) maxTeeth = Math.max(maxTeeth, eff(a), eff(b));
    let idlerTeeth = 0;
    if ((module * maxTeeth) / 2 > maxR) {
      const m = (2 * maxR) / maxTeeth;
      idlerTeeth = Math.max(12, Math.round(((2 * D) / m - T) / 2));
      module = (2 * D) / (T + 2 * idlerTeeth);
    }
    const ys: number[] = [shaftY(row)];
    let idlerY = 0;
    let yy = shaftY(row);
    pairs.forEach(([a, b], k) => {
      if (k === 0 && idlerTeeth) {
        yy -= (row * module * (eff(a) + idlerTeeth)) / 2;
        idlerY = yy;
        yy -= (row * module * (idlerTeeth + eff(b))) / 2;
      } else yy -= (row * module * (eff(a) + eff(b))) / 2;
      ys.push(yy);
    });
    ys[ys.length - 1] = ky;
    const ns = pairs.length;
    const zStage = (k: number) => Z.gear + Z.gearStep * (ns - 1 - k);
    const width = 0.026;
    const arbors: (Mesh | null)[] = [];
    for (let k = 0; k <= ns; k++) {
      const aid = id();
      const b = new GeoBuilder();
      if (k > 0)
        b.append(
          gear({ teeth: pairs[k - 1]![1], module, width, part: aid, detail }),
          at(0, 0, zStage(k - 1)),
        );
      if (k < ns) {
        const t = pairs[k]![0];
        if (t === 1) {
          const len = module * 14;
          const w = new GeoBuilder();
          const wr = module * (WORM_TEETH / 2);
          for (let j = -3; j <= 3; j++)
            w.append(
              revolve(
                [
                  [0, 0.006],
                  [wr, 0.004],
                  [wr, -0.004],
                  [0, -0.006],
                ],
                16,
                aid,
              ),
              at(0, 0, j * module * 2),
            );
          w.append(cylinder(wr * 0.6, -len / 2, len / 2, 12, aid));
          b.append(w, new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0, zStage(k)));
        } else b.append(gear({ teeth: t, module, width, part: aid, detail }), at(0, 0, zStage(k)));
      }
      if (k === ns) {
        mesh(b.tag(did), 'gear', spin);
        arbors.push(null);
        continue;
      }
      const am = mesh(b, 'gear', group);
      am.position.set(ck.x, ys[k]!, 0);
      arbors.push(am);
      stat.shaft.append(
        cylinder(0.016, Z.shaft, zStage(Math.min(k, ns - 1)) + 0.04, 10, id()),
        at(ck.x, ys[k]!, 0),
      );
    }
    let idler: Mesh | null = null;
    if (idlerTeeth) {
      idler = mesh(gear({ teeth: idlerTeeth, module, width, part: id(), detail }), 'gear', group);
      idler.position.set(ck.x, idlerY, zStage(0));
      stat.shaft.append(cylinder(0.014, Z.shaft, zStage(0) + 0.03, 10, id()), at(ck.x, idlerY, 0));
    }
    const mitre: V2[] = [
      [0.02, 0.0],
      [0.05, -0.03],
      [0.05, -0.045],
      [0.02, -0.045],
    ];
    stat.shaft.append(revolve(mitre, 20, id()), at(ck.x, shaftY(row), Z.shaft + 0.075));
    // A short stub of the driving shaft, so the train visibly starts somewhere.
    stat.shaft.append(
      rod(ck.x - 0.2, shaftY(row), Z.shaft, ck.x + 0.2, shaftY(row), Z.shaft, 0.026, 16, id()),
    );
    mesh(stat.frame, 'frame', group);
    mesh(stat.shaft, 'shaft', group);

    units.push({
      group,
      pulley,
      slide,
      disc,
      pin,
      block,
      hot: [pid, sid, did, pinId],
      arbors,
      idler,
      pairs,
      idlerTeeth,
      angle: new Float64Array(ns + 1),
      ys,
      crankY: ky,
    });
  }

  // ── Wire path: guides from the model (Kelvin: M2 in the lower row, then over two guides to the pen) ─────────────
  const guides = model.path.filter((p) => p.kind === 'guide');
  const lastCrank = model.cranks[n - 1]!;
  if (lastCrank.row !== -1 || guides.length !== 2 || guides.some((g) => g.row !== 1))
    throw new Error('rig expects the pen end as on Kelvin’s machine');
  const g1 = guides[0]!;
  const g2 = guides[1]!;
  const guideTop = g1.y;
  const penX = g2.x + g2.radius;
  const wireParts = new Group();
  solids.add(wireParts);
  const guideMeshes = guides.map((g) => {
    const gid = id();
    const gm = mesh(
      revolve(pulleyProfile, 40, gid).append(box(r * 0.55, 0, 0.032, 0.012, 0.012, 0.004, gid)),
      'pulley',
      wireParts,
    );
    gm.position.set(g.x, g.y, 0);
    return gm;
  });
  // The pen carriage, as in the assembly.
  const penId = id();
  const penGroup = new Group();
  wireParts.add(penGroup);
  mesh(
    new GeoBuilder()
      .append(box(0, -0.06, 0.05, 0.05, 0.06, 0.025, penId))
      .append(cylinder(0.012, 0.02, 0.08, 10, penId))
      .append(
        revolve(
          [
            [0, 0.05],
            [0.014, 0.035],
            [0.014, -0.02],
            [0, -0.02],
          ],
          12,
          penId,
        ),
        new Matrix4().makeRotationX(Math.PI).setPosition(0, -0.06, 0.07),
      ),
    'pen',
    penGroup,
  );
  penGroup.position.set(penX, model.penRestY, 0);
  const anchorMesh = mesh(box(0, 0, 0, 0.03, 0.03, 0.02, id()), 'pen', wireParts);

  // ── The record: paper band and rolls where the assembly puts them ────────────────────────────────────────────
  const paperGroup = new Group();
  solids.add(paperGroup);
  const takeR = 0.15;
  const supplyR = 0.24;
  const takeX = lastCrank.x + yokeHalfW + takeR + 0.12;
  const supplyX = penX + 0.38;
  const bandZ = -0.03;
  // Paper height from the pen's range over the assembly's run (same sampling as the assembly).
  let lo = Infinity;
  let hi = -Infinity;
  const traceN = Math.round(machine.span / 600000) + 1;
  const fullPen = (ms: number) => {
    const h = (ms - model.t0) / 3.6e6;
    let s = 0;
    for (const ck of model.cranks)
      s += ck.throw0 * Math.cos((ck.theta0 + ck.train.speed * h) * (Math.PI / 180));
    return model.penRestY + 2 * s;
  };
  for (let i = 0; i < traceN; i++) {
    const y = fullPen(model.t0 + (i * machine.span) / (traceN - 1));
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const paperLo = lo - 0.26;
  const paperHi = hi + 0.16;
  const paperCY = (paperLo + paperHi) / 2;
  const paperH = paperHi - paperLo;
  mesh(
    box((takeX + supplyX) / 2, paperCY, bandZ - 0.004, (supplyX - takeX) / 2, paperH / 2, 0.004, id()),
    'paper',
    paperGroup,
  );
  const roll = (radius: number, part: number) =>
    new GeoBuilder()
      .append(
        revolve(
          [
            [0, paperH / 2 + 0.05],
            [radius + 0.04, paperH / 2 + 0.05],
            [radius + 0.04, paperH / 2 + 0.02],
            [radius, paperH / 2 + 0.02],
            [radius, -paperH / 2 - 0.02],
            [radius + 0.04, -paperH / 2 - 0.02],
            [radius + 0.04, -paperH / 2 - 0.05],
            [0, -paperH / 2 - 0.05],
          ],
          48,
          part,
        ),
        new Matrix4().makeRotationX(-Math.PI / 2),
      )
      .append(box(radius * 0.5, paperH / 2 + 0.055, 0, radius * 0.45, 0.006, 0.012, part))
      .append(rod(0, -paperH / 2 - 0.3, 0, 0, paperH / 2 + 0.25, 0, 0.025, 10, part));
  const supply = mesh(roll(supplyR, id()), 'paper', paperGroup);
  supply.position.set(supplyX, paperCY, bandZ - supplyR);
  const takeup = mesh(roll(takeR, id()), 'paper', paperGroup);
  takeup.position.set(takeX, paperCY, bandZ - takeR);

  // ── Luminous parts ───────────────────────────────────────────────────────────────────────────────────────────
  const maxWire = 4 + n * (ARC + 1) + 2 * (ARC + 1) + 4;
  const wire: GlowLine = createGlowLine(maxWire, WIRE_COLOUR, { width: 0.005, intensity: 1.35 });
  const pins: GlowPoints = createGlowPoints(n, PIN_COLOUR, { radius: 0.05, intensity: 2.2 });
  const trace: GlowLine = createGlowLine(TRACE_N, TRACE_COLOUR, {
    width: 0.0075,
    intensity: 2.2,
    minPx: 0.0011,
  });
  const trail: GlowLine = createGlowLine(TRAIL_N, TRACE_COLOUR, {
    width: 0.009,
    intensity: 2.0,
    minPx: 0.0013,
  });
  const trailRest: GlowLine = createGlowLine(2, RULE_COLOUR, { width: 0.003, intensity: 0.8, minPx: 0.0008 });
  const throwLine: GlowLine = createGlowLine(2, PIN_COLOUR, { width: 0.006, intensity: 2.4, minPx: 0.0012 });
  const ANGLE_N = 72;
  const angleArc: GlowLine = createGlowLine(ANGLE_N + 2, PIN_COLOUR, {
    width: 0.009,
    intensity: 3,
    minPx: 0.0016,
  });
  const bracket: GlowLine = createGlowLine(4, WIRE_COLOUR, { width: 0.003, intensity: 1.4, minPx: 0.0009 });
  // Day ticks along the paper's base line (one polyline), and the printed metre lines (0 m = MLLW brighter).
  const maxTicks = 40;
  const base: GlowLine = createGlowLine(2 + maxTicks * 4, RULE_COLOUR, {
    width: 0.003,
    intensity: 0.9,
    minPx: 0.0008,
  });
  const metres: GlowLine[] = [];
  const metreY: number[] = [];
  const metreI: number[] = [];
  for (let mtr = -1; mtr <= 4; mtr++) {
    const y = model.penRestY + 2 * model.scale * (mtr - model.z0);
    if (y < paperLo + 0.19 || y > paperHi - 0.03) continue;
    const g = createGlowLine(2, RULE_COLOUR, {
      width: 0.003,
      intensity: mtr === 0 ? 0.9 : 0.5,
      minPx: 0.0008,
    });
    metres.push(g);
    metreY.push(y);
    metreI.push(mtr === 0 ? 0.9 : 0.5);
  }
  const lumens = [wire, pins, trace, trail, trailRest, throwLine, angleArc, bracket, base, ...metres];
  for (const g of lumens) overlay.add(g.mesh);
  const flatX0 = takeX + takeR;
  const recordZ = bandZ + 0.004;
  metres.forEach((g, k) => {
    g.set(0, flatX0, metreY[k]!, recordZ);
    g.set(1, supplyX - supplyR * 0.4, metreY[k]!, recordZ);
    g.commit(2);
  });
  const baseY = paperLo + 0.07;

  // Wire length fed past each pulley (for its spin), relative to the start of the run with every throw set.
  const restAlong = new Float64Array(n + 2);
  const along = new Float64Array(n + 2);
  const dy = new Float64Array(n);
  const fillAlong = (out: Float64Array) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = model.cranks[i]!.row * dy[i]!;
      out[i] = acc + v;
      acc += 2 * v;
    }
    out[n] = acc;
    out[n + 1] = acc;
  };
  {
    const h = 0;
    for (let i = 0; i < n; i++) {
      const ck = model.cranks[i]!;
      dy[i] = ck.row * ck.throw0 * Math.cos((ck.theta0 + ck.train.speed * h) * (Math.PI / 180));
    }
    fillAlong(restAlong);
  }

  const rig: Rig = {
    solids,
    overlay,
    units,
    hot,
    geo: { r, Rc, flange, penX, takeX, supplyX, paperLo, paperHi, shaftY, guideTop },
    penY: model.penRestY,
    anchorX: 0,
    anchorY: 0,
    bracketX: 0,
    bracketY: 0,
    penAt(ms, setAt) {
      const h = (ms - model.t0) / 3.6e6;
      let s = 0;
      for (let i = 0; i < n; i++) {
        const k = setAt(i, ms);
        if (k <= 0) continue;
        const ck = model.cranks[i]!;
        s += k * ck.throw0 * Math.cos((ck.theta0 + ck.train.speed * h) * (Math.PI / 180));
      }
      return model.penRestY + 2 * s;
    },
    update(f) {
      const st = machine.state; // machine.update(f.ms) has run: crank angles are the geared ones
      const D2R = Math.PI / 180;
      let first = -1;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const ck = model.cranks[i]!;
        const u = units[i]!;
        const seat = f.seat[i]!;
        u.group.visible = seat > 0.001;
        // Moves in from behind and below, settling into place.
        const e = 1 - seat;
        u.group.position.set(0, -ck.row * 0.35 * e * e, -2.2 * e * e);
        const thr = ck.throw0 * f.set[i]!;
        const th = st.angle[i]! * D2R;
        dy[i] = ck.row * thr * Math.cos(th);
        if (seat >= 0.999 && first < 0) first = i;
        if (seat >= 0.999) sum += thr * Math.cos(th);
        u.pulley.position.y = ck.restY + dy[i]!;
        u.slide.position.y = ck.restY + dy[i]!;
        u.disc.rotation.z = th;
        u.pin.position.y = thr;
        const px = ck.x - ck.row * thr * Math.sin(th);
        const py = u.crankY + ck.row * thr * Math.cos(th);
        u.block.position.set(px, py, 0);
        pins.set(
          i,
          px,
          py + u.group.position.y,
          Z.yoke + 0.02 + u.group.position.z,
          seat > 0.001
            ? f.glow * Math.min(1, seat * 1.4) * (0.5 + 0.5 * Math.min(1, thr / (0.6 * maxThrow)))
            : 0,
        );
        // Gears: the crank's wheel turns with the disc; work back up the train, meshing tooth to gap.
        const ns = u.pairs.length;
        u.angle[ns] = th;
        for (let s = ns - 1; s >= 0; s--) {
          const [a, b] = u.pairs[s]!;
          const beta = ck.row > 0 ? -Math.PI / 2 : Math.PI / 2;
          if (a === 1) u.angle[s] = -u.angle[s + 1]! * b;
          else if (s === 0 && u.idlerTeeth) {
            const phiI = beta + (beta + Math.PI + Math.PI / b - u.angle[1]!) * (b / u.idlerTeeth);
            u.angle[0] = beta + (beta + Math.PI + Math.PI / u.idlerTeeth - phiI) * (u.idlerTeeth / a);
            u.idler!.rotation.z = phiI;
          } else u.angle[s] = beta + (beta + Math.PI + Math.PI / b - u.angle[s + 1]!) * (b / a);
          const m = u.arbors[s];
          if (m) m.rotation.z = u.angle[s]!;
        }
      }
      pins.commit();
      fillAlong(along);
      for (let i = 0; i < n; i++)
        units[i]!.pulley.rotation.z = (model.cranks[i]!.row * (along[i]! - restAlong[i]!)) / r;
      guideMeshes[0]!.rotation.z = -(along[n]! - restAlong[n]!) / r;
      guideMeshes[1]!.rotation.z = -(along[n + 1]! - restAlong[n + 1]!) / r;

      // The pen: only the pulleys the wire threads count.
      const penY = model.penRestY + 2 * sum;
      rig.penY = penY;
      wireParts.visible = f.wire > 0.001;
      penGroup.position.y = penY;

      // Wire: fixed end above/below the first pulley in place, half a turn round each pulley, up over the guides
      // and down to the pen. Revealed from the pen end as it is threaded.
      let p = 0;
      if (first >= 0 && f.wire > 0.001) {
        const c0 = model.cranks[first]!;
        rig.anchorX = c0.x - r;
        rig.anchorY = c0.restY - c0.row * (c0.throw0 + 3 * r);
        anchorMesh.position.set(rig.anchorX, rig.anchorY - (c0.row > 0 ? 0.03 : -0.03), 0);
        wire.set(p++, rig.anchorX, rig.anchorY, 0);
        for (let i = first; i < n; i++) {
          const ck = model.cranks[i]!;
          const cy = ck.restY + dy[i]!;
          for (let j = 0; j <= ARC; j++) {
            // Over the top: from the left (π) clockwise to the right (0); under: from π anticlockwise to 2π.
            const a = Math.PI - (ck.row * Math.PI * j) / ARC;
            wire.set(p++, ck.x + r * Math.cos(a), cy + r * Math.sin(a), 0);
          }
        }
        for (let j = 0; j <= ARC; j++) {
          const a = Math.PI - (Math.PI / 2) * (j / ARC);
          wire.set(p++, g1.x + r * Math.cos(a), g1.y + r * Math.sin(a), 0);
        }
        for (let j = 0; j <= ARC; j++) {
          const a = Math.PI / 2 - (Math.PI / 2) * (j / ARC);
          wire.set(p++, g2.x + r * Math.cos(a), g2.y + r * Math.sin(a), 0);
        }
        wire.set(p++, penX, penY + 0.02, 0);
      }
      wire.commit(p);
      wire.intensity.value = 1.35 * f.glow * f.wire;

      // Paper and record.
      paperGroup.visible = f.paper > 0.001;
      const W = penX - flatX0;
      const fed = (W / f.windowMs) * (f.ms - model.t0);
      supply.rotation.y = -fed / supplyR;
      takeup.rotation.y = -fed / takeR;
      let q = 0;
      if (f.paper > 0.001) {
        const tFrom = Math.max(f.recordFrom, f.ms - f.windowMs);
        for (let k = 0; k < TRACE_N; k++) {
          const t = tFrom + ((f.ms - tFrom) * k) / (TRACE_N - 1);
          if (f.ms - tFrom < 1) break;
          trace.set(q++, penX - (W * (f.ms - t)) / f.windowMs, rig.penAt(t, f.setAt), recordZ);
        }
      }
      trace.commit(q);
      // A month of record packs ~60 waves into the band: dim it so the envelope reads, not a white block.
      const waves = (f.windowMs / 3.6e6) * (28.984 / 360);
      trace.intensity.value = 2.2 * f.glow * f.paper * Math.min(1, Math.max(0.42, 9 / waves));
      // Base line with a tick at each midnight (UTC) of machine time.
      let b = 0;
      if (f.paper > 0.001) {
        base.set(b++, flatX0, baseY, recordZ);
        const dayFirst = Math.ceil((f.ms - f.windowMs - model.t0) / DAY_MS);
        const dayLast = Math.floor((f.ms - model.t0) / DAY_MS);
        for (let d = dayFirst; d <= dayLast && b < 2 + maxTicks * 4 - 4; d++) {
          const x = penX - (W * (f.ms - (model.t0 + d * DAY_MS))) / f.windowMs;
          if (x < flatX0) continue;
          base.set(b++, x, baseY, recordZ);
          base.set(b++, x, baseY + 0.08, recordZ);
          base.set(b++, x, baseY, recordZ);
        }
        base.set(b++, penX, baseY, recordZ);
      }
      base.commit(b);
      base.intensity.value = 0.9 * f.glow * f.paper;
      metres.forEach((g, k) => (g.intensity.value = metreI[k]! * f.glow * f.paper));

      // The lone pulley's trail: its centre height over the last trailMs, drawn leftward from the pulley.
      let tq = 0;
      if (f.trail > 0.001 && f.trailCrank >= 0) {
        const ck = model.cranks[f.trailCrank]!;
        const u = units[f.trailCrank]!;
        const px = ck.x;
        for (let k = 0; k < TRAIL_N; k++) {
          const t = f.ms - (f.trailMs * k) / (TRAIL_N - 1);
          if (t < model.t0) break;
          const h = (t - model.t0) / 3.6e6;
          const y =
            ck.restY +
            ck.row * ck.throw0 * f.set[f.trailCrank]! * Math.cos((ck.theta0 + ck.train.speed * h) * D2R);
          trail.set(tq++, px - (f.trailWidth * (f.ms - t)) / f.trailMs, y + u.group.position.y, 0.02);
        }
        trailRest.set(0, px - f.trailWidth, ck.restY, 0.0);
        trailRest.set(1, px, ck.restY, 0.0);
      }
      trail.commit(tq);
      trailRest.commit(tq > 1 ? 2 : 0);
      trail.intensity.value = 2.0 * f.trail * f.glow;
      trailRest.intensity.value = 0.9 * f.trail * f.glow;

      // Indicators on the trail crank.
      let nt = 0;
      let na = 0;
      let nb = 0;
      if (f.trailCrank >= 0 && f.showThrow + f.showAngle + f.showPeriod > 0.001) {
        const i = f.trailCrank;
        const ck = model.cranks[i]!;
        const u = units[i]!;
        const thr = ck.throw0 * f.set[i]!;
        const th = st.angle[i]! * D2R;
        const px = ck.x - ck.row * thr * Math.sin(th);
        const py = u.crankY + ck.row * thr * Math.cos(th);
        throwLine.set(nt++, ck.x, u.crankY, Z.yoke + 0.03);
        throwLine.set(nt++, px, py, Z.yoke + 0.03);
        // The angle from the crank's zero (towards the wire's pull: up on the upper row, down on the lower).
        const a0 = ck.row > 0 ? Math.PI / 2 : -Math.PI / 2;
        const sweep = ((st.angle[i]! % 360) + 360) % 360;
        const ra = Rc + 0.034;
        const steps = Math.max(2, Math.ceil((sweep / 360) * ANGLE_N));
        for (let k = 0; k <= steps; k++) {
          const a = a0 + (sweep * D2R * k) / steps;
          angleArc.set(na++, ck.x + ra * Math.cos(a), u.crankY + ra * Math.sin(a), Z.ring + 0.012);
        }
        // Two crests of the trail: the pulley at its highest (row · cos θ = 1).
        const wdeg = ck.train.speed / 3.6e6;
        const crest = ck.row > 0 ? 0 : 180;
        const back = (((st.angle[i]! - crest) % 360) + 360) % 360;
        const tc = f.ms - back / wdeg - (back < 60 ? 360 / wdeg : 0);
        const tp = tc - 360 / wdeg;
        const xc = ck.x - (f.trailWidth * (f.ms - tc)) / f.trailMs;
        const xp = ck.x - (f.trailWidth * (f.ms - tp)) / f.trailMs;
        const yb = ck.restY + thr + 0.1;
        if (tp >= model.t0 && xp > ck.x - f.trailWidth) {
          bracket.set(nb++, xp, yb - 0.05, 0.02);
          bracket.set(nb++, xp, yb, 0.02);
          bracket.set(nb++, xc, yb, 0.02);
          bracket.set(nb++, xc, yb - 0.05, 0.02);
        }
        rig.bracketX = (xp + xc) / 2;
        rig.bracketY = yb;
      }
      throwLine.commit(nt);
      angleArc.commit(na);
      bracket.commit(nb);
      throwLine.intensity.value = 2.4 * f.showThrow * f.glow;
      angleArc.intensity.value = 3 * f.showAngle * f.glow;
      bracket.intensity.value = 1.4 * f.showPeriod * f.trail * f.glow;
      if (nb === 0) rig.bracketX = Number.NaN;
      // Lines with nothing to add stay out of the frame (WebGL2 has drawn zero-valued additive fragments black).
      for (const g of lumens) g.mesh.visible = g.intensity.value > 1e-3;
      pins.mesh.visible = f.glow > 1e-3;
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const k of Object.keys(mats) as StyleName[]) mats[k].dispose();
      for (const g of lumens) g.dispose();
      solids.clear();
      overlay.clear();
    },
  };
  return rig;
}
