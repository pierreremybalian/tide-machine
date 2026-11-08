// The machine in brass (HANDOFF §8.3, stages 8–11): every part laid out from the pure model in src/tides/machine.ts
// and driven by it. createMachine(ctx, config) builds the solids (rendered through the outline pass) and the
// luminous overlay (the wire and the pen's trace); update(machineTimeMs) turns every crank, gear and pulley, slides
// every yoke, re-lays the wire, moves the pen and feeds the paper. No allocation per frame.
//
// Layout (machine units; the model's x along the wire, y up; z towards the viewer):
//   z = 0      the wire plane: pulleys (grooves), the pen and its arm, the paper's front
//   z ≈ −0.07  pulley slides and the cross-slot yokes, with their guides
//   z ≈ −0.14  crank discs (slotted, the pin clamped at the throw), each in a fixed degree circle
//   z ≈ −0.3…−0.5  the gear trains: real tooth counts, arbors collinear with the crank, outward
//   z ≈ −0.6   the driving shafts along each row (mitre gears to each train), the frame behind
// The upper row's cranks and trains sit above it, the lower row's below, so neighbours in a row are 4r apart.

import { Group, Matrix4, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three/webgpu';
import {
  createMachineModel,
  createMachineState,
  machineAt,
  type MachineId,
  type MachineModel,
  type MachineState,
} from '../../tides/machine.ts';
import type { StationConstants } from '../../tides/predict.ts';
import type { RenderContext } from '../../scenes/types.ts';
import { box, circle, cylinder, extrude, gear, GeoBuilder, revolve, rod, roundRect, type V2 } from './geometry.ts';
import { createBrassMaterial, createHot, type BrassMaterial, type BrassStyle } from './material.ts';
import { createGlowLine, createGlowPoints, createPaperTrace, type GlowLine, type PaperLine, type PaperTrace } from './lines.ts';

export interface MachineConfig {
  machine: MachineId;
  station: StationConstants;
  /** Start of the run (ms UTC): cranks are set for this instant. */
  t0: number;
  /** Length of the run drawn on the paper, ms (default one week). */
  span?: number;
  /** Machine units of crank throw per metre of tide (default 0.4). */
  scale?: number;
  /** How far the wire runs sideways over guides to the pen above the paper (machine units, default 2.6). */
  penOffset?: number;
}

/** Places worth labelling (world coordinates, current pose). */
export type Spot =
  | 'disc' // a crank's disc centre
  | 'ring' // the left edge of its degree circle
  | 'pin' // its crank pin
  | 'train' // its gear train, halfway to the driving shaft
  | 'shaft' // where its train meets the driving shaft
  | 'pulley' // its pulley centre
  | 'anchor' // the wire's fixed end
  | 'run' // the middle of the wire's run after crank i
  | 'pen' // the pen's nib on the paper
  | 'paper'; // the top of the paper band

export interface BrassMachine {
  /** Solids: add to the scene rendered through the outline pass. */
  solids: Group;
  /** Luminous lines: add to the overlay scene. */
  overlay: Group;
  model: MachineModel;
  state: MachineState;
  /** Index of the featured crank (largest throw). */
  featured: number;
  /** Part ids per crank (pulley, slide, disc, arbors…), for highlighting. */
  crankParts: number[][];
  /** Axis-aligned bounds of the solids (min, max). */
  bounds: { min: Vector3; max: Vector3; centre: Vector3; size: Vector3 };
  /** Write the world position of a spot (for crank i where it applies) into out. */
  locate(spot: Spot, i: number, out: Vector3): Vector3;
  /** Pulley and crank-disc radii (machine units). */
  pulleyRadius: number;
  discRadius: number;
  /** Machine time of the run's start and its length (ms). */
  t0: number;
  span: number;
  update(machineTimeMs: number): void;
  /** Highlight up to four part ids (others −1). */
  setHot(a?: number, b?: number, c?: number, d?: number): void;
  /** Brightness of the wire, the trace and the crank pins (HDR multipliers). */
  setGlow(wire: number, trace: number, pins?: number): void;
  dispose(): void;
}

const STYLES = {
  frame: { line: 0.42, fill: 0.55 },
  shaft: { line: 0.55, fill: 0.7 },
  gear: { line: 0.62, fill: 0.8 },
  crank: { line: 1.0, fill: 1.0 },
  pulley: { line: 1.15, fill: 1.1 },
  pen: { line: 1.2, fill: 1.2 },
  paper: { line: 0.75, fill: 2.2, tint: [0.62, 0.52, 0.36] },
} satisfies Record<string, BrassStyle>;
type StyleName = keyof typeof STYLES;

const WIRE_COLOUR = [1.0, 0.86, 0.62] as const;
const TRACE_COLOUR = [1.0, 0.8, 0.45] as const;
const RULING = [0.32, 0.2, 0.08] as const;
const PIN_COLOUR = [1.0, 0.72, 0.36] as const;
const ARC_STEPS = 10;
const WORM_TEETH = 12; // effective pitch diameter of a single-start worm, in teeth (for spacing only)

interface Train {
  /** Arbor y positions from the driving shaft (0) to the crank (last). */
  ys: number[];
  /** Per arbor: rotation angle (radians), written by update. */
  angle: Float64Array;
  /** Per stage: driver and driven tooth counts; idler (0 = none) on the first stage. */
  pairs: (readonly [number, number])[];
  idler: number;
  idlerY: number;
  module: number;
  meshes: (Mesh | null)[];
  idlerMesh: Mesh | null;
}

export function createMachine(ctx: RenderContext, config: MachineConfig): BrassMachine {
  const span = config.span ?? 7 * 86400e3;
  const model = createMachineModel(config.station, config.machine, { t0: config.t0, scale: config.scale ?? 0.4, penOffset: config.penOffset ?? 2.6 });
  const state = createMachineState(model);
  const r = model.cranks[0]!.radius;
  const n = model.cranks.length;
  const detail = ctx.quality?.detail ?? 1;

  const hot = createHot();
  const mats = {} as Record<StyleName, BrassMaterial>;
  for (const k of Object.keys(STYLES) as StyleName[]) mats[k] = createBrassMaterial(STYLES[k], hot);
  const geos: BufferGeometry[] = [];
  const solids = new Group();
  const overlay = new Group();
  let nextId = 1;
  const id = () => nextId++;
  const mesh = (b: GeoBuilder, style: StyleName, parent: Object3D = solids): Mesh => {
    const g = b.build();
    geos.push(g);
    const m = new Mesh(g, mats[style].material);
    m.frustumCulled = false;
    parent.add(m);
    return m;
  };
  // Static parts, merged per style.
  const stat: Record<StyleName, GeoBuilder> = {
    frame: new GeoBuilder(),
    shaft: new GeoBuilder(),
    gear: new GeoBuilder(),
    crank: new GeoBuilder(),
    pulley: new GeoBuilder(),
    pen: new GeoBuilder(),
    paper: new GeoBuilder(),
  };
  const M = new Matrix4();
  const at = (x: number, y: number, z: number) => M.makeTranslation(x, y, z);

  // ── Proportions ────────────────────────────────────────────────────────────────────────────────────────────────
  let maxThrow = 0;
  let featured = 0;
  for (const ck of model.cranks) {
    if (ck.throw0 > maxThrow) {
      maxThrow = ck.throw0;
      featured = ck.index;
    }
  }
  const Rc = Math.min(1.8 * r, Math.max(0.6 * r, maxThrow + 0.35 * r)); // crank disc radius
  const flange = r * 1.16;
  const Z = { slide: -0.065, yoke: -0.08, disc: -0.14, ring: -0.165, rail: -0.21, gear: -0.3, gearStep: -0.09, shaft: -0.62, frame: -0.72 };
  const yokeHalfH = 0.075;
  const yokeHalfW = Rc + 0.03;
  // Crank centre: far enough from its pulley that disc and pulley never overlap on screen.
  const crankY = (i: number) => {
    const ck = model.cranks[i]!;
    return ck.restY + ck.row * (flange + Rc + ck.throw0 + 0.06 + yokeHalfH);
  };
  const driveGap = 0.95; // nominal crank-to-driving-shaft distance
  const rowShaftY = { up: -Infinity, down: Infinity };
  for (let i = 0; i < n; i++) {
    const y = crankY(i);
    if (model.cranks[i]!.row > 0) rowShaftY.up = Math.max(rowShaftY.up, y + driveGap);
    else rowShaftY.down = Math.min(rowShaftY.down, y - driveGap);
  }
  const shaftY = (row: number) => (row > 0 ? rowShaftY.up : rowShaftY.down);
  const lastNode = model.path[model.path.length - 1]!;

  // ── Per crank ─────────────────────────────────────────────────────────────────────────────────────────────────
  const crankParts: number[][] = [];
  const pulleys: Mesh[] = [];
  const slides: Mesh[] = [];
  const discs: Group[] = [];
  const blocks: Mesh[] = [];
  const trains: Train[] = [];
  const crankYs = new Float64Array(n);

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

  for (let i = 0; i < n; i++) {
    const ck = model.cranks[i]!;
    const row = ck.row;
    const ky = crankY(i);
    crankYs[i] = ky;
    const ids: number[] = [];

    // Pulley: grooved, spoked by a hub ring; spins as the wire feeds.
    const pid = id();
    ids.push(pid);
    const pb = revolve(pulleyProfile, 40, pid).append(box(r * 0.62, 0, 0.032, 0.014, 0.01, 0.004, pid));
    const pm = mesh(pb, 'pulley');
    pm.position.set(ck.x, ck.restY, 0);
    pulleys.push(pm);

    // Slide: the pulley's axle plate and strip up to the yoke, and the cross-slot yoke (moves vertically).
    const sid = id();
    ids.push(sid);
    const yokeY = row * (flange + Rc + ck.throw0 + 0.06 + yokeHalfH); // relative to the pulley centre
    const sb = new GeoBuilder();
    sb.append(cylinder(0.02, Z.slide - 0.012, 0.04, 12, sid));
    const stripTop = yokeY - row * yokeHalfH;
    sb.append(box(0, stripTop / 2, Z.slide, 0.018, Math.abs(stripTop) / 2, 0.008, sid));
    const outer = roundRect(0, yokeY, yokeHalfW, yokeHalfH, 0.02);
    const slot = roundRect(0, yokeY, yokeHalfW - 0.03, 0.026, 0.012).reverse();
    sb.append(extrude(outer, [slot], Z.yoke - 0.01, Z.yoke + 0.01, sid));
    const sm = mesh(sb, 'crank');
    sm.position.set(ck.x, ck.restY, 0);
    slides.push(sm);

    // Guides for the slide (fixed), either side of the strip.
    const gid = id();
    const gy0 = ck.restY + Math.min(0, stripTop) - ck.throw0 - 0.02;
    const gy1 = ck.restY + Math.max(0, stripTop) + ck.throw0 + 0.02;
    for (const sx of [-1, 1]) stat.frame.append(box(ck.x + sx * 0.032, (gy0 + gy1) / 2, Z.slide, 0.008, (gy1 - gy0) / 2 + 0.01, 0.012, gid));

    // Crank disc with its radial slot, the pin clamped at the throw, and the last gear of the train behind.
    const did = id();
    ids.push(did);
    const discOuter = circle(Rc, 48);
    const slotHole = roundRect(0, (Rc * 0.55 + 0.02) * 1, 0.016, Rc * 0.45, 0.014).reverse();
    const db = extrude(discOuter, [slotHole], Z.disc - 0.015, Z.disc + 0.015, did);
    db.append(cylinder(0.045, Z.disc - 0.02, Z.disc + 0.03, 16, did)); // hub
    db.append(box(0, -Rc * 0.62, Z.disc + 0.017, 0.006, Rc * 0.3, 0.003, did)); // epoch pointer (opposite the slot)
    // Pin at local (0, throw) (the disc is rotated by π on the lower row).
    const pinGeo = cylinder(0.014, Z.disc, Z.yoke + 0.012, 12, did);
    db.append(pinGeo, M.makeTranslation(0, ck.throw0, 0));
    const dm = new Group();
    dm.position.set(ck.x, ky, 0);
    solids.add(dm);
    const discMesh = mesh(db, 'crank', dm);
    if (row < 0) discMesh.rotation.z = Math.PI;
    discs.push(dm);

    // Pin block riding in the yoke's slot (moves with the pin, does not turn).
    const bid = id();
    const bm = mesh(box(0, 0, Z.yoke, 0.03, 0.022, 0.012, bid), 'crank');
    blocks.push(bm);

    // Fixed degree circle round the disc (silvered ring with ticks), and the crank axle.
    const rid = id();
    const ring = extrude(circle(Rc + 0.05, 64), [circle(Rc + 0.018, 64).reverse()], Z.ring - 0.004, Z.ring + 0.004, rid);
    for (let t = 0; t < 36; t++) {
      const a = (t / 36) * Math.PI * 2;
      const long = t % 9 === 0 ? 0.03 : t % 3 === 0 ? 0.02 : 0.012;
      const rr = Rc + 0.05 + long / 2;
      ring.append(box(0, 0, 0, long / 2, 0.003, 0.004, rid), new Matrix4().makeRotationZ(a).setPosition(rr * Math.cos(a), rr * Math.sin(a), Z.ring));
    }
    stat.frame.append(ring, at(ck.x, ky, 0));
    stat.shaft.append(cylinder(0.022, Z.shaft + 0.03, Z.disc, 12, id()), at(ck.x, ky, 0));

    // ── Gear train, from the driving shaft (arbor 0) to the crank (last arbor) ──
    const pairs = ck.train.pairs.map(([a, b]) => [a, b] as const);
    const eff = (t: number) => (t === 1 ? WORM_TEETH : t);
    const T = pairs.reduce((s, [a, b]) => s + eff(a) + eff(b), 0);
    const D = Math.abs(shaftY(row) - ky);
    const maxR = 1.85 * r;
    let module = (2 * D) / T;
    let maxTeeth = 0;
    for (const [a, b] of pairs) maxTeeth = Math.max(maxTeeth, eff(a), eff(b));
    let idler = 0;
    if ((module * maxTeeth) / 2 > maxR) {
      // An idler on the first stage takes up the distance without changing the ratio.
      const m = (2 * maxR) / maxTeeth;
      idler = Math.max(12, Math.round(((2 * D) / m - T) / 2));
      module = (2 * D) / (T + 2 * idler);
    }
    const ys: number[] = [shaftY(row)];
    let idlerY = 0;
    let yy = shaftY(row);
    pairs.forEach(([a, b], k) => {
      if (k === 0 && idler) {
        yy -= (row * module * (eff(a) + idler)) / 2;
        idlerY = yy;
        yy -= (row * module * (idler + eff(b))) / 2;
      } else yy -= (row * module * (eff(a) + eff(b))) / 2;
      ys.push(yy);
    });
    ys[ys.length - 1] = ky; // exact
    const ns = pairs.length;
    const zStage = (k: number) => Z.gear + Z.gearStep * (ns - 1 - k);
    const width = 0.026;
    const trainMeshes: (Mesh | null)[] = [];
    for (let k = 0; k <= ns; k++) {
      // Arbor k carries the driven gear of stage k−1 and the driver of stage k.
      const aid = id();
      ids.push(aid);
      const b = new GeoBuilder();
      if (k > 0) {
        const t = pairs[k - 1]![1];
        b.append(gear({ teeth: t, module, width, part: aid, detail }), at(0, 0, zStage(k - 1)));
      }
      if (k < ns) {
        const t = pairs[k]![0];
        if (t === 1) {
          // Single-start worm (axis across the train), drawn as a threaded rod at the wheel's rim.
          const len = module * 14;
          const w = new GeoBuilder();
          const wr = module * (WORM_TEETH / 2);
          for (let j = -3; j <= 3; j++) w.append(revolve([[0, 0.006], [wr, 0.004], [wr, -0.004], [0, -0.006]], 16, aid), at(0, 0, j * module * 2));
          w.append(cylinder(wr * 0.6, -len / 2, len / 2, 12, aid));
          b.append(w, new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0, zStage(k)));
        } else b.append(gear({ teeth: t, module, width, part: aid, detail }), at(0, 0, zStage(k)));
      }
      if (k === ns) {
        // The crank's own gear turns with the disc: merge it into the disc.
        const g = new GeoBuilder().append(b);
        dm.add(mesh(g.tag(did), 'gear'));
        trainMeshes.push(null);
        continue;
      }
      const am = mesh(b, 'gear');
      am.position.set(ck.x, ys[k]!, 0);
      trainMeshes.push(am);
      // Arbor shaft (fixed).
      stat.shaft.append(cylinder(0.016, Z.shaft, zStage(Math.min(k, ns - 1)) + 0.04, 10, id()), at(ck.x, ys[k]!, 0));
    }
    let idlerMesh: Mesh | null = null;
    if (idler) {
      const iid = id();
      ids.push(iid);
      idlerMesh = mesh(gear({ teeth: idler, module, width, part: iid, detail }), 'gear');
      idlerMesh.position.set(ck.x, idlerY, zStage(0));
      stat.shaft.append(cylinder(0.014, Z.shaft, zStage(0) + 0.03, 10, id()), at(ck.x, idlerY, 0));
    }
    // Mitre pair from the driving shaft to arbor 0.
    const mitre: V2[] = [
      [0.02, 0.0],
      [0.05, -0.03],
      [0.05, -0.045],
      [0.02, -0.045],
    ];
    stat.shaft.append(revolve(mitre, 20, id()), at(ck.x, shaftY(row), Z.shaft + 0.075));
    stat.shaft.append(revolve(mitre, 20, id()), new Matrix4().makeRotationY(Math.PI / 2).setPosition(ck.x - 0.075, shaftY(row), Z.shaft));
    trains.push({ ys, angle: new Float64Array(ns + 1), pairs, idler, idlerY, module, meshes: trainMeshes, idlerMesh });
    crankParts.push(ids);
  }

  // ── Driving shafts, frame, base ────────────────────────────────────────────────────────────────────────────────
  const xs0 = model.cranks[0]!.x - 0.6;
  const xs1 = model.cranks[n - 1]!.x + 0.5;
  for (const row of [1, -1]) {
    stat.shaft.append(rod(xs0, shaftY(row), Z.shaft, xs1, shaftY(row), Z.shaft, 0.026, 16, id()));
  }
  // Vertical drive linking the two rows at the left, with the hand crank's wheel in front.
  stat.shaft.append(rod(xs0 - 0.12, shaftY(-1) - 0.05, Z.shaft, xs0 - 0.12, shaftY(1) + 0.05, Z.shaft, 0.03, 16, id()));
  // ── The record: a paper band fed from a supply drum past the pen onto a take-up roll ──
  // Sample the pen over the run first: the band covers what this run draws.
  const traceN = Math.round(span / 600000) + 1;
  const ts = new Float64Array(traceN);
  const ys = new Float64Array(traceN);
  const ss = new Float64Array(traceN);
  const tmp = createMachineState(model);
  let lo = Infinity;
  let hi = -Infinity;
  const penX = lastNode.x + lastNode.radius;
  const lastRowX = model.cranks[n - 1]!.x;
  const takeR = 0.15;
  const supplyR = 0.24;
  const takeX = lastRowX + yokeHalfW + takeR + 0.12; // clear of the last crank's yoke and train
  const supplyX = penX + 0.38;
  const bandZ = -0.03;
  const visible = penX - (takeX + takeR); // flat paper between the take-up roll and the pen
  const feed = visible / (2.5 * 86400e3); // machine units of paper per ms: the band shows the last 2.5 days
  for (let i = 0; i < traceN; i++) {
    const t = config.t0 + (i * span) / (traceN - 1);
    machineAt(model, t, 'geared', tmp);
    ts[i] = i / (traceN - 1);
    ys[i] = tmp.penY;
    ss[i] = feed * (t - config.t0);
    lo = Math.min(lo, tmp.penY);
    hi = Math.max(hi, tmp.penY);
  }
  const paperLo = lo - 0.26;
  const paperHi = hi + 0.16;
  const paperCY = (paperLo + paperHi) / 2;
  const paperH = paperHi - paperLo;
  for (let i = 0; i < traceN; i++) ys[i] = ys[i]! - paperCY;

  const top = shaftY(1) + 0.25;
  const bottom = Math.min(shaftY(-1) - 0.3, paperLo - 0.55);
  const baseTop = bottom - 0.05;
  const midY = (top + bottom) / 2;
  const wheel = id();
  const crankWheel = extrude(circle(0.3, 48), [circle(0.24, 48).reverse()], -0.015, 0.015, wheel)
    .append(box(0, 0, 0, 0.27, 0.018, 0.012, wheel))
    .append(box(0, 0, 0, 0.018, 0.27, 0.012, wheel))
    .append(cylinder(0.05, -0.04, 0.04, 16, wheel));
  const handWheel = mesh(crankWheel, 'crank');
  handWheel.position.set(xs0 - 0.12, midY, 0.05);
  const hid = id();
  const handle = mesh(cylinder(0.022, 0.05, 0.22, 12, hid).append(cylinder(0.035, 0.12, 0.2, 12, hid)), 'crank', handWheel);
  handle.position.set(0.26, 0, 0);
  stat.shaft.append(cylinder(0.03, Z.shaft, 0.04, 12, id()), at(xs0 - 0.12, midY, 0));

  // Frame: rails behind each row of cranks, columns, top and bottom beams, a stepped base.
  const fx0 = xs0 - 0.45;
  const fx1 = supplyX + supplyR + 0.3;
  for (const row of [1, -1]) {
    const rid = id();
    // A rail that follows the row (the rows spread where the big components sit).
    const pts = model.cranks.filter((c) => c.row === row);
    for (let j = 0; j < pts.length - 1; j++) {
      const a = pts[j]!;
      const b = pts[j + 1]!;
      stat.frame.append(rod(a.x, crankYs[a.index]!, Z.rail, b.x, crankYs[b.index]!, Z.rail, 0.03, 10, rid));
    }
    stat.frame.append(rod(xs0 - 0.12, crankYs[pts[0]!.index]!, Z.rail, pts[0]!.x, crankYs[pts[0]!.index]!, Z.rail, 0.03, 10, rid));
  }
  // Columns at the ends, and between the mechanism and the record.
  const colXs: number[] = [fx0 + 0.1, (lastRowX + yokeHalfW + takeX - takeR) / 2, fx1];
  const colProfile = (h: number): V2[] => [
    [0, h],
    [0.1, h],
    [0.1, h - 0.05],
    [0.065, h - 0.08],
    [0.05, h - 0.12],
    [0.05, 0.12],
    [0.065, 0.08],
    [0.1, 0.05],
    [0.1, 0],
    [0, 0],
  ];
  for (const cx of colXs) {
    const cid = id();
    const col = revolve(colProfile(top - baseTop), 24, cid);
    stat.frame.append(col, new Matrix4().makeRotationX(-Math.PI / 2).setPosition(cx, baseTop, Z.frame));
  }
  const beam = id();
  stat.frame.append(box((fx0 + fx1) / 2, top + 0.04, Z.frame, (fx1 - fx0) / 2 + 0.12, 0.05, 0.07, beam));
  stat.frame.append(box((fx0 + fx1) / 2, bottom + 0.1, Z.frame, (fx1 - fx0) / 2 + 0.12, 0.04, 0.06, id()));
  // Bearings for the driving shafts on the columns.
  for (const cx of colXs) for (const row of [1, -1]) stat.frame.append(box(cx, shaftY(row), (Z.shaft + Z.frame) / 2, 0.06, 0.06, 0.07, id()));
  // Stepped base.
  const bx0 = fx0 - 0.3;
  const bx1 = fx1 + 0.3;
  stat.frame.append(box((bx0 + bx1) / 2, baseTop - 0.07, -0.35, (bx1 - bx0) / 2, 0.07, 0.62, id()));
  stat.frame.append(box((bx0 + bx1) / 2, baseTop - 0.2, -0.35, (bx1 - bx0) / 2 + 0.08, 0.06, 0.7, id()));

  // ── Guide pulleys (fixed, they spin as the wire feeds), the fixed end, the pen, the paper ─────────────────────
  const guides: { mesh: Mesh; k: number; r: number; row: number }[] = [];
  model.path.forEach((node, k) => {
    if (node.kind !== 'guide') return;
    const gid = id();
    const gm = mesh(revolve(pulleyProfile, 40, gid).append(box(r * 0.55, 0, 0.032, 0.012, 0.012, 0.004, gid)), 'pulley');
    gm.position.set(node.x, node.y, 0);
    guides.push({ mesh: gm, k, r: node.radius, row: node.row });
    // A bracket back to the frame.
    stat.frame.append(cylinder(0.02, Z.frame, 0.04, 10, id()), at(node.x, node.y, 0));
    stat.frame.append(box(node.x, node.y, -0.05, 0.03, 0.03, 0.01, gid));
  });
  const anchorNode = model.path[0]!;
  const eye = id();
  stat.pen.append(box(anchorNode.x, anchorNode.y - (model.cranks[0]!.row > 0 ? 0.03 : -0.03), 0, 0.03, 0.03, 0.02, eye));
  stat.frame.append(cylinder(0.018, Z.frame, -0.02, 10, eye), at(anchorNode.x, anchorNode.y - (model.cranks[0]!.row > 0 ? 0.03 : -0.03), 0));

  // Pen carriage: hangs on the wire, slides on two rods, the nib against the paper.
  const penId = id();
  const penGroup = new Group();
  solids.add(penGroup);
  const carriage = new GeoBuilder()
    .append(box(0, -0.06, 0.05, 0.05, 0.06, 0.025, penId))
    .append(cylinder(0.012, 0.02, 0.08, 10, penId), at(0, 0.0, 0))
    .append(revolve([[0, 0.05], [0.014, 0.035], [0.014, -0.02], [0, -0.02]], 12, penId), new Matrix4().makeRotationX(Math.PI).setPosition(0, -0.06, 0.07));
  mesh(carriage, 'pen', penGroup);
  penGroup.position.set(penX, model.penRestY, 0);
  const rodId = id();
  for (const sx of [-1, 1]) stat.frame.append(rod(penX + sx * 0.075, paperLo - 0.2, 0.05, penX + sx * 0.075, paperHi + 0.2, 0.05, 0.009, 8, rodId));
  for (const yb of [paperHi + 0.22, paperLo - 0.22]) {
    stat.frame.append(box(penX, yb, 0.0, 0.11, 0.022, 0.06, rodId));
    stat.frame.append(box(penX, yb, -0.2, 0.03, 0.02, 0.17, rodId));
  }

  // Paper band (flat, between the rolls), supply drum and take-up roll; both turn as the paper feeds.
  const bandId = id();
  stat.paper.append(box((takeX + supplyX) / 2, paperCY, bandZ - 0.004, (supplyX - takeX) / 2, paperH / 2, 0.004, bandId));
  const roll = (radius: number, part: number) =>
    new GeoBuilder()
      .append(revolve([[0, paperH / 2 + 0.05], [radius + 0.04, paperH / 2 + 0.05], [radius + 0.04, paperH / 2 + 0.02], [radius, paperH / 2 + 0.02], [radius, -paperH / 2 - 0.02], [radius + 0.04, -paperH / 2 - 0.02], [radius + 0.04, -paperH / 2 - 0.05], [0, -paperH / 2 - 0.05]], 48, part), new Matrix4().makeRotationX(-Math.PI / 2))
      .append(box(radius * 0.5, paperH / 2 + 0.055, 0, radius * 0.45, 0.006, 0.012, part))
      .append(rod(0, -paperH / 2 - 0.3, 0, 0, paperH / 2 + 0.25, 0, 0.025, 10, part));
  const supply = mesh(roll(supplyR, id()), 'paper');
  supply.position.set(supplyX, paperCY, bandZ - supplyR);
  const takeup = mesh(roll(takeR, id()), 'paper');
  takeup.position.set(takeX, paperCY, bandZ - takeR);
  // Roll frame: bars above and below, posts to the base.
  const rf = id();
  for (const yb of [paperHi + 0.27, paperLo - 0.27]) stat.frame.append(rod(takeX, yb, -0.2, supplyX, yb, -0.2, 0.02, 8, rf));

  // Lines on the paper: the trace (revealed), the pen's hour and day ticks along a base line (revealed), and the
  // printed ruling: a line per metre of tide (MLLW brighter) and a column per day.
  const lines: PaperLine[] = [{ s: ss, y: ys, t: ts, width: 0.0075, intensity: 2.2, reveal: true }];
  const baseY = paperLo + 0.07 - paperCY;
  const hours = Math.round(span / 3.6e6);
  for (let h = 0; h <= hours; h++) {
    const t = (h * 3.6e6) / span;
    const sh = feed * h * 3.6e6;
    const len = h % 24 === 0 ? 0.08 : h % 6 === 0 ? 0.045 : 0.02;
    lines.push({ s: Float64Array.of(sh, sh), y: Float64Array.of(baseY, baseY + len), t: Float64Array.of(t, t), width: 0.004, intensity: 1.0, reveal: true });
  }
  const sFrom = -(supplyX - takeX) - 0.5;
  const sTo = feed * span + (supplyX - penX) + 0.5;
  const ruleN = 2;
  const rule = (y: number, intensity: number) =>
    lines.push({ s: Float64Array.of(sFrom, sTo), y: Float64Array.of(y, y), t: new Float64Array(ruleN), width: 0.003, intensity, reveal: false });
  rule(baseY, 0.7);
  for (let mtr = -1; mtr <= 4; mtr++) {
    const y = model.penRestY + 2 * model.scale * (mtr - model.z0) - paperCY;
    if (y < baseY + 0.12 || y > paperH / 2 - 0.03) continue;
    rule(y, mtr === 0 ? 0.9 : 0.5);
  }
  for (let d = -3; d <= Math.round(span / 86400e3) + 3; d++) {
    const sd = feed * d * 86400e3;
    lines.push({ s: Float64Array.of(sd, sd), y: Float64Array.of(baseY, paperH / 2 - 0.03), t: new Float64Array(2), width: 0.003, intensity: 0.5, reveal: false });
  }
  const trace: PaperTrace = createPaperTrace(lines, TRACE_COLOUR, RULING);
  trace.x0.value = takeX + takeR * 0.6;
  trace.x1.value = supplyX - supplyR * 0.4;
  const traceGroup = new Group();
  traceGroup.position.set(penX, paperCY, bandZ + 0.004);
  traceGroup.add(trace.mesh);
  overlay.add(traceGroup);

  // ── Static meshes ──────────────────────────────────────────────────────────────────────────────────────────────
  for (const k of Object.keys(stat) as StyleName[]) if (stat[k].count) mesh(stat[k], k);

  // ── The wire ───────────────────────────────────────────────────────────────────────────────────────────────────
  const maxPts = 2 + model.path.length * (ARC_STEPS + 3);
  const wire: GlowLine = createGlowLine(maxPts, WIRE_COLOUR, { width: 0.005, intensity: 1.35 });
  overlay.add(wire.mesh);
  // Crank pins glow: each circles at its constituent's speed, at a radius set by its amplitude.
  const pins = createGlowPoints(n, PIN_COLOUR, { radius: 0.05, intensity: 2.2 });
  overlay.add(pins.mesh);

  // ── Bounds ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const min = new Vector3(bx0, baseTop - 0.26, -1.0);
  const max = new Vector3(bx1, top + 0.1, 0.3);
  const bounds = { min, max, centre: min.clone().add(max).multiplyScalar(0.5), size: max.clone().sub(min) };

  const locate = (spot: Spot, i: number, out: Vector3): Vector3 => {
    const ck = model.cranks[Math.max(0, Math.min(n - 1, i))]!;
    const j = ck.index;
    const th = state.angle[j]! * (Math.PI / 180);
    switch (spot) {
      case 'disc':
        return out.set(ck.x, crankYs[j]!, Z.disc);
      case 'ring':
        return out.set(ck.x - Rc - 0.06, crankYs[j]!, Z.ring);
      case 'pin':
        return out.set(ck.x - ck.row * state.throw[j]! * Math.sin(th), crankYs[j]! + ck.row * state.throw[j]! * Math.cos(th), Z.yoke);
      case 'train': {
        const ys = trains[j]!.ys;
        return out.set(ck.x, (ys[0]! + ys[ys.length - 1]!) / 2, Z.gear);
      }
      case 'shaft':
        return out.set(ck.x, trains[j]!.ys[0]!, Z.shaft);
      case 'pulley':
        return out.set(state.x[j]!, state.y[j]!, 0);
      case 'anchor':
        return out.set(state.outX[0]!, state.outY[0]!, 0);
      case 'run': {
        const k = Math.min(model.path.length - 2, j + 1);
        return out.set(state.outX[k]!, (state.outY[k]! + state.inY[k + 1]!) / 2, 0);
      }
      case 'pen':
        return out.set(penX, state.penY - 0.06, 0.05);
      case 'paper':
        return out.set((takeX + penX) / 2, paperHi + 0.05, bandZ);
    }
  };

  // Rest wire lengths (pulley spin is relative to the start).
  machineAt(model, config.t0, 'geared', state);
  const along0 = Float64Array.from(state.along);

  const self: BrassMachine = {
    solids,
    overlay,
    model,
    state,
    featured,
    crankParts,
    bounds,
    locate,
    pulleyRadius: r,
    discRadius: Rc,
    t0: config.t0,
    span,
    update(ms) {
      machineAt(model, ms, 'geared', state);
      for (let i = 0; i < n; i++) {
        const ck = model.cranks[i]!;
        const k = i + 1; // path index
        const th = state.angle[i]! * (Math.PI / 180);
        pulleys[i]!.position.set(state.x[i]!, state.y[i]!, 0);
        pulleys[i]!.rotation.z = (ck.row * (state.along[k]! - along0[k]!)) / ck.radius;
        slides[i]!.position.set(state.x[i]!, state.y[i]!, 0);
        discs[i]!.rotation.z = th;
        const px = ck.x - ck.row * state.throw[i]! * Math.sin(th);
        const py = crankYs[i]! + ck.row * state.throw[i]! * Math.cos(th);
        blocks[i]!.position.set(px, py, 0);
        // Brightness by amplitude, so the terms that matter read first (a floor keeps every pin visible).
        pins.set(i, px, py, Z.yoke + 0.02, 0.5 + 0.5 * Math.min(1, state.throw[i]! / (0.6 * maxThrow)));
        // Gears: the crank's own wheel turns with the disc; work back up the train, meshing tooth to gap.
        const tr = trains[i]!;
        const ns = tr.pairs.length;
        tr.angle[ns] = th;
        for (let s = ns - 1; s >= 0; s--) {
          const [a, b] = tr.pairs[s]!;
          const beta = ck.row > 0 ? -Math.PI / 2 : Math.PI / 2; // from the driver (outward) towards the driven
          if (a === 1) tr.angle[s] = -tr.angle[s + 1]! * b; // a worm turns once per tooth of its wheel
          else if (s === 0 && tr.idler) {
            const phiI = beta + (beta + Math.PI + Math.PI / b - tr.angle[1]!) * (b / tr.idler);
            tr.angle[0] = beta + (beta + Math.PI + Math.PI / tr.idler - phiI) * (tr.idler / a);
            tr.idlerMesh!.rotation.z = phiI;
          } else tr.angle[s] = beta + (beta + Math.PI + Math.PI / b - tr.angle[s + 1]!) * (b / a);
          const m = tr.meshes[s];
          if (m) m.rotation.z = tr.angle[s]!;
        }
      }
      penGroup.position.y = state.penY;
      const fed = feed * (ms - config.t0);
      traceGroup.position.x = penX - fed;
      supply.rotation.y = -fed / supplyR;
      takeup.rotation.y = -fed / takeR;
      trace.reveal.value = Math.min(1, Math.max(0, (ms - config.t0) / span));
      for (const g of guides) g.mesh.rotation.z = (g.row * (state.along[g.k]! - along0[g.k]!)) / g.r;

      // Wire: anchor, then each node's arrival point, wrapped arc and departure, then down to the pen.
      let p = 0;
      wire.set(p++, state.outX[0]!, state.outY[0]!, 0);
      for (let k = 1; k < model.path.length; k++) {
        const node = model.path[k]!;
        const cx = node.crank >= 0 ? state.x[node.crank]! : node.x;
        const cy = node.crank >= 0 ? state.y[node.crank]! : node.y;
        const a0 = state.arcStart[k]!;
        const sw = state.arcSweep[k]!;
        for (let j = 0; j <= ARC_STEPS; j++) {
          const a = a0 + (sw * j) / ARC_STEPS;
          wire.set(p++, cx + node.radius * Math.cos(a), cy + node.radius * Math.sin(a), 0);
        }
      }
      wire.set(p++, state.penX, state.penY + 0.02, 0);
      wire.commit(p);
      pins.commit();
    },
    setHot(a = -1, b = -1, c = -1, d = -1) {
      hot.value.set(a, b, c, d);
    },
    setGlow(w, t, p = 2.2) {
      wire.intensity.value = w;
      trace.intensity.value = t;
      pins.intensity.value = p;
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const k of Object.keys(mats) as StyleName[]) mats[k].dispose();
      wire.dispose();
      pins.dispose();
      trace.dispose();
      solids.clear();
      overlay.clear();
    },
  };
  self.update(config.t0);
  return self;
}
