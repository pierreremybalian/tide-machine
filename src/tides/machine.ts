// The tide-predicting machine as a mechanism (HANDOFF §4, stages 8–11). Pure.
//
// One crank per constituent, turned by its own gear train from a common driving shaft:
//   crank throw  ∝ amplitude   throw = scale · f · H          (f: node factor, set at the start of a run)
//   crank angle  = phase       θ₀ = V₀ + u − κ                 (equilibrium argument at the start, minus the port's lag)
//   gear ratio   = speed       ω = ω_ref · Π(driver/driven)    (documented tooth counts, else the best within limits)
// Each crank drives a Scotch yoke (Old Brass Brains' "cross-slot frame"): its pulley moves vertically by throw·cos θ,
// a pure sine wave. One wire, fixed at one end, runs alternately under and over the pulleys (two rows, neighbouring
// pulleys one diameter apart, so every free run of wire is vertical) and hangs from the last one carrying the pen.
// A pulley that rises by δ lengthens the two vertical runs beside it by δ each, so the pen rises by 2δ: the pen
// moves 2 Σ throw·cos θ. That factor of two is the machine's; the reading divides it out:
//   tide = z₀ + pen displacement / (2 · scale).
// The wire length is computed from the actual tangent geometry (straight runs between tangent points plus the arcs
// wrapped on each pulley), not from the identity, so the tests check the mechanism rather than restate the sum. The
// same geometry quantifies Kelvin's first machine, which carried each pulley on the crank itself (linkage 'crank'):
// the pulley then also swings sideways, the runs tilt, and the sum picks up a small error Thomson accepted.
//
// Sources: DECISIONS.md, "Machine" (Thomson 1881; Thomson & Tait 1879; US C&GS Special Publication No. 32, 1915).

import { astro, D2R, mod360, type Astro } from './astro.ts';
import { BY_NAME, speed, V, type Constituent } from './constituents.ts';
import type { StationConstants } from './predict.ts';

// ── The two machines ───────────────────────────────────────────────────────────────────────────────────────────────

export type MachineId = 'kelvin' | 'obb';
export type Linkage = 'yoke' | 'crank';
export type Pairs = readonly (readonly [number, number])[];

export interface MachineSpec {
  id: MachineId;
  title: string;
  year: number;
  /** Constituents in wire order, from the wire's fixed end to the pen. */
  constituents: readonly string[];
  /** Speed of the driving shaft the trains start from, degrees per hour. */
  refSpeed: number;
  /** Documented tooth counts by constituent ([driver, driven] per stage; a driver of 1 is a single-start worm). */
  documented?: Readonly<Record<string, Pairs>>;
  note: string;
}

/**
 * Kelvin's first tide predicter (British Association; designed 1872, exhibited 1873, built by A. Légé & Co.;
 * Science Museum, London, 1876-1129). Ten components; Thomson (ICE Minutes vol. 65, 1881, p. 18) lists them from the
 * pen end: M2, S2, N2, K1, O1, K2, L2, P1, M4, MS4. Wire order here runs from the fixed end, so it is reversed.
 */
export const KELVIN_1872: readonly string[] = ['MS4', 'M4', 'P1', 'L2', 'K2', 'O1', 'K1', 'N2', 'S2', 'M2'];

/**
 * US Coast and Geodetic Survey Tide Predicting Machine No. 2, "Old Brass Brains" (R. A. Harris and E. G. Fischer;
 * predictions 1912–1965). SP-32 (1915) gives the components of each range of the rear frame, front to rear, and the
 * chain runs alternately under (lower range) and over (upper range) from its fixed end at the rear to the front
 * frame. The front frame held M2, S2 and K1 on two shafts each at half amplitude (40 height pulleys in all); we give
 * every component one pulley, keeping the order.
 */
