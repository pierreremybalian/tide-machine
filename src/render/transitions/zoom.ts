// Incoming scales up from the centre while the outgoing frame gets a radial blur (HANDOFF §10.4).
import { float, mix, smoothstep, step, vec2, vec4 } from 'three/tsl';
import type { Node, TextureNode } from 'three/webgpu';

const TAPS = 10;

export function zoom(a: TextureNode, b: TextureNode, uv: Node<'vec2'>, t: Node<'float'>, aspect: Node<'float'>) {
  const c = vec2(0.5, 0.5);
  const d = uv.sub(c);
  // Outgoing: zoom-blur toward the viewer.
  const strength = t.mul(0.35);
  let acc: Node<'vec4'> = vec4(0);
  for (let i = 0; i < TAPS; i++) {
    acc = acc.add(a.sample(c.add(d.mul(float(1).sub(strength.mul(i / (TAPS - 1)))))));
  }
  const outgoing = acc.div(TAPS);
  // Incoming: grows from a small disc at the centre.
  const scale = mix(float(0.15), float(1), smoothstep(0, 1, t));
  const inside = c.add(d.div(scale));
  const inBounds = step(0, inside.x).mul(step(inside.x, 1)).mul(step(0, inside.y)).mul(step(inside.y, 1));
  const incoming = b.sample(inside).mul(inBounds);
  const r = vec2(d.x.mul(aspect), d.y).length();
  const radius = t.mul(1.3);
  const disc = float(1).sub(smoothstep(radius.sub(0.25), radius, r));
  return mix(outgoing, incoming, disc.mul(smoothstep(0, 0.12, t)).max(smoothstep(0.8, 1, t)));
}
