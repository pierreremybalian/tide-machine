// Quality tiers, feature detection and the frame-time probe (HANDOFF §10.5).

export type TierName = 'low' | 'medium' | 'high';
export type Backend = 'webgpu' | 'webgl2' | 'none';

export interface QualityTier {
  name: TierName;
  backend: Backend;
  maxDpr: number;
  renderScale: number;
  particles: number;
  raymarchSteps: number;
  /** Segments per worldline ribbon and per surface ring. */
  detail: number;
  /** True when chosen automatically (may drop a tier under load). */
  auto: boolean;
}

const TIERS: Record<TierName, Omit<QualityTier, 'backend' | 'auto'>> = {
  low: { name: 'low', maxDpr: 1, renderScale: 0.75, particles: 20_000, raymarchSteps: 24, detail: 0.5 },
  medium: { name: 'medium', maxDpr: 1.5, renderScale: 0.9, particles: 60_000, raymarchSteps: 48, detail: 1 },
  high: { name: 'high', maxDpr: 2, renderScale: 1.0, particles: 150_000, raymarchSteps: 96, detail: 1.5 },
};

export const TIER_ORDER: TierName[] = ['low', 'medium', 'high'];

export function tier(name: TierName, backend: Backend, auto: boolean): QualityTier {
  return { ...TIERS[name], backend, auto };
}

export function lowerTier(name: TierName): TierName | null {
  const i = TIER_ORDER.indexOf(name);
  return i > 0 ? TIER_ORDER[i - 1]! : null;
}

/** Initial guess before the probe: backend + cores + coarse device hints. */
export function guessTier(backend: Backend): TierName {
  if (backend === 'none') return 'low';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 8;
  const mobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
  if (mobile) return cores >= 8 && backend === 'webgpu' ? 'medium' : 'low';
  if (backend === 'webgpu' && cores >= 8 && mem >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

/** Refine the guess with measured frame times (median ms over the probe). */
export function tierFromProbe(guess: TierName, medianMs: number): TierName {
  if (medianMs > 30) return 'low';
  if (medianMs > 18) return guess === 'high' ? 'medium' : guess === 'medium' ? 'low' : 'low';
  return guess;
}

/** Rolling frame-time monitor: drop a tier if the median exceeds 22 ms for 3 s (never auto-raise). */
export class FrameMonitor {
  private samples = new Float32Array(240);
  private n = 0;
  private i = 0;
  private overSince = -1;
  constructor(
    private readonly thresholdMs = 22,
    private readonly holdS = 3,
  ) {}
  reset(): void {
    this.n = 0;
    this.i = 0;
    this.overSince = -1;
  }
  /** Returns true when the tier should drop. */
  push(dtMs: number, nowS: number): boolean {
    this.samples[this.i] = dtMs;
    this.i = (this.i + 1) % this.samples.length;
    this.n = Math.min(this.n + 1, this.samples.length);
    if (this.n < 60) return false;
    const med = this.median();
    if (med > this.thresholdMs) {
      if (this.overSince < 0) this.overSince = nowS;
      if (nowS - this.overSince > this.holdS) {
        this.reset();
        return true;
      }
    } else this.overSince = -1;
    return false;
  }
  private scratch = new Float32Array(240);
  median(): number {
    const k = this.n;
    this.scratch.set(this.samples.subarray(0, k));
    const s = this.scratch.subarray(0, k).sort();
    return s[k >> 1] ?? 0;
  }
}