export const OBB_37: readonly string[] = [
  // Rear frame, rear to front, lower/upper alternating from the fixed end.
  'SA', 'SSA', 'MSF', 'MM', 'MF', 'J1', 'RHO', 'M1', 'Q1', 'S1', 'T2', 'LAM2', 'R2', 'OO1', '2Q1', '2N2',
  'P1', 'MU2', '2SM2', 'S6', 'M3', 'NU2', 'L2', 'MN4', '2MK3', 'S4', 'K2', 'MK3', 'M8', 'M6', 'MS4',
  // Front frame.
  'M4', 'O1', 'K1', 'N2', 'S2', 'M2',
]; // prettier-ignore

/**
 * SP-32 Table C: tooth counts I/II × III/IV from the vertical driving shafts (30° per dial hour). A "1" is a
 * single-start worm. M1 is omitted: the machine's M1 (14.4920521°/h) is Schureman's, not NOAA's present M1
 * (14.4966939°/h, equivalent to N2 − O1) that the station constants use, so that crank gets the best approximation.
 */
export const OBB_TRAINS: Readonly<Record<string, Pairs>> = {
  J1: [[107, 90], [52, 119]],
  K1: [[61, 73], [51, 85]],
  K2: [[122, 80], [96, 146]],
  L2: [[104, 61], [56, 97]],
  LAM2: [[131, 65], [57, 117]],
  M2: [[103, 74], [59, 85]],
  M3: [[86, 62], [70, 67]],
  M4: [[118, 74], [103, 85]],
  M6: [[140, 62], [86, 67]],
  M8: [[118, 37], [103, 85]],
  MF: [[84, 45], [1, 51]],
  MK3: [[120, 81], [105, 106]],
  '2MK3': [[81, 52], [79, 86]],
  MM: [[93, 41], [1, 125]],
  MN4: [[135, 42], [53, 89]],
  MS4: [[118, 61], [62, 61]],
  MSF: [[149, 80], [1, 55]],
  MU2: [[125, 82], [74, 121]],
  N2: [[65, 46], [53, 79]],
  '2N2': [[68, 58], [46, 58]],
  NU2: [[89, 69], [70, 95]],
  O1: [[92, 89], [58, 129]],
  OO1: [[134, 131], [71, 135]],
  P1: [[91, 73], [50, 125]],
  Q1: [[84, 88], [51, 109]],
  '2Q1': [[127, 114], [50, 130]],
  R2: [[85, 50], [43, 73]],
  RHO: [[69, 70], [41, 90]],
  S1: [[63, 75], [50, 84]],
  S2: [[70, 70], [70, 70]],
  S4: [[75, 45], [60, 50]],
  S6: [[90, 48], [80, 50]],
  SA: [[51, 149], [1, 125], [60, 120]],
  '2SM2': [[69, 47], [50, 71]],
  SSA: [[51, 149], [1, 125]],
  T2: [[81, 50], [45, 73]],
}; // prettier-ignore

/** Mean speed of a driving shaft that turns once per mean solar day (S1, S2, S4, S6 come out exact). */
export const DAY_SHAFT_SPEED = 15;
/** Old Brass Brains' vertical driving shafts: 30° per dial hour (SP-32, Table C). */
export const OBB_SHAFT_SPEED = 30;

export const MACHINES: Readonly<Record<MachineId, MachineSpec>> = {
  kelvin: {
    id: 'kelvin',
    title: 'Kelvin’s tide predicter',
    year: 1872,
    constituents: KELVIN_1872,
    refSpeed: DAY_SHAFT_SPEED,
    note: 'Ten pulleys: the British Association machine, built by Légé. No tooth counts survive; ours are the best two-stage approximations.',
  },
  obb: {
    id: 'obb',
    title: 'Old Brass Brains',
    year: 1912,
    constituents: OBB_37,
    refSpeed: OBB_SHAFT_SPEED,
    documented: OBB_TRAINS,
    note: 'US Coast and Geodetic Survey Tide Predicting Machine No. 2 (Harris and Fischer): 37 components, tooth counts from SP-32.',
  },
};

