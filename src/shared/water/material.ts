// The coast material (TSL): one mesh draws land, tidal water, salt ponds and wet flats.
//
// Geometry: a grid whose vertices carry the terrain height; the vertex stage lifts every tidally wet vertex to the
// water level (y = max(terrain, level) where the level exceeds the spill height), so the surface you see is the true
// air–water–land boundary with no z-fighting. The fragment stage decides wet/dry per pixel from the full-resolution
// textures (antialiased over one pixel) and shades either water or land; both use the same procedural sky.
//
// Water (HANDOFF §8.2):
// - waves: three bands (ocean swell, wind sea, chop) of several components each; phase = r·ω·(T(x) − s·t) with T
//   the fast-marching travel time, so crests shorten and bend toward shore; heights shoal (K_s from the local
//   group speed) and saturate at H = 0.78·d (breaking → foam); components below ~2 px fade out and their slope
//   variance widens the sun's GGX lobe instead (no shimmer);
// - optics: Schlick Fresnel sky reflection, GGX sun glitter, Beer–Lambert absorption with RGB coefficients along the
//   refracted path down to the bottom and back, sediment scattering (turbidity rises in the bay and the shallows),
//   bottom visibility in the shallows, swash foam at the waterline.
// Land: slope, aspect and elevation palette (no imagery), hillshade from per-pixel normals, ambient occlusion, haze;
// recently exposed flats are dark and glossy (wet sheen), diked land and salt ponds are told apart.

import { MeshBasicNodeMaterial, Vector2, Vector3, type DataTexture, type Texture } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { backdrop, skyRadiance, type SkyUniforms } from './sky.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

const TAU = Math.PI * 2;

/** World rectangle (km) a texture covers: uv = (xz − origin) / size. */
export interface Extent {
  x0: number;
  z0: number;
  w: number;
  d: number;
}

export interface WaveBandSpec {
  period: number;
  /** Component multipliers of the band's wavenumber. */
  ratios: number[];
}

export interface CoastMaterialInputs {
  /** RGBA: height (m), spill height (m), ambient occlusion, unused. */
  terrain: DataTexture;
  /** RG: signed distance (cells) to salt ponds, to never-tidal (diked) land; positive inside. */
  classes: DataTexture;
  terrainExt: Extent;
  /** Terrain texel size (m), x and z. */
  terrainCell: [number, number];
  level: DataTexture;
  levelExt: Extent;
  wave: DataTexture;
  waveExt: Extent;
  waveSize: [number, number];
  /** Wave texel size (m). */
  waveCell: [number, number];
  amp: DataTexture;
  bands: WaveBandSpec[];
  sky: SkyUniforms;
  /** Full extent of the coast (km) for the edge fade. */
  extent: Extent;
  /** Wind direction (degrees the wind blows toward) for the gust drift. */
  windToward: number;
  /** Shadow-march steps (0 disables). */
  shadowSteps: number;
}

export function createCoastUniforms() {
  return {
    /** Vertical exaggeration of terrain and water level (×). */
    exaggeration: uniform(3),
    /** Wave clock (s), wrapped by the caller. */
    time: uniform(0),
    /** Significant wave height of each band before shoaling (m): swell, wind sea, chop. */
    bandHeight: uniform(new Vector3(2.0, 0.45, 0.22)),
    /** Overall wave strength (0 = mirror calm). */
    waveStrength: uniform(1),
    /** 1 = terrain casts sun shadows. */
    shadowSteps: uniform(1),
    /** Gust patchiness 0–1 (0 = uniform wind). */
    gusts: uniform(1),
    /** Horizontal wave scale (1 = true scale). */
    waveScale: uniform(1),
    foam: uniform(1),
    /** Haze: distance (km) where it starts and its density (1/km). */
    hazeStart: uniform(20),
    hazeDensity: uniform(0.012),
    hazeColor: uniform(new Vector3(0.018, 0.024, 0.036)),
    /** Edge fade width (km) and the radius (fraction of the half-extent) where the world-space vignette starts. */
    edgeFade: uniform(8),
    vignette: uniform(0.95),
    /** Sky ambient multiplier (water), and the land's sky fill (a dusk sky is dim; the land needs some fill). */
    ambient: uniform(1),
    ambientLand: uniform(new Vector3(0.15, 0.18, 0.24)),
    /** Land albedo multiplier. */
    landGain: uniform(1),
    /** Debug view: 0 off, 1 wave travel times, 2 wave amplitude factors, 3 wet / depth / bathymetry. */
    debug: uniform(0),
    /** Mean pixel footprint hint for AA (set from the camera, m per px). */
    resolution: uniform(new Vector2(1280, 720)),
  };
}
export type CoastUniforms = ReturnType<typeof createCoastUniforms>;

