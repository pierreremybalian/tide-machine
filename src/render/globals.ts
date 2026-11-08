// Global TSL uniforms shared by every scene, updated once per frame.

import { Vector2 } from 'three/webgpu';
import { uniform } from 'three/tsl';

const _mkFloat = () => uniform(0);
const _mkVec2 = () => uniform(new Vector2());
export type FloatUniform = ReturnType<typeof _mkFloat>;
export type Vec2Uniform = ReturnType<typeof _mkVec2>;

export interface GlobalUniforms {
  /** Wall-clock seconds (idle motion); stops under reduced motion. */
  uElapsed: FloatUniform;
  /** Active stage progress 0–1. */
  uLocal: FloatUniform;
  /** Render-target pixels. */
  uResolution: Vec2Uniform;
  update(local: number, elapsed: number): void;
  setResolution(w: number, h: number): void;
  dispose(): void;
}

export function createGlobalUniforms(): GlobalUniforms {
  const u: GlobalUniforms = {
    uElapsed: uniform(0),
    uLocal: uniform(0),
    uResolution: uniform(new Vector2(1, 1)),
    update(local, elapsed) {
      u.uElapsed.value = elapsed;
      u.uLocal.value = local;
    },
    setResolution(w, h) {
      u.uResolution.value.set(w, h);
    },
    dispose() {},
  };
  return u;
}
