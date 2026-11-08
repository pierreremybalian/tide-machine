// The ocean's M2 tide on a globe (stage 3): EOT20's 1/2° overview as a texture of H·e^{iκ} (complex, so bilinear
// filtering is meaningful across phase wraps and amphidromes), times the ocean mask. Per pixel: amplitude and
// Greenwich phase lag κ; the tide now is H cos(V + u − κ) with V + u the M2 argument (a uniform). Drawn as luminous
// water that brightens where it is high, co-tidal lines every 30° of κ (one line per 1 h 2 min of M2), the crest of
// the wave (high water now) as a bright line, and land dark with a faint coast. Sphere: x = cos φ sin λ, y = sin φ,
// z = cos φ cos λ (radius 1).

import { DataTexture, HalfFloatType, LinearFilter, ClampToEdgeWrapping, Mesh, MeshBasicNodeMaterial, RGBAFormat, SphereGeometry } from 'three/webgpu';
import { Fn, abs, asin, atan, cameraPosition, clamp, cos, dot, exp, float, fract, fwidth, max, min, mix, normalize, smoothstep, step, texture, uniform, varying, vec2, vec3, vec4, attribute } from 'three/tsl';
import type { Texture } from 'three/webgpu';
import type { FloatUniform } from '../../render/globals.ts';
import { floatToHalf } from '../../coast/heightfield.ts';
import { interpolateTile, tileFor, type Eot20, type Eot20Tile } from '../../finale/eot20.ts';

const D2R = Math.PI / 180;

export interface Globe {
  mesh: Mesh;
  /** M2 argument V + u (degrees). */
  arg: FloatUniform;
  /** Co-tidal lines and crest strength (0–1). */
  lines: FloatUniform;
  crest: FloatUniform;
  dispose(): void;
}

/** Unit-sphere point for a latitude/longitude (degrees). */
export function onSphere(lat: number, lng: number, r = 1): [number, number, number] {
  const p = lat * D2R;
  const l = lng * D2R;
  return [r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l)];
}

/** M2 texture from the overview: RGBA16F = (H cos κ, H sin κ, ocean, 0), H in metres, rows from the south. */
function m2Texture(t: Eot20Tile): DataTexture {
  const c = t.names.indexOf('M2');
  const n = t.rows * t.cols;
  const data = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const k = t.ocean[i]!;
    if (k < 0) continue;
    const H = t.amp[c]![k]! / 1000;
    const kap = (t.pha[c]![k]! / 100) * D2R;
    data[i * 4] = floatToHalf(H * Math.cos(kap));
    data[i * 4 + 1] = floatToHalf(H * Math.sin(kap));
    data[i * 4 + 2] = floatToHalf(1);
  }
  const tex = new DataTexture(data, t.cols, t.rows, RGBAFormat, HalfFloatType);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** A finer patch of M2 (EOT20's native 1/8°) where the camera comes close (the West Coast). */
export interface M2Patch {
  lat0: number;
  lng0: number;
  step: number;
  rows: number;
  cols: number;
  /** RGBA16F bits: (H cos κ, H sin κ, ocean, 0), rows from the south. */
  data: Uint16Array;
}

/** Load EOT20's tiles over a box and resample M2 at 1/8° (thinned open ocean from its 1/4° lattice; land = 0). */
export async function loadPatch(eot: Eot20, south: number, west: number, north: number, east: number): Promise<M2Patch> {
  const step = 1 / 8;
  const names = new Set<string>();
  for (let la = south; la < north; la += 10) for (let lo = west; lo < east; lo += 10) names.add(tileFor(la + 0.01, lo + 0.01));
  const tiles = new Map<string, Eot20Tile | null>();
  await Promise.all([...names].map(async (n) => tiles.set(n, await eot.tile(n))));
  const rows = Math.round((north - south) / step) + 1;
  const cols = Math.round((east - west) / step) + 1;
  const data = new Uint16Array(rows * cols * 4);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      // Nudge inside the tile so shared edges resolve to one tile.
      const lat = Math.min(south + r * step, north - 1e-6);
      const lng = Math.min(west + c * step, east - 1e-6);
      const t = tiles.get(tileFor(lat, lng));
      if (!t) continue;
      const smp = interpolateTile(t, lat, lng, ['M2']);
      if (!smp || smp.method !== 'bilinear') continue;
      const m2 = smp.constituents[0];
      if (!m2) continue;
      const i = (r * cols + c) * 4;
      data[i] = floatToHalf(m2.amplitude * Math.cos(m2.phase * D2R));
      data[i + 1] = floatToHalf(m2.amplitude * Math.sin(m2.phase * D2R));
      data[i + 2] = floatToHalf(1);
    }
  return { lat0: south, lng0: west, step, rows, cols, data };
}

