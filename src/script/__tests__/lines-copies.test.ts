// The luminous-line helper is copied into each of the four tide-instrument scenes (scenes share only src/shared/,
// which those stages do not own); the copies must stay identical until it moves to src/shared/gfx/lines.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (id: string) => readFileSync(new URL(`../../scenes/${id}/lines.ts`, import.meta.url), 'utf8');

describe('scene line helpers', () => {
  it('moon, sun, rhythms and apart carry the same lines.ts', () => {
    const ref = read('sun');
    for (const id of ['moon', 'rhythms', 'apart']) expect(read(id), id).toBe(ref);
  });
});
