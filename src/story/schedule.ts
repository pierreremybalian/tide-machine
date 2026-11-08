// When each caption of the guided narration is on screen (pure). One caption at a time: a chapter's intro card
// (title + summary) from the chapter start, then each beat from its `local`, so text lands where the scene shows it.
// Every caption gets at least `minDwell` of scroll to be read; beats are pushed later (never earlier) to get it,
// and pulled back only if a chapter would otherwise overflow.

/** The hero title card covers the first sliver of progress (index.astro fades it out by then). */
export const HERO_END = 0.012;
/** Minimum scroll each caption stays on screen, in svh. */
export const MIN_DWELL_SVH = 32;

export interface ScheduleChapter {
  /** Progress at which the chapter starts / ends. */
  p0: number;
  p1: number;
  /** Beat positions within the chapter, 0–1, ascending. */
  beats: readonly number[];
}

export interface Caption {
  chapter: number;
  /** -1 = intro card, otherwise beat index. */
  beat: number;
  /** Progress at which the caption appears; it stays until the next caption's start. */
  start: number;
}

export function captionSchedule(chapters: readonly ScheduleChapter[], opts: { heroEnd: number; minDwell: number }): Caption[] {
  const out: Caption[] = [];
  chapters.forEach((ch, i) => {
    const span = ch.p1 - ch.p0;
    const starts = [i === 0 ? Math.max(ch.p0, opts.heroEnd) : ch.p0];
    for (const local of ch.beats) starts.push(Math.max(ch.p0 + local * span, starts.at(-1)! + opts.minDwell));
    // Backward pass: the last caption keeps at least minDwell before the chapter ends.
    let limit = ch.p1 - opts.minDwell;
    for (let k = starts.length - 1; k >= 1; k--) {
      starts[k] = Math.min(starts[k]!, limit);
      limit = starts[k]! - opts.minDwell;
    }
    starts.forEach((start, k) => out.push({ chapter: i, beat: k - 1, start }));
  });
  return out;
}

/** Index of the caption on screen at progress p (−1 before the first). Binary search over ascending starts. */
export function captionAt(starts: ArrayLike<number>, p: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= p) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
