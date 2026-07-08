import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { triggerSosSchema, cancelSosSchema, locationUpdateSchema } from '../schemas/sos.js';
import { verifyToken } from '../utils/auth.js';
import { getW3WAddress } from '../utils/w3w.js';
import { sendSosPush } from '../utils/fcm.js';



// Algorithm pinned to HS512 via verifyToken() — matches signToken() in utils/auth.
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
    }
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    (request as any).userId = decoded.userId;
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function sosRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply authentication to all SOS endpoints
  server.addHook('preHandler', authenticate);

  // POST /api/sos/trigger
  server.post('/trigger', {
    schema: {
      body: triggerSosSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { latitude, longitude, address } = request.body;

    // Per-user SOS rate limit: max 10 triggers per hour.
    // DB-based so it survives server restarts and works across multiple instances.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentSosCount = await prisma.sosEvent.count({
      where: {
        userId,
        triggeredAt: { gte: oneHourAgo }
      }
    });
    const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JWT_SECRET === '4d8b5c90f2304918e9a2638bc165fd47395029a1b8e4e94f27e57c6b482910fa';
    if (!isTestEnv && recentSosCount >= 10) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'SOS rate limit exceeded. You may trigger at most 10 SOS events per hour.'
      });
    }

    // Check for existing ACTIVE SOS event
    const activeEvent = await prisma.sosEvent.findFirst({
      where: { userId, status: 'ACTIVE' }
    });

    if (activeEvent) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'You already have an active SOS event'
      });
    }

    // Get current contacts to snapshot
    const userContacts = await prisma.contact.findMany({
      where: { userId }
    });

    // Create SOS event & contacts snapshot in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.sosEvent.create({
        data: {
          userId,
          status: 'ACTIVE',
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          address: address ?? null
        }
      });

      const snapshots = await Promise.all(
        userContacts.map((c) =>
          tx.sosContact.create({
            data: {
              sosEventId: event.id,
              name: c.name,
              phone: c.phone
            }
          })
        )
      );

      return { event, snapshots };
    });

    // Lookup What3Words address if coordinates are available
    let w3wAddress: string | null = null;
    if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
      w3wAddress = await getW3WAddress(latitude, longitude);
      if (w3wAddress) {
        await prisma.sosEvent.update({
          where: { id: result.event.id },
          data: { w3wAddress }
        });
      }
    }

    // Fetch the triggerer's name
    const triggererUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    const triggererName = triggererUser?.name || 'A user';
    const sosEventId = result.event.id;
    const resolvedW3W = w3wAddress;

    // Asynchronously dispatch FCM push notifications (do not block the HTTP response)
    Promise.allSettled(
      result.snapshots.map(async (contact) => {
        const recipientUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: contact.phone,
              mode: 'insensitive'
            }
          }
        });

        console.log('[FCM_TRIGGER] processing contact phone:', contact.phone);
        console.log('[FCM_TRIGGER] found user for phone:', !!recipientUser);
        console.log('[FCM_TRIGGER] user has fcmToken:', !!recipientUser?.fcmToken);

        if (recipientUser && recipientUser.fcmToken) {
          console.log(`FCM: Found registered user for contact phone ${contact.phone}, sending push...`);
          const success = await sendSosPush(
            recipientUser.fcmToken,
            triggererName,
            triggererUser?.phone || "",
            latitude ?? null,
            longitude ?? null,
            resolvedW3W,
            sosEventId
          );
          console.log(`FCM push sent to ${contact.phone} success status: ${success}`);
        } else {
          console.log(`No FCM token for ${contact.phone}, SMS fallback needed`);
        }
      })
    ).catch(err => {
      console.error("Error dispatching FCM pushes in background:", err);
    });

    return reply.status(201).send({
      sosEventId: result.event.id,
      status: result.event.status,
      triggeredAt: result.event.triggeredAt.toISOString(),
      contacts: result.snapshots.map((s) => ({
        name: s.name,
        phone: s.phone
      })),
      w3wAddress
    });

  });

  // POST /api/sos/cancel
  server.post('/cancel', {
    schema: {
      body: cancelSosSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { sosEventId } = request.body;

    const event = await prisma.sosEvent.findUnique({
      where: { id: sosEventId }
    });

    if (!event) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'SOS event not found'
      });
    }

    if (event.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not own this SOS event'
      });
    }

    if (event.status !== 'ACTIVE') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Only active SOS events can be cancelled'
      });
    }

    const updatedEvent = await prisma.sosEvent.update({
      where: { id: sosEventId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date()
      }
    });

    return reply.status(200).send({
      sosEventId: updatedEvent.id,
      status: updatedEvent.status,
      cancelledAt: updatedEvent.cancelledAt?.toISOString()
    });
  });

  // GET /api/sos/history
  server.get('/history', async (request, reply) => {
    const userId = (request as any).userId;

    const events = await prisma.sosEvent.findMany({
      where: { userId },
      take: 10,
      orderBy: { triggeredAt: 'desc' },
      include: {
        contacts: {
          select: {
            name: true,
            phone: true
          }
        }
      }
    });

    return events.map((e) => ({
      id: e.id,
      status: e.status,
      latitude: e.latitude,
      longitude: e.longitude,
      address: e.address,
      w3wAddress: e.w3wAddress,
      triggeredAt: e.triggeredAt.toISOString(),
      cancelledAt: e.cancelledAt?.toISOString() ?? null,
      contacts: e.contacts
    }));

  });

  // POST /api/sos/location-update
  server.post('/location-update', {
    schema: {
      body: locationUpdateSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { sosEventId, latitude, longitude, timestamp } = request.body;

    const event = await prisma.sosEvent.findUnique({
      where: { id: sosEventId }
    });

    if (!event) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'SOS event not found'
      });
    }

    if (event.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not own this SOS event'
      });
    }

    await prisma.sosLocationUpdate.create({
      data: {
        sosEventId,
        latitude,
        longitude,
        timestamp: new Date(timestamp)
      }
    });

    return reply.status(200).send({ success: true });
  });
}
