import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { addContactSchema, deleteContactParamsSchema } from '../schemas/contacts.js';
import { verifyToken } from '../utils/auth.js';
import { checkExpiredDeadZones } from '../utils/deadzone.js';

// Hook to verify token and inject userId into request.
// Uses verifyToken() from utils/auth — algorithm pinned to HS512.
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
    }
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    const userId = decoded.userId;
    (request as any).userId = userId;

    // Piggyback expired deadzone check-in scan: non-blocking
    checkExpiredDeadZones(userId).catch(err => {
      console.error('[DEADZONE_HOOK] Error in contacts check:', err.message);
    });
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function contactsRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply authentication to all contact endpoints
  server.addHook('preHandler', authenticate);

  // List all contacts
  server.get('/', async (request, reply) => {
    const userId = (request as any).userId;
    const contacts = await prisma.contact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' }
    });

    const enrichedContacts = await Promise.all(
      contacts.map(async (c) => {
        const contactUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: c.phone,
              mode: 'insensitive'
            }
          }
        });
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          relationship: c.relationship,
          userId: c.userId,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
          hasFcmToken: !!contactUser?.fcmToken
        };
      })
    );

    return enrichedContacts;
  });

  // Add a contact (max 5)
  server.post('/', {
    schema: {
      body: addContactSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { name, phone, relationship } = request.body;

    // Check count limit
    const count = await prisma.contact.count({
      where: { userId }
    });

    if (count >= 5) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You can only add up to 5 emergency contacts'
      });
    }

    const contact = await prisma.contact.create({
      data: {
        name,
        phone,
        relationship,
        userId
      }
    });

    return reply.status(201).send(contact);
  });

  // Delete a contact
  server.delete('/:id', {
    schema: {
      params: deleteContactParamsSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params;

    const contact = await prisma.contact.findFirst({
      where: { id, userId }
    });

    if (!contact) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Contact not found'
      });
    }

    await prisma.contact.delete({
      where: { id }
    });

    return { success: true };
  });
}
