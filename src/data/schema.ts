// Data schemas for public/data/*.json (HANDOFF §14).

import { z } from 'astro/zod';

const source = z.object({ label: z.string().min(2), url: z.url() });

export const experimentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  year: z.number().int().min(1800).max(2100),
  /** What it tested, in one plain sentence. */
  tested: z.string().min(10),
  /** What was predicted and what was found. */
  result: z.string().min(10),
  /** Stage ids that rely on it. */
  stages: z.array(z.string()).min(1),
  sources: z.array(source).min(1),
});
export type Experiment = z.infer<typeof experimentSchema>;
export const experimentsSchema = z.array(experimentSchema);

export const positionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  who: z.string().min(2),
  year: z.number().int().min(1800).max(2100),
  /** The view in a sentence. */
  claim: z.string().min(10),
  camp: z.enum(['block', 'presentism', 'growing', 'spotlight', 'neutral']),
  sources: z.array(source).min(1),
});
export type Position = z.infer<typeof positionSchema>;
export const positionsSchema = z.array(positionSchema);
