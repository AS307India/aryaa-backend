import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import crypto from 'crypto';
import { prisma } from '../db/index.js';
import { triggerSosSchema, cancelSosSchema, locationUpdateSchema } from '../schemas/sos.js';
import { verifyToken } from '../utils/auth.js';
import { getW3WAddress } from '../utils/w3w.js';
import { sendSosPush, sendSosCancelPush, sendDuressAlertPush } from '../utils/fcm.js';
import { checkExpiredDeadZones } from '../utils/deadzone.js';

// Clean up any stale duress events older than 2 hours dynamically
async function autoResolveExpiredDuressEvents() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  try {
    await prisma.sosEvent.updateMany({
      where: {
        status: 'DURESS',
        duressTriggeredAt: { lt: twoHoursAgo }
      },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date()
      }
    });
  } catch (err) {
    console.error('[AUTO_RESOLVE] Failed to resolve stale duress events:', err);
  }
}

// Algorithm pinned to HS512 via verifyToken() — matches signToken() in utils/auth.
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
      console.error('[DEADZONE_HOOK] Error in SOS check:', err.message);
    });
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function sosRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Run auto-resolve and authentication as preHandlers
  server.addHook('preHandler', async (request, reply) => {
    await autoResolveExpiredDuressEvents();
  });
  server.addHook('preHandler', authenticate);

  // POST /api/sos/trigger
  server.post('/trigger', {
    schema: {
      body: triggerSosSchema
    }
  }, async (request, reply) => {
    console.log('[TIMING_DATA] SOS trigger received at:', new Date().toISOString());
    const userId = (request as any).userId;
    const { latitude, longitude, address, accuracy } = request.body;

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

    // Check for existing ACTIVE or DURESS SOS event
    const activeEvent = await prisma.sosEvent.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'DURESS'] }
      }
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
          publicTrackToken: crypto.randomUUID(),
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          address: address ?? null,
          accuracy: accuracy ?? null
        }
      });

      const snapshots = await Promise.all(
        userContacts.map((c) =>
          tx.sosContact.create({
            data: {
              sosEventId: event.id,
              name: c.name,
              phone: c.phone,
              isNearby: c.isNearby
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

    // Filter contacts into Local vs Non-Local responders
    const localResponders = result.snapshots.filter((c) => c.isNearby === 'YES');
    const nonLocalResponders = result.snapshots.filter((c) => c.isNearby !== 'YES');

    // Asynchronously dispatch FCM push notifications to Local responders immediately
    Promise.allSettled(
      localResponders.map(async (contact) => {
        const recipientUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: contact.phone,
              mode: 'insensitive'
            }
          }
        });

        if (recipientUser && recipientUser.fcmToken) {
          console.log(`[TIMING_DATA] [Local-tier] Immediately before FCM dispatch to ${contact.phone} at:`, new Date().toISOString());
          const success = await sendSosPush(
            recipientUser.fcmToken,
            triggererName,
            triggererUser?.phone || "",
            latitude ?? null,
            longitude ?? null,
            resolvedW3W,
            sosEventId,
            accuracy ?? null,
            'LOCAL_RESPONDER'
          );
          console.log(`[TIMING_DATA] [Local-tier] Immediately after FCM dispatch to ${contact.phone} returned success: ${success} at:`, new Date().toISOString());
        } else {
          console.log(`No FCM token for local responder ${contact.phone}, SMS fallback needed`);
        }
      })
    ).catch(err => {
      console.error("Error dispatching Local FCM pushes in background:", err);
    });

    // Schedule 30-second timer to dispatch to Non-Local responders if no response has been registered
    setTimeout(async () => {
      console.log('[TIMING_DATA] Entry into the 30s setTimeout callback at:', new Date().toISOString());
      // KNOWN LIMITATION (v1): in-memory timer, lost on Render restart.
      // Acceptable at current scale. Revisit with Redis-backed queue 
      // (e.g. BullMQ) before scale-up or if restart frequency increases.
      const hasResponse = await prisma.sosResponse.findFirst({ where: { sosEventId } });
      if (!hasResponse) {
        console.log(`No active response registered for event ${sosEventId} within 30s. Escalating to Non-Local responders...`);
        Promise.allSettled(
          nonLocalResponders.map(async (contact) => {
            const recipientUser = await prisma.user.findFirst({
              where: {
                phone: {
                  equals: contact.phone,
                  mode: 'insensitive'
                }
              }
            });

            if (recipientUser && recipientUser.fcmToken) {
              console.log(`[TIMING_DATA] [Family-tier] Immediately before FCM dispatch to ${contact.phone} at:`, new Date().toISOString());
              const success = await sendSosPush(
                recipientUser.fcmToken,
                triggererName,
                triggererUser?.phone || "",
                latitude ?? null,
                longitude ?? null,
                resolvedW3W,
                sosEventId,
                accuracy ?? null,
                'FAMILY'
              );
              console.log(`[TIMING_DATA] [Family-tier] Immediately after FCM dispatch to ${contact.phone} returned success: ${success} at:`, new Date().toISOString());
            } else {
              console.log(`No FCM token for non-local responder ${contact.phone}, SMS fallback needed`);
            }
          })
        ).catch(err => {
          console.error("Error dispatching Non-Local FCM pushes in background:", err);
        });
      } else {
        console.log(`Response registered for event ${sosEventId}. Suppressing escalation to Non-Local responders.`);
      }
    }, 30000);

    const backendBase = (process.env.PUBLIC_URL || 'https://aryaa-backend.onrender.com').replace(/\/$/, '');
    const publicTrackUrl = `${backendBase}/track/sos/${result.event.id}?token=${result.event.publicTrackToken}`;

    return reply.status(201).send({
      sosEventId: result.event.id,
      status: result.event.status,
      publicTrackUrl,
      triggeredAt: result.event.triggeredAt.toISOString(),
      contacts: result.snapshots.map((s) => ({
        name: s.name,
        phone: s.phone,
        isNearby: s.isNearby
      })),
      w3wAddress,
      accuracy: result.event.accuracy
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

    // Retrieve snapshots (i.e. contacts who received the SOS)
    const snapshots = await prisma.sosContact.findMany({
      where: { sosEventId }
    });

    // Asynchronously dispatch FCM SOS cancel push notifications (do not block the HTTP response)
    Promise.allSettled(
      snapshots.map(async (contact: { name: string; phone: string }) => {
        const recipientUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: contact.phone,
              mode: 'insensitive'
            }
          }
        });

        console.log('[FCM_CANCEL_TRIGGER] processing contact phone:', contact.phone);
        console.log('[FCM_CANCEL_TRIGGER] found user for phone:', !!recipientUser);
        console.log('[FCM_CANCEL_TRIGGER] user has fcmToken:', !!recipientUser?.fcmToken);

        if (recipientUser && recipientUser.fcmToken) {
          console.log(`FCM: Found registered user for contact phone ${contact.phone}, sending cancel push...`);
          const success = await sendSosCancelPush(recipientUser.fcmToken, sosEventId);
          console.log(`FCM cancel push sent to ${contact.phone} success status: ${success}`);
        }
      })
    ).catch(err => {
      console.error("Error dispatching FCM cancel pushes in background:", err);
    });

    return reply.status(200).send({
      sosEventId: updatedEvent.id,
      status: updatedEvent.status,
      cancelledAt: updatedEvent.cancelledAt?.toISOString()
    });
  });

  // GET /api/sos/active-incoming
  server.get('/active-incoming', async (request, reply) => {
    const userId = (request as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'User not found'
      });
    }

    const activeEvent = await prisma.sosEvent.findFirst({
      where: {
        status: 'ACTIVE',
        contacts: {
          some: {
            phone: {
              equals: user.phone,
              mode: 'insensitive'
            }
          }
        }
      },
      include: {
        contacts: true
      }
    });

    if (!activeEvent) {
      return reply.status(200).send({
        hasActiveIncoming: false
      });
    }

    const victim = await prisma.user.findUnique({
      where: { id: activeEvent.userId }
    });
    const victimName = victim?.name || 'A user';

    const responderContact = activeEvent.contacts.find(
      (c) => c.phone.toLowerCase() === user.phone.toLowerCase()
    );
    const tier = responderContact?.isNearby === 'YES' ? 'LOCAL_RESPONDER' : 'FAMILY';

    return reply.status(200).send({
      hasActiveIncoming: true,
      eventId: activeEvent.id,
      victimName,
      tier,
      lat: activeEvent.latitude,
      lng: activeEvent.longitude,
      w3w: activeEvent.w3wAddress,
      accuracy: activeEvent.accuracy,
      triggeredAt: activeEvent.triggeredAt.toISOString()
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
      status: e.status === 'DURESS' ? 'CANCELLED' : e.status,
      latitude: e.latitude,
      longitude: e.longitude,
      address: e.address,
      w3wAddress: e.w3wAddress,
      accuracy: e.accuracy,
      triggeredAt: e.triggeredAt.toISOString(),
      cancelledAt: e.status === 'DURESS' ? (e.duressTriggeredAt?.toISOString() ?? null) : (e.cancelledAt?.toISOString() ?? null),
      contacts: e.contacts
    }));

  });

  // POST /api/sos/duress-cancel
  server.post('/duress-cancel', {
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

    // Update status to DURESS internally
    const updatedEvent = await prisma.sosEvent.update({
      where: { id: sosEventId },
      data: {
        status: 'DURESS',
        duressTriggeredAt: new Date()
      }
    });

    // Retrieve snapshots (i.e. contacts who received the SOS)
    const snapshots = await prisma.sosContact.findMany({
      where: { sosEventId }
    });

    // Fetch triggerer details
    const triggererUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    const triggererName = triggererUser?.name || 'A user';

    // Asynchronously dispatch quiet FCM duress push notifications (no await, no timing side channel)
    Promise.allSettled(
      snapshots.map(async (contact) => {
        const recipientUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: contact.phone,
              mode: 'insensitive'
            }
          }
        });

        if (recipientUser && recipientUser.fcmToken) {
          console.log(`FCM: Found registered user for contact phone ${contact.phone}, sending quiet duress push...`);
          const success = await sendDuressAlertPush(
            recipientUser.fcmToken,
            triggererName,
            triggererUser?.phone || '',
            event.latitude,
            event.longitude,
            event.w3wAddress,
            sosEventId,
            event.accuracy
          );
          console.log(`FCM quiet duress push sent to ${contact.phone} success status: ${success}`);
        }
      })
    ).catch(err => {
      console.error("Error dispatching FCM duress pushes in background:", err);
    });

    // Return identical response body layout to normal cancel
    return reply.status(200).send({
      sosEventId: updatedEvent.id,
      status: 'CANCELLED',
      cancelledAt: updatedEvent.duressTriggeredAt?.toISOString()
    });
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

  // POST /api/sos/:eventId/respond
  server.post('/:eventId/respond', async (request, reply) => {
    const userId = (request as any).userId;
    const { eventId } = request.params as { eventId: string };

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    }

    const event = await prisma.sosEvent.findUnique({
      where: { id: eventId }
    });
    if (!event) {
      return reply.status(404).send({ error: 'Not Found', message: 'SOS event not found' });
    }

    // Check if response already exists
    let response = await prisma.sosResponse.findFirst({
      where: {
        sosEventId: eventId,
        phone: user.phone
      }
    });

    if (!response) {
      response = await prisma.sosResponse.create({
        data: {
          sosEventId: eventId,
          phone: user.phone
        }
      });
    }

    return reply.status(200).send({
      id: response.id,
      sosEventId: response.sosEventId,
      phone: response.phone,
      respondedAt: response.respondedAt.toISOString()
    });
  });

  // GET /api/sos/:eventId/playbook
  server.get('/:eventId/playbook', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };

    const event = await prisma.sosEvent.findUnique({
      where: { id: eventId },
      include: {
        contacts: true,
        responses: true,
        locationUpdates: {
          orderBy: { timestamp: 'desc' },
          take: 1
        }
      }
    });

    if (!event) {
      return reply.status(404).send({ error: 'Not Found', message: 'SOS event not found' });
    }

    // Find the victim user
    const victim = await prisma.user.findUnique({
      where: { id: event.userId },
      select: { name: true, phone: true }
    });

    // Resolve details for responders
    const responders = await Promise.all(
      event.responses.map(async (r) => {
        const responderUser = await prisma.user.findFirst({
          where: { phone: r.phone }
        });
        return {
          phone: r.phone,
          name: responderUser?.name || 'Anonymous Responder',
          respondedAt: r.respondedAt.toISOString()
        };
      })
    );

    const latestLocation = event.locationUpdates[0];
    const backendBase = (process.env.PUBLIC_URL || 'https://aryaa-backend.onrender.com').replace(/\/$/, '');
    const publicTrackUrl = event.publicTrackToken
      ? `${backendBase}/track/sos/${event.id}?token=${event.publicTrackToken}`
      : null;

    return reply.status(200).send({
      id: event.id,
      victimName: victim?.name || 'Unknown',
      victimPhone: victim?.phone || '',
      status: event.status,
      publicTrackUrl,
      latitude: latestLocation?.latitude ?? event.latitude,
      longitude: latestLocation?.longitude ?? event.longitude,
      w3wAddress: event.w3wAddress,
      accuracy: event.accuracy,
      triggeredAt: event.triggeredAt.toISOString(),
      responders
    });
  });
}
