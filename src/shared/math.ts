// Small shared helpers: CPU and TSL.

import { clamp as tslClamp, float, mat3, cos, sin, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => clamp01((x - a) / (b - a));
export const remap = (x: number, a0: number, a1: number, b0: number, b1: number) => lerp(b0, b1, invLerp(a0, a1, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = invLerp(a, b, x);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a: number, b: number, x: number) => {
  const t = invLerp(a, b, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Ease for camera moves. */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
/** Bell curve centred at c with half-width w, 0 outside. */
export const bump = (x: number, c: number, w: number) => {
  const d = (x - c) / w;
  return Math.abs(d) >= 1 ? 0 : (1 - d * d) * (1 - d * d);
};

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform PRNG (Box–Muller). */
export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ── TSL ──
export const saturateRemap = (x: Node<'float'>, a: number, b: number) => tslClamp(x.sub(a).div(b - a), 0, 1);

/** Rotation matrix about Y (TSL). */
export function rotY(angle: Node<'float'> | number) {
  const a = typeof angle === 'number' ? float(angle) : angle;
  const c = cos(a);
  const s = sin(a);
  return mat3(vec3(c, 0, s.negate()), vec3(0, 1, 0), vec3(s, 0, c));
}
