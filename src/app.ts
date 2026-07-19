import Fastify, { FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { prisma } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { contactsRoutes } from './routes/contacts.js';
import { sosRoutes } from './routes/sos.js';
import { honeypotRoutes } from './routes/honeypot.js';
import { userRoutes } from './routes/users.js';
import { deadZoneRoutes } from './routes/deadzone.js';
import { locationShareRoutes } from './routes/locationshare.js';
import { nearbyRoutes } from './routes/nearby.js';
import { safetyRoutes } from './routes/safety.js';

// Startup guard — utils/auth.ts calls process.exit(1) if JWT_SECRET is missing.
// Importing it here ensures the guard runs before the server binds to any port.
import './utils/auth.js';

export const app = Fastify({
  logger: true,
  // Trust the X-Forwarded-For header when behind a reverse proxy (Render, AWS ALB).
  // Set to 1 to trust one hop; adjust for your proxy chain depth.
  trustProxy: 1
});

// ─── Security middleware (order matters — register before routes) ────────────

// @fastify/helmet adds CSP, X-Frame-Options, HSTS, X-Content-Type-Options, etc.
// contentSecurityPolicy is disabled here; re-enable and tune when the web
// dashboard domain is known (Phase 2).
await app.register(helmet, {
  contentSecurityPolicy: false
});

// @fastify/cors — no browser cross-origin requests allowed.
// Change origin to your dashboard domain when Phase 2 B2B panel lands.
await app.register(cors, {
  origin: false
});

// Global rate limit: 50 requests per minute per IP.
// Individual routes can override this with a tighter config.
// Rate-limit sends 429 directly via reply.code(429).send() — does NOT go through setErrorHandler.
// Test requests are handled by individual route-level rateLimit configs.
await app.register(rateLimit, {
  global: true,
  max: 50,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => {
    return request.ip;
  }
});

// ─── Zod type provider ───────────────────────────────────────────────────────

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /health — unauthenticated health check / keep-alive ping.
// Registered first and excluded from rate limiting so monitoring
// services always get through.
app.get('/health', {
  config: {
    rateLimit: false
  }
}, async (request, reply) => {
  return reply.status(200).send({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Honeypot routes registered first so attack-scanner paths are captured
// before any legitimate route can accidentally match them.
app.register(honeypotRoutes);

app.register(authRoutes, { prefix: '/api/auth' });
app.register(contactsRoutes, { prefix: '/api/contacts' });
app.register(sosRoutes, { prefix: '/api/sos' });
app.register(userRoutes, { prefix: '/api/users' });
app.register(deadZoneRoutes, { prefix: '/api/deadzone' });
app.register(locationShareRoutes, { prefix: '/api/location-share' });
app.register(nearbyRoutes, { prefix: '/api/nearby-services' });
app.register(safetyRoutes, { prefix: '/api' });

// ─── Public live-tracking HTML page ──────────────────────────────────────────
// GET /track/:sessionId?token=<shareToken>
// No auth required — renders a Leaflet map that auto-refreshes the sharer's
// location every 10 seconds by polling /api/location-share/:sessionId/view.
app.get('/track/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const { token } = request.query as { token: string };
  const apiBase = (process.env.PUBLIC_URL || 'https://aryaa-backend.onrender.com').replace(/\/$/, '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Live Location — ARYAA</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #fff; }
    #header { padding: 16px 20px; background: #1a1d27; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2a2d3a; }
    #header .logo { font-size: 20px; font-weight: 700; color: #3b82f6; }
    #header .subtitle { font-size: 13px; color: #94a3b8; }
    #status { padding: 10px 20px; font-size: 13px; color: #94a3b8; background: #1a1d27; text-align: center; }
    #status.active { color: #3b82f6; }
    #status.expired { color: #ef4444; }
    #map { width: 100%; height: calc(100vh - 110px); }
  </style>
</head>
<body>
  <div id="header">
    <div>
      <div class="logo">📍 ARYAA Live Location</div>
      <div class="subtitle" id="sharerName">Loading...</div>
    </div>
  </div>
  <div id="status">Fetching location...</div>
  <div id="map"></div>
  <script>
    const SESSION_ID = '${sessionId}';
    const TOKEN = '${token}';
    const API = '${apiBase}/api/location-share/' + SESSION_ID + '/view?token=' + TOKEN;

    const map = L.map('map').setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const icon = L.divIcon({ html: '📍', iconSize: [30, 30], iconAnchor: [15, 30], className: '' });
    let marker = null;
    let polyline = null;
    let firstLoad = true;

    async function refresh() {
      try {
        const res = await fetch(API);
        if (res.status === 400) {
          document.getElementById('status').textContent = 'Session expired or stopped.';
          document.getElementById('status').className = 'expired';
          return;
        }
        const data = await res.json();
        document.getElementById('sharerName').textContent = (data.victimName || 'Contact') + ' • Live';
        const locs = data.locations || [];
        if (locs.length === 0) { document.getElementById('status').textContent = 'Waiting for first location update...'; return; }
        const last = locs[locs.length - 1];
        const latlng = [last.latitude, last.longitude];
        if (marker) { marker.setLatLng(latlng); } else { marker = L.marker(latlng, { icon }).addTo(map); }
        if (firstLoad) { map.setView(latlng, 15); firstLoad = false; }
        if (polyline) { polyline.setLatLngs(locs.map(l => [l.latitude, l.longitude])); }
        else { polyline = L.polyline(locs.map(l => [l.latitude, l.longitude]), { color: '#3b82f6', weight: 3 }).addTo(map); }
        const ts = new Date(last.timestamp).toLocaleTimeString();
        document.getElementById('status').textContent = 'Last updated: ' + ts;
        document.getElementById('status').className = 'active';
      } catch(e) { document.getElementById('status').textContent = 'Network error. Retrying...'; }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;

  return reply.type('text/html').send(html);
});

// GET /api/sos/track/:eventId — public unauthenticated API to get SOS tracking data.
// Rate limited to max 60 requests/minute to prevent enumeration/scraping.
app.get('/api/sos/track/:eventId', {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute'
    }
  }
}, async (request, reply) => {
  const { eventId } = request.params as { eventId: string };
  const { token } = request.query as { token: string };

  if (!token) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Missing token' });
  }

  const event = await prisma.sosEvent.findUnique({
    where: { id: eventId },
    include: {
      user: { select: { name: true } },
      locationUpdates: { orderBy: { timestamp: 'asc' } }
    }
  });

  if (!event || event.publicTrackToken !== token) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Invalid token' });
  }

  // If the event has finished or is a duress fake-cancellation, expire it immediately
  if (event.status === 'CANCELLED' || event.status === 'RESOLVED' || event.status === 'DURESS') {
    return reply.status(200).send({
      active: false,
      status: 'Resolved',
      triggeredAt: event.triggeredAt.toISOString()
    });
  }

  const victimFirstName = event.user?.name.split(' ')[0] || 'User';
  const latest = event.locationUpdates[event.locationUpdates.length - 1];
  const lat = latest?.latitude ?? event.latitude;
  const lng = latest?.longitude ?? event.longitude;
  const accuracy = event.accuracy;

  return reply.status(200).send({
    active: true,
    victimFirstName,
    lat,
    lng,
    accuracy,
    pathHistory: event.locationUpdates.map(loc => ({
      latitude: loc.latitude,
      longitude: loc.longitude,
      timestamp: loc.timestamp.toISOString()
    })),
    status: 'Active',
    triggeredAt: event.triggeredAt.toISOString()
  });
});

// GET /track/sos/:eventId — public unauthenticated HTML page rendering a Leaflet map.
app.get('/track/sos/:eventId', async (request, reply) => {
  const { eventId } = request.params as { eventId: string };
  const { token } = request.query as { token: string };
  const apiBase = (process.env.PUBLIC_URL || 'https://aryaa-backend.onrender.com').replace(/\/$/, '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Live Location — ARYAA</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #fff; }
    #header { padding: 16px 20px; background: #1a1d27; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2a2d3a; }
    #header .logo { font-size: 20px; font-weight: 700; color: #ef4444; }
    #header .subtitle { font-size: 13px; color: #94a3b8; }
    #status { padding: 10px 20px; font-size: 13px; color: #94a3b8; background: #1a1d27; text-align: center; }
    #status.active { color: #ef4444; }
    #status.expired { color: #ef4444; }
    #map { width: 100%; height: calc(100vh - 110px); }
  </style>
</head>
<body>
  <div id="header">
    <div>
      <div class="logo">🚨 ARYAA SOS Live Tracking</div>
      <div class="subtitle" id="sharerName">Loading...</div>
    </div>
  </div>
  <div id="status">Fetching location...</div>
  <div id="map"></div>
  <script>
    const EVENT_ID = '${eventId}';
    const TOKEN = '${token}';
    const API = '${apiBase}/api/sos/track/' + EVENT_ID + '?token=' + TOKEN;

    const map = L.map('map').setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const icon = L.divIcon({ html: '📍', iconSize: [30, 30], iconAnchor: [15, 30], className: '' });
    let marker = null;
    let polyline = null;
    let firstLoad = true;

    async function refresh() {
      try {
        const res = await fetch(API);
        if (res.status === 400 || res.status === 403 || res.status === 404) {
          document.getElementById('status').textContent = 'Session expired or stopped.';
          document.getElementById('status').className = 'expired';
          return;
        }
        const data = await res.json();
        if (data.active === false) {
          document.getElementById('status').textContent = 'Session expired or stopped.';
          document.getElementById('status').className = 'expired';
          return;
        }
        document.getElementById('sharerName').textContent = (data.victimFirstName || 'User') + ' • SOS';
        const lat = data.lat;
        const lng = data.lng;
        const latlng = [lat, lng];
        if (marker) { marker.setLatLng(latlng); } else { marker = L.marker(latlng, { icon }).addTo(map); }
        if (firstLoad) { map.setView(latlng, 15); firstLoad = false; }
        const history = data.pathHistory || [];
        if (polyline) { polyline.setLatLngs(history.map(l => [l.latitude, l.longitude])); }
        else { polyline = L.polyline(history.map(l => [l.latitude, l.longitude]), { color: '#ef4444', weight: 3 }).addTo(map); }
        document.getElementById('status').textContent = 'SOS Active';
        document.getElementById('status').className = 'active';
      } catch(e) { document.getElementById('status').textContent = 'Network error. Retrying...'; }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;

  return reply.type('text/html').send(html);
});

// ─── Global error handler ────────────────────────────────────────────────────

app.setErrorHandler((error, request, reply) => {
  // @fastify/rate-limit routes through setErrorHandler in Fastify 4.
  // Catch it here and forward as a proper 429 (not 500).
  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: 'Too Many Requests',
      message: error.message
    });
  }

  // Handle validation errors (Zod / Fastify validation)
  if (error.validation || error.statusCode === 400) {
    let cleanMessage = error.message;
    try {
      const parsed = JSON.parse(error.message);
      if (Array.isArray(parsed)) {
        cleanMessage = parsed.map((err: any) => {
          const field = err.path ? err.path.join('.') : '';
          return field ? `${field}: ${err.message}` : err.message;
        }).join(', ');
      }
    } catch (e) {
      // Use original message if not stringified JSON
    }

    return reply.status(400).send({
      error: 'Bad Request',
      message: cleanMessage
    });
  }

  // Log unexpected errors server-side
  app.log.error(error);

  // Return safe 500 error response (no stack trace leaked)
  return reply.status(500).send({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred'
  });
});
