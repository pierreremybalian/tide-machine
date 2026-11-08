// Procedural brass parts (HANDOFF §8.3): indexed geometries with position, normal and a per-vertex part id
// (`aPart`, written to the outline G-buffer so neighbouring parts get a line between them). Profiles are revolved or
// extruded with flat normals across corners, so every turned shoulder and every tooth flank reads as a crease.
// Axes: parts are built around +z (shafts point at the viewer); callers rotate as needed.

import { BufferGeometry, Float32BufferAttribute, Matrix4, ShapeUtils, Vector2 } from 'three/webgpu';

export type V2 = readonly [number, number];

/** A geometry under construction: plain arrays, merged and uploaded once. */
export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, part: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.part.push(part);
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Append another builder's content transformed by m (normals by its rotation). */
  append(o: GeoBuilder, m?: Matrix4): this {
    const base = this.count;
    const e = m?.elements;
    for (let i = 0; i < o.count; i++) {
      const x = o.pos[i * 3]!;
      const y = o.pos[i * 3 + 1]!;
      const z = o.pos[i * 3 + 2]!;
      const nx = o.nrm[i * 3]!;
      const ny = o.nrm[i * 3 + 1]!;
      const nz = o.nrm[i * 3 + 2]!;
      if (e) {
        this.pos.push(e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!);
        const tx = e[0]! * nx + e[4]! * ny + e[8]! * nz;
        const ty = e[1]! * nx + e[5]! * ny + e[9]! * nz;
        const tz = e[2]! * nx + e[6]! * ny + e[10]! * nz;
        const l = Math.hypot(tx, ty, tz) || 1;
        this.nrm.push(tx / l, ty / l, tz / l);
      } else {
        this.pos.push(x, y, z);
        this.nrm.push(nx, ny, nz);
      }
      this.part.push(o.part[i]!);
    }
    for (const k of o.idx) this.idx.push(base + k);
    return this;
  }

  /** Set every vertex's part id. */
  tag(part: number): this {
    this.part.fill(part);
    return this;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPart', new Float32BufferAttribute(this.part, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Revolve a profile [radius, z] about the z axis. Each profile segment gets its own strip with its own normal, so
 * shoulders crease; around the axis the normals are smooth.
 */
export function revolve(profile: readonly V2[], segments: number, part = 0): GeoBuilder {
  const b = new GeoBuilder();
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i]!;
    const [r1, z1] = profile[i + 1]!;
    // Outward normal of the segment in the (r, z) plane, oriented so that a profile walked front-to-back (z down)
    // at constant radius faces outward.
    let nr = z0 - z1;
    let nz = r1 - r0;
    const l = Math.hypot(nr, nz) || 1;
    nr /= l;
    nz /= l;
    const base = b.count;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      b.vertex(r0 * c, r0 * sn, z0, nr * c, nr * sn, nz, part);
      b.vertex(r1 * c, r1 * sn, z1, nr * c, nr * sn, nz, part);
    }
    for (let s = 0; s < segments; s++) {
      const k = base + s * 2;
      b.tri(k, k + 1, k + 2);
      b.tri(k + 1, k + 3, k + 2);
    }
  }
  return b;
}

/** A solid cylinder along z from z0 to z1 (front z1), with flat caps. */
export function cylinder(radius: number, z0: number, z1: number, segments = 24, part = 0): GeoBuilder {
  return revolve(
    [
      [0, z1],
      [radius, z1],
      [radius, z0],
      [0, z0],
    ],
    segments,
    part,
  );
}

/** A box centred at (cx, cy, cz) with half sizes hx, hy, hz. */
export function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, part = 0): GeoBuilder {
  const b = new GeoBuilder();
  const faces: [number, number, number, number, number, number, number, number, number][] = [
    // normal, u axis, v axis
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 0, 0, 1, 1, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, 0, 1, 0, 1, 0, 0],
  ];
  const h = [hx, hy, hz];
  for (const [nx, ny, nz, ux, uy, uz, vx, vy, vz] of faces) {
    const base = b.count;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const x = cx + (nx + ux * su + vx * sv) * h[0]!;
      const y = cy + (ny + uy * su + vy * sv) * h[1]!;
      const z = cz + (nz + uz * su + vz * sv) * h[2]!;
      b.vertex(x, y, z, nx, ny, nz, part);
    }
    b.tri(base, base + 1, base + 2);
    b.tri(base, base + 2, base + 3);
  }
  return b;
}

