// createCoast: terrain + tidal water + waves for one region, driven by the real tide field (HANDOFF §8.1–8.2).
//
//   const coast = await createCoast(ctx, { region: 'sf', exaggeration: 3 });
//   scene.add(coast.object);
//   coast.update(msUTC, waveSeconds);   // every frame; no allocation
//   coast.dispose();
//
// World units (HANDOFF §5): x east, y up, z south, 1 unit = 1 km; heights are metres × exaggeration / 1000.
// Every water level comes from src/tides/predict.ts through src/coast/tidefield.ts (NAVD88).

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  RGBAFormat,
  RGFormat,
  Vector3,
} from 'three/webgpu';
import type { RenderContext } from '../../scenes/types.ts';
import { floatToHalf, projection, sampleGrid, worldExtent, cellMetres, type Projection } from '../../coast/heightfield.ts';
import { createTideField, fillLevels, type FieldWeights, type TideField } from '../../coast/tidefield.ts';
import { gridPoints, type BakeOptions, type CoastBake } from '../../coast/bake.ts';
import type { WaveBand } from '../../coast/waves.ts';
import { bakeSource, loadCoastSource, type CoastSource } from './data.ts';
import { createCoastMaterial, createCoastUniforms, type CoastUniforms, type Extent } from './material.ts';
import { createBackdropMesh, createSkyUniforms, sunDirection, type SkyUniforms } from './sky.ts';

export interface CoastWaves {
  /** Direction the swell travels toward (degrees from north) and its period (s). */
  swellToward: number;
  swellPeriod: number;
  /** Direction the wind blows toward (degrees from north); the wind sea and chop follow it. */
  windToward: number;
}

export interface CoastOptions {
  /** Baked region id ('sf', 'nyc'), or a ready source (finale). */
  region?: string;
  source?: CoastSource;
  /** Vertical exaggeration of relief and water level (×); a uniform, always stated. */
  exaggeration?: number;
  waves?: Partial<CoastWaves>;
  /** Sun azimuth/elevation (degrees). */
  sun?: { azimuth: number; elevation: number };
  /** Grid cells along the longer side (default from the quality tier). */
  meshCells?: number;
  /** Concentrate mesh vertices around a point (km): density × (1 + gain) within ≈ radius. */
  focus?: { x: number; z: number; radius: number; gain: number };
  /** Draw the dark backdrop behind the coast (default true; the material fades its edges into it). */
  backdrop?: boolean;
  /** Same, by latitude/longitude and radius (km), gain 8. */
  focusLatLng?: { lat: number; lng: number; radius: number; gain?: number };
}

export interface Coast {
  object: Group;
  uniforms: CoastUniforms;
  sky: SkyUniforms;
  field: TideField;
  projection: Projection;
  /** World rectangle (km). */
  extent: Extent;
  /** Station levels (m NAVD88) at the last update, in field.stations order. */
  stationLevels: Float64Array;
  /** Terrain height (m NAVD88) at a world point. */
  heightAt(x: number, z: number): number;
  /** Interpolated water level (m NAVD88) at a world point, from the last update. */
  levelAt(x: number, z: number): number;
  /** Whether a world point is under tidal water at the last update. */
  wetAt(x: number, z: number): boolean;
  /** Rendered y (km) for a height in metres. */
  y(metres: number): number;
  /** Set the tide time (ms UTC) and the wave clock (s). */
  update(ms: number, waveSeconds: number): void;
  setSun(azimuthDeg: number, elevationDeg: number): void;
  dispose(): void;
}

/** Spill height (m) stored for never-tidal cells: above the highest tide and surge we show (Sandy: 3.4 m NAVD88). */
const NEVER_WET = 5;

const DEFAULT_WAVES: CoastWaves = { swellToward: 100, swellPeriod: 11, windToward: 110 };

/** Bake options shared by every coast (cache key: keep stable). */
export function bakeOptionsFor(w: CoastWaves): BakeOptions {
  const bands: WaveBand[] = [
    { period: w.swellPeriod, toward: w.swellToward, source: 'ocean', scale: 1800 },
    { period: 4.5, toward: w.windToward - 5, source: 'shore', scale: 9000 },
    { period: 2.4, toward: w.windToward, source: 'shore', scale: 1500 },
  ];
  return { bands, waveDown: 2, fieldDown: 10 };
}

