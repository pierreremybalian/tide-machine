// The finale's globe: dark, luminous land and sea from EOT20's 1/2° overview (where the model has ocean), the M2 tide
// as a cyan tint (brighter where the twice-daily tide is bigger) with faint co-tidal lines every 30°, a glowing
// coastline, day and night from the real Sun, an atmosphere rim, NOAA's harmonic stations as amber points and a
// reticle under the pointer. Unit sphere at the origin; the camera orbits it (the globe never rotates).
//
// Convention (shared with picking and the camera): x = cos φ sin λ, y = sin φ, z = cos φ cos λ.

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
} from 'three/webgpu';
import {
  abs,
  acos,
  asin,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cross,
  Discard,
  dot,
  exp,
  float,
  Fn,
  fract,
  fwidth,
  If,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  positionWorld,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Eot20Tile } from '../../finale/eot20.ts';
import { floatToHalf } from '../../coast/heightfield.ts';

const D2R = Math.PI / 180;
const _f = () => uniform(0);
const _v = () => uniform(new Vector3());
type FU = ReturnType<typeof _f>;
type V3U = ReturnType<typeof _v>;

export function unitFromLatLng(lat: number, lng: number, out = new Vector3()): Vector3 {
  const c = Math.cos(lat * D2R);
  return out.set(c * Math.sin(lng * D2R), Math.sin(lat * D2R), c * Math.cos(lng * D2R));
}

export function latLngFromUnit(v: Vector3): { lat: number; lng: number } {
  const r = v.length() || 1;
  return { lat: Math.asin(Math.max(-1, Math.min(1, v.y / r))) / D2R, lng: Math.atan2(v.x, v.z) / D2R };
}

