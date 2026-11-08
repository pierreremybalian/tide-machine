// Events as glowing points (HANDOFF §8.4): instanced sprites at spacetime positions, lit by knives, filtered by
// existence, with a slow idle pulse. Positions, colours, sizes and intensities can change per frame (commit()).

import { AdditiveBlending, InstancedBufferAttribute, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import { exp, float, instancedBufferAttribute, sin, uniform, uv } from 'three/tsl';
import type { BlockKit } from './kit.ts';
import type { FloatUniform } from '../../render/globals.ts';
import type { RGB } from './palette.ts';

export interface EventSpec {
  p: readonly [number, number, number];
  colour: RGB;
  size?: number;
  intensity?: number;
}

export interface Events {
  object: Sprite;
  count: number;
  setPos(i: number, x: number, t: number, y: number): void;
  setColour(i: number, c: RGB): void;
  setSize(i: number, s: number): void;
  setIntensity(i: number, v: number): void;
  /** Upload changed attributes. */
  commit(): void;
  opacity: FloatUniform;
  dispose(): void;
}

export function createEvents(kit: BlockKit, specs: readonly EventSpec[], elapsed: FloatUniform, opts: { pulse?: number } = {}): Events {
  const n = Math.max(1, specs.length);
  const pos = new Float32Array(n * 4);
  const col = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    pos.set([s.p[0], s.p[1], s.p[2], s.size ?? 0.09], i * 4);
    col.set([s.colour[0], s.colour[1], s.colour[2], s.intensity ?? 1], i * 4);
  });
  const aPos = new InstancedBufferAttribute(pos, 4);
  const aCol = new InstancedBufferAttribute(col, 4);
  let dirtyP = false;
  let dirtyC = false;
  const P = instancedBufferAttribute<'vec4'>(aPos, 'vec4');
  const C = instancedBufferAttribute<'vec4'>(aCol, 'vec4');
  const opacity = uniform(1);

  const sp = P.xyz;
  const r = uv().sub(0.5).length().mul(2);
  const core = exp(r.mul(r).mul(18).negate());
  const halo = exp(r.mul(r).mul(4).negate()).mul(0.28);
  const pulse = float(1).add(sin(elapsed.mul(1.7).add(sp.x.mul(3.1)).add(sp.y.mul(1.3))).mul(opts.pulse ?? 0.08));
  const glow = kit.sliceGlow(sp);
  const exist = kit.existence(sp);
  const lum = core.mul(1.6).add(halo);
  const colour = C.xyz.mul(C.w).mul(pulse).mul(lum).add(glow.mul(lum).mul(2.2)).mul(exist).mul(opacity);

  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  material.positionNode = kit.toView(sp);
  material.scaleNode = P.w.mul(float(1).add(glow.length().mul(0.6)));
  material.colorNode = colour;
  material.opacityNode = float(1);
  const object = new Sprite(material);
  object.count = specs.length;
  object.frustumCulled = false;
  if (specs.length === 0) object.visible = false;

  return {
    object,
    count: specs.length,
    opacity,
    setPos(i, x, t, y) {
      pos[i * 4] = x;
      pos[i * 4 + 1] = t;
      pos[i * 4 + 2] = y;
      dirtyP = true;
    },
    setColour(i, c) {
      col[i * 4] = c[0];
      col[i * 4 + 1] = c[1];
      col[i * 4 + 2] = c[2];
      dirtyC = true;
    },
    setSize(i, s) {
      pos[i * 4 + 3] = s;
      dirtyP = true;
    },
    setIntensity(i, v) {
      col[i * 4 + 3] = v;
      dirtyC = true;
    },
    commit() {
      if (dirtyP) aPos.needsUpdate = true;
      if (dirtyC) aCol.needsUpdate = true;
      dirtyP = dirtyC = false;
    },
    dispose() {
      material.dispose();
    },
  };
}