// ── Gear trains ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Julian year in hours (drift is reported per year). */
export const HOURS_PER_YEAR = 365.25 * 24;

export interface TeethLimits {
  min: number;
  max: number;
  /** Gear pairs in series (1 or 2). */
  stages: 1 | 2;
}

export const DEFAULT_TEETH: TeethLimits = { min: 10, max: 200, stages: 2 };

export interface GearTrain {
  /** [driver, driven] tooth counts per stage, from the driving shaft to the crank (driver 1 = worm). */
  pairs: Pairs;
  /** Realised ratio Π driver/driven. */
  ratio: number;
  /** Exact ratio wanted (true speed / shaft speed). */
  target: number;
  /** Realised crank speed, degrees per hour. */
  speed: number;
  /** True constituent speed, degrees per hour. */
  trueSpeed: number;
  /** Realised − true, degrees per hour. */
  error: number;
  /** Phase the crank gains (+) or loses (−) per Julian year, degrees. */
  driftPerYear: number;
  source: 'documented' | 'approximation' | 'exact';
}

const factorCache = new Map<string, Int32Array>();

/** For every n ≤ max², the smallest factor a with a and n/a both in [min, max] (0 if none). Cached per limits. */
function twoFactorTable(min: number, max: number): Int32Array {
  const key = `${min}:${max}`;
  const hit = factorCache.get(key);
  if (hit) return hit;
  const t = new Int32Array(max * max + 1);
  for (let a = max; a >= min; a--) for (let c = a; c <= max; c++) t[a * c] = a;
  factorCache.set(key, t);
  return t;
}

/**
 * Best rational approximation p/q to `target` with p and q realisable as gear trains within the limits: one stage
 * (p, q themselves tooth counts) or two (p = a·c, q = b·d, every factor a tooth count). Exhaustive over q, so the
 * result is the closest realisable ratio; ties (exact ratios such as 2:1) go to fewer stages, then to gears of
 * moderate size (about 40 teeth on average).
 */
export function bestTrain(target: number, limits: TeethLimits = DEFAULT_TEETH): { pairs: [number, number][]; ratio: number } {
  const { min, max, stages } = limits;
  const acc: { best: { pairs: [number, number][]; ratio: number; err: number; teeth: number } | null } = { best: null };
  const consider = (pairs: [number, number][]) => {
    const ratio = pairs.reduce((r, [a, b]) => (r * a) / b, 1);
    const err = Math.abs(ratio - target);
    const teeth = Math.abs(pairs.reduce((s, [a, b]) => s + a + b, 0) - 80 * pairs.length);
    const tol = 1e-15 * Math.max(1, target);
    const b = acc.best;
    if (
      !b ||
      err < b.err - tol ||
      (Math.abs(err - b.err) <= tol && (pairs.length < b.pairs.length || (pairs.length === b.pairs.length && teeth < b.teeth)))
    )
      acc.best = { pairs, ratio, err, teeth };
  };
  for (let q = min; q <= max; q++) {
    for (const p of [Math.floor(target * q), Math.ceil(target * q)]) if (p >= min && p <= max) consider([[p, q]]);
  }
  if (stages === 2) {
    const t = twoFactorTable(min, max);
    const top = max * max;
    for (let q = min * min; q <= top; q++) {
      const b = t[q]!;
      if (!b) continue;
      for (const p of [Math.floor(target * q), Math.ceil(target * q)]) {
        if (p < min * min || p > top) continue;
        const a = t[p]!;
        if (!a) continue;
        consider([
          [p / a, q / b],
          [a, b],
        ]);
      }
    }
  }
  if (acc.best) return { pairs: acc.best.pairs, ratio: acc.best.ratio };
  // Too slow for spur gears alone (long-period terms off a fast shaft): a single-start worm first, as on Old Brass
  // Brains, then the best spur train for what remains.
  for (let w = min; w <= max; w++) {
    if (target * w < (min / max) ** stages) continue;
    const rest = bestTrain(target * w, limits);
    return { pairs: [[1, w], ...rest.pairs], ratio: rest.ratio / w };
  }
  throw new Error(`no gear train for ratio ${target}`);
}

