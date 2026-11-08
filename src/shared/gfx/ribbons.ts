// Worldlines as luminous, camera-facing ribbons (HANDOFF §8.3). Each path is a polyline of spacetime points in
// display layout (x, t, y). The ribbon is built from the *viewed* centre and tangent, so it stays correct under
// boosts and the loupe. Per-vertex proper time τ drives tick beads (a clock reading every `tick`); per-path uniforms
// drive reveal (drawing a worldline as time is stacked), intensity and highlight. Knives light the point where they
// cross a worldline; the existence filter fades what "doesn't exist" in presentism or the growing block.

import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  Vector4,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cross,
  exp,
  float,
  fract,
  max,
  min,
  normalize,
  step,
  uniform,
  uniformArray,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { BlockKit, FloatU } from './kit.ts';
import type { RGB } from './palette.ts';

export interface PathSpec {
  /** Spacetime points [x, t, y]. */
  points: readonly (readonly number[])[];
  colour: RGB;
  /** World half-width of the ribbon (halo extent). */
  width?: number;
  /** Proper-time interval between tick beads (display units); 0 = none. */
  tick?: number;
  /** Base intensity (HDR). */
  intensity?: number;
  /** Draw as a dashed line (for spacelike guides: rungs, distances). */
  dashed?: number;
  /** Treat the path as spacelike (use Euclidean length for the dash pattern; no ticks). */
  spacelike?: boolean;
  /** How strongly knives light this path (default 1). */
  sliceResponse?: number;
  /** 0 ignores the existence filter (e.g. the knives' own guides). */
  existResponse?: number;
}

export interface Ribbons {
  mesh: Mesh;
  /** Per path: x = reveal end (0–1 along the path), y = intensity multiplier, z = reveal start, w = highlight. */
  state: Vector4[];
  set(i: number, reveal: number, intensity?: number, from?: number, highlight?: number): void;
  /** Move path i to new points (same count). Proper time is recomputed. */
  update(i: number, points: readonly (readonly number[])[]): void;
  /** Global multiplier. */
  opacity: FloatU;
  dispose(): void;
}

/** Proper time (timelike) or Euclidean length (spacelike) along a path. */
function pathParams(points: readonly (readonly number[])[], spacelike: boolean) {
  const tau = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b[0]! - a[0]!;
    const dt = b[1]! - a[1]!;
    const dy = (b[2] ?? 0) - (a[2] ?? 0);
    const s = spacelike ? Math.sqrt(dx * dx + dt * dt + dy * dy) : Math.sqrt(Math.max(0, dt * dt - dx * dx - dy * dy));
    tau.push(tau[i - 1]! + s);
  }
  return tau;
}

