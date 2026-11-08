// Multi-view rendering into one scene target (HANDOFF §8.10): diptych, quadtych and the loupe inset. Panels use
// fractions of the target with a top-left origin (same as LabelSet panels). Between panels the caller updates the
// view/reality uniforms. The target is cleared once; each panel clears depth only.

import { Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, Scene, type Camera, type PerspectiveCamera, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import { float, uniform, uv, vec3, exp, min, max } from 'three/tsl';
import type { Panel } from './labels.ts';

export function renderPanels(
  renderer: WebGPURenderer,
  target: RenderTarget,
  scene: Scene,
  camera: PerspectiveCamera,
  panels: readonly Panel[],
  before: (i: number) => void,
  afterEach?: (i: number, panel: Panel) => void,
): void {
  const W = target.width;
  const H = target.height;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  const auto = renderer.autoClear;
  renderer.autoClear = false;
  const aspect0 = camera.aspect;
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]!;
    const x = Math.round(p.x * W);
    const y = Math.round(p.y * H);
    const w = Math.max(1, Math.round(p.w * W));
    const h = Math.max(1, Math.round(p.h * H));
    target.viewport.set(x, y, w, h);
    target.scissor.set(x, y, w, h);
    renderer.setScissorTest(true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    before(i);
    renderer.clearDepth();
    renderer.render(scene, camera);
    afterEach?.(i, p);
  }
  renderer.setScissorTest(false);
  target.viewport.set(0, 0, W, H);
  target.scissor.set(0, 0, W, H);
  renderer.autoClear = auto;
  camera.aspect = aspect0;
  camera.updateProjectionMatrix();
}

/** A dark rounded backdrop + frame drawn into a panel (for the loupe inset). Render it with renderInPanel. */
export function createPanelFrame(colour: [number, number, number] = [0.9, 0.9, 1]) {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const opacity = uniform(1);
  const aspect = uniform(1);
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  const p = uv().sub(0.5).mul(2);
  const ax = p.x.abs().mul(aspect);
  const ay = p.y.abs();
  const dEdge = min(aspect.sub(ax), float(1).sub(ay));
  const frame = exp(dEdge.mul(160).abs().pow(2).negate());
  const shade = float(0.9);
  mat.colorNode = vec3(colour[0], colour[1], colour[2]).mul(frame.mul(0.9));
  mat.opacityNode = max(shade, frame).mul(opacity);
  const quad = new Mesh(new PlaneGeometry(2, 2), mat);
  scene.add(quad);
  return {
    scene,
    camera,
    opacity,
    aspect,
    dispose() {
      quad.geometry.dispose();
      mat.dispose();
    },
  };
}

/** Render `scene` with `camera` into a sub-rectangle of the current target (no clear). */
export function renderInPanel(renderer: WebGPURenderer, target: RenderTarget, scene: Scene, camera: Camera, p: Panel): void {
  const W = target.width;
  const H = target.height;
  const x = Math.round(p.x * W);
  const y = Math.round(p.y * H);
  const w = Math.max(1, Math.round(p.w * W));
  const h = Math.max(1, Math.round(p.h * H));
  target.viewport.set(x, y, w, h);
  target.scissor.set(x, y, w, h);
  renderer.setScissorTest(true);
  const auto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = auto;
  renderer.setScissorTest(false);
  target.viewport.set(0, 0, W, H);
  target.scissor.set(0, 0, W, H);
}

