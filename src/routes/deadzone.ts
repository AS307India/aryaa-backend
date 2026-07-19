import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import crypto from 'crypto';
import { prisma } from '../db/index.js';
import { verifyToken } from '../utils/auth.js';
import { startDeadZoneSchema, checkInSchema } from '../schemas/deadzone.js';
import { checkExpiredDeadZones } from '../utils/deadzone.js';
import { sendLocationShareStartPush, sendLocationShareStopPush } from '../utils/fcm.js';

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

    // IMPORTANT: await here (not fire-and-forget) so the PENDING→MISSED→ALERTED
    // transition completes before the route handler queries the DB.
    // Without await, GET /status races the scan and always sees PENDING.
    await checkExpiredDeadZones(userId);
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function deadZoneRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.addHook('preHandler', authenticate);

  // POST /start
  server.post('/start', {
    schema: {
      body: startDeadZoneSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { durationMinutes, latitude, longitude, accuracy, mode, destination, intervalMinutes } = request.body;

    // Check if there is already an active PENDING session
    const existing = await prisma.deadZoneCheckIn.findFirst({
      where: {
        userId,
        status: 'PENDING'
      }
    });

    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'You already have an active Dead Zone Check-In session pending.'
      });
    }

    if (mode === 'HEARTBEAT' && !intervalMinutes) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'intervalMinutes is required for HEARTBEAT mode.'
      });
    }

    const now = new Date();
    let expectedBackAt: Date;
    let gracePeriodEnd: Date;

    if (mode === 'HEARTBEAT') {
      const interval = intervalMinutes ?? 30;
      expectedBackAt = new Date(now.getTime() + interval * 60 * 1000);
      gracePeriodEnd = new Date(expectedBackAt.getTime() + 5 * 60 * 1000); // fixed 5-minute grace period
    } else {
      expectedBackAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
      const rawGrace = Math.round(durationMinutes * 0.25);
      const gracePeriodMinutes = Math.min(30, Math.max(5, rawGrace));
      gracePeriodEnd = new Date(expectedBackAt.getTime() + gracePeriodMinutes * 60 * 1000);
    }

    // Auto-start Feature F location sharing session if mode is SAFE_WALK
    let locationShareSessionId: string | null = null;
    let shareToken: string | null = null;
    let shareUrl: string | null = null;

    const userWithContacts = await prisma.user.findUnique({
      where: { id: userId },
      include: { contacts: true }
    });
    const contacts = userWithContacts?.contacts ?? [];

    if (mode === 'SAFE_WALK' && contacts.length > 0) {
      shareToken = crypto.randomUUID();
      const session = await prisma.locationShareSession.create({
        data: {
          userId,
          token: shareToken,
          expiresAt: expectedBackAt,
          contacts: {
            create: contacts.map(c => ({
              contactId: c.id
            }))
          }
        }
      });
      locationShareSessionId = session.id;
      const backendBase = (process.env.PUBLIC_URL || 'https://aryaa-backend.onrender.com').replace(/\/$/, '');
      shareUrl = `${backendBase}/track/${session.id}?token=${shareToken}`;

      // Notify contacts in parallel via FCM
      const sharerName = userWithContacts?.name ?? 'A contact';
      const sharerPhone = userWithContacts?.phone ?? '';
      const finalUrl = shareUrl;
      const finalSessionId = session.id;
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
              finalUrl,
              finalSessionId,
              durationMinutes
            );
          }
        })
      ).catch(err => console.error('[SAFE_WALK_FCM] start dispatch error:', err));
    }

    const checkIn = await prisma.deadZoneCheckIn.create({
      data: {
        userId,
        status: 'PENDING',
        mode: mode ?? 'PLAIN',
        destination: destination ?? null,
        intervalMinutes: intervalMinutes ?? null,
        locationShareSessionId,
        startedAt: now,
        expectedBackAt,
        gracePeriodEnd,
        lastLatitude: latitude ?? null,
        lastLongitude: longitude ?? null,
        lastAccuracy: accuracy ?? null
      }
    });

    return reply.status(201).send({
      checkInId: checkIn.id,
      status: checkIn.status,
      mode: checkIn.mode,
      destination: checkIn.destination,
      intervalMinutes: checkIn.intervalMinutes,
      locationShareSessionId: checkIn.locationShareSessionId,
      startedAt: checkIn.startedAt.toISOString(),
      expectedBackAt: checkIn.expectedBackAt.toISOString(),
      gracePeriodEnd: checkIn.gracePeriodEnd.toISOString(),
      shareToken,
      shareUrl
    });
  });

  // POST /checkin
  server.post('/checkin', {
    schema: {
      body: checkInSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { checkInId } = request.body;

    const checkIn = await prisma.deadZoneCheckIn.findUnique({
      where: { id: checkInId }
    });

    if (!checkIn) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Check-in session not found.'
      });
    }

    if (checkIn.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not own this check-in session.'
      });
    }

    if (checkIn.status !== 'PENDING') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Cannot check in. Current session status is ${checkIn.status}.`
      });
    }

    const now = new Date();

    if (checkIn.mode === 'HEARTBEAT') {
      // Periodic heartbeat ping: shift timers forward to next interval (fixed 5-minute grace period)
      const interval = checkIn.intervalMinutes ?? 30;
      const nextExpected = new Date(now.getTime() + interval * 60 * 1000);
      const nextGrace = new Date(nextExpected.getTime() + 5 * 60 * 1000);

      const updated = await prisma.deadZoneCheckIn.update({
        where: { id: checkInId },
        data: {
          expectedBackAt: nextExpected,
          gracePeriodEnd: nextGrace,
          checkedInAt: now
        }
      });

      return reply.status(200).send({
        checkInId: updated.id,
        status: updated.status,
        expectedBackAt: updated.expectedBackAt.toISOString(),
        gracePeriodEnd: updated.gracePeriodEnd.toISOString(),
        checkedInAt: updated.checkedInAt?.toISOString()
      });
    } else {
      // Standard CHECKED_IN close
      const updated = await prisma.deadZoneCheckIn.update({
        where: { id: checkInId },
        data: {
          status: 'CHECKED_IN',
          checkedInAt: now
        }
      });

      // Stop linked location sharing session if it exists
      if (checkIn.locationShareSessionId) {
        const locSession = await prisma.locationShareSession.findUnique({
          where: { id: checkIn.locationShareSessionId },
          include: { contacts: { include: { contact: true } } }
        });
        if (locSession) {
          await prisma.locationShareSession.update({
            where: { id: locSession.id },
            data: { active: false }
          });
          const user = await prisma.user.findUnique({ where: { id: userId } });
          const sharerName = user?.name ?? 'A contact';
          Promise.allSettled(
            locSession.contacts.map(async (c) => {
              const recipientUser = await prisma.user.findFirst({
                where: { phone: { equals: c.contact.phone, mode: 'insensitive' } }
              });
              if (recipientUser?.fcmToken) {
                await sendLocationShareStopPush(recipientUser.fcmToken, sharerName, locSession.id);
              }
            })
          ).catch(err => console.error('[SAFE_WALK_FCM] stop dispatch error:', err));
        }
      }

      return reply.status(200).send({
        checkInId: updated.id,
        status: updated.status,
        checkedInAt: updated.checkedInAt?.toISOString()
      });
    }
  });

  // POST /cancel
  server.post('/cancel', {
    schema: {
      body: checkInSchema
    }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { checkInId } = request.body;

    const checkIn = await prisma.deadZoneCheckIn.findUnique({
      where: { id: checkInId }
    });

    if (!checkIn) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Check-in session not found.'
      });
    }

    if (checkIn.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not own this check-in session.'
      });
    }

    if (checkIn.status !== 'PENDING') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Cannot cancel. Current session status is ${checkIn.status}.`
      });
    }

    // Cancellation ends the session for all modes, including Heartbeat
    const updated = await prisma.deadZoneCheckIn.update({
      where: { id: checkInId },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: new Date()
      }
    });

    // Stop linked location sharing session if it exists
    if (checkIn.locationShareSessionId) {
      const locSession = await prisma.locationShareSession.findUnique({
        where: { id: checkIn.locationShareSessionId },
        include: { contacts: { include: { contact: true } } }
      });
      if (locSession) {
        await prisma.locationShareSession.update({
          where: { id: locSession.id },
          data: { active: false }
        });
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const sharerName = user?.name ?? 'A contact';
        Promise.allSettled(
          locSession.contacts.map(async (c) => {
            const recipientUser = await prisma.user.findFirst({
              where: { phone: { equals: c.contact.phone, mode: 'insensitive' } }
            });
            if (recipientUser?.fcmToken) {
              await sendLocationShareStopPush(recipientUser.fcmToken, sharerName, locSession.id);
            }
          })
        ).catch(err => console.error('[SAFE_WALK_FCM] stop cancel dispatch error:', err));
      }
    }

    return reply.status(200).send({
      checkInId: updated.id,
      status: updated.status,
      checkedInAt: updated.checkedInAt?.toISOString()
    });
  });

  // GET /status
  server.get('/status', async (request, reply) => {
    const userId = (request as any).userId;

    const checkIn = await prisma.deadZoneCheckIn.findFirst({
      where: {
        userId,
        status: 'PENDING'
      }
    });

    if (!checkIn) {
      return reply.status(200).send({ checkIn: null });
    }

    return reply.status(200).send({
      checkIn: {
        checkInId: checkIn.id,
        status: checkIn.status,
        mode: checkIn.mode,
        destination: checkIn.destination,
        intervalMinutes: checkIn.intervalMinutes,
        locationShareSessionId: checkIn.locationShareSessionId,
        startedAt: checkIn.startedAt.toISOString(),
        expectedBackAt: checkIn.expectedBackAt.toISOString(),
        gracePeriodEnd: checkIn.gracePeriodEnd.toISOString()
      }
    });
  });
}
