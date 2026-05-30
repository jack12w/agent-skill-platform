import { z } from 'zod';

export const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  license: z.string().optional(),
  author: z.string().optional(),
  io: z.object({
    inputs: z.record(z.string()).optional(),
    outputs: z.record(z.string()).optional(),
  }).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
