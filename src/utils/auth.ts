import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

// Fail fast at startup — never run with the default fallback secret.
// If JWT_SECRET is missing, the server refuses to start entirely.
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. ' +
    'The server will not start without a real secret. ' +
    'Add JWT_SECRET=<strong-random-value> to your .env file.');
  process.exit(1);
}

// Single source of truth for the JWT secret.
// Exported so route files import from here — no duplication.
export const JWT_SECRET: string = process.env.JWT_SECRET;

// Algorithm is pinned to HS512 on both sign and verify.
// HS256 (the jsonwebtoken default) is not accepted.
const JWT_ALGORITHM = 'HS512' as const;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: '7d',
    algorithm: JWT_ALGORITHM
  });
}

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws if the token is invalid, expired, or signed with any algorithm
 * other than HS512 (prevents algorithm-confusion attacks).
 */
export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: [JWT_ALGORITHM]
  }) as { userId: string };
}
