// Gauge markers for the coast stages: glowing, camera-facing points sized in pixels, so a tide gauge reads the same
// from 100 km and from 3 km. Instanced sprites, additive, drawn over the coast (no depth test: the stages place
// them on open water). Per instance: position, colour, intensity, size (px) and a ring that can flare (a crest
// passing, a reading). Positions and colours are written in place; commit() uploads what changed.

import { AdditiveBlending, InstancedBufferAttribute, Sprite, SpriteNodeMaterial, type PerspectiveCamera } from 'three/webgpu';
import { abs, exp, float, instancedBufferAttribute, sin, smoothstep, uniform, uv } from 'three/tsl';
import type { FloatUniform } from '../../render/globals.ts';

export type RGB = readonly [number, number, number];

export interface MarkerSpec {
  x: number;
  y: number;
  z: number;
  color: RGB;
  /** Diameter of the glow, px at the reference viewport height (720 px). */
  size?: number;
  intensity?: number;
  /** 0–1: strength of the outer ring. */
  ring?: number;
}

export interface Markers {
  object: Sprite;
  count: number;
  /** Overall opacity (0 hides). */
  opacity: FloatUniform;
  setPos(i: number, x: number, y: number, z: number): void;
  setColor(i: number, r: number, g: number, b: number): void;
  setIntensity(i: number, v: number): void;
  setSize(i: number, px: number): void;
  setRing(i: number, v: number): void;
  /** Pixel scale for the camera (call once per frame before rendering). */
  update(camera: PerspectiveCamera): void;
  commit(): void;
  dispose(): void;
}

const REF_HEIGHT = 720;

export function createMarkers(specs: readonly MarkerSpec[], elapsed: FloatUniform): Markers {
  const n = Math.max(1, specs.length);
  const pos = new Float32Array(n * 4);
  const col = new Float32Array(n * 4);
  const ext = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    pos.set([s.x, s.y, s.z, s.size ?? 14], i * 4);
    col.set([s.color[0], s.color[1], s.color[2], s.intensity ?? 1], i * 4);
    ext.set([s.ring ?? 0, i * 1.37, 0, 0], i * 4);
  });
  const aPos = new InstancedBufferAttribute(pos, 4);
  const aCol = new InstancedBufferAttribute(col, 4);
  const aExt = new InstancedBufferAttribute(ext, 4);
  let dirtyP = false;
  let dirtyC = false;
  let dirtyE = false;
  const P = instancedBufferAttribute<'vec4'>(aPos, 'vec4');
  const C = instancedBufferAttribute<'vec4'>(aCol, 'vec4');
  const E = instancedBufferAttribute<'vec4'>(aExt, 'vec4');
  const opacity = uniform(1);
  /** Sprite scale per pixel of diameter (world units at depth 1). */
  const pxScale = uniform(0.001);

  const r = uv().sub(0.5).length().mul(2);
  const core = exp(r.mul(r).mul(40).negate()).mul(1.5);
  const halo = exp(r.mul(r).mul(6).negate()).mul(0.22);
  // A thin ring at 70 % of the radius; it flares with E.x.
  const ring = float(1).sub(smoothstep(0.0, 0.07, abs(r.sub(0.7)))).mul(E.x);
  const pulse = float(1).add(sin(elapsed.mul(1.9).add(E.y)).mul(0.06));
  const lum = core.add(halo).add(ring.mul(0.9)).mul(pulse);

  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending });
  material.sizeAttenuation = false;
  material.positionNode = P.xyz;
  material.scaleNode = P.w.mul(pxScale);
  material.colorNode = C.xyz.mul(C.w).mul(lum).mul(opacity);
  material.opacityNode = float(1);
  const object = new Sprite(material);
  object.count = specs.length;
  object.frustumCulled = false;
  object.renderOrder = 10;
  if (specs.length === 0) object.visible = false;

  return {
    object,
    count: specs.length,
    opacity,
    setPos(i, x, y, z) {
      pos[i * 4] = x;
      pos[i * 4 + 1] = y;
      pos[i * 4 + 2] = z;
      dirtyP = true;
    },
    setColor(i, rr, g, b) {
      col[i * 4] = rr;
      col[i * 4 + 1] = g;
      col[i * 4 + 2] = b;
      dirtyC = true;
    },
    setIntensity(i, v) {
      if (col[i * 4 + 3] === v) return;
      col[i * 4 + 3] = v;
      dirtyC = true;
    },
    setSize(i, px) {
      if (pos[i * 4 + 3] === px) return;
      pos[i * 4 + 3] = px;
      dirtyP = true;
    },
    setRing(i, v) {
      if (ext[i * 4] === v) return;
      ext[i * 4] = v;
      dirtyE = true;
    },
    update(camera) {
      // Sizes are authored for a 720 px tall view and scale with the viewport, like the labels.
      pxScale.value = (2 * Math.tan(((camera.fov * Math.PI) / 180) * 0.5)) / REF_HEIGHT;
    },
    commit() {
      if (dirtyP) aPos.needsUpdate = true;
      if (dirtyC) aCol.needsUpdate = true;
      if (dirtyE) aExt.needsUpdate = true;
      dirtyP = dirtyC = dirtyE = false;
    },
    dispose() {
      material.dispose();
    },
  };
}