// CPU texture payloads derived from a bake, shared across scene reloads.
const payloads = new WeakMap<CoastBake, { terrain: Uint16Array; classes: Uint16Array; wave: Float32Array; amp: Uint16Array }>();

function payloadFor(src: CoastSource, bake: CoastBake) {
  let p = payloads.get(bake);
  if (p) return p;
  const n = src.hf.nx * src.hf.ny;
  const terrain = new Uint16Array(n * 4);
  const classes = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    classes[i * 2] = floatToHalf(bake.pondSdf[i]!);
    classes[i * 2 + 1] = floatToHalf(bake.dikedSdf[i]!);
    terrain[i * 4] = src.halfBits[i]!;
    // Never-tidal cells (diked land, ponds) get a spill height just above any tide, not ∞: the bilinear filter then
    // draws a smooth waterline along levees instead of a staircase of texels.
    const e = bake.spill[i]!;
    terrain[i * 4 + 1] = floatToHalf(Number.isFinite(e) ? e : Math.max(src.hf.data[i]!, NEVER_WET));
    terrain[i * 4 + 2] = floatToHalf(bake.ao[i]!);
    terrain[i * 4 + 3] = 0;
  }
  const wn = bake.wave.nx * bake.wave.ny;
  const wave = new Float32Array(wn * 4);
  const amp = new Uint16Array(wn * 4);
  for (let i = 0; i < wn; i++) {
    for (let b = 0; b < 3; b++) {
      wave[i * 4 + b] = bake.wave.T[b]?.[i] ?? -1;
      amp[i * 4 + b] = floatToHalf(bake.wave.amp[b]?.[i] ?? 0);
    }
    wave[i * 4 + 3] = 0;
    amp[i * 4 + 3] = floatToHalf(bake.wave.reach[i] ?? 0);
  }
  p = { terrain, classes, wave, amp };
  payloads.set(bake, p);
  return p;
}

function dataTexture(
  data: Uint16Array | Float32Array,
  w: number,
  h: number,
  type: typeof HalfFloatType | typeof FloatType,
  linear: boolean,
  format: typeof RGBAFormat | typeof RGFormat = RGBAFormat,
): DataTexture {
  const t = new DataTexture(data, w, h, format, type);
  t.minFilter = t.magFilter = linear ? LinearFilter : NearestFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Monotonic warp of [0, 1] that packs samples around f (density 1 + gain within ≈ σ). */
function warpTable(f: number, sigma: number, gain: number): (u: number) => number {
  const N = 2048;
  const F = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const x = (i - 0.5) / N;
    F[i] = F[i - 1]! + 1 + gain * Math.exp(-(((x - f) / sigma) ** 2));
  }
  const tot = F[N]!;
  return (u: number) => {
    const target = u * tot;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid]! < target) lo = mid;
      else hi = mid;
    }
    const t = (target - F[lo]!) / Math.max(F[hi]! - F[lo]!, 1e-12);
    return (lo + t) / N;
  };
}

