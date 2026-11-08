import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { seriesSchema, stationSchema } from '../schema.ts';
import { BY_NAME } from '../../tides/constituents.ts';

const DATA = new URL('../../../public/data/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, DATA), 'utf8'));

describe('data', () => {
  const index = read('stations/index.json') as { id: string }[];
  it('25 finale ports, each with a valid station file', () => {
    expect(index.length).toBe(25);
    for (const s of index) expect(() => stationSchema.parse(read(`stations/${s.id}.json`))).not.toThrow();
  });
  it('every station constituent is one we model', () => {
    for (const s of index) for (const c of read(`stations/${s.id}.json`).constituents) expect(BY_NAME.has(c.name), `${s.id} ${c.name}`).toBe(true);
  });
  it('series files validate', () => {
    for (const f of ['sf-week.json', 'sf-year.json']) expect(() => seriesSchema.parse(read(f))).not.toThrow();
    for (const f of readdirSync(new URL('validation/', DATA))) expect(() => seriesSchema.parse(read(`validation/${f}`))).not.toThrow();
  });
});
