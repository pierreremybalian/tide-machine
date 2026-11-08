// Many glowing straight segments in one draw call (the drift ladder's rungs, ticks and bars): camera-facing quads in
// world space, each with its own colour, width and brightness, updated in place. Additive, after the outline pass.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  Uint32BufferAttribute,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cross,
  Discard,
  exp,
  float,
  Fn,
  If,
  max,
  mix,
  normalize,
  uniform,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { RGB } from '../../shared/gfx/palette.ts';
import type { FloatU } from '../../shared/brass/material.ts';

export interface Segments {
  mesh: Mesh;
  /** Segment i from (ax, ay, az) to (bx, by, bz): colour, brightness, half-width (world; floored in screen space). */
  set(
    i: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    colour: RGB,
    brightness: number,
    width: number,
  ): void;
  /** Hide segment i. */
  off(i: number): void;
  commit(): void;
  intensity: FloatU;
  dispose(): void;
}

export function createSegments(count: number, opts: { minPx?: number } = {}): Segments {
  const a = new Float32Array(count * 4 * 4);
  const b = new Float32Array(count * 4 * 4);
  const col = new Float32Array(count * 4 * 3);
  const corner = new Float32Array(count * 4 * 2);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    corner.set([0, -1, 1, -1, 1, 1, 0, 1], i * 8);
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geo = new BufferGeometry();
  const aA = new BufferAttribute(a, 4);
  const aB = new BufferAttribute(b, 4);
  const aC = new BufferAttribute(col, 3);
  geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geo.setAttribute('aA', aA);
  geo.setAttribute('aB', aB);
  geo.setAttribute('aColour', aC);
  geo.setAttribute('aCorner', new Float32BufferAttribute(corner, 2));
  geo.setIndex(new Uint32BufferAttribute(index, 1));

  const intensity = uniform(1);
  const minPx = opts.minPx ?? 0.0011;
  const A = attribute<'vec4'>('aA', 'vec4');
  const B = attribute<'vec4'>('aB', 'vec4');
  const k = attribute<'vec2'>('aCorner', 'vec2');
  const p = mix(A.xyz, B.xyz, k.x);
  const toCam = normalize(cameraPosition.sub(p));
  const along = B.xyz.sub(A.xyz).add(vec3(1e-6, 1e-6, 0));
  const side = normalize(cross(along, toCam).add(vec3(0, 1e-6, 1e-6)));
  const halfW = max(B.w, cameraPosition.sub(p).length().mul(minPx));
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
  mat.positionNode = p.add(side.mul(k.y).mul(halfW));
  // Across the segment, interpolated per pixel (squares as products: pow() of a negative base is NaN).
  const v = vertexStage(k.y) as unknown as Node<'float'>;
  const vc = v.div(0.3);
  const glow = exp(vc.mul(vc).negate()).add(exp(v.mul(v).mul(2.5).negate()).mul(0.16));
  const bright = vertexStage(A.w) as unknown as Node<'float'>;
  const c = vertexStage(attribute<'vec3'>('aColour', 'vec3')) as unknown as Node<'vec3'>;
  const amount = glow.mul(bright).mul(intensity);
  mat.colorNode = Fn(() => {
    If(amount.lessThan(0.004), () => {
      Discard();
    });
    return vec4(c.mul(amount), float(1));
  })();
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;

  const self: Segments = {
    mesh,
    intensity,
    set(i, ax, ay, az, bx, by, bz, colour, brightness, width) {
      for (let q = 0; q < 4; q++) {
        const o = (i * 4 + q) * 4;
        a[o] = ax;
        a[o + 1] = ay;
        a[o + 2] = az;
        a[o + 3] = brightness;
        b[o] = bx;
        b[o + 1] = by;
        b[o + 2] = bz;
        b[o + 3] = width;
        const oc = (i * 4 + q) * 3;
        col[oc] = colour[0];
        col[oc + 1] = colour[1];
        col[oc + 2] = colour[2];
      }
    },
    off(i) {
      for (let q = 0; q < 4; q++) a[(i * 4 + q) * 4 + 3] = 0;
    },
    commit() {
      aA.needsUpdate = true;
      aB.needsUpdate = true;
      aC.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
  return self;
}
