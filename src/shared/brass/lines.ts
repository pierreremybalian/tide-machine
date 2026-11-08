// Luminous lines for the machine (HANDOFF §8.3): the summing wire and the pen's trace. Both render additively after
// the outline composite. The wire is a camera-facing ribbon rebuilt in place every frame (no allocation); the trace
// is a ribbon lying on the paper band, built once for the whole run, carried along as the paper feeds and revealed
// as machine time advances.

import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicNodeMaterial, Uint32BufferAttribute } from 'three/webgpu';
import { attribute, cameraPosition, cross, Discard, exp, float, Fn, If, max, mix, modelWorldMatrix, normalize, smoothstep, step, uniform, vec3, vec4, vertexStage } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { RGB } from '../gfx/palette.ts';
import type { FloatU } from './material.ts';

// ── The wire ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GlowLine {
  mesh: Mesh;
  /** Write point i (world). Call commit(n) after writing n points. */
  set(i: number, x: number, y: number, z: number): void;
  commit(n: number): void;
  intensity: FloatU;
  dispose(): void;
}

export function createGlowLine(maxPoints: number, colour: RGB, opts: { width?: number; intensity?: number; minPx?: number } = {}): GlowLine {
  const pts = new Float32Array(maxPoints * 3);
  const pos = new Float32Array(maxPoints * 2 * 3);
  const prev = new Float32Array(maxPoints * 2 * 3);
  const next = new Float32Array(maxPoints * 2 * 3);
  const side = new Float32Array(maxPoints * 2);
  for (let i = 0; i < maxPoints; i++) {
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
  }
  const index = new Uint32Array((maxPoints - 1) * 6);
  for (let i = 0; i < maxPoints - 1; i++) {
    const k = i * 2;
    index.set([k, k + 1, k + 2, k + 1, k + 3, k + 2], i * 6);
  }
  const geo = new BufferGeometry();
  // BufferAttribute (not Float32BufferAttribute, which copies) so commit() writes straight into the GPU-bound arrays.
  const aPos = new BufferAttribute(pos, 3);
  const aPrev = new BufferAttribute(prev, 3);
  const aNext = new BufferAttribute(next, 3);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aPrev', aPrev);
  geo.setAttribute('aNext', aNext);
  geo.setAttribute('aSide', new Float32BufferAttribute(side, 1));
  geo.setIndex(new Uint32BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);

  const intensity = uniform(opts.intensity ?? 2.5);
  const width = opts.width ?? 0.012;
  const minPx = opts.minPx ?? 0.0018;
  const c = attribute<'vec3'>('position', 'vec3');
  const tan = normalize(attribute<'vec3'>('aNext', 'vec3').sub(attribute<'vec3'>('aPrev', 'vec3')).add(vec3(0, 1e-6, 0)));
  const s = attribute<'float'>('aSide', 'float');
  const toCam = normalize(cameraPosition.sub(c));
  const sideDir = normalize(cross(tan, toCam).add(vec3(1e-6, 0, 0)));
  const halfW = max(float(width), cameraPosition.sub(c).length().mul(minPx));
  const v = s;
  // Squares as products: pow() of a negative base is NaN on the GPU.
  const vc = v.div(0.28);
  const core = exp(vc.mul(vc).negate());
  const halo = exp(v.mul(v).mul(2.5).negate()).mul(0.18);
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: DoubleSide });
  mat.positionNode = c.add(sideDir.mul(s).mul(halfW));
  const glow = core.add(halo);
  mat.colorNode = Fn(() => {
    If(glow.lessThan(0.004), () => {
      Discard();
    });
    return vec4(vec3(colour[0], colour[1], colour[2]).mul(glow).mul(intensity), 1);
  })();
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  return {
    mesh,
    intensity,
    set(i, x, y, z) {
      pts[i * 3] = x;
      pts[i * 3 + 1] = y;
      pts[i * 3 + 2] = z;
    },
    commit(n) {
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        for (let k = 0; k < 2; k++) {
          const o = (i * 2 + k) * 3;
          pos[o] = pts[i * 3]!;
          pos[o + 1] = pts[i * 3 + 1]!;
          pos[o + 2] = pts[i * 3 + 2]!;
          prev[o] = pts[a * 3]!;
          prev[o + 1] = pts[a * 3 + 1]!;
          prev[o + 2] = pts[a * 3 + 2]!;
          next[o] = pts[b * 3]!;
          next[o + 1] = pts[b * 3 + 1]!;
          next[o + 2] = pts[b * 3 + 2]!;
        }
      }
      aPos.needsUpdate = true;
      aPrev.needsUpdate = true;
      aNext.needsUpdate = true;
      geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ── The trace on the paper band ────────────────────────────────────────────────────────────────────────────────

/** A polyline on the paper: s = distance along the band (machine units), y = height. */
export interface PaperLine {
  s: Float64Array;
  y: Float64Array;
  /** Fraction of the run (0–1) at which each point is drawn; lines with reveal = false are printed ruling. */
  t: Float64Array;
  width: number;
  intensity: number;
  reveal: boolean;
}

export interface PaperTrace {
  /** Child this of a group that moves with the paper (local x = s). */
  mesh: Mesh;
  /** Fraction of the run drawn so far (0–1). */
  reveal: FloatU;
  /** World x range where the band lies flat and visible (fades at both ends). */
  x0: FloatU;
  x1: FloatU;
  intensity: FloatU;
  dispose(): void;
}

/**
 * Lines on the paper band (the plane z = 0 of the mesh). Each line becomes a strip offset along its in-plane normal,
 * so steep stretches of the curve keep their width. The first line is the pen's trace (hot at its writing head).
 */
export function createPaperTrace(lines: readonly PaperLine[], colour: RGB, ruling: RGB): PaperTrace {
  const pos: number[] = [];
  const meta: number[] = [];
  const index: number[] = [];
  lines.forEach((ln, li) => {
    const n = ln.s.length;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let ts = ln.s[b]! - ln.s[a]!;
      let ty = ln.y[b]! - ln.y[a]!;
      const l = Math.hypot(ts, ty) || 1;
      ts /= l;
      ty /= l;
      for (const k of [-1, 1]) {
        pos.push(ln.s[i]! - ty * ln.width * k, ln.y[i]! + ts * ln.width * k, 0);
        meta.push(ln.reveal ? ln.t[i]! : -1, k, li === 0 ? 1 : 0, ln.intensity);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const k = base + i * 2;
      index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aMeta', new Float32BufferAttribute(meta, 4));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  const reveal = uniform(0);
  const intensity = uniform(1);
  const x0 = uniform(0);
  const x1 = uniform(1);
  const p = attribute<'vec3'>('position', 'vec3');
  const m = attribute<'vec4'>('aMeta', 'vec4');
  const wx = vertexStage(modelWorldMatrix.mul(vec4(p, 1)).x) as unknown as Node<'float'>;
  const tDraw = m.x;
  const across = m.y;
  const isTrace = m.z;
  // Revealed lines appear as the pen passes; the ruling is always there. The band fades where it bends onto a roll.
  const shown = mix(float(1), step(tDraw, reveal), step(0, tDraw));
  const dh = reveal.sub(tDraw).div(0.004);
  const head = exp(dh.mul(dh).negate()).mul(step(0, tDraw)).mul(step(tDraw, reveal)).mul(isTrace);
  const flat = smoothstep(x0, x0.add(0.18), wx).mul(float(1).sub(smoothstep(x1.sub(0.05), x1, wx)));
  const ac = across.div(0.45);
  const core = exp(ac.mul(ac).negate());
  const col = mix(vec3(ruling[0], ruling[1], ruling[2]), vec3(colour[0], colour[1], colour[2]), isTrace);
  const lum = core.mul(m.w).mul(float(1).add(head.mul(4)));
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: DoubleSide });
  // Discard what adds nothing: on some WebGL2 drivers these overlays have drawn black where they should add zero.
  const amount = lum.mul(shown).mul(flat);
  mat.colorNode = Fn(() => {
    If(amount.lessThan(0.004), () => {
      Discard();
    });
    return vec4(col.mul(amount).mul(intensity), 1);
  })();
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return {
    mesh,
    reveal,
    x0,
    x1,
    intensity,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
