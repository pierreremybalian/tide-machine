// Keyframe tracks for stage scripts (pure). A track maps local ∈ [0, 1] to a value through keyframes with eased
// segments; values hold flat before the first and after the last key. Windows fade things in and out.

export type Ease = (s: number) => number;

export const linear: Ease = (s) => s;
export const smooth: Ease = (s) => s * s * (3 - 2 * s);
export const smoother: Ease = (s) => s * s * s * (s * (s * 6 - 15) + 10);
export const easeOut: Ease = (s) => 1 - (1 - s) * (1 - s) * (1 - s);
export const easeIn: Ease = (s) => s * s * s;

export type Key = readonly [local: number, value: number];

/** Build a track. Keys must be sorted by local. */
export function track(keys: readonly Key[], ease: Ease = smoother): (local: number) => number {
  if (!keys.length) throw new Error('empty track');
  for (let i = 1; i < keys.length; i++) if (keys[i]![0] < keys[i - 1]![0]) throw new Error('track keys must be sorted');
  const n = keys.length;
  return (local: number) => {
    if (local <= keys[0]![0]) return keys[0]![1];
    if (local >= keys[n - 1]![0]) return keys[n - 1]![1];
    let i = 1;
    while (keys[i]![0] < local) i++;
    const [l0, v0] = keys[i - 1]!;
    const [l1, v1] = keys[i]!;
    const s = l1 > l0 ? (local - l0) / (l1 - l0) : 1;
    return v0 + (v1 - v0) * ease(s);
  };
}

/** 0 before a, eased up to 1 over `fade`, held, eased down to 0 ending at b. */
export function windowed(local: number, a: number, b: number, fadeIn = 0.06, fadeOut = fadeIn): number {
  if (local <= a || local >= b) return 0;
  const up = fadeIn > 0 ? Math.min(1, (local - a) / fadeIn) : 1;
  const down = fadeOut > 0 ? Math.min(1, (b - local) / fadeOut) : 1;
  return smoother(Math.min(up, down));
}

/** 0 before a, eased to 1 at b, held after. */
export function ramp(local: number, a: number, b: number, ease: Ease = smoother): number {
  if (local <= a) return 0;
  if (local >= b) return 1;
  return ease((local - a) / (b - a));
}
