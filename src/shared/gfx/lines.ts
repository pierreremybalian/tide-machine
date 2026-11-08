// Luminous polylines drawn with a constant on-screen width, for the line-drawn instruments of the tide stages
// (dials, curves, spectra, arrows). Each line keeps its points in its own data space (hours × metres, a unit
// circle, a unit arrow …) and is placed every frame by a per-line transform held in uniforms:
//   world = (x, y, z) + R(rot) · (sx·px, sy·py, pz)       (then the mesh's own matrix)
// so curves computed once on the CPU (from src/tides/predict.ts) can be zoomed, panned, revealed and highlighted
// without re-uploading anything, and no allocation happens in the frame loop.
//
// Identical copies live in src/scenes/{moon,sun,rhythms,apart}/lines.ts (scenes share only src/shared/; a test keeps
// the copies in sync). Proposed home: src/shared/gfx/lines.ts.

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  Vector4,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  exp,
  float,
  fract,
  max,
  modelWorldMatrix,
  sin,
  smoothstep,
  step,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Vec2Uniform } from '../../render/globals.ts';

export type RGB = readonly [number, number, number];

export interface LineSpec {
  /** Flat point list in the line's data space: x, y (dims 2) or x, y, z (dims 3). */
  points: ArrayLike<number>;
  dims?: 2 | 3;
  colour: RGB;
  /** Core width in reference pixels (one reference pixel ≈ 1 px on a 1000 px screen; geometric mean of w × h). */
  width?: number;
  /** Base intensity (HDR; bloom picks up above ~0.85). */
  intensity?: number;
  /** Dash period in world units (0 = solid). Assumes the line is scaled about evenly. */
  dash?: number;
  /** Join the last point back to the first. */
  closed?: boolean;
}

export interface LineState {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  rot: number;
  /** Visible window along the line, 0–1 by point index. */
  from: number;
  to: number;
  /** Multiplies the spec's intensity (0 hides the line). */
  intensity: number;
  /** 0–1: brighter and wider. */
  highlight: number;
  /** Multiplies the spec's width. */
  width: number;
  /** 0–1: a hot writing head at `to`. */
  head: number;
}

const _f = () => uniform(0);
type FloatU = ReturnType<typeof _f>;

export interface Lines {
  mesh: Mesh;
  state: LineState[];
  /** Global multiplier. */
  opacity: FloatU;
  /** Write the CPU state into the uniforms (call once per frame after changing state). */
  commit(): void;
  dispose(): void;
}

export interface LinesOptions {
  /** Render-target size in pixels (ctx.globals.uResolution). */
  resolution: Vec2Uniform;
  depthTest?: boolean;
  /** Lines (world space) behind this sphere, as seen from the camera, are dimmed to `dim`. */
  occluder?: { centre: readonly [number, number, number]; radius: number; dim: number };
}

/** Quad half-width in core half-widths: room for the halo. */
const EXTENT = 4;

export function defaultState(): LineState {
  return {
    x: 0,
    y: 0,
    z: 0,
    sx: 1,
    sy: 1,
    rot: 0,
    from: 0,
    to: 1,
    intensity: 1,
    highlight: 0,
    width: 1,
    head: 0,
  };
}