export function createRibbons(kit: BlockKit, paths: readonly PathSpec[]): Ribbons {
  const center: number[] = [];
  const prev: number[] = [];
  const next: number[] = [];
  const meta: number[] = [];
  const colour: number[] = [];
  const style: number[] = [];
  const index: number[] = [];
  let base = 0;
  const starts: number[] = [];
  paths.forEach((p, pi) => {
    const pts = p.points;
    const n = pts.length;
    starts.push(base);
    if (n < 2) return;
    const tau = pathParams(pts, !!p.spacelike);
    for (let i = 0; i < n; i++) {
      const c = pts[i]!;
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(n - 1, i + 1)]!;
      for (const s of [-1, 1]) {
        center.push(c[0]!, c[1]!, c[2] ?? 0);
        prev.push(a[0]!, a[1]!, a[2] ?? 0, p.existResponse ?? 1);
        next.push(b[0]!, b[1]!, b[2] ?? 0);
        meta.push(s, tau[i]!, i / (n - 1), pi);
        colour.push(p.colour[0], p.colour[1], p.colour[2], p.sliceResponse ?? 1);
        style.push(p.width ?? 0.035, p.tick ?? 0, p.intensity ?? 1, p.dashed ?? 0);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const k = base + i * 2;
      index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    base += n * 2;
  });

  // Packed into 6 vertex buffers (WebGPU allows 8).
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(center, 3));
  geo.setAttribute('aPrev', new Float32BufferAttribute(prev, 4));
  geo.setAttribute('aNext', new Float32BufferAttribute(next, 3));
  geo.setAttribute('aMeta', new Float32BufferAttribute(meta, 4));
  geo.setAttribute('aColour', new Float32BufferAttribute(colour, 4));
  geo.setAttribute('aStyle', new Float32BufferAttribute(style, 4));
  geo.setIndex(index);
  const posAttr = geo.getAttribute('position') as Float32BufferAttribute;
  const prevAttr = geo.getAttribute('aPrev') as Float32BufferAttribute;
  const nextAttr = geo.getAttribute('aNext') as Float32BufferAttribute;
  const metaAttr = geo.getAttribute('aMeta') as Float32BufferAttribute;

  const state = paths.map(() => new Vector4(1, 1, 0, 0));
  const uState = uniformArray(state, 'vec4');
  const opacity = uniform(1);

  const c = attribute<'vec3'>('position', 'vec3');
  const aPrev = attribute<'vec4'>('aPrev', 'vec4');
  const pPrev = aPrev.xyz;
  const pNext = attribute<'vec3'>('aNext', 'vec3');
  const aMeta = attribute<'vec4'>('aMeta', 'vec4');
  const aSide = aMeta.x;
  const aTau = aMeta.y;
  const aAlong = aMeta.z;
  const aPath = aMeta.w;
  const aCol4 = attribute<'vec4'>('aColour', 'vec4');
  const aColour = aCol4.xyz;
  const aStyle = attribute<'vec4'>('aStyle', 'vec4');
  const sliceResponse = aCol4.w;
  const existResponse = aPrev.w;

  // Vertex: camera-facing ribbon around the viewed centre line.
  const wc = kit.toView(c);
  const tan = normalize(kit.toView(pNext).sub(kit.toView(pPrev)).add(vec3(0, 1e-6, 0)));
  const toCam = normalize(cameraPosition.sub(wc));
  const sideDir = normalize(cross(tan, toCam).add(vec3(1e-6, 0, 0)));
  const dist = cameraPosition.sub(wc).length();
  // World width with a floor in screen space so distant lines never vanish.
  const halfW = max(aStyle.x, dist.mul(0.0016));
  const pos = wc.add(sideDir.mul(aSide).mul(halfW));

  // vertexStage keeps the per-path lookup in the vertex shader (one varying), safe on WebGL2.
  const st = vertexStage(uState.element(aPath.toInt())) as unknown as Node<'vec4'>;
  const v = aSide; // −1…1 across the ribbon (interpolated)
  const tick = aStyle.y;
  const phase = fract(aTau.div(max(tick, 1e-6)));
  const dPhase = min(phase, float(1).sub(phase)).mul(tick);
  const bead = exp(dPhase.div(max(tick.mul(0.045), 1e-6)).abs().pow(2).negate()).mul(step(1e-5, tick));
  const coreW = float(0.16).add(bead.mul(0.5));
  const core = exp(v.div(coreW).abs().pow(2).negate());
  const halo = exp(v.mul(v).mul(3.0).negate()).mul(0.12);
  const dash = aStyle.w;
  const dashMask = float(1).sub(step(1e-5, dash).mul(step(0.55, fract(aTau.div(max(dash, 1e-6))))));

  // Reveal window along the path with a hot writing head.
  const revealEnd = st.x;
  const revealFrom = st.z;
  const inside = step(aAlong, revealEnd.add(1e-4)).mul(step(revealFrom.sub(1e-4), aAlong));
  // The hot writing head only while a path is being drawn (not before it starts, not once complete).
  const head = exp(revealEnd.sub(aAlong).div(0.012).abs().pow(2).negate()).mul(step(revealEnd, 0.999)).mul(step(1e-4, revealEnd)).mul(inside);

  const glow = kit.sliceGlow(c).mul(sliceResponse);
  const exist = kit.existence(c).mul(existResponse).add(float(1).sub(existResponse));
  const intensity = aStyle.z.mul(st.y).mul(float(1).add(st.w.mul(1.5)));
  const lum = core.mul(float(1).add(bead.mul(1.8))).add(halo);
  const colourOut = aColour
    .mul(intensity)
    .mul(lum)
    .add(glow.mul(core.mul(2.4).add(halo.mul(1.5))))
    .add(aColour.mul(head.mul(core).mul(6)))
    .mul(inside)
    .mul(dashMask)
    .mul(exist)
    .mul(opacity);

  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
  mat.positionNode = pos;
  mat.colorNode = vec4(colourOut, 1);
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;

  return {
    mesh,
    state,
    opacity,
    set(i, reveal, intensity = 1, from = 0, highlight = 0) {
      state[i]!.set(reveal, intensity, from, highlight);
    },
    update(i, pts) {
      const n = pts.length;
      if (n !== paths[i]!.points.length) throw new Error('ribbon update: point count changed');
      const tau = pathParams(pts, !!paths[i]!.spacelike);
      const P = posAttr.array as Float32Array;
      const A = prevAttr.array as Float32Array;
      const N = nextAttr.array as Float32Array;
      const M = metaAttr.array as Float32Array;
      for (let k = 0; k < n; k++) {
        const c = pts[k]!;
        const a = pts[Math.max(0, k - 1)]!;
        const b = pts[Math.min(n - 1, k + 1)]!;
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const v = starts[i]! + k * 2 + sIdx;
          P[v * 3] = c[0]!;
          P[v * 3 + 1] = c[1]!;
          P[v * 3 + 2] = c[2] ?? 0;
          A[v * 4] = a[0]!;
          A[v * 4 + 1] = a[1]!;
          A[v * 4 + 2] = a[2] ?? 0;
          N[v * 3] = b[0]!;
          N[v * 3 + 1] = b[1]!;
          N[v * 3 + 2] = b[2] ?? 0;
          M[v * 4 + 1] = tau[k]!;
        }
      }
      posAttr.needsUpdate = true;
      prevAttr.needsUpdate = true;
      nextAttr.needsUpdate = true;
      metaAttr.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/** Sample a worldline function t ↦ (x, y) into points [x, t, y] between t0 and t1. */
export function sampleWorldline(f: (t: number) => readonly [number, number], t0: number, t1: number, n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    const [x, y] = f(t);
    out.push([x, t, y]);
  }
  return out;
}

/** Points [x, t, y] where a path's proper time crosses multiples of `every` (for bead sprites and ladder rungs). */
export function tickPoints(points: readonly (readonly number[])[], every: number): { tau: number; p: [number, number, number] }[] {
  const tau = pathParams(points, false);
  const out: { tau: number; p: [number, number, number] }[] = [];
  let k = 0;
  for (let i = 1; i < points.length; i++) {
    while ((k + 1) * every <= tau[i]! + 1e-9) {
      k++;
      const target = k * every;
      const s = (target - tau[i - 1]!) / Math.max(1e-12, tau[i]! - tau[i - 1]!);
      const a = points[i - 1]!;
      const b = points[i]!;
      out.push({
        tau: target,
        p: [a[0]! + (b[0]! - a[0]!) * s, a[1]! + (b[1]! - a[1]!) * s, (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * s],
      });
    }
  }
  return out;
}