const col = (r: number, g: number, b: number) => vec3(r, g, b);

/** Schlick Fresnel for water (F0 = 0.02). */
const fresnel = (cosTheta: F) => float(0.02).add(float(0.98).mul(pow(float(1).sub(clamp(cosTheta, 0, 1)), 5)));

/** GGX normal distribution. */
function ggx(NdotH: F, alpha: F): F {
  const a2 = alpha.mul(alpha);
  const d = NdotH.mul(NdotH).mul(a2.sub(1)).add(1);
  return a2.div(d.mul(d).mul(Math.PI).max(1e-6));
}

export function createCoastMaterial(inp: CoastMaterialInputs, u: CoastUniforms): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  const u_windToward = inp.windToward;
  const { terrainExt: te, levelExt: le, waveExt: we, extent: ex } = inp;
  const tTex = (uv: V2) => texture(inp.terrain as Texture, uv);
  const lTex = (uv: V2) => texture(inp.level as Texture, uv);
  const uvOf = (e: Extent, xz: V2) => xz.sub(vec2(e.x0, e.z0)).div(vec2(e.w, e.d));

  // ── Vertex: lift wet vertices to the water level ──
  const pos = attribute('position', 'vec3');
  const tv = texture(inp.terrain as Texture, uvOf(te, pos.xz)).level(float(0));
  const lv = texture(inp.level as Texture, uvOf(le, pos.xz)).level(float(0));
  const hV = pos.y.mul(1000);
  const yM = select(lv.x.greaterThan(tv.y), max(hV, lv.x), hV);
  const yWorld = yM.mul(u.exaggeration).div(1000);
  mat.positionNode = vec3(pos.x, yWorld, pos.z);
  const vXZ = varying(pos.xz, 'vCoastXZ');
  const vY = varying(yWorld, 'vCoastY');

  mat.colorNode = Fn(() => {
    const xz = vXZ;
    const pm = xz.mul(1000); // metres
    const world = vec3(xz.x, vY, xz.y);
    const toCam = cameraPosition.sub(world);
    const dist = length(toCam);
    const V = toCam.div(dist);
    const S = inp.sky.sunDir;
    const sunCol = inp.sky.sunColor;

    const uvT = uvOf(te, xz);
    const t4 = tTex(uvT);
    const h = t4.x;
    const spill = t4.y;
    const ao = t4.z;
    const cls = texture(inp.classes as Texture, uvT);
    const pond = smoothstep(-0.35, 0.35, cls.x);
    const diked = smoothstep(-0.35, 0.35, cls.y);
    const l4 = lTex(uvOf(le, xz));
    const L = l4.x;
    const Lmax = l4.y;
    const msl = l4.w;

    // Wet/dry, antialiased over a pixel.
    const s = L.sub(spill);
    // One pixel of antialiasing, capped so a jump in spill height (a levee, a pond edge) cannot smear water inland.
    const aa = clamp(fwidth(s), 1e-4, 0.08);
    const wet = smoothstep(aa.negate(), aa, s);
    const depth = max(L.sub(h), 0.0);
    const footprint = max(max(fwidth(pm.x), fwidth(pm.y)), 0.05);

    const sky = (d: V3) => skyRadiance(d, inp.sky);
    const ambSky = sky(vec3(0, 1, 0)).mul(u.ambient);
    const ambLand = u.ambientLand;
    const sunUp = smoothstep(-0.02, 0.08, S.y);

    const land = vec3(0).toVar();
    const water = vec3(0).toVar();
    const dbg = vec3(0).toVar();

    // ── Land ──
    If(wet.lessThan(0.999), () => {
      const [cx, cz] = inp.terrainCell;
      // Two-scale normals: ±1 texel for crisp detail, ±3 texels for the broad landform; mixed so the relief reads
      // as shaped masses rather than lidar grain.
      const grad = (k: number) => {
        const du = vec2(k / ((te.w * 1000) / cx), 0);
        const dv = vec2(0, k / ((te.d * 1000) / cz));
        return vec2(
          tTex(uvT.add(du)).x.sub(tTex(uvT.sub(du)).x).div(2 * k * cx),
          tTex(uvT.add(dv)).x.sub(tTex(uvT.sub(dv)).x).div(2 * k * cz),
        );
      };
      const g1 = grad(1);
      const g3 = grad(3);
      const gm = mix(g3, g1, 0.45).toVar();
      // Close up (pixels finer than the data), add procedural micro-relief so slopes are not clay-smooth.
      If(footprint.lessThan(cx * 0.6), () => {
        const e = 6.0;
        const q = pm.mul(1 / 90);
        const nb = (o: V2) => mx_noise_float(vec3(q.add(o), 2.0)).add(mx_noise_float(vec3(q.mul(3.1).add(o.mul(3.1)), 5.0)).mul(0.35));
        const n0 = nb(vec2(0, 0));
        const ddx = nb(vec2(e / 90, 0)).sub(n0).div(e);
        const ddz = nb(vec2(0, e / 90)).sub(n0).div(e);
        const amp = float(1).sub(smoothstep(cx * 0.15, cx * 0.6, footprint)).mul(smoothstep(0.02, 0.2, length(g3)).mul(0.7).add(0.3)).mul(2.2);
        gm.addAssign(vec2(ddx, ddz).mul(amp));
      });
      const N = normalize(vec3(gm.x.mul(u.exaggeration).negate(), 1, gm.y.mul(u.exaggeration).negate()));
      const slope = length(g3); // true gradient (m/m), broad scale
      const above = h.sub(msl); // height above local mean sea level (m)
      // Bay Area ecology, restrained (no imagery): north-facing slopes hold oak woodland and chaparral (darker,
      // greener); south- and west-facing slopes are grassland, green in winter; valleys hold denser trees.
      const northness = clamp(gm.y.div(max(slope, 1e-3)), -1, 1).mul(smoothstep(0.03, 0.15, slope));
      const grass = col(0.078, 0.088, 0.044);
      const wood = col(0.03, 0.046, 0.027);
      // Plains and towns: a neutral grey with a fine grain (blocks, parks), so cities do not read as haze.
      const grain = mx_noise_float(vec3(pm.mul(1 / 95), 4.2)).mul(0.5).add(mx_noise_float(vec3(pm.mul(1 / 31), 8.4)).mul(0.3));
      const lowland = col(0.06, 0.056, 0.047).mul(grain.mul(0.35).add(1));
      const marsh = col(0.04, 0.048, 0.032); // tidal marsh and diked baylands
      const rock = col(0.1, 0.094, 0.083);
      // Patchy tree cover: clumps on shaded slopes and in hollows (AO), at 100–400 m scales.
      const n1 = mx_noise_float(vec3(pm.mul(0.0011), 1.3)).mul(0.5).add(mx_noise_float(vec3(pm.mul(0.0045), 7.1)).mul(0.25));
      const n2 = mx_noise_float(vec3(pm.mul(1 / 160), 11.0));
      const treeMask = smoothstep(0.05, 0.45, n2.mul(0.6).add(northness.mul(0.45)).add(float(1).sub(ao).mul(1.2)).sub(0.1));
      const hills = mix(grass, wood, treeMask.mul(smoothstep(15, 90, above)));
      const hillW = smoothstep(10, 80, above).mul(smoothstep(0.02, 0.08, slope).mul(0.7).add(0.3));
      const alb = mix(lowland, hills, clamp(hillW, 0, 1)).toVar();
      alb.assign(mix(alb, rock, smoothstep(0.55, 1.1, slope).mul(0.45)));
      alb.assign(mix(alb, alb.mul(1.25).add(vec3(0.012, 0.01, 0.006)), smoothstep(500, 1100, above)));
      // Low ground near the tide: marsh tones.
      const low = float(1).sub(smoothstep(1.5, 4.0, above));
      alb.assign(mix(alb, marsh, low.mul(0.85)));
      // Intertidal mud (≈ MLLW to MHW), bare when the tide is out.
      const tidal = float(1).sub(diked);
      const inter = float(1).sub(smoothstep(0.6, 1.4, above)).mul(smoothstep(-2.5, -1.2, above)).mul(tidal);
      const mud = col(0.075, 0.064, 0.05);
      alb.assign(mix(alb, mud, inter));
      // Surf beaches (exposed to the ocean swell): sand from the low-tide line to the dunes.
      const surfExposure = texture(inp.amp as Texture, uvOf(we, xz)).x;
      const beach = smoothstep(0.15, 0.6, surfExposure.mul(u.bandHeight.x).div(1.2)).mul(float(1).sub(smoothstep(3.0, 7.0, above))).mul(tidal);
      alb.assign(mix(alb, col(0.2, 0.18, 0.145), beach));
      alb.mulAssign(n1.mul(0.25).add(1));
      alb.mulAssign(u.landGain);

      // Sun shadows: march the heightfield toward the sun (exaggerated relief, so shadows match what you see).
      const shadow = float(1).toVar();
      If(sunUp.greaterThan(0.0).and(u.shadowSteps.greaterThan(0.5)), () => {
        const sxz = normalize(vec2(S.x, S.z));
        const tanEl = S.y.div(max(length(vec2(S.x, S.z)), 1e-3));
        const h0 = h.mul(u.exaggeration).add(2.0);
        const t = float(cx * 0.9).toVar();
        Loop(inp.shadowSteps, () => {
          const qx = xz.add(sxz.mul(t.div(1000)));
          const hq = texture(inp.terrain as Texture, uvOf(te, qx)).level(float(0)).x.mul(u.exaggeration);
          const clear = h0.add(t.mul(tanEl)).sub(hq);
          shadow.assign(min(shadow, clamp(clear.div(t.mul(0.035)).add(0.5), 0, 1)));
          t.mulAssign(1.32);
        });
      });

      // Lighting: wrapped Lambert sun (soft terminator) in shadow-aware form, cool sky fill by AO, warm bounce.
      const wrapL = clamp(dot(N, S).add(0.15).div(1.15), 0, 1);
      const sunL = sunCol.mul(wrapL.mul(wrapL.mul(0.35).add(0.65))).mul(sunUp).mul(shadow.mul(0.92).add(0.08)).mul(ao.mul(0.3).add(0.7));
      // Sky light is what valleys lose: AO weighs it more than the sun (multi-scale relief, no blur).
      const skyL = ambLand.mul(N.y.mul(0.6).add(0.4)).mul(ao.mul(ao));
      const bounce = sunCol.mul(0.03).mul(float(1).sub(N.y)).mul(ao);
      const c = alb.mul(sunL.add(skyL).add(bounce)).toVar();

      // Recently exposed flats: wet sheen (darker mud + glossy sky and sun reflection), fading as they drain.
      const exposed = smoothstep(0.0, 0.25, Lmax.sub(h)).mul(smoothstep(-0.02, 0.15, h.sub(L)));
      const recent = exposed.mul(tidal);
      If(recent.greaterThan(0.001), () => {
        const wn = mx_noise_float(vec3(pm.mul(0.02), 3.7));
        const puddle = smoothstep(0.1, 0.5, wn).mul(recent);
        const Nw = normalize(mix(N, vec3(0, 1, 0), puddle.mul(0.8).add(0.2)));
        const NdV = max(dot(Nw, V), 1e-3);
        // Wet mud is a rough, dark glaze; only puddles and rills mirror the sky.
        const F = fresnel(NdV).mul(recent).mul(mix(float(0.2), float(0.9), puddle));
        const R = reflect(V.negate(), Nw);
        const Hh = normalize(V.add(S));
        const alpha = mix(float(0.22), float(0.05), puddle);
        const spec = ggx(max(dot(Nw, Hh), 0.0), alpha).mul(F).mul(max(dot(Nw, S), 0)).div(NdV.mul(4)).mul(sunUp);
        c.assign(mix(c, c.mul(0.55), recent));
        c.addAssign(sky(R).mul(F).add(sunCol.mul(spec)));
      });

      // Salt ponds and other still water in the lidar (flat, never tidal): calm, reflective, tinted per pond.
      If(pond.greaterThan(0.02), () => {
        const tint = hash(floor(h.mul(50)).add(17.0));
        const brine = mix(col(0.05, 0.08, 0.07), col(0.12, 0.06, 0.05), smoothstep(0.55, 0.95, tint)).add(col(0.0, 0.03, 0.02).mul(float(1).sub(smoothstep(0.0, 0.2, tint))));
        const Np = normalize(vec3(mx_noise_float(vec3(pm.mul(0.05), u.time.mul(0.1))).mul(0.01), 1, mx_noise_float(vec3(pm.mul(0.05).add(9.0), u.time.mul(0.1))).mul(0.01)));
        const NdV = max(dot(Np, V), 1e-3);
        const F = fresnel(NdV);
        const Hh = normalize(V.add(S));
        const spec = ggx(max(dot(Np, Hh), 0.0), float(0.03)).mul(F).mul(max(S.y, 0)).div(NdV.mul(4));
        const pc = brine.mul(sunCol.mul(max(S.y, 0)).add(ambSky)).mul(float(1).sub(F)).add(sky(reflect(V.negate(), Np)).mul(F)).add(sunCol.mul(spec).mul(sunUp));
        c.assign(mix(c, pc, pond));
      });
      land.assign(c);
    });

    // ── Water ──
    If(wet.greaterThan(0.001), () => {
      // Wave travel times: manual bilinear on a float32 texture (4 loads, all three bands at once).
      const [wnx, wny] = inp.waveSize;
      const g = uvOf(we, xz).mul(vec2(wnx, wny)).sub(0.5);
      const g0 = floor(g);
      const f = g.sub(g0);
      const i0 = clamp(g0, vec2(0, 0), vec2(wnx - 1, wny - 1));
      const i1 = clamp(g0.add(1), vec2(0, 0), vec2(wnx - 1, wny - 1));
      const ld = (x: F, y: F) => textureLoad(inp.wave as Texture, ivec2(int(x), int(y))).xyz;
      const c00 = ld(i0.x, i0.y);
      const c10 = ld(i1.x, i0.y);
      const c01 = ld(i0.x, i1.y);
      const c11 = ld(i1.x, i1.y);
      const T = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
      const [wcx, wcz] = inp.waveCell;
      const dTx = mix(c10.sub(c00), c11.sub(c01), f.y).div(wcx);
      const dTz = mix(c01.sub(c00), c11.sub(c10), f.x).div(wcz);
      const valid = vec3(min(min(c00, c10), min(c01, c11)).greaterThanEqual(vec3(0)));
      const A = texture(inp.amp as Texture, uvOf(we, xz));
      // Debug 1: travel-time stripes (R swell 60 s, G sea 300 s, B chop 300 s) × validity; debug 2: amplitude.
      dbg.assign(select(u.debug.lessThan(1.5), step(vec3(0.5), fract(T.div(vec3(60, 300, 300)))).mul(valid).mul(0.6).add(0.05), A.xyz));

      // Gusts: the wind is patchy, so the sea is too (cat's paws, slicks). A slow noise field drifting downwind
      // modulates every band's height and the capillary roughness; it is what you see of the wind from far away.
      const drift = vec2(Math.sin((u_windToward * Math.PI) / 180), -Math.cos((u_windToward * Math.PI) / 180)).mul(u.time.mul(6));
      const gq = pm.sub(drift).div(2600);
      const gust = clamp(mx_noise_float(vec3(gq, u.time.mul(0.004))).mul(0.8).add(mx_noise_float(vec3(gq.mul(2.7), 3.1)).mul(0.4)).add(1.0), 0.35, 1.6).mul(u.gusts).add(float(1).sub(u.gusts));
      const slope = vec2(0).toVar();
      const gerst = float(0).toVar();
      const variance = float(0).toVar();
      const breaking = float(0).toVar();
      const crest = float(0).toVar();
      const Hmain = float(0).toVar();
      // The dominant band's leading component: its phase (cycles) and how well it is resolved, for surf lines.
      const surfH = float(0).toVar();
      const surfPh = float(0).toVar();
      const surfCyc = float(0).toVar();
      const surfRes = float(0).toVar();

      const chans = ['x', 'y', 'z'] as const;
      inp.bands.forEach((band, b) => {
        const ch = chans[b]!;
        const omega = TAU / band.period;
        const grad = vec2(dTx[ch], dTz[ch]);
        // Shoaling at the instantaneous depth: Eckart's k ≈ k₀/√tanh(k₀d), group speed c_g = n·ω/k,
        // K_s = √(c_g,deep / c_g); the height is then capped by depth-limited breaking, H ≤ 0.78 d.
        const k0 = (omega * omega) / 9.81;
        const dd = max(depth, 0.05);
        const kI = float(k0).div(sqrt(max(clampTanh(dd.mul(k0)), 1e-4)));
        const x2 = kI.mul(dd).mul(2).min(30);
        const sinh2 = exp(x2).sub(exp(x2.negate())).mul(0.5);
        const nG = float(0.5).mul(float(1).add(x2.div(max(sinh2, 1e-5))));
        const cg = nG.mul(omega).div(kI);
        const Ks = sqrt(float(9.81 / (2 * omega)).div(max(cg, 0.02))).min(2.5);
        const H0 = u.bandHeight[ch].mul(A[ch]).mul(valid[ch]).mul(u.waveStrength).mul(b === 0 ? float(1) : gust);
        const Hs = H0.mul(Ks);
        const Hcap = depth.mul(0.78);
        // Breaking index H/(0.78 d); the foam it makes scales with the height that is breaking.
        // Foam cover of a saturated surf zone grows with the breaking height: ≈ 60 % under a 1.5 m swell, a few %
        // where bay chop trips over the flats.
        // Short, steep bay chop mostly spills and loses its energy to the muddy bottom with little whitewater;
        // swell plunges and leaves wide foam. Cover therefore also scales with period.
        const whitewater = Math.min(1, Math.pow(band.period / 10, 1.6));
        breaking.assign(max(breaking, smoothstep(0.65, 1.05, Hs.div(max(Hcap, 0.02))).mul(smoothstep(0.03, 1.5, H0).mul(0.6 * whitewater))));
        const H = min(Hs, Hcap);
        Hmain.assign(max(Hmain, Hs.mul(Math.min(1, Math.pow(band.period / 10, 1.6)))));
        const M = band.ratios.length;
        const inv = u.waveScale.reciprocal();
        band.ratios.forEach((r, m) => {
          // Short crests: a slow, quasi-random phase modulation per component (analytic gradient).
          const a1 = (m * 2.399 + b * 1.1) % TAU;
          const q1 = vec2(Math.cos(a1), Math.sin(a1)).mul((TAU / (band.period * 9.81 * 4)) * (0.8 + 0.3 * m));
          const a2 = (a1 + 2.1) % TAU;
          const q2 = vec2(Math.cos(a2), Math.sin(a2)).mul((TAU / (band.period * 9.81 * 7)) * (1.1 + 0.2 * m));
          const p1 = dot(pm, q1).add(m * 1.7);
          const p2 = dot(pm, q2).add(b * 2.3 + m);
          const beta = 1.4;
          const theta = sin(p1).mul(beta).add(sin(p2).mul(beta * 0.7));
          const gTheta = q1.mul(cos(p1).mul(beta)).add(q2.mul(cos(p2).mul(beta * 0.7)));
          const sRatio = 1 / Math.sqrt(r); // deep-water phase-speed ratio of a component r× the band's wavenumber
          // waveScale stretches the pattern horizontally (stated when ≠ 1); phase wrapped before sin/cos.
          const kv = grad.mul(omega * r).add(gTheta).mul(inv);
          const kmag = max(length(kv), 1e-5);
          const raw = T[ch].mul(omega * r).sub(u.time.mul(omega * r * sRatio)).add(theta).mul(inv).add(m * 2.17 + b * 0.61);
          const phase = fract(raw.div(TAU)).mul(TAU);
          const lambda = float(TAU).div(kmag);
          const fade = smoothstep(1.5, 4.0, lambda.div(footprint));
          const w = 1 / Math.sqrt(M) / (1 + 0.35 * m);
          const a0 = H.mul(0.5 * w);
          const a = a0.mul(fade);
          const sn = sin(phase);
          const cs = cos(phase);
          slope.addAssign(kv.mul(a.mul(sn).negate()));
          gerst.addAssign(a.mul(kmag).mul(cs).mul(0.6));
          const ak = a0.mul(kmag);
          variance.addAssign(ak.mul(ak).mul(float(1).sub(fade.mul(fade))).mul(0.5));
          if (m === 0) {
            crest.assign(max(crest, cs.mul(smoothstep(0.02, 0.3, H)).mul(valid[ch])));
            const top = H.mul(valid[ch]).greaterThan(surfH);
            surfPh.assign(select(top, phase.div(TAU), surfPh));
            surfCyc.assign(select(top, floor(raw.div(TAU)), surfCyc));
            surfRes.assign(select(top, fade, surfRes));
            surfH.assign(max(surfH, H.mul(valid[ch])));
          }
        });
      });

      // Normal (x east, z south): n = (−∂η/∂x, 1 − Gerstner crest term, −∂η/∂z).
      const N = normalize(vec3(slope.x.negate(), float(1).sub(gerst.min(0.6)), slope.y.negate()));
      const NdV = max(dot(N, V), 1e-3);
      const F = fresnel(NdV);
      const R = reflect(V.negate(), N);
      const skyR = sky(R);

      // Sun glitter: GGX with roughness from unresolved slope variance plus capillary roughness.
      // Capillary slope variance after Cox & Munk (σ² ≈ 0.003 + 0.005·U, here for U ≈ 4 m/s), scaled by gusts.
      const alpha = sqrt(float(0.012).mul(gust).mul(u.waveStrength).add(0.002).add(variance.mul(2))).min(0.6);
      const Hh = normalize(V.add(S));
      const NdL = max(dot(N, S), 0.0);
      const VdH = max(dot(V, Hh), 0.0);
      const Fs = fresnel(VdH);
      const k = alpha.mul(0.5);
      const G = NdV.div(NdV.mul(float(1).sub(k)).add(k)).mul(NdL.div(NdL.mul(float(1).sub(k)).add(k)));
      const specRaw = ggx(max(dot(N, Hh), 0.0), alpha).mul(Fs).mul(G).div(NdV.mul(4)).mul(sunUp);
      // Soft shoulder on the glitter so a broad, unresolved lobe does not flood the bloom (peak ≈ 6× the sun).
      const spec = specRaw.div(specRaw.div(6).add(1));

      // Water body: Beer–Lambert along the refracted path to the bottom and back up, plus single scattering by
      // water and sediment. Three water types blended by turbidity: open coast (clear, blue), the Central Bay
      // (green-grey), the far bays (San Pablo, Suisun, South Bay: olive, sediment-laden). Coefficients are softened
      // from the bay's real ones (Kd ≈ 1–3 /m) so the bottom shows through the first metre or two.
      const ocean = A.x; // swell reach: the open coast
      const reach = A.w; // marine reach over ≈ 12 km from the open sea
      const shallow = exp(depth.div(2.5).negate());
      const streak = mx_noise_float(vec3(pm.mul(vec2(1 / 5200, 1 / 2600)), 0.7)).mul(0.18).mul(float(1).sub(ocean));
      const turb = clamp(float(1).sub(reach.mul(0.7)).sub(ocean.mul(0.3)).add(shallow.mul(0.35)).add(streak), 0, 1.4);
      const tA = smoothstep(0.0, 0.5, turb);
      const tB = smoothstep(0.5, 1.0, turb);
      const sigma = mix(mix(col(0.45, 0.17, 0.15), col(0.75, 0.55, 0.55), tA), col(1.25, 1.0, 0.95), tB).mul(0.6);
      const scatterAlb = mix(mix(col(0.003, 0.011, 0.017), col(0.011, 0.02, 0.022), tA), col(0.026, 0.03, 0.021), tB);
      const bottomAlb = mix(col(0.15, 0.14, 0.11), col(0.05, 0.043, 0.034), tA); // sand outside, wet mud inside
      const cosT = sqrt(float(1).sub(float(1).sub(NdV.mul(NdV)).div(1.77)));
      const cosS = sqrt(float(1).sub(float(1).sub(S.y.mul(S.y)).div(1.77)));
      const path = depth.mul(float(1).div(cosT).add(float(1).div(max(cosS, 0.2))));
      const Tr = exp(sigma.mul(path).negate());
      const irr = sunCol.mul(max(S.y, 0.0)).mul(sunUp).add(ambSky.mul(1.2));
      const body = scatterAlb.mul(irr).mul(float(1).sub(Tr)).add(bottomAlb.mul(irr).mul(ao.mul(0.3).add(0.7)).mul(Tr));

      const c = skyR.mul(F).add(body.mul(float(1).sub(F))).add(sunCol.mul(spec)).toVar();

      // Foam: breaking (H > 0.78 d) on the crests, swash at the waterline, faint whitecaps on a strong sea.
      // Foam texture: bubbly noise when resolved, its mean coverage when not (no speckle at a distance).
      const fn = mx_noise_float(vec3(pm.mul(0.09), u.time.mul(0.15))).mul(0.5).add(0.5);
      const fn2 = mx_noise_float(vec3(pm.mul(0.31), u.time.mul(0.3).add(4.0))).mul(0.5).add(0.5);
      const resolved = float(1).sub(smoothstep(1.5, 6.0, footprint));
      const bubbles = mix(float(1), smoothstep(0.28, 0.7, fn.mul(0.6).add(fn2.mul(0.4))).mul(1.5), resolved);
      // Surf: foam lines are the bores just behind each breaking crest (phase just below a crest), fading behind;
      // unresolved, their mean cover.
      // Each crest breaks differently (hash of the crest number) and unevenly along its length (noise).
      const crestVar = hash(surfCyc.add(0.5)).mul(0.7).add(0.3);
      const along = mx_noise_float(vec3(pm.mul(1 / 70), surfCyc.mul(1.37))).mul(0.5).add(0.5);
      const bore = pow(fract(surfPh), 3.0).mul(smoothstep(0.25, 0.75, along).mul(crestVar)).mul(1.9).add(0.08);
      const lines = mix(float(0.45), bore, surfRes);
      const swashBand = float(1).sub(smoothstep(0.0, Hmain.mul(0.35).add(0.015), depth));
      const swash = swashBand.mul(mix(float(0.15), crest.mul(0.4).add(0.6), resolved)).mul(smoothstep(0.05, 0.6, Hmain)).mul(0.7);
      const breakFoam = breaking.mul(lines);
      // Muddy, sheltered flats take the waves' energy by friction before they break: little whitewater away from
      // the open coast.
      const exposure = mix(float(0.3), float(1), smoothstep(0.05, 0.5, ocean));
      const foam = clamp(max(breakFoam, swash).mul(bubbles).mul(exposure), 0, 1).mul(u.foam);
      const foamCol = col(0.8, 0.82, 0.82).mul(irr);
      c.assign(mix(c, foamCol, foam.mul(0.85)));
      water.assign(c);
    });

    const surf = mix(land, water, wet).toVar();
    If(u.debug.greaterThan(0.5), () => {
      surf.assign(select(u.debug.lessThan(2.5), mix(land.mul(0.3), dbg, wet), vec3(wet, clamp(depth.div(10), 0, 1), clamp(h.div(-30), 0, 1))));
    });
    // Haze with distance beyond hazeStart, then fade out at the edges of the data into the backdrop.
    const haze = float(1).sub(exp(max(dist.sub(u.hazeStart), 0).mul(u.hazeDensity).negate()));
    surf.assign(mix(surf, u.hazeColor, clamp(haze, 0, 0.85)));
    const ed = min(min(xz.x.sub(ex.x0), float(ex.x0 + ex.w).sub(xz.x)), min(xz.y.sub(ex.z0), float(ex.z0 + ex.d).sub(xz.y)));
    // Soft elliptical vignette in world space, so the rectangle of data dissolves into the backdrop.
    const rel = xz.sub(vec2(ex.x0 + ex.w / 2, ex.z0 + ex.d / 2)).div(vec2(ex.w / 2, ex.d / 2));
    const vign = float(1).sub(smoothstep(u.vignette, u.vignette.add(0.45), length(rel)));
    const edge = smoothstep(0.0, u.edgeFade, ed).mul(vign);
    return vec4(mix(backdrop(), surf, edge), 1);
  })();
  return mat;
}

/** tanh for positive arguments without overflow. */
function clampTanh(x: F): F {
  const e = exp(x.min(15).mul(-2));
  return float(1).sub(e).div(float(1).add(e));
}
