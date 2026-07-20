import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../db/index.js';
import { submitSafetyReportSchema, adminResolveSchema } from '../schemas/safety.js';
import { verifyToken } from '../utils/auth.js';

// Haversine distance calculator in meters
function getHaversineDistanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// JWT authentication middleware
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
    }
    const decoded = verifyToken(authHeader.substring(7));
    (request as any).userId = decoded.userId;
  } catch {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

// Admin authorization — fail-closed.
//
// Identity is matched against ADMIN_EMAIL and/or ADMIN_USER_ID environment
// variables. There is NO hardcoded fallback email: if neither variable is
// set in the deployment environment this function returns 503, not 200.
// This prevents a claim-and-escalate attack where an attacker registers the
// fallback address (e.g. "admin@aryaa.com") before the env var is configured.
//
// Required Render env vars (set at least one):
//   ADMIN_EMAIL     — the email address of the designated admin account
//   ADMIN_USER_ID   — the Prisma user UUID of the designated admin account
async function authorizeAdmin(request: FastifyRequest, reply: FastifyReply) {
  const adminEmail  = process.env.ADMIN_EMAIL;
  const adminUserId = process.env.ADMIN_USER_ID;

  // Fail closed: if the deployment has no admin identity configured,
  // return 503 (misconfiguration) rather than falling through.
  if (!adminEmail && !adminUserId) {
    return reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Admin identity is not configured on this server. Set ADMIN_EMAIL or ADMIN_USER_ID.'
    });
  }

  const userId = (request as any).userId;
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const isEmailAdmin  = adminEmail  && user?.email.toLowerCase() === adminEmail.toLowerCase();
  const isIdAdmin     = adminUserId && user?.id === adminUserId;

  if (!isEmailAdmin && !isIdAdmin) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Access denied: Admin privileges required' });
  }
}

