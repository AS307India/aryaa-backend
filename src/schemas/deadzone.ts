import { z } from 'zod';

export const startDeadZoneSchema = z.object({
  durationMinutes: z.number()
    .int()
    .min(1, "Minimum duration is 1 minute")
    .max(1440, "Maximum duration is 24 hours"),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  accuracy: z.number().optional().nullable(),
  mode: z.enum(["PLAIN", "SAFE_WALK", "HEARTBEAT"]).optional().default("PLAIN"),
  destination: z.string().optional().nullable(),
  intervalMinutes: z.number().int().min(1).max(1440).optional().nullable()
});

export const checkInSchema = z.object({
  checkInId: z.string().uuid()
});