function buildGrid(src: CoastSource, ext: ReturnType<typeof worldExtent>, cells: number, focus?: CoastOptions['focus']): BufferGeometry {
  const aspect = ext.width / ext.depth;
  const nx = Math.max(8, Math.round(aspect >= 1 ? cells : cells * aspect));
  const nz = Math.max(8, Math.round(aspect >= 1 ? cells / aspect : cells));
  const wx = focus ? warpTable((focus.x - ext.x0) / ext.width, focus.radius / ext.width, focus.gain) : (u: number) => u;
  const wz = focus ? warpTable((focus.z - ext.z0) / ext.depth, focus.radius / ext.depth, focus.gain) : (u: number) => u;
  const hf = src.hf;
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  let o = 0;
  for (let j = 0; j <= nz; j++) {
    const v = wz(j / nz);
    const z = ext.z0 + v * ext.depth;
    const gy = v * hf.ny - 0.5;
    for (let i = 0; i <= nx; i++) {
      const u = wx(i / nx);
      const x = ext.x0 + u * ext.width;
      pos[o++] = x;
      pos[o++] = sampleGrid(hf.data, hf.nx, hf.ny, u * hf.nx - 0.5, gy) / 1000;
      pos[o++] = z;
    }
  }
  const idx = new Uint32Array(nx * nz * 6);
  o = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // Alternate the diagonal for a more isotropic surface.
      if ((i + j) & 1) idx.set([a, c, b, b, c, d], o);
      else idx.set([a, c, d, a, d, b], o);
      o += 6;
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export async function createCoast(ctx: RenderContext, opts: CoastOptions): Promise<Coast> {
  const src = opts.source ?? (await loadCoastSource(ctx.assets, opts.region ?? 'sf'));
  const waves = { ...DEFAULT_WAVES, ...opts.waves };
  const bakeOpts = bakeOptionsFor(waves);
  const bake = await bakeSource(src, bakeOpts);
  const hf = src.hf;
  const proj = projection(hf.bbox);
  const ext = worldExtent(hf.bbox);
  const extent: Extent = { x0: ext.x0, z0: ext.z0, w: ext.width, d: ext.depth };
  // Sub-grids (field, waves) in the terrain's projection.
  const extOf = (b: typeof hf.bbox): Extent => {
    const x0 = proj.x(b.west);
    const z0 = proj.z(b.north);
    return { x0, z0, w: proj.x(b.east) - x0, d: proj.z(b.south) - z0 };
  };

  // Tide field with water-path detours, and its per-frame grid.
  const field = createTideField(src.stations, { bbox: hf.bbox, detour: bake.detour });
  const fg = bake.field;
  const weights: FieldWeights = field.weights(gridPoints(fg, hf.bbox));
  const nF = fg.nx * fg.ny;
  const levelData = new Uint16Array(nF * 4);
  const levelNow = new Float32Array(nF);
  const levelMax = new Float32Array(nF);
  const stationLevels = new Float64Array(field.stations.length);
  const stationMax = new Float64Array(field.stations.length);
  const stationTmp = new Float64Array(field.stations.length);
  const rateField = new Float32Array(nF);
  for (let i = 0; i < nF; i++) levelData[i * 4 + 3] = floatToHalf(fg.meanLevel[i]!);

  // Textures.
  const pay = payloadFor(src, bake);
  const terrainTex = dataTexture(pay.terrain, hf.nx, hf.ny, HalfFloatType, true);
  const classTex = dataTexture(pay.classes, hf.nx, hf.ny, HalfFloatType, true, RGFormat);
  const levelTex = dataTexture(levelData, fg.nx, fg.ny, HalfFloatType, true);
  const waveTex = dataTexture(pay.wave, bake.wave.nx, bake.wave.ny, FloatType, false);
  const ampTex = dataTexture(pay.amp, bake.wave.nx, bake.wave.ny, HalfFloatType, true);

  const sunAz = opts.sun?.azimuth ?? 245;
  const sunEl = opts.sun?.elevation ?? 16;
  const sky = createSkyUniforms({
    sunDir: sunDirection(sunAz, sunEl),
    sunColor: new Color(2.45, 2.2, 1.85),
    zenith: new Color(0.07, 0.12, 0.24),
    horizon: new Color(0.3, 0.31, 0.33),
  });
  const uniforms = createCoastUniforms();
  uniforms.exaggeration.value = opts.exaggeration ?? 3;

  const [cx, cz] = cellMetres(hf);
  const tier = ctx.quality;
  const ratiosFor = (n: number, base: number[]) => base.slice(0, n);
  const per = tier.name === 'low' ? 2 : tier.name === 'medium' ? 3 : 4;
  const material = createCoastMaterial(
    {
      terrain: terrainTex,
      classes: classTex,
      terrainExt: extent,
      terrainCell: [cx, cz],
      level: levelTex,
      levelExt: extOf(fg.bbox),
      wave: waveTex,
      waveExt: extOf(bake.wave.bbox),
      waveSize: [bake.wave.nx, bake.wave.ny],
      waveCell: [bake.wave.dx, bake.wave.dy],
      amp: ampTex,
      bands: [
        { period: waves.swellPeriod, ratios: ratiosFor(per, [1, 1.37, 0.79, 1.83]) },
        { period: 4.5, ratios: ratiosFor(per, [1, 1.29, 0.83, 1.71]) },
        { period: 2.4, ratios: ratiosFor(per, [1, 1.41, 2.13, 3.07]) },
      ],
      sky,
      extent,
      windToward: waves.windToward,
      shadowSteps: tier.name === 'low' ? 10 : tier.name === 'medium' ? 18 : 24,
    },
    uniforms,
  );
  const cells = opts.meshCells ?? Math.round(600 * tier.detail);
  const fl = opts.focusLatLng;
  const focus = opts.focus ?? (fl ? { x: proj.x(fl.lng), z: proj.z(fl.lat), radius: fl.radius, gain: fl.gain ?? 8 } : undefined);
  const geometry = buildGrid(src, ext, cells, focus);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const object = new Group();
  object.add(mesh);
  const backdropMesh = opts.backdrop === false ? null : createBackdropMesh();
  if (backdropMesh) object.add(backdropMesh);

  const HISTORY_H = 3;
  const HISTORY_STEPS = 6;
  let lastMs = NaN;
  const extF = extOf(fg.bbox);

  const coast: Coast = {
    object,
    uniforms,
    sky,
    field,
    projection: proj,
    extent,
    stationLevels,
    heightAt(x, z) {
      return sampleGrid(hf.data, hf.nx, hf.ny, ((x - extent.x0) / extent.w) * hf.nx - 0.5, ((z - extent.z0) / extent.d) * hf.ny - 0.5);
    },
    levelAt(x, z) {
      return sampleGrid(levelNow, fg.nx, fg.ny, ((x - extF.x0) / extF.w) * fg.nx - 0.5, ((z - extF.z0) / extF.d) * fg.ny - 0.5);
    },
    wetAt(x, z) {
      const e = sampleGrid(bake.spill, hf.nx, hf.ny, ((x - extent.x0) / extent.w) * hf.nx - 0.5, ((z - extent.z0) / extent.d) * hf.ny - 0.5);
      return coast.levelAt(x, z) > e;
    },
    y(m) {
      return (m * uniforms.exaggeration.value) / 1000;
    },
    update(ms, waveSeconds) {
      // Wave clock wrapped (precision); the jump once every half hour is invisible under the foam and glitter.
      uniforms.time.value = waveSeconds % 1800;
      if (ms === lastMs) return;
      lastMs = ms;
      field.levels(ms, stationLevels);
      stationMax.set(stationLevels);
      for (let k = 1; k <= HISTORY_STEPS; k++) {
        field.levels(ms - (k * HISTORY_H * 3600e3) / HISTORY_STEPS, stationTmp);
        for (let j = 0; j < stationMax.length; j++) if (stationTmp[j]! > stationMax[j]!) stationMax[j] = stationTmp[j]!;
      }
      fillLevels(weights, stationLevels, levelNow);
      fillLevels(weights, stationMax, levelMax);
      field.levels(ms - 600e3, stationTmp);
      for (let i = 0; i < nF; i++) {
        levelData[i * 4] = floatToHalf(levelNow[i]!);
        levelData[i * 4 + 1] = floatToHalf(levelMax[i]!);
      }
      // Rate (m/h) in B, interpolated from the stations' 10-minute change.
      for (let j = 0; j < stationTmp.length; j++) stationTmp[j] = (stationLevels[j]! - stationTmp[j]!) * 6;
      fillLevels(weights, stationTmp, rateField);
      for (let i = 0; i < nF; i++) levelData[i * 4 + 2] = floatToHalf(rateField[i]!);
      levelTex.needsUpdate = true;
    },
    setSun(az, el) {
      sunDirection(az, el, sky.sunDir.value as Vector3);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      if (backdropMesh) {
        backdropMesh.geometry.dispose();
        (backdropMesh.material as MeshBasicNodeMaterial).dispose();
      }
      terrainTex.dispose();
      classTex.dispose();
      levelTex.dispose();
      waveTex.dispose();
      ampTex.dispose();
    },
  };
  return coast;
}