export function createLines(specs: readonly LineSpec[], opts: LinesOptions): Lines {
  const pos: number[] = [];
  const prev: number[] = [];
  const next: number[] = [];
  const meta: number[] = [];
  const style: number[] = [];
  const index: number[] = [];
  let base = 0;
  specs.forEach((sp, li) => {
    const d = sp.dims ?? 2;
    const raw = sp.points;
    const n0 = Math.floor(raw.length / d);
    if (n0 < 2) return;
    const n = sp.closed ? n0 + 1 : n0;
    const P = (i: number, k: number) => {
      const j = sp.closed ? i % n0 : i;
      return k < d ? raw[j * d + k]! : 0;
    };
    // Path length split into |dx| and |dy| sums: exact for axis-aligned lines under any scale, close for curves.
    let lx = 0;
    let ly = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        lx += Math.abs(P(i, 0) - P(i - 1, 0));
        ly += Math.abs(P(i, 1) - P(i - 1, 1));
      }
      const ip = i > 0 ? i - 1 : sp.closed ? n0 - 1 : 0;
      const inx = i < n - 1 ? i + 1 : sp.closed ? 1 : n - 1;
      for (const side of [-1, 1]) {
        pos.push(P(i, 0), P(i, 1), P(i, 2));
        prev.push(P(ip, 0), P(ip, 1), P(ip, 2), lx);
        next.push(P(inx, 0), P(inx, 1), P(inx, 2), sp.dash ?? 0);
        meta.push(side, i / (n - 1), li, ly);
        style.push(sp.colour[0], sp.colour[1], sp.colour[2], sp.width ?? 2);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const k = base + i * 2;
      index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    base += n * 2;
  });

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPrev', new Float32BufferAttribute(prev, 4));
  geo.setAttribute('aNext', new Float32BufferAttribute(next, 4));
  geo.setAttribute('aMeta', new Float32BufferAttribute(meta, 4));
  geo.setAttribute('aStyle', new Float32BufferAttribute(style, 4));
  geo.setIndex(index);

  const state = specs.map(defaultState);
  const T = specs.map(() => new Vector4(0, 0, 1, 1)); // x, y, sx, sy
  const U = specs.map(() => new Vector4(0, 0, 0, 1)); // rot, z, from, to
  const V = specs.map((sp) => new Vector4(sp.intensity ?? 1, 0, 1, 0)); // intensity, highlight, width, head
  const base0 = specs.map((sp) => sp.intensity ?? 1);
  const uT = uniformArray(T, 'vec4');
  const uU = uniformArray(U, 'vec4');
  const uV = uniformArray(V, 'vec4');
  const opacity = uniform(1);

  const aPos = attribute<'vec3'>('position', 'vec3');
  const aPrev4 = attribute<'vec4'>('aPrev', 'vec4');
  const aNext4 = attribute<'vec4'>('aNext', 'vec4');
  const aMeta = attribute<'vec4'>('aMeta', 'vec4');
  const aStyle = attribute<'vec4'>('aStyle', 'vec4');
  const lid = aMeta.z.toInt();
  const t = uT.element(lid) as unknown as Node<'vec4'>;
  const u = uU.element(lid) as unknown as Node<'vec4'>;
  const v = uV.element(lid) as unknown as Node<'vec4'>;
  const cr = cos(u.x);
  const sr = sin(u.x);
  const xf = (p: Node<'vec3'>) => {
    const qx = p.x.mul(t.z);
    const qy = p.y.mul(t.w);
    return modelWorldMatrix.mul(
      vec4(t.x.add(cr.mul(qx)).sub(sr.mul(qy)), t.y.add(sr.mul(qx)).add(cr.mul(qy)), u.y.add(p.z), 1),
    );
  };
  const wC = xf(aPos);
  const wP = xf(aPrev4.xyz);
  const wN = xf(aNext4.xyz);
  const vp = cameraProjectionMatrix.mul(cameraViewMatrix);
  const cC = vp.mul(wC);
  const cP = vp.mul(wP);
  const cN = vp.mul(wN);
  const res = opts.resolution;
  const aspect = res.x.div(res.y);
  const ndcDir = cN.xy.div(cN.w).sub(cP.xy.div(cP.w)).mul(vec2(aspect, 1));
  const dir = ndcDir.div(max(ndcDir.length(), 1e-6));
  const normal = vec2(dir.y.negate(), dir.x.div(aspect)).negate();
  // Reference pixel: geometric mean of the target's sides / 1000, in NDC (y) units.
  const refPx = res.x.mul(res.y).sqrt().div(1000).mul(2).div(res.y);
  const widthMul = v.z.mul(float(1).add(v.y.mul(0.6)));
  const half = aStyle.w.mul(0.5).mul(widthMul).mul(refPx).mul(EXTENT);
  const side = aMeta.x;
  const clip = vec4(cC.xy.add(normal.mul(side).mul(half).mul(cC.w)), cC.z, cC.w);

  // Varyings for the fragment.
  const vSide = varying(side, 'vSide');
  const vAlong = varying(aMeta.y, 'vAlong');
  const vLen = varying(vec2(aPrev4.w.mul(t.z), aMeta.w.mul(t.w)).length(), 'vLen');
  const vState = varying(vec4(u.z, u.w, v.x, v.y), 'vState');
  const vHead = varying(v.w, 'vHead');
  const vWorld = varying(wC.xyz, 'vWorld');

  const d = vSide.abs().mul(EXTENT);
  const core = float(1).sub(smoothstep(0.55, 1.25, d));
  const halo = exp(d.mul(d).mul(-0.3)).mul(0.32);
  const along = vAlong;
  const inside = step(vState.x.sub(1e-5), along).mul(step(along, vState.y.add(1e-5)));
  const headGlow = exp(along.sub(vState.y).div(0.006).abs().pow(2).negate())
    .mul(vHead)
    .mul(step(vState.y, 0.9995));
  const dash = aNext4.w;
  const dashMask = float(1).sub(step(1e-6, dash).mul(step(0.55, fract(vLen.div(max(dash, 1e-6))))));
  const lum = core.mul(float(1).add(vState.w.mul(0.8))).add(halo.mul(float(1).add(vState.w)));
  let occl: Node<'float'> = float(1);
  if (opts.occluder) {
    const c = vec3(...opts.occluder.centre);
    const r = opts.occluder.radius;
    // Does the segment camera → point pass through the sphere before reaching the point?
    const ro = cameraPosition;
    const rd = vWorld.sub(ro);
    const L = rd.length();
    const dn = rd.div(L);
    const oc = ro.sub(c);
    const b = oc.dot(dn);
    const cc = oc.dot(oc).sub(r * r);
    const disc = b.mul(b).sub(cc);
    const tHit = b.negate().sub(max(disc, 0).sqrt());
    const hidden = step(0, disc)
      .mul(step(tHit, L.sub(1e-3)))
      .mul(step(0, tHit));
    occl = float(1).sub(hidden.mul(1 - opts.occluder.dim));
  }
  const colour = aStyle.xyz
    .mul(vState.z)
    .mul(lum.add(headGlow.mul(core).mul(5)))
    .mul(inside)
    .mul(dashMask)
    .mul(occl)
    .mul(opacity);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest ?? false,
    blending: AdditiveBlending,
  });
  mat.vertexNode = clip;
  mat.colorNode = vec4(colour, 1);
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;

  return {
    mesh,
    state,
    opacity,
    commit() {
      for (let i = 0; i < state.length; i++) {
        const s = state[i]!;
        T[i]!.set(s.x, s.y, s.sx, s.sy);
        U[i]!.set(s.rot, s.z, s.from, s.to);
        V[i]!.set(base0[i]! * s.intensity, s.highlight, s.width, s.head);
      }
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/** Points of a unit circle (flat x, y), n segments. */
export function circlePoints(n: number, r = 1): Float32Array {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out[i * 2] = Math.cos(a) * r;
    out[i * 2 + 1] = Math.sin(a) * r;
  }
  return out;
}

/** An arc of the unit circle from a0 to a1 (radians), n segments. */
export function arcPoints(a0: number, a1: number, n: number, r = 1): Float32Array {
  const out = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out[i * 2] = Math.cos(a) * r;
    out[i * 2 + 1] = Math.sin(a) * r;
  }
  return out;
}