/** A cylinder between two points (any direction). */
export function rod(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, segments = 12, part = 0): GeoBuilder {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const c = cylinder(radius, 0, len, segments, part);
  const m = new Matrix4();
  const dir = [(bx - ax) / len, (by - ay) / len, (bz - az) / len] as const;
  // Rotate +z onto dir.
  const z = dir;
  const up = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let x = [up[1]! * z[2] - up[2]! * z[1], up[2]! * z[0] - up[0]! * z[2], up[0]! * z[1] - up[1]! * z[0]];
  const xl = Math.hypot(x[0]!, x[1]!, x[2]!);
  x = x.map((v) => v / xl);
  const y = [z[1] * x[2]! - z[2] * x[1]!, z[2] * x[0]! - z[0] * x[2]!, z[0] * x[1]! - z[1] * x[0]!];
  m.set(x[0]!, y[0]!, z[0], ax, x[1]!, y[1]!, z[1], ay, x[2]!, y[2]!, z[2], az, 0, 0, 0, 1);
  return new GeoBuilder().append(c, m);
}

/**
 * Extrude a polygon (with holes) along z from z0 to z1: flat caps, side walls with shared vertices per loop (smooth
 * around gentle curves; the outline pass still sees the cap edge as a crease).
 */
export function extrude(outer: readonly V2[], holes: readonly (readonly V2[])[], z0: number, z1: number, part = 0): GeoBuilder {
  const b = new GeoBuilder();
  const contour = outer.map(([x, y]) => new Vector2(x, y));
  const hs = holes.map((h) => h.map(([x, y]) => new Vector2(x, y)));
  const faces = ShapeUtils.triangulateShape(contour, hs);
  const all = [...outer, ...holes.flat()];
  for (const [z, nz] of [
    [z1, 1],
    [z0, -1],
  ] as const) {
    const base = b.count;
    for (const [x, y] of all) b.vertex(x, y, z, 0, 0, nz, part);
    for (const [i, j, k] of faces) {
      const p = all[i!]!;
      const q = all[j!]!;
      const r = all[k!]!;
      const ccw = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0;
      if (ccw === nz > 0) b.tri(base + i!, base + j!, base + k!);
      else b.tri(base + i!, base + k!, base + j!);
    }
  }
  const wall = (loop: readonly V2[], isHole: boolean) => {
    const n = loop.length;
    const cw = ShapeUtils.isClockWise(loop.map(([x, y]) => new Vector2(x, y)));
    const outward = (cw ? -1 : 1) * (isHole ? -1 : 1);
    const base = b.count;
    for (let i = 0; i < n; i++) {
      const p = loop[(i - 1 + n) % n]!;
      const q = loop[(i + 1) % n]!;
      // Edge-averaged outward normal.
      let nx = (q[1] - p[1]) * outward;
      let ny = -(q[0] - p[0]) * outward;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const [x, y] = loop[i]!;
      b.vertex(x, y, z1, nx, ny, 0, part);
      b.vertex(x, y, z0, nx, ny, 0, part);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      const c = base + ((i + 1) % n) * 2;
      if (outward > 0) {
        b.tri(a, a + 1, c);
        b.tri(a + 1, c + 1, c);
      } else {
        b.tri(a, c, a + 1);
        b.tri(a + 1, c, c + 1);
      }
    }
  };
  wall(outer, false);
  for (const h of holes) wall(h, true);
  return b;
}

/** Points of a circle (counter-clockwise). */
export function circle(r: number, n: number, cx = 0, cy = 0, start = 0): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** A rounded rectangle (counter-clockwise), centred at (cx, cy). */
export function roundRect(cx: number, cy: number, hw: number, hh: number, r: number, n = 4): V2[] {
  const out: V2[] = [];
  const corners: [number, number, number][] = [
    [cx + hw - r, cy - hh + r, -Math.PI / 2],
    [cx + hw - r, cy + hh - r, 0],
    [cx - hw + r, cy + hh - r, Math.PI / 2],
    [cx - hw + r, cy - hh + r, Math.PI],
  ];
  for (const [x, y, a0] of corners) for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * (Math.PI / 2);
    out.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return out;
}

// ── Involute spur gears ────────────────────────────────────────────────────────────────────────────────────────────