export async function safetyRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. POST /api/safety-reports — Create a report (authenticated, rate-limited)
  server.post('/safety-reports', {
    preHandler: authenticate,
    schema: { body: submitSafetyReportSchema }
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { category, description, latitude, longitude, isPublicSpace } = request.body;

    // Rate limiting: max 3 reports per user per day
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const reportCountToday = await prisma.safetyReport.count({
      where: { userId, createdAt: { gte: startOfToday } }
    });
    if (reportCountToday >= 3) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'You have reached the limit of 3 safety reports per day.'
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });

    const report = await prisma.safetyReport.create({
      data: {
        userId,
        userPhone: user.phone,
        category,
        description,
        latitude,
        longitude,
        // Server also forces isPublicSpace for category-implied public-space types,
        // even if the client accidentally sends false for road/lighting.
        isPublicSpace: isPublicSpace || category === 'POOR_LIGHTING' || category === 'UNSAFE_ROAD'
      }
    });

    return reply.status(201).send(report);
  });

  // 1b. GET /api/safety-reports/me — Get user's own reports (authenticated)
  server.get('/safety-reports/me', {
    preHandler: authenticate
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const reports = await prisma.safetyReport.findMany({
      where: {
        userId,
        status: { in: ['ACTIVE', 'UNDER_REVIEW'] }
      },
      orderBy: { createdAt: 'desc' }
    });
    return reply.status(200).send(reports);
  });

  // 1c. DELETE /api/safety-reports/:id — Delete user's own report (authenticated)
  server.delete('/safety-reports/:id', {
    preHandler: authenticate
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const report = await prisma.safetyReport.findUnique({ where: { id } });
    if (!report) return reply.status(404).send({ error: 'Not Found', message: 'Safety report not found' });

    if (report.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You can only remove reports you created.'
      });
    }

    await prisma.safetyReport.delete({ where: { id } });
    return reply.status(200).send({ success: true });
  });

  // 2. GET /api/safety-map/pins — Public aggregated safety pins (unauthenticated)
  server.get('/safety-map/pins', async (_request, reply) => {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo   = new Date(now.getTime() -  90 * 24 * 60 * 60 * 1000);

    const reports = await prisma.safetyReport.findMany({
      where: {
        status: { in: ['ACTIVE', 'UNDER_REVIEW'] },
        createdAt: { gte: twelveMonthsAgo }
      }
    });

    // Geohash-like clustering: round to 3 decimal places (~110m grid)
    const clusters: Record<string, typeof reports> = {};
    for (const r of reports) {
      const key = `${r.latitude.toFixed(3)},${r.longitude.toFixed(3)}`;
      if (!clusters[key]) clusters[key] = [];
      clusters[key].push(r);
    }

    const pins = [];
    for (const clusterReports of Object.values(clusters)) {
      // Anti-abuse gate: COUNT(DISTINCT userPhone) >= 3 in rolling 90-day window
      const reportsLast90Days = clusterReports.filter(r => r.createdAt >= ninetyDaysAgo);
      const distinctPhones = new Set(reportsLast90Days.map(r => r.userPhone.toLowerCase()));

      if (distinctPhones.size >= 3) {
        const avgLat = clusterReports.reduce((s, r) => s + r.latitude, 0) / clusterReports.length;
        const avgLng = clusterReports.reduce((s, r) => s + r.longitude, 0) / clusterReports.length;

        const categoryBreakdown: Record<string, number> = {};
        for (const r of clusterReports) {
          categoryBreakdown[r.category] = (categoryBreakdown[r.category] || 0) + 1;
        }

        let dominantCategory = 'OTHER';
        let maxCount = 0;
        for (const [cat, count] of Object.entries(categoryBreakdown)) {
          if (count > maxCount) { maxCount = count; dominantCategory = cat; }
        }

        pins.push({
          latitude: avgLat,
          longitude: avgLng,
          category: dominantCategory,
          reportCount: clusterReports.length,
          disputed: clusterReports.some(r => r.status === 'UNDER_REVIEW'),
          reportIds: clusterReports.map(r => r.id),
          categoryBreakdown
        });
      }
    }

    return reply.status(200).send(pins);
  });

  // 3. POST /api/safety-reports/:id/dispute — Dispute a report (authenticated, proximity-gated)
  // This endpoint takes no request body — do NOT send Content-Type: application/json.
  server.post('/safety-reports/:id/dispute', {
    preHandler: authenticate
  }, async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const report = await prisma.safetyReport.findUnique({ where: { id } });
    if (!report) return reply.status(404).send({ error: 'Not Found', message: 'Safety report not found' });

    if (report.status === 'REMOVED_BY_ADMIN') {
      return reply.status(400).send({ error: 'Bad Request', message: 'Report is already removed' });
    }

    // Gate 1: public-space reports are not disputable
    if (report.isPublicSpace) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Public space reports cannot be disputed.'
      });
    }

    // Gate 2: requester must have a home address registered within 50m of the report
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.homeLatitude === null || user.homeLongitude === null) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You must register your profile home coordinates to dispute reports.'
      });
    }

    const distance = getHaversineDistanceInMeters(
      report.latitude, report.longitude,
      user.homeLatitude, user.homeLongitude
    );
    if (distance > 50) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Your registered home address is ${Math.round(distance)}m away (must be within 50m).`
      });
    }

    const updated = await prisma.safetyReport.update({
      where: { id },
      data: { status: 'UNDER_REVIEW', disputedBy: userId, disputedAt: new Date() }
    });

    return reply.status(200).send(updated);
  });

  // 4. GET /api/admin/safety-reports — Admin: list reports
  // Requires JWT + ADMIN_EMAIL or ADMIN_USER_ID env var match (fail-closed if unconfigured).
  server.get('/admin/safety-reports', {
    preHandler: [authenticate, authorizeAdmin]
  }, async (request, reply) => {
    const { status } = request.query as { status?: string };
    const reports = await prisma.safetyReport.findMany({
      where: { status: status ? status : undefined },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    return reply.status(200).send(reports);
  });

  // 5. POST /api/admin/safety-reports/:id/resolve — Admin: resolve dispute
  // outcome: 'UPHOLD' (restore to ACTIVE) | 'REMOVE' (lock as REMOVED_BY_ADMIN)
  server.post('/admin/safety-reports/:id/resolve', {
    preHandler: [authenticate, authorizeAdmin],
    schema: { body: adminResolveSchema }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { outcome } = request.body;

    const report = await prisma.safetyReport.findUnique({ where: { id } });
    if (!report) return reply.status(404).send({ error: 'Not Found', message: 'Safety report not found' });

    if (outcome === 'REMOVE') {
      return reply.status(200).send(
        await prisma.safetyReport.update({ where: { id }, data: { status: 'REMOVED_BY_ADMIN' } })
      );
    } else {
      // UPHOLD — restore to ACTIVE and clear dispute metadata
      return reply.status(200).send(
        await prisma.safetyReport.update({
          where: { id },
          data: { status: 'ACTIVE', disputedBy: null, disputedAt: null }
        })
      );
    }
  });
}
