// Brass part materials for the outline pass (HANDOFF §8.3). Each style is one material; every part carries its id
// in the `aPart` vertex attribute. The material's colour is the dark solid fill (a whisper of brass, lit from the
// upper left, with a rim); into the G-buffer it also writes its view-space normal and an ident vector
// (part id, line gain, highlight, fill gain) that the composite reads to draw and colour the outlines.

import { FrontSide, MeshBasicNodeMaterial, Vector4 } from 'three/webgpu';
import { abs, attribute, dot, float, max, mrt, normalView, normalize, pow, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { RGB } from '../gfx/palette.ts';

const _f = () => uniform(0);
const _v4 = () => uniform(new Vector4());
export type FloatU = ReturnType<typeof _f>;
export type Vec4U = ReturnType<typeof _v4>;

/** Warm brass, linear RGB (#e6b866). */
export const BRASS: RGB = [0.791, 0.479, 0.133];

export interface BrassStyle {
  /** Outline brightness (1 = standard brass line). */
  line: number;
  /** Solid fill brightness (1 = standard). */
  fill: number;
  /** Fill tint (defaults to brass). */
  tint?: RGB;
}

export interface BrassMaterial {
  material: MeshBasicNodeMaterial;
  line: FloatU;
  fill: FloatU;
  dispose(): void;
}

/** Up to four highlighted part ids, shared by every material of a machine (−1 = none). */
export function createHot(): Vec4U {
  return uniform(new Vector4(-1, -1, -1, -1));
}

export function createBrassMaterial(style: BrassStyle, hot: Vec4U): BrassMaterial {
  const line = uniform(style.line);
  const fill = uniform(style.fill);
  const t = style.tint ?? BRASS;
  const part = attribute<'float'>('aPart', 'float');
  const n = normalize(normalView);
  const key = normalize(vec3(-0.45, 0.65, 0.6));
  const diffuse = max(dot(n, key), 0);
  const rim = pow(float(1).sub(abs(n.z)), 3);
  const hotHit = max(
    max(float(1).sub(abs(part.sub(hot.x)).min(1)), float(1).sub(abs(part.sub(hot.y)).min(1))),
    max(float(1).sub(abs(part.sub(hot.z)).min(1)), float(1).sub(abs(part.sub(hot.w)).min(1))),
  );
  const shade = float(0.018).add(diffuse.mul(0.05)).add(rim.mul(0.06)).mul(fill).mul(float(1).add(hotHit.mul(1.5)));
  const m = new MeshBasicNodeMaterial({ side: FrontSide });
  m.colorNode = vec4(vec3(t[0], t[1], t[2]).mul(shade), 1);
  m.mrtNode = mrt({ ident: vec4(part, line, hotHit, fill) as unknown as Node<'vec4'> });
  return {
    material: m,
    line,
    fill,
    dispose() {
      m.dispose();
    },
  };
}
