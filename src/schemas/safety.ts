import { z } from 'zod';

export const submitSafetyReportSchema = z.object({
  category: z.enum(["HARASSMENT", "POOR_LIGHTING", "THEFT", "UNSAFE_ROAD", "OTHER"]),
  description: z.string().min(1, "Description is required"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  isPublicSpace: z.boolean().default(false)
});

export const adminResolveSchema = z.object({
  outcome: z.enum(["UPHOLD", "REMOVE"])
});
