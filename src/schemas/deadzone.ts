import { z } from 'zod';

const isProduction = process.env.NODE_ENV === 'production';
const allowedDurations = isProduction
  ? [60, 120, 240, 480] as const
  : [2, 60, 120, 240, 480] as const;

export const startDeadZoneSchema = z.object({
  durationMinutes: z.number().refine(
    (val) => (allowedDurations as readonly number[]).includes(val),
    {
      message: `Duration must be one of: ${allowedDurations.join(', ')}`
    }
  ),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  accuracy: z.number().optional().nullable()
});

export const checkInSchema = z.object({
  checkInId: z.string().uuid()
});
