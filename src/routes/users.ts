import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { registerFcmTokenSchema } from '../schemas/users.js';
import { verifyToken } from '../utils/auth.js';
import { checkExpiredDeadZones } from '../utils/deadzone.js';

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
      console.error('[DEADZONE_HOOK] Error in users check:', err.message);
    });
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function userRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply authentication
  server.addHook('preHandler', authenticate);

  // POST /fcm-token
  server.post('/fcm-token', {
    schema: {
      body: registerFcmTokenSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { fcmToken } = request.body;

    await prisma.user.update({
      where: { id: userId },
      data: { fcmToken }
    });

    return reply.status(200).send({ success: true });
  });
}