/** RGBA half floats over the overview grid: ocean (0/1), M2 amplitude (m), cos κ, sin κ. */
function overviewTexture(t: Eot20Tile): DataTexture {
  const n = t.rows * t.cols;
  const data = new Uint16Array(n * 4);
  const iM2 = Math.max(0, t.names.indexOf('M2'));
  const one = floatToHalf(1);
  for (let k = 0; k < n; k++) {
    const i = t.ocean[k]!;
    if (i < 0) continue;
    const a = t.amp[iM2]![i]! / 1000;
    const ph = (t.pha[iM2]![i]! / 100) * D2R;
    data[k * 4] = one;
    data[k * 4 + 1] = floatToHalf(a);
    data[k * 4 + 2] = floatToHalf(Math.cos(ph));
    data[k * 4 + 3] = floatToHalf(Math.sin(ph));
  }
  const tex = new DataTexture(data, t.cols, t.rows, RGBAFormat, HalfFloatType);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export interface Globe {
  meshes: Mesh[];
  /** Sun direction (unit, world). */
  sun: V3U;
  /** Reticle under the pointer: unit vector and strength (0 hides it). */
  hover: V3U;
  hoverOn: FU;
  /** The chosen place: unit vector and strength. */
  pick: V3U;
  pickOn: FU;
  /** 0 → 1 reveals of the tide tint and the stations. */
  tint: FU;
  stations: FU;
  time: FU;
  /** World size of one pixel at unit distance (2 tan(fov/2) / height). */
  pixel: FU;
  setCamera(cam: PerspectiveCamera, heightPx: number): void;
  dispose(): void;
}

export function createGlobe(overview: Eot20Tile, stations: readonly { lat: number; lng: number }[], places: readonly { lat: number; lng: number }[]): Globe {
  const tex = overviewTexture(overview);
  const sun = uniform(new Vector3(1, 0.3, 0.4).normalize());
  const hover = uniform(new Vector3(0, 0, 1));
  const hoverOn = uniform(0);
  const pick = uniform(new Vector3(0, 0, 1));
  const pickOn = uniform(0);
  const tint = uniform(1);
  const stationsOn = uniform(1);
  const time = uniform(0);
  const pixel = uniform(0.001);
  const camRight = uniform(new Vector3(1, 0, 0));
  const camUp = uniform(new Vector3(0, 1, 0));

  // ── The sphere ──
  const geo = new SphereGeometry(1, 192, 128);
  const mat = new MeshBasicNodeMaterial();
  const p = normalize(attribute<'vec3'>('position', 'vec3'));
  const lat = asin(clamp(p.y, -1, 1));
  const lng = atan(p.x, p.z);
  const u = lng.div(2 * Math.PI).add(0.5).mul(overview.cols - 1).add(0.5).div(overview.cols);
  const v = lat.div(Math.PI).add(0.5).mul(overview.rows - 1).add(0.5).div(overview.rows);
  // Four bilinear taps half a texel apart: a tent filter, so the 1/2° coastline reads as a curve, not a staircase.
  const du = 0.5 / overview.cols;
  const dv = 0.5 / overview.rows;
  const s = texture(tex, vec2(u.sub(du), v.sub(dv)))
    .add(texture(tex, vec2(u.add(du), v.sub(dv))))
    .add(texture(tex, vec2(u.sub(du), v.add(dv))))
    .add(texture(tex, vec2(u.add(du), v.add(dv))))
    .mul(0.25);
  mat.colorNode = Fn(() => {
    const ocean = s.r;
    const amp = s.g.div(max(ocean, 0.05));
    const aw = fwidth(ocean).add(1e-4);
    const sea = smoothstep(float(0.5).sub(aw), float(0.5).add(aw), ocean);
    // Sea: deep ink, lifted to cyan where the semidiurnal tide is large.
    const ta = clamp(sqrt(amp.div(1.6)), 0, 1).mul(tint);
    const seaCol = mix(vec3(0.0018, 0.0045, 0.012), vec3(0.006, 0.04, 0.075), ta).add(vec3(0.0, 0.025, 0.05).mul(ta.mul(ta)));
    // Co-tidal lines: where the M2 phase crosses a multiple of 30° (from cos κ, sin κ so it survives interpolation).
    const ph = atan(s.a, s.b).div(Math.PI / 6);
    const fp = fract(ph);
    const dl = min(fp, float(1).sub(fp));
    const lw = fwidth(ph).mul(1.2).add(1e-4);
    const lines = float(1).sub(smoothstep(lw.mul(0.5), lw.mul(1.5), dl)).mul(smoothstep(0.03, 0.15, amp)).mul(tint).mul(0.032);
    const landCol = vec3(0.011, 0.01, 0.009).add(vec3(0.004, 0.0035, 0.002).mul(sin(lat.mul(40)).mul(sin(lng.mul(40))).mul(0.5).add(0.5)));
    let col = mix(landCol, seaCol.add(vec3(0.25, 0.65, 0.9).mul(lines)), sea);
    // Day and night from the real Sun; the night side stays legible.
    const day = smoothstep(-0.18, 0.3, dot(p, sun));
    col = col.mul(float(0.35).add(day.mul(0.95)));
    // Coastline: a thin warm line along the land–sea edge.
    const edge = exp(abs(ocean.sub(0.5)).div(aw.mul(1.4)).mul(abs(ocean.sub(0.5)).div(aw.mul(1.4))).negate());
    col = col.add(vec3(1.0, 0.78, 0.5).mul(edge).mul(float(0.45).add(day.mul(0.55))).mul(0.32));
    // Atmosphere rim.
    const vd = normalize(cameraPosition.sub(p));
    const rim = pow(float(1).sub(clamp(dot(p, vd), 0, 1)), 3);
    col = col.add(vec3(0.03, 0.08, 0.22).mul(rim).mul(float(0.35).add(day.mul(0.65))));
    // Reticle under the pointer and the chosen place (angular distance on the sphere).
    const ring = (c: typeof hover, on: typeof hoverOn, r: number | Node<'float'>, w: number) => {
      const a = acos(clamp(dot(p, c), -1, 1));
      const d = a.sub(r).div(w);
      return exp(d.mul(d).negate()).mul(on);
    };
    const pulse = sin(time.mul(3)).mul(0.5).add(0.5);
    col = col.add(vec3(1.0, 0.85, 0.6).mul(ring(hover, hoverOn, 0.035, 0.005)).mul(0.8));
    col = col.add(vec3(1.0, 0.7, 0.35).mul(ring(pick, pickOn, float(0.02).add(pulse.mul(0.02)), 0.005)).mul(1.2));
    return vec4(col, 1);
  })();
  const sphere = new Mesh(geo, mat);

  // ── Atmosphere halo: a back-facing shell, bright at the globe's limb and fading outward ──
  const haloGeo = new SphereGeometry(1.1, 96, 64);
  const haloMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: BackSide });
  haloMat.colorNode = Fn(() => {
    // Closest approach of the view ray to the centre: the glow falls off with height above the limb.
    const ray = normalize(positionWorld.sub(cameraPosition));
    const b = length(cross(ray, cameraPosition));
    const hgt = max(b.sub(1), 0);
    const g = exp(hgt.div(0.028).negate()).mul(0.8).add(exp(hgt.div(0.08).negate()).mul(0.2));
    const hp = normalize(positionWorld);
    const lit = smoothstep(-0.5, 0.5, dot(hp, sun)).mul(0.75).add(0.25);
    return vec4(vec3(0.06, 0.16, 0.45).mul(g).mul(lit).mul(0.5), 1);
  })();
  const halo = new Mesh(haloGeo, haloMat);

  // ── Points: NOAA's stations (small, amber) and the suggested places (larger, warm white) ──
  const all = [...stations.map((x) => ({ ...x, kind: 0 })), ...places.map((x) => ({ ...x, kind: 1 }))];
  const n = all.length;
  const centre = new Float32Array(n * 4 * 4);
  const corner = new Float32Array(n * 4 * 2);
  const index = new Uint32Array(n * 6);
  const tmp = new Vector3();
  all.forEach((pt, i) => {
    unitFromLatLng(pt.lat, pt.lng, tmp).multiplyScalar(1.002);
    for (let k = 0; k < 4; k++) centre.set([tmp.x, tmp.y, tmp.z, pt.kind], (i * 4 + k) * 4);
    corner.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const pGeo = new BufferGeometry();
  pGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 4 * 3), 3));
  pGeo.setAttribute('aCentre', new BufferAttribute(centre, 4));
  pGeo.setAttribute('aCorner', new Float32BufferAttribute(corner, 2));
  pGeo.setIndex(new BufferAttribute(index, 1));
  const pMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  const c4 = attribute<'vec4'>('aCentre', 'vec4');
  const kc = attribute<'vec2'>('aCorner', 'vec2');
  const isPlace = c4.w;
  const px = mix(float(2.2), float(5), isPlace);
  const dist = length(cameraPosition.sub(c4.xyz));
  pMat.positionNode = c4.xyz.add(camRight.mul(kc.x).add(camUp.mul(kc.y)).mul(px.mul(pixel).mul(dist)));
  pMat.colorNode = Fn(() => {
    const kf = vertexStage(kc) as unknown as typeof kc;
    const d2 = dot(kf, kf);
    const g = exp(d2.mul(-4)).mul(float(1).sub(smoothstep(0.8, 1, d2)));
    // Fade at the limb (points seen edge-on crowd together) and on the far side.
    const facing = smoothstep(0.05, 0.3, dot(normalize(c4.xyz), normalize(cameraPosition)));
    const on = mix(stationsOn, float(1), isPlace).mul(facing);
    const colr = mix(vec3(1.0, 0.55, 0.18).mul(0.55), vec3(1.0, 0.93, 0.8).mul(1.6), isPlace);
    If(g.mul(on).lessThan(0.004), () => {
      Discard();
    });
    return vec4(colr.mul(g).mul(on), 1);
  })();
  const points = new Mesh(pGeo, pMat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  halo.renderOrder = 4;

  return {
    meshes: [sphere, halo, points],
    sun,
    hover,
    hoverOn,
    pick,
    pickOn,
    tint,
    stations: stationsOn,
    time,
    pixel,
    setCamera(cam, heightPx) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      camRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
      camUp.value.set(e[4]!, e[5]!, e[6]!).normalize();
      pixel.value = (2 * Math.tan((cam.fov * D2R) / 2)) / Math.max(1, heightPx) / Math.max(1e-3, cam.zoom);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      pGeo.dispose();
      pMat.dispose();
      tex.dispose();
    },
  };
}
