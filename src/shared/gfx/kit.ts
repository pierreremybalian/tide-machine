// The view transform and the "reality" uniforms every block material shares (HANDOFF §8.1–8.2).
// Spacetime points are stored in display layout vec3(x, t, y): world Y is time, up is the future.
//
// View: Lorentz boost along x by β (so the same block can be drawn in another observer's frame), then the loupe's
// anisotropic scale about a focus point, then an offset.
// Reality: up to two knives (now-slices t = βx + c) that light whatever they cut, and the existence filter used to
// draw presentism (only the slice exists) and the growing block (only the slice and below exist).

import { Color, Vector3 } from 'three/webgpu';
import { exp, float, mix, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
const gamma = (beta: number) => 1 / Math.sqrt(1 - beta * beta);
import type { RGB } from './palette.ts';

type V3 = Node<'vec3'>;
type F = Node<'float'>;

const _f = () => uniform(0);
const _c = () => uniform(new Color());
const _v = () => uniform(new Vector3());
export type FloatU = ReturnType<typeof _f>;
export type ColorU = ReturnType<typeof _c>;
export type Vec3U = ReturnType<typeof _v>;

export interface Knife {
  beta: FloatU;
  gamma: FloatU;
  /** Intercept: the plane is t = βx + c. */
  c: FloatU;
  colour: ColorU;
  /** 0 hides the glow. */
  strength: FloatU;
  /** Half-thickness of the glow, in the knife's own time. */
  width: FloatU;
}

export interface BlockKit {
  view: { beta: FloatU; gamma: FloatU; focus: Vec3U; stretch: Vec3U; offset: Vec3U };
  knives: [Knife, Knife];
  exist: { present: FloatU; growing: FloatU; presentWidth: FloatU; fade: FloatU };
  /** Spacetime → world. */
  toView(p: V3): V3;
  /** Direction (tangent) spacetime → world (linear part only). */
  dirToView(d: V3): V3;
  /** Signed distance (in knife i's time) of p from knife i. */
  knifeDist(i: 0 | 1, p: V3): F;
  /** Additive glow from both knives at p. */
  sliceGlow(p: V3): V3;
  /** 0–1: how much p exists under the existence filter. */
  existence(p: V3): F;
  setBeta(beta: number): void;
  setKnife(i: 0 | 1, beta: number, c: number, strength?: number, colour?: RGB): void;
  setLoupe(focus: [number, number, number] | null, stretch?: [number, number, number], offset?: [number, number, number]): void;
  /** CPU mirror of toView, for labels. Writes world coordinates into out. */
  viewCPU(x: number, t: number, y: number, out: Vector3): Vector3;
}

export function createKit(): BlockKit {
  const view = {
    beta: uniform(0),
    gamma: uniform(1),
    focus: uniform(new Vector3()),
    stretch: uniform(new Vector3(1, 1, 1)),
    offset: uniform(new Vector3()),
  };
  const mkKnife = (): Knife => ({
    beta: uniform(0),
    gamma: uniform(1),
    c: uniform(0),
    colour: uniform(new Color(1, 1, 1)),
    strength: uniform(0),
    width: uniform(0.05),
  });
  const knives: [Knife, Knife] = [mkKnife(), mkKnife()];
  const exist = { present: uniform(0), growing: uniform(0), presentWidth: uniform(0.08), fade: uniform(0.06) };

  const boost = (p: V3): V3 => {
    const b = view.beta;
    const g = view.gamma;
    return vec3(p.x.sub(b.mul(p.y)).mul(g), p.y.sub(b.mul(p.x)).mul(g), p.z);
  };
  const toView = (p: V3): V3 => boost(p).sub(view.focus).mul(view.stretch).add(view.focus).add(view.offset);
  const dirToView = (d: V3): V3 => boost(d).mul(view.stretch);
  const knifeDist = (i: 0 | 1, p: V3): F => {
    const k = knives[i];
    return p.y.sub(k.beta.mul(p.x)).sub(k.c).mul(k.gamma);
  };
  const sliceGlow = (p: V3): V3 => {
    let out: V3 = vec3(0);
    for (const i of [0, 1] as const) {
      const k = knives[i];
      const d = knifeDist(i, p).div(k.width);
      out = out.add(k.colour.mul(exp(d.mul(d).negate()).mul(k.strength)));
    }
    return out;
  };
  const existence = (p: V3): F => {
    const d = knifeDist(0, p);
    const near = exp(d.div(exist.presentWidth).pow(2).negate());
    const below = float(1).sub(smoothstep(exist.fade.negate(), exist.fade, d));
    return mix(float(1), near, exist.present).mul(mix(float(1), below.max(near), exist.growing));
  };

  return {
    view,
    knives,
    exist,
    toView,
    dirToView,
    knifeDist,
    sliceGlow,
    existence,
    setBeta(beta) {
      view.beta.value = beta;
      view.gamma.value = gamma(beta);
    },
    setKnife(i, beta, c, strength, colour) {
      const k = knives[i];
      k.beta.value = beta;
      k.gamma.value = gamma(beta);
      k.c.value = c;
      if (strength !== undefined) k.strength.value = strength;
      if (colour) k.colour.value.setRGB(colour[0], colour[1], colour[2]);
    },
    setLoupe(focus, stretch = [1, 1, 1], offset = [0, 0, 0]) {
      if (!focus) {
        view.focus.value.set(0, 0, 0);
        view.stretch.value.set(1, 1, 1);
        view.offset.value.set(0, 0, 0);
        return;
      }
      view.focus.value.set(focus[0], focus[1], focus[2]);
      view.stretch.value.set(stretch[0], stretch[1], stretch[2]);
      view.offset.value.set(offset[0], offset[1], offset[2]);
    },
    viewCPU(x, t, y, out) {
      const b = view.beta.value;
      const g = view.gamma.value;
      const bx = g * (x - b * t);
      const bt = g * (t - b * x);
      const f = view.focus.value;
      const s = view.stretch.value;
      const o = view.offset.value;
      return out.set((bx - f.x) * s.x + f.x + o.x, (bt - f.y) * s.y + f.y + o.y, (y - f.z) * s.z + f.z + o.z);
    },
  };
}
