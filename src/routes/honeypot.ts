import { FastifyInstance } from 'fastify';

/**
 * Honeypot / canary endpoints.
 *
 * These paths mimic common attack-scanner targets (admin panels, env files,
 * WordPress, etc.). No legitimate client ever calls them. Any hit is logged
 * with the source IP for later WAF rule creation.
 *
 * In production: feed the logged IPs into a WAF blocklist (e.g. AWS WAF).
 * For prototype: logging is sufficient — no automated IP block implemented.
 */
const HONEYPOT_PATHS = [
  '/api/admin',
  '/api/users',
  '/api/internal',
  '/.env',
  '/wp-admin',
  '/phpMyAdmin',
  '/admin',
  '/config',
];

export async function honeypotRoutes(fastify: FastifyInstance) {
  for (const path of HONEYPOT_PATHS) {
    // Register both GET and POST on each decoy path
    fastify.get(path, async (request, reply) => {
      const sourceIp = request.ip;
      const userAgent = request.headers['user-agent'] ?? 'unknown';
      fastify.log.warn({
        event: 'HONEYPOT_HIT',
        path,
        method: 'GET',
        ip: sourceIp,
        userAgent,
      }, `[SECURITY] Honeypot hit: GET ${path} from ${sourceIp}`);
      return reply.status(404).send({ error: 'Not Found' });
    });

    fastify.post(path, async (request, reply) => {
      const sourceIp = request.ip;
      const userAgent = request.headers['user-agent'] ?? 'unknown';
      fastify.log.warn({
        event: 'HONEYPOT_HIT',
        path,
        method: 'POST',
        ip: sourceIp,
        userAgent,
      }, `[SECURITY] Honeypot hit: POST ${path} from ${sourceIp}`);
      return reply.status(404).send({ error: 'Not Found' });
    });
  }
}
