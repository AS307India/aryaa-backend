import { z } from 'zod';

export const registerFcmTokenSchema = z.object({
  fcmToken: z.string().min(1, "FCM token is required")
});

export const updateProfileAddressSchema = z.object({
  homeAddress: z.string().nullable().optional(),
  homeLatitude: z.number().nullable().optional(),
  homeLongitude: z.number().nullable().optional()
});
