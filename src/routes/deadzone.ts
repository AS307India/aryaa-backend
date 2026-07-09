import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { verifyToken } from '../utils/auth.js';
import { startDeadZoneSchema, checkInSchema } from '../schemas/deadzone.js';
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
    const { durationMinutes, latitude, longitude, accuracy } = request.body;

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

    const now = new Date();
    const expectedBackAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
    // In non-production (local dev / debug builds), use a 1-minute grace period so test
    // cycles complete in ~3 minutes (2min duration + 1min grace) instead of 32 minutes.
    // Production always uses the real 30-minute grace period.
    const gracePeriodMinutes = process.env.NODE_ENV !== 'production' ? 1 : 30;
    const gracePeriodEnd = new Date(expectedBackAt.getTime() + gracePeriodMinutes * 60 * 1000);

    const checkIn = await prisma.deadZoneCheckIn.create({
      data: {
        userId,
        status: 'PENDING',
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
      startedAt: checkIn.startedAt.toISOString(),
      expectedBackAt: checkIn.expectedBackAt.toISOString(),
      gracePeriodEnd: checkIn.gracePeriodEnd.toISOString()
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

    const updated = await prisma.deadZoneCheckIn.update({
      where: { id: checkInId },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: new Date()
      }
    });

    return reply.status(200).send({
      checkInId: updated.id,
      status: updated.status,
      checkedInAt: updated.checkedInAt?.toISOString()
    });
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

    const updated = await prisma.deadZoneCheckIn.update({
      where: { id: checkInId },
      data: {
        status: 'CHECKED_IN',  // treat cancel the same as a successful check-in to stop the timer
        checkedInAt: new Date()
      }
    });

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
        startedAt: checkIn.startedAt.toISOString(),
        expectedBackAt: checkIn.expectedBackAt.toISOString(),
        gracePeriodEnd: checkIn.gracePeriodEnd.toISOString()
      }
    });
  });
}
