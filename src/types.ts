import { z } from 'zod';

export const SourceTypeSchema = z.enum([
  'hatena',
  'zenn',
  'hackernews',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const RawSignalInputSchema = z.object({
  source: SourceTypeSchema,
  external_id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  content: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  posted_at: z.string().datetime({ offset: true }),
  metadata: z.record(z.unknown()).default({}),
});
export type RawSignalInput = z.infer<typeof RawSignalInputSchema>;
