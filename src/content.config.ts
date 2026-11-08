// Stage narrative (HANDOFF §12). One MDX file per stage; id must match src/time/stages.ts.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const stages = defineCollection({
  loader: glob({ pattern: '*.mdx', base: './src/content/stages' }),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    /** Short label above the title. */
    kicker: z.string(),
    summary: z.string(),
    beats: z
      .array(
        z.object({
          local: z.number().min(0).max(1),
          text: z.string(),
          /** Optional small label shown with the beat. */
          time: z.string().optional(),
        }),
      )
      .default([]),
    howWeKnow: z.string(),
    sources: z.array(z.object({ label: z.string(), url: z.url() })).min(1),
  }),
});

export const collections = { stages };
