import { z } from 'zod';

export const registerBodySchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email format"),
  phone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, "Invalid phone format (must be 10-digit Indian number or start with +91)"),
  password: z.string().min(8, "Password must be at least 8 characters long")
});

export const loginBodySchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required")
});
