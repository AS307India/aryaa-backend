import Fastify, { FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { authRoutes } from './routes/auth.js';
import { contactsRoutes } from './routes/contacts.js';
import { sosRoutes } from './routes/sos.js';
import { honeypotRoutes } from './routes/honeypot.js';

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

// Honeypot routes registered first so attack-scanner paths are captured
// before any legitimate route can accidentally match them.
app.register(honeypotRoutes);

app.register(authRoutes, { prefix: '/api/auth' });
app.register(contactsRoutes, { prefix: '/api/contacts' });
app.register(sosRoutes, { prefix: '/api/sos' });

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
