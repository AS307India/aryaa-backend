import { z } from 'zod';

export const triggerSosSchema = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  address: z.string().nullable().optional()
});

export type TriggerSosBody = z.infer<typeof triggerSosSchema>;

export const cancelSosSchema = z.object({
  sosEventId: z.string().uuid({ message: 'Invalid SOS event ID format' })
});

export type CancelSosBody = z.infer<typeof cancelSosSchema>;

export const locationUpdateSchema = z.object({
  sosEventId: z.string().uuid({ message: 'Invalid SOS event ID format' }),
  latitude: z.number(),
  longitude: z.number(),
  timestamp: z.string() // fastify ZodTypeProvider handles date parsing
});

export type LocationUpdateBody = z.infer<typeof locationUpdateSchema>;
