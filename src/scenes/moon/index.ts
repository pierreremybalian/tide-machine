// Stage 2 · The Moon pulls unevenly — Newton's equilibrium tide (HANDOFF §7, §8.4).
// Earth (a dark globe with glowing coasts) and the Moon at a schematic distance. Arrows show the Moon's pull on each
// part of Earth, then what is left when the pull every part shares is taken away: a stretch along the Earth–Moon line.
// The ocean rises into two bulges (equilibrium heights, drawn ×10⁶), and Earth turns beneath them: San Francisco
// passes two highs per lunar day of 24 h 50 min while the Moon moves on along its orbit.

import {
  BackSide,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RedFormat,
  Scene,
  SphereGeometry,
  Vector3,
  AdditiveBlending,
  type Node,
  type RenderTarget,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  attribute,
  cameraPosition,
  dot,
  float,
  fract,
  fwidth,
  max,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { BlockScene, RenderContext } from '../types.ts';
import { createKit } from '../../shared/gfx/kit.ts';
import { createEvents, type Events } from '../../shared/gfx/events.ts';
import { LabelSet, type LabelSpec } from '../../shared/gfx/labels.ts';
import { OrbitRig, type RigPose } from '../../shared/gfx/rig.ts';
import { PAL, type RGB } from '../../shared/gfx/palette.ts';
import { fbm } from '../../shared/noise.ts';
import { arcPoints, circlePoints, createLines, type LineSpec, type Lines } from './lines.ts';
import { decodeLand, LAND_H, LAND_W } from './land.ts';
import {
  BULGE_EXAGGERATION,
  EARTH_RADIUS_M,
  earthAngle,
  moon,
  MOON_DIST_R,
  moonAngle,
  moonState,
  SF,
  sfHeight,
  TURN_START_H,
  type MoonState,
} from '../../script/moon.ts';
import { MOON_BULGE_M } from '../../tides/equilibrium.ts';
import { mulberry32 } from '../../shared/math.ts';
import { smooth } from '../../time/tracks.ts';

const D2R = Math.PI / 180;
const C = {
  force: [0.72, 0.6, 1.0] as RGB,
  sea: [0.36, 0.78, 1.0] as RGB,
  mean: [0.42, 0.5, 0.72] as RGB,
  orbit: [0.5, 0.54, 0.7] as RGB,
  sf: PAL.a,
};

const params = {
  fov: 34,
  /** Bulge drawn: metres of equilibrium tide → Earth radii. */
  k: BULGE_EXAGGERATION / EARTH_RADIUS_M,
  arrows: 16,
  /** Tidal part of the pull relative to the shared part, as drawn (really 2R/d ≈ 1/30). */
  uneven: 0.27,
  arrowLen: 0.32,
  stars: 220,
  poses: {
    intro: { az: 0.05, el: 0.36, dist: 13.5, tx: -2.7, tt: 0, ty: 0 },
    forces: { az: 0.0, el: 1.18, dist: 10.2, tx: -2.7, tt: 0, ty: 0.35 },
    bulge: { az: -0.25, el: 0.5, dist: 6.6, tx: -0.55, tt: 0.05, ty: 0 },
    turn: { az: -0.2, el: 0.92, dist: 6.4, tx: -0.45, tt: 0.1, ty: 0.2 },
    catchUp: { az: -0.05, el: 0.85, dist: 11.5, tx: -2.5, tt: 0, ty: 0.3 },
    wide: { az: 0.1, el: 0.62, dist: 13.5, tx: -2.6, tt: 0, ty: 0 },
  } satisfies Record<string, RigPose>,
};

function lerpPose(a: RigPose, b: RigPose, t: number, out: RigPose): RigPose {
  out.az = a.az + (b.az - a.az) * t;
  out.el = a.el + (b.el - a.el) * t;
  out.dist = a.dist + (b.dist - a.dist) * t;
  out.tx = a.tx + (b.tx - a.tx) * t;
  out.tt = a.tt + (b.tt - a.tt) * t;
  out.ty = a.ty + (b.ty - a.ty) * t;
  return out;
}

/** World direction of an angle in the equatorial plane (counterclockwise seen from above the north pole). */
function dirOf(deg: number, r: number, out: Vector3, y = 0): Vector3 {
  return out.set(Math.cos(deg * D2R) * r, y, -Math.sin(deg * D2R) * r);
}

export default function moonScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const rig = new OrbitRig(params.fov);
  const kit = createKit();
  const disposers: (() => void)[] = [];
  let plane: Lines;
  let top: Lines;
  let dots: Events;
  let globe: Mesh;
  let moonMesh: Mesh;
  let state: MoonState = moonState(0);
  const pose: RigPose = { ...params.poses.intro };
  const uMoonDir = uniform(new Vector3(-1, 0, 0));
  const uGrow = uniform(0);
  const v = new Vector3();
  const w = new Vector3();
  let sfCm = 1e9;
  /** True when Earth hides the point from the camera. */
  const behind = (x: number, y: number, z: number) => {
    const c = rig.camera.position;
    const dx = x - c.x;
    const dy = y - c.y;
    const dz = z - c.z;
    const L = Math.hypot(dx, dy, dz);
    const b = (c.x * dx + c.y * dy + c.z * dz) / L;
    const cc = c.x * c.x + c.y * c.y + c.z * c.z - 0.995 * 0.995;
    const disc = b * b - cc;
    if (disc < 0) return false;
    const tHit = -b - Math.sqrt(disc);
    return tHit > 0 && tHit < L - 1e-3;
  };

  const labelSpecs: LabelSpec[] = [
    { id: 'moon', text: 'Moon', tone: 'plain', side: 'above' },
    { id: 'dist', text: 'drawn 10 times closer', tone: 'mute', side: 'below', size: 'sm' },
    { id: 'near', text: 'near side: pulled harder', tone: 'light', side: 'left', size: 'sm' },
    { id: 'far', text: 'far side: pulled less', tone: 'light', side: 'right', size: 'sm' },
    { id: 'centre', text: 'the pull every part shares', tone: 'light', side: 'below', size: 'sm' },
    { id: 'hi1', text: `+${MOON_BULGE_M.toFixed(2)} m`, tone: 'b', side: 'left' },
    { id: 'hi2', text: `+${MOON_BULGE_M.toFixed(2)} m`, tone: 'b', side: 'right' },
    { id: 'lo1', text: `−${(MOON_BULGE_M / 2).toFixed(2)} m`, tone: 'mute', side: 'above' },
    { id: 'lo2', text: `−${(MOON_BULGE_M / 2).toFixed(2)} m`, tone: 'mute', side: 'below' },
    { id: 'sf', text: 'San Francisco', tone: 'a', side: 'right' },
    { id: 'sfL', text: 'San Francisco', tone: 'a', side: 'left' },
    { id: 'arc', text: 'the Moon moves on', tone: 'plain', side: 'above', size: 'sm' },
  ];
  const labels = new LabelSet(labelSpecs);
  const LB = Object.fromEntries(labelSpecs.map((s, i) => [s.id, i])) as Record<string, number>;

  // Lines in the equatorial plane (data x, y → world x, −z; data z → world y).
  let n = 0;
  const L = {
    shafts: Array.from({ length: params.arrows }, () => n++),
    heads: Array.from({ length: params.arrows }, () => n++),
    mean: n++,
    bulge: n++,
    orbit: n++,
    arc: n++,
    sfPath: n++,
  };

  const self: BlockScene = {
    id: 'moon',
    status: 'simplified',
    statusNote: moon.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const detail = ctx.quality.detail;

      // ── Earth: dark ocean, slate land, glowing coastlines and a faint graticule; soft key light and a blue rim.
      const mask = new DataTexture(smoothLand(decodeLand()), LAND_W, LAND_H, RedFormat);
      mask.magFilter = LinearFilter;
      mask.minFilter = LinearMipmapLinearFilter;
      mask.generateMipmaps = true;
      mask.needsUpdate = true;
      disposers.push(() => mask.dispose());
      const p = normalize(attribute<'vec3'>('position', 'vec3'));
      const lat = asin(p.y);
      const lon = atan(p.z.negate(), p.x);
      const uvE = vec2(lon.div(Math.PI * 2).add(0.5), float(0.5).sub(lat.div(Math.PI)));
      const m = texture(mask, uvE).r;
      const fw = max(fwidth(m), 1e-4);
      const coast = float(1).sub(smoothstep(0, fw.mul(1.4), abs(m.sub(0.5))));
      const land = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), m);
      const latD = lat.mul(180 / Math.PI).div(30);
      const lonD = lon.mul(180 / Math.PI).div(30);
      const gl = (x: Node<'float'>) => {
        const f = fract(x.add(0.5)).sub(0.5).abs();
        return float(1).sub(smoothstep(0, max(fwidth(x), 1e-4).mul(1.2), f));
      };
      // Graticule every 30°; meridians fade out near the poles where they crowd.
      const grat = max(gl(latD), gl(lonD).mul(float(1).sub(smoothstep(0.9, 0.97, abs(p.y)))));
      const N = normalize(normalWorld);
      const Lk = normalize(vec3(0.45, 0.6, 0.66));
      const diff = max(dot(N, Lk), 0);
      const V = normalize(cameraPosition.sub(positionWorld));
      const facing = max(dot(N, V), 0);
      const rim = float(1).sub(facing).pow(4);
      const ocean = vec3(0.006, 0.02, 0.048).mul(diff.mul(0.95).add(0.3));
      const ground = vec3(0.032, 0.034, 0.044).mul(diff.mul(0.9).add(0.35));
      const coastC = vec3(0.42, 0.76, 1.0).mul(coast.mul(diff.mul(0.5).add(0.5)).mul(0.75));
      const earthC = mix(ocean, ground, land)
        .add(coastC)
        .add(vec3(0.25, 0.35, 0.6).mul(grat).mul(0.06))
        .add(vec3(0.16, 0.42, 0.95).mul(rim).mul(0.55));
      const earthMat = new MeshBasicNodeMaterial();
      earthMat.colorNode = vec4(earthC, 1);
      const segs = Math.round(96 * detail);
      globe = new Mesh(new SphereGeometry(1, segs, Math.round(segs / 2)), earthMat);
      scene.add(globe);
      disposers.push(() => {
        globe.geometry.dispose();
        earthMat.dispose();
      });

      // Atmosphere halo (back faces of a slightly larger sphere).
      const haloMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: BackSide,
      });
      const hv = normalize(cameraPosition.sub(positionWorld));
      const hn = normalize(normalWorld);
      const edge = float(1).sub(abs(dot(hn, hv)));
      haloMat.colorNode = vec4(vec3(0.12, 0.32, 0.8).mul(edge.pow(9)).mul(0.7), 1);
      const halo = new Mesh(new SphereGeometry(1.06, 64, 32), haloMat);
      scene.add(halo);
      disposers.push(() => {
        halo.geometry.dispose();
        haloMat.dispose();
      });

      // ── The ocean's equilibrium surface: a shell displaced along the Moon's direction, glowing where it stands high.
      const sp = attribute<'vec3'>('position', 'vec3');
      const cosT = dot(normalize(sp), uMoonDir);
      const eta = cosT
        .mul(cosT)
        .mul(3)
        .sub(1)
        .mul(MOON_BULGE_M / 2); // metres
      const shellMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      shellMat.positionNode = normalize(sp).mul(eta.mul(params.k).mul(uGrow).add(1));
      const sv = normalize(cameraPosition.sub(positionWorld));
      const sn = normalize(normalWorld);
      const fres = float(1)
        .sub(max(dot(sn, sv), 0))
        .pow(2.2);
      const high = smoothstep(0, MOON_BULGE_M, eta);
      const contour = fract(eta.div(0.06).add(0.5)).sub(0.5).abs();
      const cLine = float(1).sub(smoothstep(0, max(fwidth(eta.div(0.06)), 1e-4).mul(1.3), contour));
      // Only the water standing above the mean glows: a soft fill, a Fresnel edge and contours every 6 cm.
      shellMat.colorNode = vec4(
        vec3(...C.sea)
          .mul(high.mul(fres.mul(0.7).add(0.1)).add(cLine.mul(0.2).mul(high)))
          .mul(uGrow),
        1,
      );
      const shell = new Mesh(new SphereGeometry(1, 128, 64), shellMat);
      scene.add(shell);
      disposers.push(() => {
        shell.geometry.dispose();
        shellMat.dispose();
      });

      // ── The Moon: grey with darker maria, lit by the same key light.
      const mp = normalize(attribute<'vec3'>('position', 'vec3'));
      const maria = smoothstep(0.05, 0.3, fbm(mp.mul(2.2), 4));
      const mn = normalize(normalWorld);
      const mdiff = max(dot(mn, Lk), 0);
      const mrim = float(1)
        .sub(max(dot(mn, normalize(cameraPosition.sub(positionWorld))), 0))
        .pow(3);
      const moonMat = new MeshBasicNodeMaterial();
      moonMat.colorNode = vec4(
        vec3(0.62, 0.63, 0.66)
          .mul(float(1).sub(maria.mul(0.45)))
          .mul(mdiff.mul(0.85).add(0.12))
          .add(vec3(0.5, 0.55, 0.7).mul(mrim).mul(0.4)),
        1,
      );
      moonMesh = new Mesh(new SphereGeometry(0.273, 48, 24), moonMat);
      scene.add(moonMesh);
      disposers.push(() => {
        moonMesh.geometry.dispose();
        moonMat.dispose();
      });

      // ── Lines in the equatorial plane.
      const unit = new Float32Array([0, 0, 1, 0]);
      const head = new Float32Array([-1, 0.6, 0, 0, -1, -0.6]);
      const circle = circlePoints(192);
      const specs: LineSpec[] = [];
      for (let i = 0; i < params.arrows; i++) {
        specs[L.shafts[i]!] = { points: unit, colour: C.force, width: 2.2, intensity: 1.0 };
        specs[L.heads[i]!] = { points: head, colour: C.force, width: 2.2, intensity: 1.0 };
      }
      specs[L.mean] = {
        points: circle,
        colour: C.mean,
        width: 1.1,
        intensity: 0.7,
        closed: true,
        dash: 0.05,
      };
      specs[L.bulge] = { points: circle, colour: C.sea, width: 2.2, intensity: 1.1, closed: true };
      specs[L.orbit] = {
        points: circle,
        colour: C.orbit,
        width: 1,
        intensity: 0.45,
        closed: true,
        dash: 0.12,
      };
      specs[L.arc] = { points: arcPoints(0, 1, 48), colour: [1, 1, 1], width: 2.2, intensity: 1.0 };
      specs[L.sfPath] = { points: circle, colour: C.sf, width: 1, intensity: 0.45, closed: true, dash: 0.04 };
      plane = createLines(specs, {
        resolution: ctx.globals.uResolution,
        occluder: { centre: [0, 0, 0], radius: 0.995, dim: 0.18 },
      });
      plane.mesh.rotation.x = -Math.PI / 2;
      scene.add(plane.mesh);
      disposers.push(plane.dispose);
      // The pull every part shares, drawn just above the north pole so the view from above sees it over Earth's centre.
      top = createLines(
        [
          { points: unit, colour: [1, 0.95, 0.9], width: 2.6, intensity: 1.1 },
          { points: head, colour: [1, 0.95, 0.9], width: 2.6, intensity: 1.1 },
        ],
        { resolution: ctx.globals.uResolution },
      );
      top.mesh.rotation.x = -Math.PI / 2;
      scene.add(top.mesh);
      disposers.push(top.dispose);

      // ── Dots: San Francisco, the Moon's earlier place, and a sky of faint stars.
      const rnd = mulberry32(7);
      const stars = Array.from({ length: params.stars }, () => {
        const u = rnd() * 2 - 1;
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        const b = rnd();
        return {
          p: [Math.cos(a) * r * 60, u * 60, Math.sin(a) * r * 60] as const,
          colour: (b > 0.85 ? [1, 0.9, 0.8] : [0.75, 0.82, 1]) as RGB,
          size: 0.12 + 0.22 * b * b,
          intensity: 0.25 + 0.6 * b * b,
        };
      });
      dots = createEvents(
        kit,
        [
          { p: [0, 0, 0], colour: C.sf, size: 0.07, intensity: 2.0 }, // SF
          { p: [0, 0, 0], colour: PAL.moon, size: 0.12, intensity: 0.6 }, // Moon's earlier place
          ...stars,
        ],
        ctx.globals.uElapsed,
        { pulse: 0.04 },
      );
      scene.add(dots.object);
      disposers.push(dots.dispose);

      self.update(0, 0, 0);
      await renderer.compileAsync(scene, rig.camera);
    },

    update(local, _dt, elapsed) {
      state = moonState(local);
      const s = state;
      const t = s.hours;
      const S = plane.state;
      const k = params.k;

      // Camera: wide → from above for the arrows → the bulges → closer, from higher, while Earth turns → wide.
      const P = params.poses;
      const a1 = smooth(Math.min(1, Math.max(0, (local - 0.1) / 0.1)));
      const a2 = smooth(Math.min(1, Math.max(0, (local - 0.36) / 0.1)));
      const a3 = smooth(Math.min(1, Math.max(0, (local - 0.5) / 0.08)));
      lerpPose(P.intro, P.forces, a1, pose);
      if (a2 > 0) lerpPose(pose, P.bulge, a2, pose);
      if (a3 > 0) lerpPose(pose, P.turn, a3, pose);
      const a4 = smooth(Math.min(1, Math.max(0, (local - 0.69) / 0.07)));
      if (a4 > 0) lerpPose(pose, P.catchUp, a4, pose);
      if (s.pullBack > 0) lerpPose(pose, P.wide, smooth(s.pullBack), pose);
      // Portrait: look along the Earth–Moon line from above, so the Moon sits above Earth on screen.
      if (rig.camera.aspect < 1) {
        pose.az += Math.PI / 2;
        pose.el = Math.min(1.3, pose.el + 0.12);
        pose.tx *= 0.45;
        pose.ty = 0;
      }
      rig.apply(pose, elapsed);

      // Moon and Earth.
      const mA = moonAngle(t);
      dirOf(mA, 1, v);
      uMoonDir.value.copy(v);
      dirOf(mA, MOON_DIST_R, w);
      moonMesh.position.copy(w);
      moonMesh.rotation.y = mA * D2R + Math.PI;
      globe.rotation.y = earthAngle(t) * D2R;
      uGrow.value = s.bulge;
      labels.place(LB.moon!, w.x, 0.3, w.z, rig.camera, 1);
      labels.place(LB.dist!, w.x, -0.3, w.z, rig.camera, (1 - s.bulge) * (1 - a1 * 0.4));

      // Arrows at 16 points round the equator. Moon frame: x′ toward the Moon. Pull = shared + uneven part
      // (2 cos α, −sin α); taking the shared part away leaves the stretch, drawn larger.
      const sub = smooth(s.subtract);
      const L0 = params.arrowLen * (1 + 1.3 * sub);
      const e = params.uneven;
      for (let i = 0; i < params.arrows; i++) {
        const al = (i / params.arrows) * Math.PI * 2;
        const vx = 1 - sub + e * 2 * Math.cos(al);
        const vy = -e * Math.sin(al);
        const len = Math.hypot(vx, vy) * L0;
        const ang = Math.atan2(vy, vx) + mA * D2R;
        const bx = Math.cos(al + mA * D2R);
        const by = Math.sin(al + mA * D2R);
        const on = s.pull;
        Object.assign(S[L.shafts[i]!]!, {
          x: bx,
          y: by,
          sx: len,
          sy: len,
          rot: ang,
          intensity: on * (len > 0.01 ? 1 : 0),
        });
        const hs = Math.min(0.075, len * 0.45);
        Object.assign(S[L.heads[i]!]!, {
          x: bx + Math.cos(ang) * len,
          y: by + Math.sin(ang) * len,
          sx: hs,
          sy: hs,
          rot: ang,
          intensity: on * (len > 0.01 ? 1 : 0),
        });
      }
      // The shared pull, drawn at the centre while it is being taken away.
      const cOn =
        Math.min(s.pull, Math.max(0, Math.min(1, (local - 0.21) / 0.03))) *
        (1 - smooth(Math.max(0, Math.min(1, (local - 0.3) / 0.05))));
      const cLen = params.arrowLen;
      const cA = mA * D2R;
      Object.assign(top.state[0]!, { x: 0, y: 0, z: 1.05, sx: cLen, sy: cLen, rot: cA, intensity: cOn });
      Object.assign(top.state[1]!, {
        x: Math.cos(cA) * cLen,
        y: Math.sin(cA) * cLen,
        z: 1.05,
        sx: 0.08,
        sy: 0.08,
        rot: cA,
        intensity: cOn,
      });
      top.commit();
      const nearP = dirOf(mA, 1.02 + L0 * (1 + 2 * e), v);
      labels.place(LB.near!, nearP.x, 0, nearP.z, rig.camera, s.pull * (1 - sub));
      const farP = dirOf(mA + 180, 1.08, v);
      labels.place(LB.far!, farP.x, 0, farP.z, rig.camera, s.pull * (1 - sub));
      labels.place(LB.centre!, Math.cos(cA) * cLen * 0.5, 1.05, -Math.sin(cA) * cLen * 0.5, rig.camera, cOn);

      // Mean sea level and the bulge's cross-section (exact to first order: an ellipse with semi-axes 1 + kH, 1 − kH/2).
      const g = s.bulge;
      Object.assign(S[L.mean]!, { x: 0, y: 0, sx: 1, sy: 1, intensity: g * (1 - s.pullBack * 0.5) });
      Object.assign(S[L.bulge]!, {
        x: 0,
        y: 0,
        sx: 1 + k * MOON_BULGE_M * g,
        sy: 1 - (k * MOON_BULGE_M * g) / 2,
        rot: mA * D2R,
        intensity: g,
      });
      Object.assign(S[L.orbit]!, { x: 0, y: 0, sx: MOON_DIST_R, sy: MOON_DIST_R, intensity: 1 });
      const hi = 1 + k * MOON_BULGE_M * g + 0.04;
      const hOn = Math.min(1, s.heights) * g;
      dirOf(mA, hi, v);
      labels.place(LB.hi1!, v.x, 0, v.z, rig.camera, hOn);
      dirOf(mA + 180, hi, v);
      labels.place(LB.hi2!, v.x, 0, v.z, rig.camera, hOn);
      dirOf(mA + 90, 1.0, v);
      labels.place(LB.lo1!, v.x, 0, v.z, rig.camera, hOn * 0.9 * (behind(v.x, 0, v.z) ? 0 : 1));
      dirOf(mA - 90, 1.0, v);
      labels.place(LB.lo2!, v.x, 0, v.z, rig.camera, hOn * 0.9 * (behind(v.x, 0, v.z) ? 0 : 1));

      // San Francisco on the turning globe: its dot swells at high water (the HUD card plots the height).
      const sfA = earthAngle(t) + SF.lng;
      const cl = Math.cos(SF.lat * D2R);
      const sl = Math.sin(SF.lat * D2R);
      const hRaw = sfHeight(t);
      const r = 1 + k * hRaw * g + 0.01;
      dirOf(sfA, cl, v, sl);
      const sfOn = s.sf;
      Object.assign(S[L.sfPath]!, { x: 0, y: 0, z: sl, sx: cl, sy: cl, intensity: sfOn * 0.8 });
      const lift = Math.max(0, hRaw / 0.17);
      dots.setPos(0, v.x * r, v.y * r, v.z * r);
      dots.setIntensity(0, sfOn * (1.4 + 1.4 * lift) * (behind(v.x * r, v.y * r, v.z * r) ? 0.3 : 1));
      dots.setSize(0, 0.06 + 0.05 * lift);
      const cmNow = Math.round(hRaw * 100);
      if (cmNow !== sfCm) {
        sfCm = cmNow;
        const txt = `San Francisco ${cmNow >= 0 ? '+' : '−'}${Math.abs(cmNow / 100).toFixed(2)} m`;
        labels.setText(LB.sf!, txt);
        labels.setText(LB.sfL!, txt);
      }
      labels.place(
        LB.sf!,
        v.x * r * 1.03,
        v.y * r * 1.03,
        v.z * r * 1.03,
        rig.camera,
        sfOn * (behind(v.x * r, v.y * r, v.z * r) ? 0.35 : 1),
      );
      // Near the right edge the name flips to the left of the dot.
      const sfVis = labels.state[LB.sf!]!.opacity;
      const flipL = labels.state[LB.sf!]!.x > 0.62;
      labels.place(LB.sfL!, v.x * r * 0.99, v.y * r * 0.99, v.z * r * 0.99, rig.camera, flipL ? sfVis : 0);
      if (flipL) labels.hide(LB.sf!);

      // The Moon moves on: the arc it has covered since Earth started turning.
      const a0 = moonAngle(TURN_START_H);
      const sweep = (mA - a0) * D2R;
      const arcOn = s.catchUp;
      Object.assign(S[L.arc]!, {
        x: 0,
        y: 0,
        sx: MOON_DIST_R,
        sy: MOON_DIST_R,
        rot: a0 * D2R,
        intensity: arcOn,
        from: 0,
        to: 1,
      });
      // The arc's data spans 0…1 rad; scale its angle by drawing the unit arc and rotating: use 'to' for the sweep.
      S[L.arc]!.to = Math.min(1, Math.max(0, sweep));
      dirOf(a0, MOON_DIST_R, v);
      dots.setPos(1, v.x, v.y, v.z);
      dots.setIntensity(1, 0.7 * arcOn);
      dirOf(a0 + (mA - a0) / 2, MOON_DIST_R + 0.35, v);
      labels.place(LB.arc!, v.x, 0, v.z, rig.camera, arcOn);
      plane.commit();
      dots.commit();
    },

    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, rig.camera);
    },

    resize(width, height) {
      rig.resize(width, height);
    },

    dispose() {
      for (const d of disposers) d();
    },
  };
  return self;
}

/** Two passes of a separable 5-cell box blur (wrapping in longitude): the coast becomes a smooth 0.5 contour
 * instead of a staircase of ¼° cells. */
function smoothLand(src: Uint8Array): Uint8Array {
  const W = LAND_W;
  const H = LAND_H;
  let a = Float32Array.from(src);
  let b = new Float32Array(W * H);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) s += a[y * W + ((x + d + W) % W)]!;
        b[y * W + x] = s / 5;
      }
    }
    [a, b] = [b, a];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) s += a[Math.min(H - 1, Math.max(0, y + d)) * W + x]!;
        b[y * W + x] = s / 5;
      }
    }
    [a, b] = [b, a];
  }
  return Uint8Array.from(a, (v) => Math.round(v));
}
