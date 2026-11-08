// Camera shots for the coast stages: keyframed orbit poses around a latitude/longitude, interpolated through the
// stage's `local` (distance on a log scale so long zooms feel even, azimuth the short way round), and applied to an
// OrbitRig with clip planes and haze set from the distance (as the coast labs do).

import type { OrbitRig, RigPose } from '../gfx/rig.ts';
import type { Coast } from './coast.ts';
import { smoother } from '../../time/tracks.ts';

export interface Shot {
  lat: number;
  lng: number;
  /** Radians; 0 puts the camera south of the target looking north. */
  az: number;
  /** Radians above the horizon. */
  el: number;
  /** km. */
  dist: number;
  fov?: number;
}

export type ShotKey = readonly [local: number, shot: Shot];

/** Pose at `local`: eased between neighbouring keys, held before the first and after the last. */
export function shotAt(keys: readonly ShotKey[], local: number, out: Shot): Shot {
  const n = keys.length;
  if (local <= keys[0]![0] || n === 1) return Object.assign(out, keys[0]![1]);
  if (local >= keys[n - 1]![0]) return Object.assign(out, keys[n - 1]![1]);
  let i = 1;
  while (keys[i]![0] < local) i++;
  const [l0, a] = keys[i - 1]!;
  const [l1, b] = keys[i]!;
  const s = smoother(l1 > l0 ? (local - l0) / (l1 - l0) : 1);
  let daz = b.az - a.az;
  daz -= Math.round(daz / (2 * Math.PI)) * 2 * Math.PI;
  out.lat = a.lat + (b.lat - a.lat) * s;
  out.lng = a.lng + (b.lng - a.lng) * s;
  out.az = a.az + daz * s;
  out.el = a.el + (b.el - a.el) * s;
  out.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * s);
  out.fov = (a.fov ?? 34) + ((b.fov ?? 34) - (a.fov ?? 34)) * s;
  return out;
}

/** Point the rig at the shot over the coast; sets near/far and the coast's haze for the distance. */
export function applyShot(rig: OrbitRig, coast: Coast, shot: Shot, pose: RigPose, elapsed: number): void {
  const p = coast.projection;
  pose.tx = p.x(shot.lng);
  pose.ty = p.z(shot.lat);
  pose.tt = coast.y(1);
  pose.az = shot.az;
  pose.el = shot.el;
  pose.dist = shot.dist;
  pose.fov = shot.fov ?? 34;
  rig.apply(pose, elapsed);
  const c = rig.camera;
  const d = shot.dist * rig.fit();
  c.near = Math.max(0.005, d * 0.02);
  c.far = d * 6 + 60;
  c.updateProjectionMatrix();
  coast.uniforms.hazeStart.value = d * 0.9;
  coast.uniforms.hazeDensity.value = 0.9 / (d + 10);
}
