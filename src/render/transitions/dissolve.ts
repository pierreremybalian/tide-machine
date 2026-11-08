// Noise-thresholded crossfade (HANDOFF §10.4).
import { float, mix, mx_noise_float, smoothstep, vec3 } from 'three/tsl';
import type { Node, TextureNode } from 'three/webgpu';

export function dissolve(a: TextureNode, b: TextureNode, uv: Node<'vec2'>, t: Node<'float'>, time: Node<'float'>, aspect: Node<'float'>) {
  const n = mx_noise_float(vec3(uv.x.mul(aspect).mul(3.0), uv.y.mul(3.0), time.mul(0.05))).mul(0.5).add(0.5);
  const fine = mx_noise_float(vec3(uv.x.mul(aspect).mul(14.0), uv.y.mul(14.0), time.mul(0.1))).mul(0.12);
  const edge = float(0.18);
  // Remap t so the threshold sweeps fully across the noise range.
  const thr = t.mul(float(1).add(edge.mul(2))).sub(edge);
  const w = smoothstep(thr.sub(edge), thr.add(edge), n.add(fine)).oneMinus();
  return mix(a.sample(uv), b.sample(uv), w);
}
