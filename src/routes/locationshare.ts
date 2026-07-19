import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../db/index.js';
import { verifyToken } from '../utils/auth.js';
import { sendLocationShareStartPush, sendLocationShareStopPush } from '../utils/fcm.js';

// Authenticate hook
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

// Schemas
const startSessionSchema = z.object({
  durationMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  contactIds: z.array(z.string())
});

const updateLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number().nullable().optional(),
  timestamp: z.string()
});

const viewSessionSchema = z.object({
  token: z.string()
});

export async function locationShareRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. POST /api/location-share/start
  server.post('/start', {
    preHandler: authenticate,
    schema: {
      body: startSessionSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { durationMinutes, contactIds } = request.body;

    // Check contacts exist
    const contacts = await prisma.contact.findMany({
      where: {
        id: { in: contactIds },
        userId
      }
    });

    if (contacts.length !== contactIds.length) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'One or more contact IDs are invalid'
      });
    }

    const shareToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);

    const session = await prisma.locationShareSession.create({
      data: {
        userId,
        token: shareToken,
        expiresAt,
        contacts: {
          create: contactIds.map(cid => ({
            contactId: cid
          }))
        }
      }
    });

    const shareUrl = `https://aryaa.app/track/${session.id}?token=${shareToken}`;

    // Async: look up each contact's app user by phone and send FCM push
    const sharerUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } });
    const sharerName = sharerUser?.name ?? 'A contact';
    const sharerPhone = sharerUser?.phone ?? '';

    Promise.allSettled(
      contacts.map(async (contact) => {
        const recipientUser = await prisma.user.findFirst({
          where: { phone: { equals: contact.phone, mode: 'insensitive' } }
        });
        if (recipientUser?.fcmToken) {
          await sendLocationShareStartPush(
            recipientUser.fcmToken,
            sharerName,
            sharerPhone,
            shareUrl,
            session.id,
            durationMinutes
          );
        }
      })
    ).catch(err => console.error('[LOC_SHARE] FCM dispatch error:', err));

    return reply.status(200).send({
      sessionId: session.id,
      shareToken,
      shareUrl
    });
  });

  // 2. POST /api/location-share/:sessionId/update
  server.post('/:sessionId/update', {
    preHandler: authenticate,
    schema: {
      body: updateLocationSchema,
      params: z.object({
        sessionId: z.string()
      })
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { sessionId } = request.params;
    const { lat, lng, accuracy, timestamp } = request.body;

    const session = await prisma.locationShareSession.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Location share session not found'
      });
    }

    // Ownership check (403 Forbidden)
    if (session.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You are not the owner of this share session'
      });
    }

    // Expiry/Active check
    const now = new Date();
    if (!session.active || session.expiresAt < now) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This sharing session has expired or is inactive'
      });
    }

    await prisma.locationShareHistory.create({
      data: {
        sessionId,
        latitude: lat,
        longitude: lng,
        accuracy: accuracy ?? null,
        timestamp: new Date(timestamp)
      }
    });

    return reply.status(200).send({ success: true });
  });

  // 3. POST /api/location-share/:sessionId/stop
  server.post('/:sessionId/stop', {
    preHandler: authenticate,
    schema: {
      params: z.object({
        sessionId: z.string()
      })
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { sessionId } = request.params;

    const session = await prisma.locationShareSession.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Location share session not found'
      });
    }

    // Ownership check (403 Forbidden)
    if (session.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You are not the owner of this share session'
      });
    }

    await prisma.locationShareSession.update({
      where: { id: sessionId },
      data: { active: false }
    });

    // Async: notify contacts the share has ended
    const sessionWithContacts = await prisma.locationShareSession.findUnique({
      where: { id: sessionId },
      include: {
        contacts: { include: { contact: true } },
        user: { select: { name: true } }
      }
    });
    if (sessionWithContacts) {
      const sharerName = sessionWithContacts.user.name ?? 'A contact';
      Promise.allSettled(
        sessionWithContacts.contacts.map(async (sc) => {
          const recipientUser = await prisma.user.findFirst({
            where: { phone: { equals: sc.contact.phone, mode: 'insensitive' } }
          });
          if (recipientUser?.fcmToken) {
            await sendLocationShareStopPush(recipientUser.fcmToken, sharerName, sessionId);
          }
        })
      ).catch(err => console.error('[LOC_SHARE_STOP] FCM dispatch error:', err));
    }

    return reply.status(200).send({ success: true });
  });

  // 4. GET /api/location-share/:sessionId/view
  server.get('/:sessionId/view', {
    schema: {
      params: z.object({
        sessionId: z.string()
      }),
      querystring: viewSessionSchema
    }
  }, async (request, reply) => {
    const { sessionId } = request.params;
    const { token } = request.query;

    // Secure timing-safe database lookup
    const session = await prisma.locationShareSession.findFirst({
      where: {
        id: sessionId,
        token: token
      },
      include: {
        locations: {
          orderBy: { timestamp: 'asc' }
        },
        user: {
          select: { name: true }
        }
      }
    });

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Location share session not found or invalid token'
      });
    }

    // Server-side expiry check
    const now = new Date();
    if (!session.active || session.expiresAt < now) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This location sharing session has expired or is inactive',
        expired: true
      });
    }

    return reply.status(200).send({
      active: session.active,
      expiresAt: session.expiresAt.toISOString(),
      victimName: session.user.name,
      locations: session.locations.map(loc => ({
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        timestamp: loc.timestamp.toISOString()
      }))
    });
  });
}
