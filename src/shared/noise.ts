// Shared TSL noise (HANDOFF §4 shared/noise.ts). Built on three's MaterialX gradient noise
// (mx_noise_float / mx_noise_vec3) rather than a hand-written simplex: same look, one less shader to maintain.

import { cos, float, mx_noise_float, mx_noise_vec3, sin, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type V3 = Node<'vec3'>;
type F = Node<'float'> | number;

/** Fractal Brownian motion in [-1, 1]-ish. Octaves are unrolled at graph-build time. */
export function fbm(p: V3, octaves = 5, lacunarity = 2.0, gain = 0.5): Node<'float'> {
  let sum: Node<'float'> = float(0);
  let amp = 0.5;
  let q: V3 = p;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(mx_noise_float(q).mul(amp));
    q = q.mul(lacunarity).add(vec3(1.7 + i * 3.1, 9.2 - i * 1.3, 3.1 + i * 2.7));
    amp *= gain;
  }
  return sum;
}

/** Vector fBm (three decorrelated channels). */
export function fbm3(p: V3, octaves = 4, lacunarity = 2.0, gain = 0.5): V3 {
  let sum: V3 = vec3(0);
  let amp = 0.5;
  let q: V3 = p;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(mx_noise_vec3(q).mul(amp));
    q = q.mul(lacunarity).add(vec3(5.2, 1.3 + i, 2.8));
    amp *= gain;
  }
  return sum;
}

/** Inigo Quilez-style domain warp: p + k·fbm3(p). */
export function domainWarp(p: V3, strength: F = 1, octaves = 3): V3 {
  return p.add(fbm3(p, octaves).mul(strength));
}

/** Divergence-free curl of a noise vector potential (finite differences: 6 noise taps). */
export function curlNoise(p: V3, eps = 0.01): V3 {
  const dx = vec3(eps, 0, 0);
  const dy = vec3(0, eps, 0);
  const dz = vec3(0, 0, eps);
  const px0 = mx_noise_vec3(p.sub(dx));
  const px1 = mx_noise_vec3(p.add(dx));
  const py0 = mx_noise_vec3(p.sub(dy));
  const py1 = mx_noise_vec3(p.add(dy));
  const pz0 = mx_noise_vec3(p.sub(dz));
  const pz1 = mx_noise_vec3(p.add(dz));
  const x = py1.z.sub(py0.z).sub(pz1.y.sub(pz0.y));
  const y = pz1.x.sub(pz0.x).sub(px1.z.sub(px0.z));
  const z = px1.y.sub(px0.y).sub(py1.x.sub(py0.x));
  return vec3(x, y, z).div(2 * eps);
}

/**
 * Arnold–Beltrami–Childress flow: divergence-free, chaotic, and cheap (no noise taps).
 * Good for per-particle swirl in vertex shaders where curlNoise is too expensive.
 */
export function abcFlow(p: V3, A: F = 1, B: F = 0.7, C: F = 0.43): V3 {
  return vec3(
    sin(p.z).mul(A).add(cos(p.y).mul(C)),
    sin(p.x).mul(B).add(cos(p.z).mul(A)),
    sin(p.y).mul(C).add(cos(p.x).mul(B)),
  );
}
