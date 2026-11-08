// Anisotropic stretch of the outgoing frame (expansion feel) into the incoming (HANDOFF §10.4).
import { float, mix, pow, smoothstep, vec2, vec4 } from 'three/tsl';
import type { Node, TextureNode } from 'three/webgpu';

const TAPS = 8;

export function stretch(a: TextureNode, b: TextureNode, uv: Node<'vec2'>, t: Node<'float'>) {
  const c = vec2(0.5, 0.5);
  const d = uv.sub(c);
  // Outgoing stretches horizontally much faster than vertically, as if space itself is being pulled.
  const sx = pow(float(12), t);
  const sy = pow(float(2.2), t);
  const p = c.add(vec2(d.x.div(sx), d.y.div(sy)));
  let acc: Node<'vec4'> = vec4(0);
  for (let i = 0; i < TAPS; i++) {
    const k = float(1).sub(t.mul(0.08 * i));
    acc = acc.add(a.sample(c.add(p.sub(c).mul(vec2(k, 1)))));
  }
  const outgoing = acc.div(TAPS).mul(float(1).sub(t.mul(0.6)));
  // Incoming relaxes from a slight vertical squeeze.
  const q = c.add(vec2(d.x, d.y.mul(mix(float(1.4), float(1), t))));
  const incoming = b.sample(q);
  return mix(outgoing, incoming, smoothstep(0.25, 0.95, t));
}
