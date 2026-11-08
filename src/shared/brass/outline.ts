// The luminous technical-drawing look (HANDOFF §8.3): a TSL port of Watch Academy's outline renderer
// (../watch-academy/src/gfx/{Renderer,shaders}.ts). The solids render once into a G-buffer through three's pass()
// with mrt(): colour (the dark fill), view-space normal, and an ident vector (part id, line gain, highlight, fill) per
// pixel, plus depth. The composite finds edges (Roberts cross on linear depth, normal creases, part-id changes) and
// draws them as warm brass lines over the subtle fill, in linear HDR so the compositor's bloom lifts the brightest.
// Luminous overlays (the wire, the pen's trace) render after it, additively, into the same target.

import { NodeMaterial, QuadMesh, Vector2, type Camera, type RenderTarget, type Scene, type WebGPURenderer } from 'three/webgpu';
import {
  abs,
  dot,
  float,
  Fn,
  length,
  max,
  mix,
  mrt,
  normalView,
  normalize,
  output,
  perspectiveDepthToViewZ,
  pass,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { BRASS, type FloatU } from './material.ts';
import type { RGB } from '../gfx/palette.ts';

type V2 = Node<'vec2'>;

export interface OutlineOptions {
  /** Line colour (default brass #e6b866), linear RGB. */
  line?: RGB;
  /** Line brightness multiplier (HDR). */
  lineGain?: number;
  /** Line width in pixels at DPR 1. */
  linePx?: number;
  /** Background colour at the top and bottom of the frame. */
  bgTop?: RGB;
  bgBottom?: RGB;
  /** Pass resolution relative to the drawing buffer (match the quality tier's renderScale). */
  resolutionScale?: number;
}

export interface Outline {
  /** Draw solids (via the G-buffer) and then the overlay scene into target. */
  render(target: RenderTarget | null, overlay?: Scene | null): void;
  setSize(width: number, height: number, dpr: number): void;
  readonly gain: FloatU;
  dispose(): void;
}

export function createOutline(renderer: WebGPURenderer, scene: Scene, camera: Camera & { near: number; far: number }, o: OutlineOptions = {}): Outline {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: vec4(normalize(normalView), 1), ident: vec4(0) }));
  scenePass.setResolutionScale(o.resolutionScale ?? 1);
  const tOut = scenePass.getTextureNode('output');
  const tNormal = scenePass.getTextureNode('normal');
  const tIdent = scenePass.getTextureNode('ident');
  const tDepth = scenePass.getTextureNode('depth');

  const uTexel = uniform(new Vector2(1 / 1280, 1 / 720));
  const uLinePx = uniform((o.linePx ?? 1.2) * 1);
  const uNear = uniform(0.02);
  const uFar = uniform(400);
  const gain = uniform(o.lineGain ?? 1.6);
  const lc = o.line ?? BRASS;
  const lineColour = vec3(lc[0], lc[1], lc[2]);
  const top = o.bgTop ?? [0.006, 0.007, 0.012];
  const bottom = o.bgBottom ?? [0.002, 0.002, 0.004];

  const linZ = (p: V2) => perspectiveDepthToViewZ(tDepth.sample(p).x, uNear, uFar).negate();
  const cover = (p: V2) => step(tDepth.sample(p).x, 0.99999);
  const nrm = (p: V2) => tNormal.sample(p).xyz;

  const composite = Fn(() => {
    const p = uv();
    const px = uTexel.mul(uLinePx.mul(0.5));
    const cov = cover(p);
    const d0 = linZ(p);
    const n0 = nrm(p);
    const id0 = tIdent.sample(p);
    // Depth: Roberts cross, relative to distance, stricter on faces seen edge-on.
    const o1 = vec2(px.x, px.y);
    const o2 = vec2(px.x, px.y.negate());
    const g = length(vec2(linZ(p.sub(o1)).sub(linZ(p.add(o1))), linZ(p.sub(o2)).sub(linZ(p.add(o2)))));
    const ndv = abs(n0.z).mul(cov);
    const tD = float(0.0025).mul(float(1).add(float(3).mul(float(1).sub(ndv))));
    const eD = smoothstep(tD, tD.mul(2.2), g.div(max(d0, 1e-3)));
    // Normals and part ids over a cross; carry the brightest line gain and highlight found in the kernel so
    // silhouette pixels just outside a part still take its colour.
    const eN = float(0).toVar();
    const eI = float(0).toVar();
    const lineK = id0.y.mul(cov).toVar();
    const hotK = id0.z.mul(cov).toVar();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const q = p.add(vec2(px.x.mul(dx), px.y.mul(dy)));
      const c1 = cover(q);
      const id1 = tIdent.sample(q);
      eN.assign(max(eN, float(1).sub(dot(n0, nrm(q))).mul(c1).mul(cov)));
      eI.assign(max(eI, step(0.5, abs(id0.x.sub(id1.x))).mul(c1).mul(cov)));
      lineK.assign(max(lineK, id1.y.mul(c1)));
      hotK.assign(max(hotK, id1.z.mul(c1)));
    }
    const crease = float(1 - Math.cos((30 * Math.PI) / 180));
    const e = max(max(eD, smoothstep(crease, crease.mul(1.8), eN)), eI);
    // Background: a faint vertical gradient.
    const bg = mix(vec3(bottom[0], bottom[1], bottom[2]), vec3(top[0], top[1], top[2]), p.y);
    const fill = tOut.sample(p).rgb;
    const hotCol = mix(lineColour, vec3(1.0, 0.8, 0.5), hotK.min(1).mul(0.6));
    const lineC = hotCol.mul(e).mul(lineK).mul(gain).mul(float(1).add(hotK.mul(0.45)));
    return vec4(mix(bg, fill, cov).add(lineC), 1);
  })();

  const mat = new NodeMaterial();
  mat.fragmentNode = composite;
  mat.depthTest = false;
  mat.depthWrite = false;
  const quad = new QuadMesh(mat);

  return {
    gain,
    render(target, overlay) {
      uNear.value = camera.near;
      uFar.value = camera.far;
      renderer.setRenderTarget(target);
      quad.render(renderer);
      if (overlay) {
        const auto = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(overlay, camera);
        renderer.autoClear = auto;
      }
    },
    setSize(width, height, dpr) {
      uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
      uLinePx.value = (o.linePx ?? 1.2) * Math.max(1, dpr);
    },
    dispose() {
      scenePass.dispose();
      // QuadMesh geometry is shared by every quad in three; never dispose it.
      mat.dispose();
    },
  };
}
