// Procedural sky radiance for reflections and ambient light (TSL), and the dark backdrop the coast floats in.
// The sky is never drawn as a background (backgrounds stay dark, HANDOFF art direction); it is what the water and
// the wet flats reflect: a Rayleigh-like zenith-to-horizon gradient, warmed toward the sun, plus a Mie forward lobe.

import { Color, Vector3 } from 'three/webgpu';
import { abs, dot, exp, float, max, mix, normalize, pow, screenUV, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type V3 = Node<'vec3'>;

export interface SkyParams {
  /** Unit vector toward the sun (x east, y up, z south). */
  sunDir: Vector3;
  /** Sun radiance colour × intensity (linear). */
  sunColor: Color;
  zenith: Color;
  horizon: Color;
}

export function createSkyUniforms(p: SkyParams) {
  return {
    sunDir: uniform(p.sunDir.clone().normalize()),
    sunColor: uniform(new Vector3(p.sunColor.r, p.sunColor.g, p.sunColor.b)),
    zenith: uniform(new Vector3(p.zenith.r, p.zenith.g, p.zenith.b)),
    horizon: uniform(new Vector3(p.horizon.r, p.horizon.g, p.horizon.b)),
  };
}
export type SkyUniforms = ReturnType<typeof createSkyUniforms>;

/** Sky radiance seen along a direction (upper hemisphere; the lower is mirrored). */
export function skyRadiance(dir: V3, u: SkyUniforms): V3 {
  const d = normalize(vec3(dir.x, abs(dir.y), dir.z));
  const y = max(d.y, 0.0);
  const mu = dot(d, u.sunDir);
  // Horizon brightening, sharper near the horizon.
  const t = pow(float(1).sub(y), 5.0);
  const base = mix(u.zenith, u.horizon, t);
  // Warm the half of the sky around the sun, mostly near the horizon.
  const warm = smoothstep(-0.2, 1.0, mu).mul(t).mul(0.6);
  const warmed = mix(base, base.mul(normalize(u.sunColor).mul(1.6)), warm);
  // Mie forward lobe (Henyey–Greenstein-ish, g ≈ 0.8) — exp form avoids pow of a negative base.
  const lobe = exp(mu.sub(1).mul(18.0)).mul(0.35).add(exp(mu.sub(1).mul(3.0)).mul(0.06));
  return warmed.add(u.sunColor.mul(lobe));
}

/** Backdrop colour at a screen position: a very dark vertical gradient (the stage the diorama floats on). */
export const BACKDROP = {
  top: new Color(0.004, 0.006, 0.012),
  bottom: new Color(0.012, 0.016, 0.026),
};

export function backdrop(): V3 {
  const s = screenUV.y;
  return mix(vec3(BACKDROP.top.r, BACKDROP.top.g, BACKDROP.top.b), vec3(BACKDROP.bottom.r, BACKDROP.bottom.g, BACKDROP.bottom.b), s);
}

/** Sun direction from azimuth/elevation in degrees (x east, y up, z south). */
export function sunDirection(azimuthDeg: number, elevationDeg: number, out = new Vector3()): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}