/** The gear train for a constituent: documented tooth counts if given, else the best approximation. */
export function gearTrain(trueSpeed: number, refSpeed = DAY_SHAFT_SPEED, limits: TeethLimits = DEFAULT_TEETH, documented?: Pairs): GearTrain {
  const target = trueSpeed / refSpeed;
  const pairs: Pairs = documented ?? bestTrain(target, limits).pairs;
  const ratio = pairs.reduce((r, [a, b]) => (r * a) / b, 1);
  const realised = ratio * refSpeed;
  const error = realised - trueSpeed;
  return {
    pairs,
    ratio,
    target,
    speed: realised,
    trueSpeed,
    error,
    driftPerYear: error * HOURS_PER_YEAR,
    source: documented ? 'documented' : Math.abs(ratio - target) < 1e-12 * Math.max(1, target) ? 'exact' : 'approximation',
  };
}

// ── The machine ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Crank {
  index: number;
  name: string;
  c: Constituent;
  /** Station amplitude H (m) and Greenwich phase κ (degrees); 0 and 0 when the port does not list it. */
  H: number;
  kappa: number;
  /** True speed, degrees per hour. */
  trueSpeed: number;
  train: GearTrain;
  /** +1: the wire passes over this pulley (upper row); −1: under it (lower row). */
  row: 1 | -1;
  /** Shaft position: x along the wire, rest height of the pulley centre (machine units). */
  x: number;
  restY: number;
  radius: number;
  /** Settings made at the start of the run: node factor, u, crank angle θ₀ = V₀ + u − κ (degrees). */
  f0: number;
  u0: number;
  theta0: number;
  /** Crank throw at the start, machine units (scale · f₀ · H). */
  throw0: number;
}

/** A circle the wire wraps, in path order: the fixed end (a point), the pulleys, and any fixed guide. */
export interface WireNode {
  kind: 'anchor' | 'pulley' | 'guide';
  /** Crank index for pulleys, −1 otherwise. */
  crank: number;
  x: number;
  y: number;
  radius: number;
  /** +1: the wire passes over the top; −1: under. */
  row: 1 | -1;
}

export interface MachineModel {
  spec: MachineSpec;
  station: string;
  z0: number;
  /** Start of the run (ms, UTC): where the cranks are set. */
  t0: number;
  /** Machine units of throw per metre of tide. */
  scale: number;
  refSpeed: number;
  linkage: Linkage;
  cranks: Crank[];
  /** The wire's path: anchor, pulleys, optional guide. The pen hangs straight down from the last node. */
  path: WireNode[];
  /** Total wire length, chosen so the pen rests at penRestY. */
  wireLength: number;
  penRestY: number;
  /** Largest possible pen excursion from rest (2 Σ throw), machine units. */
  penRange: number;
}

export interface MachineOptions {
  /** Start of the run, ms UTC. */
  t0: number;
  /** Machine units of throw per metre of tide. Default 0.5. */
  scale?: number;
  /** Pulley radius, machine units. Default 0.2. */
  pulleyRadius?: number;
  teeth?: TeethLimits;
  /** Ignore documented trains and use the best approximations (for comparison). */
  approximate?: boolean;
  /** 'yoke' (true harmonic slide; default) or 'crank' (pulley on the crank pin, Kelvin's first machine). */
  linkage?: Linkage;
  /** Rest height of the pen, machine units. Default: below the lower row by its full range. */
  penRestY?: number;
  /** Clearance between the rows beyond what the throws need, machine units. Default 4 × radius. */
  clearance?: number;
}

