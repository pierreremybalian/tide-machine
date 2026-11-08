// Scene contract (HANDOFF §5). Scenes are isolated modules sharing only src/shared and the global uniforms.

import type { RenderTarget, WebGPURenderer } from 'three/webgpu';
import type { GlobalUniforms } from '../render/globals.ts';
import type { QualityTier } from '../render/quality.ts';
import type { AssetLoader } from '../render/assets.ts';
import type { Status } from '../time/stages.ts';
import type { LabelSet } from '../shared/gfx/labels.ts';

export type { Status };

export interface RenderContext {
  renderer: WebGPURenderer;
  globals: GlobalUniforms;
  quality: QualityTier;
  assets: AssetLoader;
}

export interface BlockScene {
  id: string;
  status: Status;
  /** One sentence: what kind of claim this is and anything exaggerated. Shown on the stage's intro card. */
  statusNote: string;
  init(ctx: RenderContext): Promise<void>;
  /** local: 0–1 progress through this scene's stage. elapsed: wall-clock seconds for idle motion. */
  update(local: number, dt: number, elapsed: number): void;
  render(target: RenderTarget): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
  /** HTML labels anchored to 3D points; positions are refreshed in update(). */
  labels?: LabelSet;
}

export type SceneFactory = () => BlockScene;