const inv = (a: number) => Math.tan(a) - a;

export interface GearSpec {
  teeth: number;
  /** Module: pitch diameter / teeth (machine units). */
  module: number;
  /** Face width (z extent), centred on z = 0. */
  width: number;
  /** Pressure angle, radians (default 20°). */
  pressure?: number;
  /** Hub radius (a boss on both faces); 0 for none. */
  hub?: number;
  part?: number;
  /** Points per flank multiplier (quality tier detail: 0.5 low, 1 medium, 1.5 high). */
  detail?: number;
}

/** Pitch radius of a gear. */
export const pitchRadius = (teeth: number, module: number) => (teeth * module) / 2;

/**
 * The tooth outline of an involute spur gear, counter-clockwise, tooth 0 centred on +x. Addendum 1 m, dedendum
 * 1.25 m. Points per flank fall with tooth count so a 200-tooth wheel stays light.
 */
export function gearProfile(teeth: number, module: number, pressure = (20 * Math.PI) / 180, detail = 1): V2[] {
  const rp = pitchRadius(teeth, module);
  const rb = rp * Math.cos(pressure);
  const ra = rp + module;
  const rf = Math.max(rp - 1.25 * module, module * 0.5);
  const flank = Math.max(1, Math.round((teeth > 90 ? 2 : teeth > 40 ? 3 : 5) * detail));
  // Half-angle of the tooth at radius r.
  const half = (r: number) => Math.PI / (2 * teeth) + inv(pressure) - (r > rb ? inv(Math.acos(rb / r)) : 0);
  const r0 = Math.max(rf, rb);
  const radii: number[] = [];
  for (let i = 0; i <= flank; i++) radii.push(r0 + ((ra - r0) * i) / flank);
  const out: V2[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let t = 0; t < teeth; t++) {
    const c = t * step;
    // Root land up to this tooth's leading flank, then the flank to the tip, the tip land, the trailing flank.
    const hRoot = half(r0);
    out.push([rf * Math.cos(c - hRoot), rf * Math.sin(c - hRoot)]);
    for (const r of radii) {
      const a = c - Math.max(half(r), 0.002);
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    for (let i = radii.length - 1; i >= 0; i--) {
      const r = radii[i]!;
      const a = c + Math.max(half(r), 0.002);
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    out.push([rf * Math.cos(c + hRoot), rf * Math.sin(c + hRoot)]);
  }
  return out;
}

/** An involute spur gear about z, centred on z = 0; large wheels get spoked windows and every wheel a hub. */
export function gear(s: GearSpec): GeoBuilder {
  const part = s.part ?? 0;
  const prof = gearProfile(s.teeth, s.module, s.pressure, s.detail);
  const rp = pitchRadius(s.teeth, s.module);
  const rim = rp - 1.25 * s.module - Math.max(s.module * 2.5, rp * 0.12);
  const hub = s.hub ?? Math.max(rp * 0.22, s.module * 3);
  const holes: V2[][] = [];
  const spokes = rp > 0.16 ? (rp > 0.3 ? 6 : 5) : 0;
  if (spokes && rim > hub * 1.6) {
    // Windows between spokes: annular sectors from hub to rim.
    const sw = Math.max(hub * 0.45, rp * 0.07); // spoke half-width at the rim (approximately)
    const r0 = hub * 1.35;
    const r1 = rim;
    for (let k = 0; k < spokes; k++) {
      const a0 = (k / spokes) * Math.PI * 2 + sw / r0;
      const a1 = ((k + 1) / spokes) * Math.PI * 2 - sw / r0;
      const b0 = (k / spokes) * Math.PI * 2 + sw / r1;
      const b1 = ((k + 1) / spokes) * Math.PI * 2 - sw / r1;
      const win: V2[] = [];
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const a = b0 + ((b1 - b0) * i) / n;
        win.push([r1 * Math.cos(a), r1 * Math.sin(a)]);
      }
      for (let i = n; i >= 0; i--) {
        const a = a0 + ((a1 - a0) * i) / n;
        win.push([r0 * Math.cos(a), r0 * Math.sin(a)]);
      }
      holes.push(win.reverse());
    }
  }
  const half = s.width / 2;
  const g = extrude(prof, holes, -half, half, part);
  if (hub > 0) g.append(cylinder(hub, -half * 1.8, half * 1.8, 20, part));
  return g;
}
