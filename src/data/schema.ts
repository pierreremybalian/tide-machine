// Data schemas for public/data/*.json.

import { z } from 'astro/zod';

export const constituentSchema = z.object({
  name: z.string().min(1),
  amplitude: z.number().nonnegative(),
  phase: z.number().min(0).max(360),
  speed: z.number().nonnegative(),
});

export const stationSchema = z.object({
  id: z.string().regex(/^\d{7}$/),
  label: z.string().min(2),
  name: z.string().min(2),
  state: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  z0: z.number(),
  datums: z.record(z.string(), z.number().optional()),
  constituents: z.array(constituentSchema).min(5),
});
export type Station = z.infer<typeof stationSchema>;

export const seriesSchema = z.object({
  station: z.string(),
  start: z.string(),
  stepMinutes: z.number().positive(),
  unit: z.literal('mm'),
  datum: z.literal('MLLW'),
  values: z.array(z.number().nullable()),
});
