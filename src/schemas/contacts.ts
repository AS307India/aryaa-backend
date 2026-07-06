import { z } from 'zod';

export const addContactSchema = z.object({
  name: z.string().min(1, { message: 'Name is required' }),
  phone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, { message: 'Invalid phone format' }),
  relationship: z.enum(['FAMILY', 'FRIEND', 'COLLEAGUE', 'NEIGHBOUR', 'OTHER'], {
    errorMap: () => ({ message: 'Relationship must be FAMILY, FRIEND, COLLEAGUE, NEIGHBOUR, or OTHER' })
  })
});

export type AddContactBody = z.infer<typeof addContactSchema>;

export const deleteContactParamsSchema = z.object({
  id: z.string().uuid({ message: 'Invalid contact ID format' })
});

export type DeleteContactParams = z.infer<typeof deleteContactParamsSchema>;
