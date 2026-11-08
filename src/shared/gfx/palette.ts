// Shared colours (linear RGB, HDR-friendly). Mirrored as CSS tokens in src/styles/global.css.
// Amber = observer A, cyan = observer B, white = both agree, violet = light.

export type RGB = readonly [number, number, number];

export const PAL = {
  a: [1.0, 0.52, 0.14] as RGB,
  b: [0.16, 0.74, 1.0] as RGB,
  both: [1.0, 0.97, 0.92] as RGB,
  light: [0.6, 0.45, 1.0] as RGB,
  line: [1.0, 0.88, 0.74] as RGB,
  cool: [0.62, 0.72, 0.95] as RGB,
  edge: [0.42, 0.5, 0.72] as RGB,
  bowl: [0.98, 0.84, 0.6] as RGB,
  sun: [1.0, 0.78, 0.42] as RGB,
  earth: [0.36, 0.7, 1.0] as RGB,
  moon: [0.78, 0.8, 0.86] as RGB,
  andromeda: [0.86, 0.66, 1.0] as RGB,
  green: [0.45, 1.0, 0.7] as RGB,
  red: [1.0, 0.3, 0.26] as RGB,
} as const;

/** Hex for CSS/HTML use. */
export function hex(c: RGB): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}