function patchTexture(p: M2Patch): DataTexture {
  const tex = new DataTexture(p.data, p.cols, p.rows, RGBAFormat, HalfFloatType);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export function createGlobe(overview: Eot20Tile, patch: M2Patch, segments = 192): Globe {
  const tex = m2Texture(overview);
  const ptex = patchTexture(patch);
  const arg = uniform(0);
  const lines = uniform(0);
  const crest = uniform(0);
  const mat = new MeshBasicNodeMaterial();
  const p = varying(attribute('position', 'vec3'), 'vGlobeP');
  const { lat0, lng0, step: st, rows, cols } = overview;

  mat.colorNode = Fn(() => {
    const n = normalize(p);
    const lat = asin(clamp(n.y, -1, 1)).div(D2R);
    const lng = atan(n.x, n.z).div(D2R);
    const uv = vec2(lng.sub(lng0).div(st).add(0.5).div(cols), lat.sub(lat0).div(st).add(0.5).div(rows));
    const g4 = texture(tex as Texture, uv);
    // The finer patch where it exists, blended over its outer degree.
    const puv = vec2(lng.sub(patch.lng0).div(patch.step).add(0.5).div(patch.cols), lat.sub(patch.lat0).div(patch.step).add(0.5).div(patch.rows));
    const p4 = texture(ptex as Texture, puv);
    const spanX = (patch.cols - 1) * patch.step;
    const spanY = (patch.rows - 1) * patch.step;
    const ix = lng.sub(patch.lng0);
    const iy = lat.sub(patch.lat0);
    const dIn = min(min(ix, float(spanX).sub(ix)), min(iy, float(spanY).sub(iy)));
    const wP = smoothstep(0.2, 1.2, dIn);
    const t4 = mix(g4, p4, wP);
    const m = t4.z;
    const ocean = smoothstep(0.35, 0.65, m);
    const z = t4.xy.div(max(m, 0.02));
    const H = z.length();
    // radians, −π … π (offset so atan2(0, 0) never occurs on land)
    const kap = atan(z.y, z.x.add(1e-6));
    const phi = arg.mul(D2R).sub(kap);
    const c = cos(phi);
    // Amplitude response: 0 at an amphidrome, saturating toward a metre.
    const a = float(1).sub(exp(H.div(0.35).negate()));

    // Water: deep blue, glowing where the tide stands high now.
    const high = c.mul(0.5).add(0.5);
    const deep = vec3(0.006, 0.016, 0.04);
    const h2 = high.mul(high);
    const glow = vec3(0.06, 0.4, 0.7).mul(h2.mul(h2)).mul(a.mul(0.55).add(0.05));
    const low = vec3(0.0, 0.0, 0.02).mul(float(1).sub(high));
    const water = deep.add(glow).add(low).toVar();

    // Co-tidal lines: equal κ every 30°.
    const q = kap.div(30 * D2R);
    const fq = fwidth(q);
    const dq = abs(fract(q.add(0.5)).sub(0.5));
    const cot = float(1).sub(smoothstep(fq.mul(0.6), fq.mul(1.6), dq)).mul(float(1).sub(step(1.5, fq))).mul(smoothstep(0.02, 0.08, H));
    water.addAssign(vec3(0.4, 0.7, 1.0).mul(cot).mul(lines).mul(0.14));

    // The crest: high water now (φ ≡ 0), a bright line that sweeps around the amphidromes.
    const wrapped = abs(fract(phi.div(2 * Math.PI).add(0.5)).sub(0.5)).mul(2 * Math.PI);
    const wq = wrapped.div(0.06);
    const fp = max(fwidth(phi), 1e-4);
    const thin = float(1).sub(smoothstep(fp.mul(0.6), fp.mul(1.8), wrapped)).mul(float(1).sub(step(1.0, fp)));
    const crestLine = exp(wq.mul(wq).negate()).mul(0.35).add(thin).mul(smoothstep(0.03, 0.12, H));
    water.addAssign(vec3(0.7, 0.93, 1.0).mul(crestLine).mul(crest).mul(0.8));

    // Land, with a faint coast.
    const fm = max(fwidth(m), 1e-4);
    const coast = float(1).sub(smoothstep(fm.mul(0.5), fm.mul(2.5), abs(m.sub(0.5))));
    const land = vec3(0.009, 0.011, 0.016);
    const surf = mix(land, water, ocean).add(vec3(0.35, 0.55, 0.7).mul(coast).mul(0.35)).toVar();

    // Graticule every 30°, very faint.
    const gq = vec2(lat, lng).div(30);
    const gw = fwidth(gq);
    const gd = abs(fract(gq.add(0.5)).sub(0.5));
    const grid = max(float(1).sub(smoothstep(gw.x.mul(0.5), gw.x.mul(1.5), gd.x)), float(1).sub(smoothstep(gw.y.mul(0.5), gw.y.mul(1.5), gd.y)));
    surf.addAssign(vec3(0.5, 0.6, 0.8).mul(grid).mul(0.03));

    // Atmosphere rim.
    const V = normalize(cameraPosition.sub(p));
    const ndv = clamp(dot(n, V), 0, 1);
    const rim = float(1).sub(ndv);
    surf.addAssign(vec3(0.1, 0.24, 0.5).mul(rim.mul(rim).mul(rim)).mul(0.3));
    return vec4(min(surf, vec3(4)), 1);
  })();

  const geometry = new SphereGeometry(1, segments, segments / 2);
  const mesh = new Mesh(geometry, mat);
  return {
    mesh,
    arg,
    lines,
    crest,
    dispose() {
      geometry.dispose();
      mat.dispose();
      tex.dispose();
      ptex.dispose();
    },
  };
}

/** Open-ocean M2 amphidromes in the overview: cells around which κ winds a full turn, far from land and from each other. */
export function amphidromes(t: Eot20Tile, landCells = 6, minSepDeg = 4): { lat: number; lng: number }[] {
  const c = t.names.indexOf('M2');
  const pha = (r: number, k: number) => {
    const i = t.ocean[r * t.cols + k]!;
    return i < 0 ? null : t.pha[c]![i]! / 100;
  };
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const found: { lat: number; lng: number; w: number }[] = [];
  for (let r = landCells; r < t.rows - 1 - landCells; r++)
    for (let k = 0; k < t.cols - 1; k++) {
      const q = [pha(r, k), pha(r, k + 1), pha(r + 1, k + 1), pha(r + 1, k)];
      if (q.some((x) => x === null)) continue;
      let w = 0;
      for (let j = 0; j < 4; j++) w += wrap(q[(j + 1) % 4]! - q[j]!);
      if (Math.abs(w) < 300) continue;
      let land = false;
      for (let dr = -landCells; dr <= landCells && !land; dr++)
        for (let dk = -landCells; dk <= landCells; dk++) {
          const kk = (k + dk + t.cols) % t.cols;
          if (t.ocean[(r + dr) * t.cols + kk]! < 0) {
            land = true;
            break;
          }
        }
      if (!land) found.push({ lat: t.lat0 + (r + 0.5) * t.step, lng: t.lng0 + (k + 0.5) * t.step, w: Math.sign(w) });
    }
  // Opposite windings close together are a numerical pair, not an amphidrome: drop both.
  return found
    .filter((a) => !found.some((b) => b !== a && b.w !== a.w && Math.hypot(b.lat - a.lat, b.lng - a.lng) < minSepDeg))
    .map(({ lat, lng }) => ({ lat, lng }));
}
