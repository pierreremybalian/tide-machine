// The Loupe (HANDOFF §9): a picture-in-picture magnifier. The same scene is drawn into an inset panel with the kit's
// anisotropic loupe scale applied about a focus point, so a four-day or half-microsecond gap becomes visible while
// the main view stays honest. The scale factor is shown on screen by the scene (a label), never hidden.

import type { PerspectiveCamera, RenderTarget, Scene, WebGPURenderer } from 'three/webgpu';
import type { BlockKit } from './kit.ts';
import type { Panel } from './labels.ts';
import { createPanelFrame, renderInPanel } from './panels.ts';

export interface LoupeView {
  /** Spacetime point the loupe magnifies about (display layout x, t, y). */
  focus: [number, number, number];
  /** Scale per axis (x, t, y). */
  stretch: [number, number, number];
  /** Translation applied after scaling (to recentre). */
  offset?: [number, number, number];
}

export interface Loupe {
  /** 0–1 overall visibility of the inset. */
  opacity: number;
  render(renderer: WebGPURenderer, target: RenderTarget, scene: Scene, camera: PerspectiveCamera, panel: Panel, kit: BlockKit, view: LoupeView): void;
  dispose(): void;
}

export function createLoupe(colour: [number, number, number] = [0.85, 0.88, 1]): Loupe {
  const frame = createPanelFrame(colour);
  const loupe: Loupe = {
    opacity: 1,
    render(renderer, target, scene, camera, panel, kit, view) {
      if (loupe.opacity <= 0.002) return;
      const W = target.width;
      const H = target.height;
      frame.opacity.value = loupe.opacity;
      frame.aspect.value = (panel.w * W) / Math.max(1, panel.h * H);
      renderInPanel(renderer, target, frame.scene, frame.camera, panel);
      const a0 = camera.aspect;
      camera.aspect = (panel.w * W) / Math.max(1, panel.h * H);
      camera.updateProjectionMatrix();
      kit.setLoupe(view.focus, view.stretch, view.offset ?? [0, 0, 0]);
      renderer.setRenderTarget(target);
      renderer.clearDepth();
      renderInPanel(renderer, target, scene, camera, panel);
      kit.setLoupe(null);
      camera.aspect = a0;
      camera.updateProjectionMatrix();
    },
    dispose() {
      frame.dispose();
    },
  };
  return loupe;
}
