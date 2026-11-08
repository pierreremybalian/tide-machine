import { describe, expect, it } from 'vitest';
import { captionAt, captionSchedule } from '../schedule.ts';
import { STAGES as CHAPTERS, STAGE_STARTS as CHAPTER_STARTS } from '../../time/stages.ts';

describe('caption schedule', () => {
  it('keeps beats at their local when there is room', () => {
    const s = captionSchedule([{ p0: 0, p1: 1, beats: [0.2, 0.5, 0.8] }], { heroEnd: 0, minDwell: 0.05 });
    expect(s.map((c) => c.start)).toEqual([0, 0.2, 0.5, 0.8]);
    expect(s.map((c) => c.beat)).toEqual([-1, 0, 1, 2]);
  });

  it('pushes crowded beats later and pulls back at the chapter end', () => {
    const s = captionSchedule([{ p0: 0, p1: 1, beats: [0.05, 0.1, 0.95] }], { heroEnd: 0, minDwell: 0.2 });
    const starts = s.map((c) => c.start);
    for (let k = 1; k < starts.length; k++) expect(starts[k]! - starts[k - 1]!).toBeGreaterThanOrEqual(0.2 - 1e-12);
    expect(starts.at(-1)!).toBeLessThanOrEqual(0.8 + 1e-12);
  });

  it('starts the first intro after the hero', () => {
    const s = captionSchedule([{ p0: 0, p1: 1, beats: [0.01] }], { heroEnd: 0.1, minDwell: 0.05 });
    expect(s[0]!.start).toBe(0.1);
    expect(s[1]!.start).toBeCloseTo(0.15);
  });

  it('gives every real chapter a readable, ordered sequence', () => {
    const chapters = CHAPTERS.map((_, i) => ({
      p0: CHAPTER_STARTS[i]!,
      p1: CHAPTER_STARTS[i + 1]!,
      beats: [0.14, 0.3, 0.45, 0.6, 0.75, 0.92],
    }));
    const minDwell = 0.003;
    const s = captionSchedule(chapters, { heroEnd: 0.012, minDwell });
    for (let k = 1; k < s.length; k++) expect(s[k]!.start - s[k - 1]!.start).toBeGreaterThanOrEqual(minDwell - 1e-12);
    s.forEach((c) => {
      expect(c.start).toBeGreaterThanOrEqual(CHAPTER_STARTS[c.chapter]!);
      expect(c.start).toBeLessThan(CHAPTER_STARTS[c.chapter + 1]!);
    });
  });

  it('finds the caption on screen', () => {
    const starts = [0.1, 0.2, 0.4];
    expect(captionAt(starts, 0)).toBe(-1);
    expect(captionAt(starts, 0.1)).toBe(0);
    expect(captionAt(starts, 0.3)).toBe(1);
    expect(captionAt(starts, 1)).toBe(2);
  });
});