/** Build a machine for one port: a pulley per constituent of the spec, set for a run starting at t0. */
export function createMachineModel(st: StationConstants, which: MachineId | MachineSpec, o: MachineOptions): MachineModel {
  const spec = typeof which === 'string' ? MACHINES[which] : which;
  const scale = o.scale ?? 0.5;
  const r = o.pulleyRadius ?? 0.2;
  const limits = o.teeth ?? DEFAULT_TEETH;
  const clearance = o.clearance ?? 4 * r;
  const byName = new Map(st.constituents.map((k) => [k.name, k]));
  const a0 = astro(o.t0);

  const cranks: Crank[] = spec.constituents.map((name, i) => {
    const c = BY_NAME.get(name);
    if (!c) throw new Error(`unknown constituent ${name}`);
    const k = byName.get(name);
    const H = k?.amplitude ?? 0;
    const kappa = k?.phase ?? 0;
    const trueSpeed = speed(c);
    const f0 = c.f(a0);
    const u0 = c.u(a0);
    const doc = o.approximate ? undefined : spec.documented?.[name];
    return {
      index: i,
      name,
      c,
      H,
      kappa,
      trueSpeed,
      train: gearTrain(trueSpeed, spec.refSpeed, limits, doc),
      // The wire leaves its fixed end downward, so the first pulley is in the lower row.
      row: i % 2 === 0 ? -1 : 1,
      x: 2 * r * i,
      restY: 0,
      radius: r,
      f0,
      u0,
      theta0: mod360(V(c, a0) + u0 - kappa),
      throw0: scale * f0 * H,
    };
  });

  // Each pulley sits far enough from its neighbours in the other row that they never touch, whatever their phases.
  // Where the big components sit the rows spread apart (Kelvin's machine has this "<" shape).
  const n = cranks.length;
  for (let i = 0; i < n; i++) {
    const t = cranks[i]!.throw0;
    const left = i > 0 ? cranks[i - 1]!.throw0 : 0;
    const right = i < n - 1 ? cranks[i + 1]!.throw0 : 0;
    const half = (2 * r + clearance + t + Math.max(left, right)) / 2;
    cranks[i]!.restY = cranks[i]!.row * half;
  }

  const path: WireNode[] = [];
  const first = cranks[0]!;
  path.push({ kind: 'anchor', crank: -1, x: first.x - r, y: first.restY + first.throw0 + 3 * r + clearance, radius: 0, row: 1 });
  for (const ck of cranks) path.push({ kind: 'pulley', crank: ck.index, x: ck.x, y: ck.restY, radius: r, row: ck.row });
  const last = cranks[n - 1]!;
  if (last.row === -1) {
    // The wire leaves the last (lower) pulley upward: a fixed guide above turns it down to the pen.
    path.push({ kind: 'guide', crank: -1, x: last.x + 2 * r, y: last.restY + last.throw0 + 3 * r + clearance, radius: r, row: 1 });
  }

  let penRange = 0;
  let lowest = 0;
  for (const ck of cranks) {
    penRange += 2 * ck.throw0;
    lowest = Math.min(lowest, ck.restY - ck.throw0 - r);
  }
  const penRestY = o.penRestY ?? lowest - penRange - 2 * r;

  const model: MachineModel = {
    spec,
    station: st.id,
    z0: st.z0,
    t0: o.t0,
    scale,
    refSpeed: spec.refSpeed,
    linkage: o.linkage ?? 'yoke',
    cranks,
    path,
    wireLength: 0,
    penRestY,
    penRange,
  };
  // Wire length: what the path consumes with every pulley at rest, plus the hang down to the pen.
  const s = createMachineState(model);
  for (let i = 0; i < n; i++) {
    s.x[i] = cranks[i]!.x;
    s.y[i] = cranks[i]!.restY;
  }
  const consumed = solveWire(model, s);
  model.wireLength = consumed + (s.outY[path.length - 1]! - penRestY);
  return model;
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Drive = 'ideal' | 'geared';

export interface MachineState {
  ms: number;
  /** Driving-shaft angle, degrees (0 at t0). */
  shaft: number;
  /** Crank angle θ, degrees in [0, 360). */
  angle: Float64Array;
  /** Crank throw, machine units. */
  throw: Float64Array;
  /** Pulley centres, machine units. */
  x: Float64Array;
  y: Float64Array;
  /**
   * The wire, per path node k: where it arrives (inX/inY) and leaves (outX/outY), and the arc wrapped on the node:
   * start angle and signed sweep (radians; negative = clockwise). The anchor is a point (in = out).
   */
  inX: Float64Array;
  inY: Float64Array;
  outX: Float64Array;
  outY: Float64Array;
  arcStart: Float64Array;
  arcSweep: Float64Array;
  /** Wire consumed from the anchor to where it leaves the last node, machine units. */
  consumed: number;
  /** The pen (free end of the wire): x, y in machine units, and displacement from rest. */
  penX: number;
  penY: number;
  penDisplacement: number;
  /** The pen read as a tide height (m above the station datum): z₀ + displacement / (2 · scale). */
  height: number;
}

export function createMachineState(m: MachineModel): MachineState {
  const n = m.cranks.length;
  const nc = m.path.length;
  return {
    ms: m.t0,
    shaft: 0,
    angle: new Float64Array(n),
    throw: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    inX: new Float64Array(nc),
    inY: new Float64Array(nc),
    outX: new Float64Array(nc),
    outY: new Float64Array(nc),
    arcStart: new Float64Array(nc),
    arcSweep: new Float64Array(nc),
    consumed: 0,
    penX: 0,
    penY: 0,
    penDisplacement: 0,
    height: m.z0,
  };
}

const TAU = Math.PI * 2;
const scratchAstro = {} as Astro;

/**
 * Advance the machine to time ms (no allocation).
 * - 'geared': what the brass does. Cranks were set at t0 (θ₀, throw from f₀) and each turns at its gear train's
 *   realised speed; node factors stay as set.
 * - 'ideal': perfect gears and node factors reset continuously: θ = V(t) + u(t) − κ, throw = scale · f(t) · H. With
 *   the yoke linkage the pen then reproduces predict() exactly (the wire-sum identity).
 */
export function machineAt(m: MachineModel, ms: number, drive: Drive, out: MachineState): MachineState {
  const hours = (ms - m.t0) / 3.6e6;
  out.ms = ms;
  out.shaft = mod360(m.refSpeed * hours);
  const a = drive === 'ideal' ? astro(ms, scratchAstro) : null;
  const crank = m.linkage === 'crank';
  for (let i = 0; i < m.cranks.length; i++) {
    const ck = m.cranks[i]!;
    let theta: number;
    let thr: number;
    if (a) {
      theta = V(ck.c, a) + ck.c.u(a) - ck.kappa;
      thr = m.scale * ck.c.f(a) * ck.H;
    } else {
      theta = ck.theta0 + ck.train.speed * hours;
      thr = ck.throw0;
    }
    out.angle[i] = mod360(theta);
    out.throw[i] = thr;
    // Cranks are read from the vertical pointing at the wire's pull (up on the upper row, down on the lower), so
    // every pulley lengthens the path as its term grows. A yoke moves the pulley vertically only; a pulley carried on
    // the crank pin also swings sideways.
    const th = theta * D2R;
    out.y[i] = ck.restY + ck.row * thr * Math.cos(th);
    out.x[i] = crank ? ck.x - ck.row * thr * Math.sin(th) : ck.x;
  }
  const consumed = solveWire(m, out);
  const k = m.path.length - 1;
  out.penX = out.outX[k]!;
  out.penY = out.outY[k]! - (m.wireLength - consumed);
  out.penDisplacement = out.penY - m.penRestY;
  out.height = m.z0 + out.penDisplacement / (2 * m.scale);
  return out;
}

/** Pen heights (m) at n times from startMs, stepMinutes apart. */
export function penSeries(m: MachineModel, drive: Drive, startMs: number, stepMinutes: number, n: number, out = new Float64Array(n)): Float64Array {
  const st = createMachineState(m);
  for (let i = 0; i < n; i++) out[i] = machineAt(m, startMs + i * stepMinutes * 60000, drive, st).height;
  return out;
}

// ── Wire geometry ──────────────────────────────────────────────────────────────────────────────────────────────────

const circ = new Float64Array(4);

/** Path node k as [x, y, radius, row] with the pulleys at their current positions. */
function node(m: MachineModel, st: MachineState, k: number): Float64Array {
  const p = m.path[k]!;
  circ[0] = p.crank >= 0 ? st.x[p.crank]! : p.x;
  circ[1] = p.crank >= 0 ? st.y[p.crank]! : p.y;
  circ[2] = p.radius;
  circ[3] = p.row;
  return circ;
}

/**
 * Lay the wire through the path and return its length from the anchor to where it leaves the last node heading
 * straight down to the pen. Each straight run is the common tangent of two circles on their wire sides; each circle
 * adds radius × wrapped angle. The wire travels +x, so "over" wraps clockwise and "under" anticlockwise.
 */
function solveWire(m: MachineModel, st: MachineState): number {
  const nc = m.path.length;
  let total = 0;
  let prevPhi = 0;
  const a0 = node(m, st, 0);
  st.inX[0] = st.outX[0] = a0[0]!;
  st.inY[0] = st.outY[0] = a0[1]!;
  st.arcStart[0] = 0;
  st.arcSweep[0] = 0;
  for (let k = 1; k < nc; k++) {
    const a = node(m, st, k - 1);
    const ax = a[0]!;
    const ay = a[1]!;
    const ar = a[2]!;
    const as = a[3]!;
    const b = node(m, st, k);
    const bx = b[0]!;
    const by = b[1]!;
    const br = b[2]!;
    const bs = b[3]!;
    // With φ the run's direction and n its left normal, the wire touches a circle at centre + row·r·n (over the top
    // the centre lies to the right of travel). Tangency: (b − a)·n = −ρ with ρ = rowb·rb − rowa·ra, so
    // φ = ψ + asin(ρ / L) and the run is √(L² − ρ²) long.
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const rho = bs * br - as * ar;
    const phi = Math.atan2(dy, dx) + Math.asin(rho / Math.sqrt(L2));
    const nx = -Math.sin(phi);
    const ny = Math.cos(phi);
    st.outX[k - 1] = ax + as * ar * nx;
    st.outY[k - 1] = ay + as * ar * ny;
    st.inX[k] = bx + bs * br * nx;
    st.inY[k] = by + bs * br * ny;
    total += Math.sqrt(Math.max(0, L2 - rho * rho));
    if (k > 1) total += wrap(st, k - 1, ar, as, prevPhi, phi, ax, ay);
    prevPhi = phi;
  }
  // The last node: wrap from the arriving run to straight down.
  const kl = nc - 1;
  const g = node(m, st, kl);
  const down = -Math.PI / 2;
  st.outX[kl] = g[0]! + g[3]! * g[2]! * -Math.sin(down);
  st.outY[kl] = g[1]! + g[3]! * g[2]! * Math.cos(down);
  total += wrap(st, kl, g[2]!, g[3]!, prevPhi, down, g[0]!, g[1]!);
  st.consumed = total;
  return total;
}

/** Arc length wrapped on node k between the arriving direction phiIn and the leaving direction phiOut. */
function wrap(st: MachineState, k: number, r: number, row: number, phiIn: number, phiOut: number, cx: number, cy: number): number {
  let turn = row > 0 ? phiIn - phiOut : phiOut - phiIn;
  turn = ((turn % TAU) + TAU) % TAU;
  st.arcStart[k] = Math.atan2(st.inY[k]! - cy, st.inX[k]! - cx);
  st.arcSweep[k] = row > 0 ? -turn : turn;
  return r * turn;
}
