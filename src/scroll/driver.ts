// Scroll → $progress (HANDOFF §11.1). Lenis smooths the document scroll; progress is measured against the
// chapters container so chapter sections line up with chapter boundaries exactly.

import Lenis from 'lenis';
import { $progress, $reducedMotion } from '../state/store.ts';
import { STAGES as CHAPTERS, STAGE_STARTS as CHAPTER_STARTS } from '../time/stages.ts';

/** Scroll length per unit of chapter weight. Sized for reading: every caption gets ≥ MIN_DWELL_SVH of scroll. */
export const VH_PER_WEIGHT = 80;

export interface ScrollDriver {
  lenis: Lenis;
  scrollToProgress(p: number, opts?: { immediate?: boolean }): void;
  /** Progress values of every chapter start and beat, sorted (keyboard stepping). */
  stops: number[];
  destroy(): void;
}

let current: ScrollDriver | null = null;
export const getDriver = () => current;

export function createScrollDriver(container: HTMLElement): ScrollDriver {
  const reduced = $reducedMotion.get() || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lenis = new Lenis({
    smoothWheel: !reduced,
    lerp: 0.085,
    wheelMultiplier: 0.9,
    touchMultiplier: 1.4,
    syncTouch: false,
  });

  // The scrollable span is the container height minus one viewport (the last viewport is the "now" hold).
  let top = 0;
  let span = 1;
  const measure = () => {
    const rect = container.getBoundingClientRect();
    top = rect.top + window.scrollY;
    span = Math.max(1, container.offsetHeight - window.innerHeight);
  };
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(container);
  window.addEventListener('resize', measure);

  const update = () => {
    const p = Math.min(1, Math.max(0, (window.scrollY - top) / span));
    if (p !== $progress.get()) $progress.set(p);
  };
  lenis.on('scroll', update);
  update();

  let raf = 0;
  const loop = (time: number) => {
    lenis.raf(time);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // Stops for keyboard navigation: chapter starts + beats ([data-beat-progress]).
  const stops = [...CHAPTER_STARTS.slice(0, -1)];
  container.querySelectorAll<HTMLElement>('[data-beat-progress]').forEach((el) => {
    stops.push(Number(el.dataset.beatProgress));
  });
  stops.push(1);
  stops.sort((a, b) => a - b);

  const driver: ScrollDriver = {
    lenis,
    stops,
    scrollToProgress(p, opts = {}) {
      measure();
      const y = top + Math.min(1, Math.max(0, p)) * span;
      lenis.scrollTo(y, { immediate: opts.immediate || reduced, duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4) });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
      lenis.destroy();
      current = null;
    },
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.closest('input, select, textarea, [contenteditable]') || tgt.closest('[data-own-keys]'))) return;
    const p = $progress.get();
    const eps = 1e-4;
    let to: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
        if (e.key === ' ' && e.shiftKey) to = [...stops].reverse().find((s) => s < p - eps) ?? 0;
        else to = stops.find((s) => s > p + eps) ?? 1;
        break;
      case 'ArrowUp':
      case 'PageUp':
        to = [...stops].reverse().find((s) => s < p - eps) ?? 0;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = 1;
        break;
    }
    if (to === null) return;
    // Past the chapters (credits), let the browser scroll normally.
    if (window.scrollY > top + span + 4 && (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ')) return;
    e.preventDefault();
    driver.scrollToProgress(to);
  };
  window.addEventListener('keydown', onKey);
  current = driver;
  return driver;
}

/** CSS height of a chapter section, in svh. */
export function chapterHeightVh(index: number): number {
  return CHAPTERS[index]!.scrollWeight * VH_PER_WEIGHT;
}
